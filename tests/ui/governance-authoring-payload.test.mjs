import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAssignmentGrantPayload,
  buildEntitlementAddPayload,
  buildEntitlementEditPayload,
  buildEntitlementStatePayload,
  buildFallbackAddPayload,
  buildFallbackEditPayload,
} from '../../app/admin-ui/public/governance-authoring.mjs';
import { projectFallback } from '../../app/control-api/fallback-read-model-projector.mjs';
import {
  getDeterministicGovernanceSnapshots,
} from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const binding = {
  bindingCode: 'binding-team-platform-engineering-001',
  modelCodes: ['coding-fast', 'coding-primary'],
  limits: {
    requestsPerMinute: 100,
    tokensPerMinute: 100_000,
    tokenQuota: 12_000_000,
    quotaPeriod: 'Monthly',
  },
};

test('an entitlement edit payload round-trips every persisted limit', () => {
  const unchanged = buildEntitlementEditPayload(binding, {
    modelCodes: ['coding-primary', 'coding-fast'],
    requestsPerMinute: '100',
    tokensPerMinute: '100000',
    tokenQuota: '12000000',
    quotaPeriod: 'Monthly',
  });
  assert.deepEqual(unchanged, { ok: false, error: 'noChange' });

  const changed = buildEntitlementEditPayload(binding, {
    modelCodes: ['coding-fast', 'coding-primary'],
    requestsPerMinute: '75',
    tokensPerMinute: '90000',
    tokenQuota: '6000000',
    quotaPeriod: 'Weekly',
  });
  assert.deepEqual(changed, {
    ok: true,
    payload: {
      bindingId: binding.bindingCode,
      changes: {
        limits: {
          requestsPerMinute: 75,
          tokensPerMinute: 90_000,
          tokenQuota: 6_000_000,
          quotaPeriod: 'Weekly',
        },
      },
    },
  });
});

test('team and application entitlement payloads preserve target and limits', () => {
  const team = buildEntitlementAddPayload({
    targetKind: 'team',
    targetKey: 'platform-engineering',
    modelCodes: ['coding-primary'],
    requestsPerMinute: '20',
    tokensPerMinute: '',
    tokenQuota: '1000000',
    quotaPeriod: 'Monthly',
    reasonCode: 'team-exception',
  });

  assert.equal(team.ok, true);
  assert.deepEqual(team.payload.target, { kind: 'team', key: 'platform-engineering' });
  assert.deepEqual(team.payload.limits, {
    requestsPerMinute: 20,
    tokenQuota: 1_000_000,
    quotaPeriod: 'Monthly',
  });

  const application = buildEntitlementAddPayload({
    targetKind: 'application',
    targetKey: 'app-agent',
    modelCodes: ['coding-fast'],
    tokenQuota: '',
    quotaPeriod: '',
    reasonCode: 'pilot-participant',
  });
  assert.equal(application.ok, true);
  assert.deepEqual(application.payload.target, { kind: 'application', key: 'app-agent' });
  assert.deepEqual(application.payload.limits, {});

  assert.deepEqual(buildEntitlementAddPayload({
    targetKind: 'application',
    targetKey: 'app-agent',
    modelCodes: ['coding-fast'],
    tokenQuota: '1000',
    quotaPeriod: '',
    reasonCode: 'pilot-participant',
  }), { ok: false, error: 'quotaPairRequired' });
});

test('only non-global active bindings retire and only restorable revoked bindings reactivate', () => {
  const active = {
    bindingCode: 'binding-application-agent',
    targetKind: 'application',
    state: 'active',
    canRestore: false,
  };
  assert.deepEqual(buildEntitlementStatePayload(active, 'revoked'), {
    ok: true,
    payload: {
      bindingId: active.bindingCode,
      changes: { state: 'revoked' },
    },
  });
  assert.deepEqual(
    buildEntitlementStatePayload({ ...active, targetKind: 'global' }, 'revoked'),
    { ok: false, error: 'globalBindingRequired' },
  );

  const revoked = { ...active, state: 'revoked', canRestore: true };
  assert.deepEqual(buildEntitlementStatePayload(revoked, 'active'), {
    ok: true,
    payload: {
      bindingId: active.bindingCode,
      changes: { state: 'active' },
    },
  });
  assert.deepEqual(
    buildEntitlementStatePayload({ ...revoked, canRestore: false }, 'active'),
    { ok: false, error: 'bindingStateUnavailable' },
  );
});

test('assignment grants are constrained to the server-provided role rule', () => {
  const values = {
    assignmentId: 'assignment-team-admin-002',
    roleCode: 'team-admin',
    assigneeKind: 'group',
    assigneeKey: 'group-platform-engineering',
    scopeKind: 'team',
    scopeKey: 'platform-engineering',
    reasonCode: 'delegated-team-administration',
  };
  const rule = {
    roleCode: 'team-admin',
    assigneeKinds: ['subject', 'group'],
    scopeKinds: ['team'],
  };
  assert.deepEqual(buildAssignmentGrantPayload(values, rule), {
    ok: true,
    payload: {
      command: 'grant',
      assignmentId: values.assignmentId,
      roleCode: values.roleCode,
      assignee: { kind: 'group', key: values.assigneeKey },
      scope: { kind: 'team', key: values.scopeKey },
      reasonCode: values.reasonCode,
    },
  });
  assert.deepEqual(
    buildAssignmentGrantPayload({ ...values, assigneeKind: 'application' }, rule),
    { ok: false, error: 'assignmentCombinationInvalid' },
  );
});

test('fallback payloads preserve the current authored values and reject no-ops', () => {
  const authored = {
    planCode: 'plan-1',
    optedIn: true,
    modelSelectionIntent: 'preferred',
    substitutionNotice: 'header',
    edges: [
      { from: 'model-z', to: 'model-y' },
      { from: 'model-a', to: 'model-b' },
    ],
  };
  assert.deepEqual(buildFallbackEditPayload(authored, {
    enabled: true,
    modelSelectionIntent: 'preferred',
    substitutionNotice: 'header',
    edges: [...authored.edges].reverse(),
    modelCodes: ['model-a', 'model-b', 'model-y', 'model-z'],
  }), { ok: false, error: 'noChange' });
  assert.deepEqual(buildFallbackEditPayload(authored, {
    enabled: false,
    modelSelectionIntent: 'preferred',
    substitutionNotice: 'header',
    edges: authored.edges,
    modelCodes: ['model-a', 'model-b', 'model-y', 'model-z'],
  }), {
    ok: true,
    payload: {
      planId: 'plan-1',
      changes: {
        enabled: false,
        modelSelectionIntent: 'preferred',
        substitutionNotice: 'header',
        edges: [
          { from: 'model-a', to: 'model-b' },
          { from: 'model-z', to: 'model-y' },
        ],
      },
    },
  });
});

test('fallback creation builds safe defaults and validates identifiers, teams, settings, and edges', () => {
  const values = {
    planId: 'plan-global-new', targetKind: 'global', targetKey: '',
    edges: [{ from: 'coding-secondary', to: 'coding-primary' }],
    modelCodes: ['coding-primary', 'coding-secondary'],
  };
  assert.deepEqual(buildFallbackAddPayload(values), {
    ok: true,
    payload: {
      command: 'add',
      plan: {
        planId: 'plan-global-new', target: { kind: 'global', key: null },
        enabled: false, modelSelectionIntent: 'pinned', substitutionNotice: 'header',
        edges: values.edges,
      },
    },
  });
  const configured = buildFallbackAddPayload({
    ...values, enabled: true, modelSelectionIntent: 'preferred', substitutionNotice: 'inline',
  });
  assert.equal(configured.payload.plan.enabled, true);
  assert.equal(configured.payload.plan.substitutionNotice, 'inline');
  for (const [change, error] of [
    [{ planId: '' }, 'fallbackTargetRequired'],
    [{ targetKind: 'organization' }, 'fallbackTargetRequired'],
    [{ targetKind: 'subject', targetKey: '' }, 'fallbackTargetRequired'],
    [{ targetKind: 'team', targetKey: 'unknown' }, 'fallbackTeamUnknown'],
    [{ enabled: 'true' }, 'fallbackSettingsInvalid'],
    [{ substitutionNotice: 'inline' }, 'fallbackNoticeRequiresPreferred'],
    [{ edges: [{ from: 'missing', to: 'coding-primary' }] }, 'fallbackModelUnknown'],
    [{ edges: [values.edges[0], values.edges[0]] }, 'fallbackDuplicateSource'],
  ]) {
    assert.deepEqual(buildFallbackAddPayload({ ...values, ...change }), { ok: false, error });
  }
  for (const targetKind of ['team', 'subject', 'application']) {
    const created = buildFallbackAddPayload({
      ...values, targetKind, targetKey: 'known-key', teamKeys: ['known-key'],
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.payload.plan.target, { kind: targetKind, key: 'known-key' });
  }
});

test('fallback graph payloads reject invalid whole-set replacements', () => {
  const authored = {
    planCode: 'plan-1',
    optedIn: true,
    modelSelectionIntent: 'preferred',
    substitutionNotice: 'header',
    edges: [],
  };
  const values = {
    enabled: true,
    modelSelectionIntent: 'preferred',
    substitutionNotice: 'header',
    modelCodes: ['model-a', 'model-b', 'model-c'],
  };
  assert.deepEqual(
    buildFallbackEditPayload(authored, {
      ...values,
      edges: [{ from: 'model-a', to: 'model-a' }],
    }),
    { ok: false, error: 'fallbackSelfLoop' },
  );
  assert.deepEqual(
    buildFallbackEditPayload(authored, {
      ...values,
      edges: [
        { from: 'model-a', to: 'model-b' },
        { from: 'model-a', to: 'model-c' },
      ],
    }),
    { ok: false, error: 'fallbackDuplicateSource' },
  );
  assert.deepEqual(
    buildFallbackEditPayload(authored, {
      ...values,
      edges: [
        { from: 'model-a', to: 'model-b' },
        { from: 'model-b', to: 'model-a' },
      ],
    }),
    { ok: false, error: 'fallbackCycle' },
  );
  assert.deepEqual(
    buildFallbackEditPayload(authored, {
      ...values,
      edges: [{ from: 'model-a', to: 'model-unknown' }],
    }),
    { ok: false, error: 'fallbackModelUnknown' },
  );
  assert.deepEqual(
    buildFallbackEditPayload(authored, {
      ...values,
      edges: Array.from({ length: 33 }, (_, index) => ({
        from: `model-${index}`,
        to: 'model-a',
      })),
    }),
    { ok: false, error: 'fallbackEdgesTooMany' },
  );
});

test('fallback no-op comparison applies defaults omitted by the deterministic plan', () => {
  const { fallbackPolicySnapshot } = getDeterministicGovernanceSnapshots();
  const plan = fallbackPolicySnapshot.plans.find(
    ({ planId }) => planId === 'plan-global-cheaper-alternative-001',
  );
  assert.equal(Object.hasOwn(plan, 'substitutionNotice'), false);

  const readModel = projectFallback({
    authorization: {
      contractVersion: 'v1',
      readAuthority: 'authoritative',
      permittedReadScopes: ['global'],
      permittedTeamKeys: [],
    },
    plan,
    compiled: null,
    decision: null,
    selection: {
      scope: 'global',
      teamKey: null,
      generatedAt: '2026-07-24T10:00:00.000Z',
    },
  });
  assert.equal(readModel.authored.substitutionNotice, undefined);
  assert.deepEqual(buildFallbackEditPayload(readModel.authored, {
    enabled: true,
    modelSelectionIntent: 'preferred',
    substitutionNotice: 'header',
    edges: readModel.authored.edges,
    modelCodes: ['coding-fast', 'coding-primary'],
  }), { ok: false, error: 'noChange' });
});
