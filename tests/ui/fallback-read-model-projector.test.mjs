import assert from 'node:assert/strict';
import test from 'node:test';

import { projectFallback } from '../../app/control-api/fallback-read-model-projector.mjs';

const generatedAt = '2026-07-24T10:00:00.000Z';

function authorization(permittedReadScopes = ['self', 'team', 'global']) {
  return {
    contractVersion: 'v1',
    readAuthority: 'authoritative',
    permittedReadScopes,
    permittedTeamKeys: ['platform-engineering'],
    reasonCode: 'authorized',
  };
}

function plan(overrides = {}) {
  return {
    planId: 'plan-global-001',
    planVersion: 2,
    state: 'active',
    target: { kind: 'global', key: null },
    enabled: true,
    modelSelectionIntent: 'preferred',
    substitutionNotice: 'header',
    edges: [{ from: 'coding-primary', to: 'coding-fast' }],
    validFrom: '2026-07-01T00:00:00.000Z',
    validUntil: null,
    issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
    reasonCode: 'local-fixture-policy',
    ...overrides,
  };
}

function compiled(overrides = {}) {
  return {
    disposition: 'compiled',
    enabled: true,
    maxDepth: 1,
    onExhausted: 'continue-with-requested',
    modelSelectionIntent: 'preferred',
    substitutionNotice: 'header',
    chain: [{ from: 'coding-primary', to: 'coding-fast' }],
    rejections: [],
    reasonCode: 'fallback-compiled',
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    decision: 'selected',
    reasonCode: 'downgraded-under-pressure',
    requested: { modelKey: 'coding-primary', providerKey: 'azure-openai' },
    effective: { modelKey: 'coding-fast', providerKey: 'azure-openai' },
    hops: 1,
    modelSelectionIntent: 'preferred',
    trigger: { kind: 'threshold-breach', warnThresholdPercent: 90, breachedScopes: ['subject'] },
    exhausted: null,
    configVersion: 7,
    ...overrides,
  };
}

function project(overrides = {}) {
  const single = overrides.compiled === undefined ? compiled() : overrides.compiled;
  return projectFallback({
    authorization: authorization(overrides.scopes),
    plan: overrides.plan === undefined ? plan() : overrides.plan,
    compiled: single === null ? null : [{ apiFamily: 'openai-responses', compiled: single }],
    decision: overrides.decision === undefined ? decision() : overrides.decision,
    selection: {
      scope: overrides.scope ?? 'global',
      teamKey: overrides.teamKey ?? null,
      generatedAt,
    },
  });
}

test('what was authored, what compiled, and what happened are three separate answers', () => {
  const readModel = project();
  assert.equal(readModel.readModelVersion, 'fallback.v1');
  assert.equal(readModel.quality.state, 'complete');

  assert.equal(readModel.authored.planCode, 'plan-global-001');
  assert.equal(readModel.authored.optedIn, true);
  assert.equal(readModel.authored.modelSelectionIntent, 'preferred');
  assert.equal(readModel.authored.substitutionNotice, 'header');
  assert.deepEqual(readModel.authored.edges, [{ from: 'coding-primary', to: 'coding-fast' }]);

  assert.deepEqual(readModel.compiled[0].permittedHops, [{ from: 'coding-primary', to: 'coding-fast' }]);
  assert.equal(readModel.compiled[0].maxDepth, 1);

  assert.equal(readModel.decision.requested.modelKey, 'coding-primary');
  assert.equal(readModel.decision.effective.modelKey, 'coding-fast');
  assert.equal(readModel.decision.configVersion, 7);
});

test('a hop that compiled away names the class that blocked it', () => {
  const readModel = project({
    compiled: compiled({
      chain: [],
      enabled: false,
      reasonCode: 'fallback-no-permitted-target',
      rejections: [{ from: 'coding-primary', to: 'coding-fast', blockedBy: 'fallback-not-cheaper' }],
    }),
  });
  assert.deepEqual(readModel.compiled[0].permittedHops, []);
  assert.deepEqual(readModel.compiled[0].refusedHops, [
    { from: 'coding-primary', to: 'coding-fast', blockedBy: 'fallback-not-cheaper' },
  ]);
  assert.equal(readModel.compiled[0].reasonCode, 'fallback-no-permitted-target');
});

test('a cyclic plan is shown with its reason rather than hidden', () => {
  const readModel = project({
    plan: plan({
      edges: [
        { from: 'coding-primary', to: 'coding-fast' },
        { from: 'coding-fast', to: 'coding-primary' },
      ],
    }),
  });
  assert.equal(readModel.quality.state, 'plan-refused');
  assert.equal(readModel.authored.accepted, false);
  assert.equal(readModel.authored.authoringReasonCode, 'authoring-cycle');
  // The graph an administrator has to fix is still on the screen.
  assert.equal(readModel.authored.edges.length, 2);
});

test('each authoring rule reports its own code', () => {
  const cases = [
    [[{ from: 'coding-fast', to: 'coding-fast' }], 'authoring-self-loop'],
    [
      [
        { from: 'coding-primary', to: 'coding-fast' },
        { from: 'coding-primary', to: 'coding-slow' },
      ],
      'authoring-multiple-targets',
    ],
  ];
  for (const [edges, expected] of cases) {
    const readModel = project({ plan: plan({ edges }) });
    assert.equal(readModel.authored.authoringReasonCode, expected, expected);
  }

  const inverted = project({
    plan: plan({ validFrom: '2026-07-10T00:00:00.000Z', validUntil: '2026-07-01T00:00:00.000Z' }),
  });
  assert.equal(inverted.authored.authoringReasonCode, 'authoring-window-inverted');
});

test('an opt-out is a state, not a missing plan', () => {
  const readModel = project({
    plan: plan({ enabled: false }),
    compiled: compiled({
      disposition: 'disabled',
      enabled: false,
      chain: [],
      reasonCode: 'fallback-not-opted-in',
    }),
  });
  assert.equal(readModel.authored.optedIn, false);
  assert.equal(readModel.quality.state, 'complete');
  assert.equal(readModel.compiled[0].reasonCode, 'fallback-not-opted-in');
});

test('no plan for the scope is a complete answer, not a degraded one', () => {
  const readModel = project({ plan: null, compiled: null, decision: null });
  assert.equal(readModel.quality.state, 'no-plan');
  assert.equal(readModel.quality.reasonCode, 'fallback-no-plan-for-scope');
  assert.equal(readModel.authored, null);
  assert.equal(readModel.compiled, null);
  assert.equal(readModel.decision, null);
});

test('a pin is reported as the pin, not as a budget denial', () => {
  const readModel = project({
    compiled: compiled({ modelSelectionIntent: 'pinned' }),
    decision: decision({
      decision: 'selected',
      reasonCode: 'model-pinned',
      effective: { modelKey: 'coding-primary', providerKey: 'azure-openai' },
      hops: 0,
      modelSelectionIntent: 'pinned',
      exhausted: {
        modelKey: 'coding-primary',
        providerKey: 'azure-openai',
        blockedBy: 'model-pinned',
        unenforcedPolicy: null,
      },
    }),
  });
  assert.equal(readModel.decision.modelSelectionIntent, 'pinned');
  assert.equal(readModel.decision.exhausted.blockedBy, 'model-pinned');
  assert.equal(readModel.decision.exhausted.unenforcedPolicy, null);
  assert.equal(readModel.decision.hops, 0);
});

test('a configured denial the deployment cannot carry out is surfaced', () => {
  const readModel = project({
    decision: decision({
      decision: 'selected',
      reasonCode: 'no-configured-target',
      effective: { modelKey: 'coding-primary', providerKey: 'azure-openai' },
      hops: 0,
      exhausted: {
        modelKey: 'coding-primary',
        providerKey: 'azure-openai',
        blockedBy: 'fallback-no-configured-target',
        unenforcedPolicy: 'deny',
      },
    }),
  });
  assert.equal(readModel.decision.exhausted.unenforcedPolicy, 'deny');
  assert.equal(readModel.decision.effective.modelKey, 'coding-primary');
});

test('a denial reports no effective model at all', () => {
  const readModel = project({
    decision: decision({ decision: 'denied', reasonCode: 'model-not-entitled', effective: null, hops: 0 }),
  });
  assert.equal(readModel.decision.decision, 'denied');
  assert.equal(readModel.decision.effective, null);
});

test('an unpermitted scope is denied before anything is projected', () => {
  assert.throws(
    () => project({ scopes: ['self'] }),
    (error) => error.code === 'scope-denied',
  );
});

test('the read model carries no request body and no raw principal identifier', () => {
  const serialized = JSON.stringify(project());
  for (const forbidden of ['prompt', 'completion', 'subjectId', 'applicationId', 'providerKey']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `read model must not carry ${forbidden}`);
  }
});
