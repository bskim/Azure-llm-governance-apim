import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { evaluateGovernanceAuthorization } from '../../app/governance-domain/authorization/governance-authorization-evaluator.mjs';

const evaluationTime = '2026-07-24T00:00:00.000Z';
const principalContext = JSON.parse(
  await readFile(
    new URL('./fixtures/principal-context/valid-user-complete.json', import.meta.url),
    'utf8',
  ),
);

async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`./fixtures/governance-authorization/${name}`, import.meta.url), 'utf8'),
  );
}

function clone(value) {
  return structuredClone(value);
}

function assignmentSnapshot(assignments = [], overrides = {}) {
  return {
    contractVersion: 'v1',
    snapshotId: 'assignment-snapshot-001',
    tenantId: principalContext.subject.tenantId,
    version: 1,
    status: 'complete',
    capturedAt: '2026-07-23T23:55:00.000Z',
    expiresAt: '2026-07-24T00:30:00.000Z',
    sourceRevision: 'assignment-source-001',
    assignments,
    ...overrides,
  };
}

function entitlementSnapshot(overrides = {}) {
  return {
    contractVersion: 'v1',
    snapshotId: 'entitlement-snapshot-001',
    tenantId: principalContext.subject.tenantId,
    version: 1,
    status: 'complete',
    capturedAt: '2026-07-23T23:55:00.000Z',
    expiresAt: '2026-07-24T00:30:00.000Z',
    sourceRevision: 'entitlement-source-001',
    teamCatalog: [],
    bindings: [
      {
        bindingId: 'binding-global-001',
        bindingVersion: 1,
        state: 'active',
        target: { kind: 'global', key: null },
        modelAllowlist: ['coding-primary'],
        limits: { requestsPerMinute: 80, tokensPerMinute: 80_000 },
        validFrom: '2026-07-23T00:00:00.000Z',
        validUntil: null,
        issuedBy: { kind: 'subject', key: 'user-approver-001' },
        reasonCode: 'approved-policy',
      },
      {
        bindingId: 'binding-subject-001',
        bindingVersion: 1,
        state: 'active',
        target: { kind: 'subject', key: principalContext.subject.subjectId },
        modelAllowlist: ['coding-fast', 'coding-primary'],
        limits: { requestsPerMinute: 120, tokensPerMinute: 120_000 },
        validFrom: '2026-07-23T00:00:00.000Z',
        validUntil: null,
        issuedBy: { kind: 'subject', key: 'user-approver-001' },
        reasonCode: 'approved-policy',
      },
    ],
    ...overrides,
  };
}

function adminAssignment(overrides = {}) {
  return {
    assignmentId: 'assignment-admin-001',
    assignmentVersion: 1,
    state: 'active',
    roleCode: 'governance-admin',
    assignee: { kind: 'subject', key: principalContext.subject.subjectId },
    scope: { kind: 'global', key: null },
    validFrom: '2026-07-23T00:00:00.000Z',
    validUntil: null,
    issuedBy: { kind: 'subject', key: 'user-approver-001' },
    reasonCode: 'approved-access',
    ...overrides,
  };
}

test('server-owned assignments alone grant elevated read scopes while direct policy cannot broaden inherited policy', () => {
  const baseInput = {
    principalContext,
    entitlementSnapshot: entitlementSnapshot(),
    evaluationTime,
  };

  const withoutAssignment = evaluateGovernanceAuthorization({
    ...baseInput,
    assignmentSnapshot: assignmentSnapshot(),
  });
  assert.deepEqual(withoutAssignment.effectiveRoles, ['end-user']);
  // A gateway caller keeps its model entitlement and reads no governance at all.
  assert.deepEqual(withoutAssignment.permittedReadScopes, []);
  assert.deepEqual(withoutAssignment.modelAllowlist, ['coding-primary']);
  assert.deepEqual(withoutAssignment.limits, {
    requestsPerMinute: 80,
    tokensPerMinute: 80_000,
  });

  const withAdminAssignment = evaluateGovernanceAuthorization({
    ...baseInput,
    assignmentSnapshot: assignmentSnapshot([adminAssignment()]),
  });
  assert.deepEqual(withAdminAssignment.effectiveRoles, ['governance-admin']);
  assert.deepEqual(withAdminAssignment.permittedReadScopes, ['self', 'team', 'global']);
  assert.deepEqual(withAdminAssignment.modelAllowlist, ['coding-primary']);
  assert.deepEqual(withAdminAssignment.limits, {
    requestsPerMinute: 80,
    tokensPerMinute: 80_000,
  });
  assert.equal(Object.isFrozen(withAdminAssignment), true);
  assert.equal(Object.isFrozen(withAdminAssignment.appliedAssignments[0]), true);
  assert.deepEqual(withAdminAssignment.appliedAssignments, [
    {
      assignmentId: 'assignment-admin-001',
      assignmentVersion: 1,
      roleCode: 'governance-admin',
      scopeKind: 'global',
      scopeKey: null,
    },
  ]);
  assert.deepEqual(withAdminAssignment.appliedBindings.map((binding) => binding.targetKind), [
    'global',
    'subject',
  ]);
});

test('degraded membership and snapshots return unavailable without authority', async () => {
  const stalePrincipal = JSON.parse(
    await readFile(
      new URL('./fixtures/principal-context/degraded-stale.json', import.meta.url),
      'utf8',
    ),
  );
  const staleMembership = evaluateGovernanceAuthorization({
    principalContext: stalePrincipal,
    assignmentSnapshot: assignmentSnapshot(),
    entitlementSnapshot: entitlementSnapshot(),
    evaluationTime,
  });
  assert.equal(staleMembership.decision, 'unavailable');
  assert.equal(staleMembership.reasonCode, 'membership-evidence-stale');
  assert.deepEqual(staleMembership.effectiveRoles, []);
  assert.deepEqual(staleMembership.permittedReadScopes, []);

  const staleAssignments = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot([], {
      status: 'stale',
      reason: 'control-plane-lag',
    }),
    entitlementSnapshot: entitlementSnapshot(),
    evaluationTime,
  });
  assert.equal(staleAssignments.decision, 'unavailable');
  assert.equal(staleAssignments.reasonCode, 'assignment-snapshot-stale');
  assert.deepEqual(staleAssignments.permittedReadScopes, []);

  const unavailableEntitlements = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot([adminAssignment()]),
    entitlementSnapshot: entitlementSnapshot({
      status: 'source-unavailable',
      reason: 'control-plane-unavailable',
      bindings: [],
    }),
    evaluationTime,
  });
  assert.equal(unavailableEntitlements.decision, 'unavailable');
  assert.equal(unavailableEntitlements.reasonCode, 'entitlement-snapshot-source-unavailable');
  assert.deepEqual(unavailableEntitlements.effectiveRoles, ['governance-admin']);
  assert.deepEqual(unavailableEntitlements.permittedReadScopes, ['self', 'team', 'global']);
  assert.deepEqual(unavailableEntitlements.modelAllowlist, []);

  const unavailableForEndUser = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot(),
    entitlementSnapshot: entitlementSnapshot({
      status: 'source-unavailable',
      reason: 'control-plane-unavailable',
      bindings: [],
    }),
    evaluationTime,
  });
  assert.deepEqual(unavailableForEndUser.effectiveRoles, ['end-user']);
  assert.deepEqual(unavailableForEndUser.permittedReadScopes, []);
});

test('a direct subject grant remains effective when its mapped team has no policy', () => {
  const teamMapping = [
    { teamKey: 'team-alpha', membershipGroupId: 'group-alpha' },
  ];
  const teamRole = {
    assignmentId: 'assignment-team-viewer-001',
    assignmentVersion: 1,
    state: 'active',
    roleCode: 'team-viewer',
    assignee: { kind: 'group', key: 'group-alpha' },
    scope: { kind: 'team', key: 'team-alpha' },
    validFrom: '2026-07-23T00:00:00.000Z',
    validUntil: null,
    issuedBy: { kind: 'system', key: 'system-bootstrap' },
    reasonCode: 'approved-team-access',
  };
  const withoutTeamPolicy = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot([teamRole]),
    entitlementSnapshot: entitlementSnapshot({ teamCatalog: teamMapping }),
    evaluationTime,
  });
  assert.equal(withoutTeamPolicy.decision, 'allow');
  assert.equal(withoutTeamPolicy.reasonCode, 'most-restrictive-policy');
  assert.deepEqual(withoutTeamPolicy.modelAllowlist, ['coding-primary']);
  assert.deepEqual(withoutTeamPolicy.effectiveRoles, ['team-viewer']);
  assert.deepEqual(withoutTeamPolicy.permittedReadScopes, ['self', 'team']);
  assert.deepEqual(withoutTeamPolicy.permittedTeamKeys, ['team-alpha']);

  const membershipOnlySnapshot = entitlementSnapshot({ teamCatalog: teamMapping });
  membershipOnlySnapshot.bindings = membershipOnlySnapshot.bindings.filter(
    (binding) => binding.target.kind === 'global',
  );
  const membershipOnly = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot([teamRole]),
    entitlementSnapshot: membershipOnlySnapshot,
    evaluationTime,
  });
  assert.equal(membershipOnly.decision, 'deny');
  assert.equal(membershipOnly.reasonCode, 'principal-not-entitled');

  const withTeamPolicySnapshot = entitlementSnapshot({ teamCatalog: teamMapping });
  withTeamPolicySnapshot.bindings.push({
    bindingId: 'binding-team-alpha-001',
    bindingVersion: 1,
    state: 'active',
    target: { kind: 'team', key: 'team-alpha' },
    modelAllowlist: ['coding-primary'],
    limits: { requestsPerMinute: 70, tokensPerMinute: 70_000 },
    validFrom: '2026-07-23T00:00:00.000Z',
    validUntil: null,
    issuedBy: { kind: 'subject', key: 'user-approver-001' },
    reasonCode: 'approved-policy',
  });
  const withTeamPolicy = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot([teamRole]),
    entitlementSnapshot: withTeamPolicySnapshot,
    evaluationTime,
  });
  assert.equal(withTeamPolicy.decision, 'allow');
  assert.deepEqual(withTeamPolicy.modelAllowlist, ['coding-primary']);
  assert.deepEqual(withTeamPolicy.limits, {
    requestsPerMinute: 70,
    tokensPerMinute: 70_000,
  });

  const unavailableTeamCatalog = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot([teamRole]),
    entitlementSnapshot: entitlementSnapshot({
      status: 'source-unavailable',
      reason: 'team-catalog-unavailable',
      teamCatalog: [],
      bindings: [],
    }),
    evaluationTime,
  });
  assert.equal(unavailableTeamCatalog.decision, 'unavailable');
  assert.deepEqual(unavailableTeamCatalog.effectiveRoles, []);
  assert.deepEqual(unavailableTeamCatalog.permittedReadScopes, []);
});

test('an authoritative empty model intersection is a denial with no applicable limits', () => {
  const snapshot = entitlementSnapshot();
  snapshot.bindings[1].modelAllowlist = ['coding-fast'];
  const decision = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot(),
    entitlementSnapshot: snapshot,
    evaluationTime,
  });
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reasonCode, 'model-intersection-empty');
  assert.deepEqual(decision.modelAllowlist, []);
  assert.deepEqual(decision.limits, {
    requestsPerMinute: null,
    tokensPerMinute: null,
  });
});

test('invalid assignments and entitlement bindings are rejected before evaluation', () => {
  const cases = [
    {
      name: 'cross-tenant-assignment-snapshot',
      assignment: assignmentSnapshot([], { tenantId: 'tenant-other' }),
      entitlement: entitlementSnapshot(),
    },
    {
      name: 'self-grant',
      assignment: assignmentSnapshot([
        adminAssignment({
          issuedBy: { kind: 'subject', key: principalContext.subject.subjectId },
        }),
      ]),
      entitlement: entitlementSnapshot(),
    },
    {
      name: 'unknown-role',
      assignment: assignmentSnapshot([adminAssignment({ roleCode: 'super-admin' })]),
      entitlement: entitlementSnapshot(),
    },
    {
      name: 'forbidden-authority-field',
      assignment: assignmentSnapshot([
        { ...adminAssignment(), permissions: ['global'] },
      ]),
      entitlement: entitlementSnapshot(),
    },
    {
      name: 'duplicate-target-binding',
      assignment: assignmentSnapshot(),
      entitlement: (() => {
        const snapshot = entitlementSnapshot();
        snapshot.bindings.push({
          ...clone(snapshot.bindings[1]),
          bindingId: 'binding-subject-002',
        });
        return snapshot;
      })(),
    },
    {
      name: 'negative-limit',
      assignment: assignmentSnapshot(),
      entitlement: (() => {
        const snapshot = entitlementSnapshot();
        snapshot.bindings[0].limits.requestsPerMinute = -1;
        return snapshot;
      })(),
    },
    {
      name: 'oversized-limit',
      assignment: assignmentSnapshot(),
      entitlement: (() => {
        const snapshot = entitlementSnapshot();
        snapshot.bindings[0].limits.requestsPerMinute = 1_000_000_001;
        return snapshot;
      })(),
    },
    {
      name: 'active-assignment-expired',
      assignment: assignmentSnapshot([
        adminAssignment({ validUntil: '2026-07-23T23:59:59.000Z' }),
      ]),
      entitlement: entitlementSnapshot(),
    },
    {
      name: 'reversed-validity-window',
      assignment: assignmentSnapshot(),
      entitlement: (() => {
        const snapshot = entitlementSnapshot();
        snapshot.bindings[0].validFrom = '2026-07-25T00:00:00.000Z';
        snapshot.bindings[0].validUntil = '2026-07-24T00:00:00.000Z';
        return snapshot;
      })(),
    },
    {
      name: 'unsorted-assignment-ids',
      assignment: assignmentSnapshot([
        adminAssignment({ assignmentId: 'assignment-z' }),
        adminAssignment({
          assignmentId: 'assignment-a',
          roleCode: 'auditor',
          assignee: { kind: 'group', key: 'group-alpha' },
        }),
      ]),
      entitlement: entitlementSnapshot(),
    },
    {
      name: 'unsorted-model-allowlist',
      assignment: assignmentSnapshot(),
      entitlement: (() => {
        const snapshot = entitlementSnapshot();
        snapshot.bindings[0].modelAllowlist = ['coding-primary', 'coding-fast'];
        return snapshot;
      })(),
    },
    {
      name: 'duplicate-team-group-mapping',
      assignment: assignmentSnapshot(),
      entitlement: entitlementSnapshot({
        teamCatalog: [
          { teamKey: 'team-alpha', membershipGroupId: 'group-alpha' },
          { teamKey: 'team-beta', membershipGroupId: 'group-alpha' },
        ],
      }),
    },
    {
      name: 'unknown-team-binding',
      assignment: assignmentSnapshot(),
      entitlement: (() => {
        const snapshot = entitlementSnapshot();
        snapshot.bindings.push({
          ...clone(snapshot.bindings[1]),
          bindingId: 'binding-team-unknown',
          target: { kind: 'team', key: 'team-unknown' },
        });
        return snapshot;
      })(),
    },
    {
      name: 'application-receives-governance-admin',
      assignment: assignmentSnapshot([
        adminAssignment({
          assignee: { kind: 'application', key: principalContext.application.applicationId },
        }),
      ]),
      entitlement: entitlementSnapshot(),
    },
    {
      name: 'multiple-active-global-bindings',
      assignment: assignmentSnapshot(),
      entitlement: (() => {
        const snapshot = entitlementSnapshot();
        snapshot.bindings.push({
          ...clone(snapshot.bindings[0]),
          bindingId: 'binding-global-002',
        });
        return snapshot;
      })(),
    },
  ];

  for (const candidate of cases) {
    assert.throws(
      () => evaluateGovernanceAuthorization({
        principalContext,
        assignmentSnapshot: candidate.assignment,
        entitlementSnapshot: candidate.entitlement,
        evaluationTime,
      }),
      undefined,
      candidate.name,
    );
  }
});

test('revoked records are retained as evidence but ignored by evaluation', () => {
  const revokedAssignment = adminAssignment({ state: 'revoked' });
  const revokedBindingSnapshot = entitlementSnapshot();
  revokedBindingSnapshot.bindings[1].state = 'revoked';

  const decision = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot([revokedAssignment]),
    entitlementSnapshot: revokedBindingSnapshot,
    evaluationTime,
  });
  assert.deepEqual(decision.effectiveRoles, ['end-user']);
  assert.deepEqual(decision.appliedAssignments, []);
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reasonCode, 'principal-not-entitled');
  assert.deepEqual(decision.modelAllowlist, []);
  assert.deepEqual(decision.appliedBindings, []);
});

test('versioned snapshot fixtures produce the declared effective authorization contract', async () => {
  const assignment = await fixture('valid-assignment-snapshot.json');
  const entitlement = await fixture('valid-entitlement-snapshot.json');
  const expected = await fixture('valid-effective-authorization.json');

  const actual = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignment,
    entitlementSnapshot: entitlement,
    evaluationTime,
  });
  assert.deepEqual(actual, expected);
});

test('workload roles are derived from application assignments without group authority', async () => {
  const workload = JSON.parse(
    await readFile(
      new URL('./fixtures/principal-context/valid-workload-empty-complete.json', import.meta.url),
      'utf8',
    ),
  );
  const applicationAssignment = {
    assignmentId: 'assignment-platform-operator-001',
    assignmentVersion: 1,
    state: 'active',
    roleCode: 'platform-operator',
    assignee: { kind: 'application', key: workload.application.applicationId },
    scope: { kind: 'global', key: null },
    validFrom: '2026-07-23T00:00:00.000Z',
    validUntil: null,
    issuedBy: { kind: 'system', key: 'system-bootstrap' },
    reasonCode: 'approved-operator-access',
  };
  const workloadAssignmentSnapshot = assignmentSnapshot([applicationAssignment]);
  const workloadEntitlementSnapshot = entitlementSnapshot({
    bindings: [
      {
        bindingId: 'binding-global-workload-001',
        bindingVersion: 1,
        state: 'active',
        target: { kind: 'global', key: null },
        modelAllowlist: ['coding-primary'],
        limits: { requestsPerMinute: 40, tokensPerMinute: 40_000 },
        validFrom: '2026-07-23T00:00:00.000Z',
        validUntil: null,
        issuedBy: { kind: 'system', key: 'system-bootstrap' },
        reasonCode: 'approved-policy',
      },
      {
        bindingId: 'binding-workload-application-001',
        bindingVersion: 1,
        state: 'active',
        target: { kind: 'application', key: workload.application.applicationId },
        modelAllowlist: ['coding-primary'],
        limits: { requestsPerMinute: 30, tokensPerMinute: 30_000 },
        validFrom: '2026-07-23T00:00:00.000Z',
        validUntil: null,
        issuedBy: { kind: 'system', key: 'system-bootstrap' },
        reasonCode: 'approved-policy',
      },
    ],
  });
  workloadAssignmentSnapshot.tenantId = workload.subject.tenantId;
  workloadEntitlementSnapshot.tenantId = workload.subject.tenantId;

  const decision = evaluateGovernanceAuthorization({
    principalContext: workload,
    assignmentSnapshot: workloadAssignmentSnapshot,
    entitlementSnapshot: workloadEntitlementSnapshot,
    evaluationTime,
  });
  assert.deepEqual(decision.effectiveRoles, ['platform-operator']);
  assert.deepEqual(decision.permittedReadScopes, ['self', 'team', 'global']);
  assert.deepEqual(decision.modelAllowlist, ['coding-primary']);
  assert.deepEqual(decision.limits, {
    requestsPerMinute: 30,
    tokensPerMinute: 30_000,
  });
});
test('a token quota without its accrual period is refused', () => {
  const snapshot = entitlementSnapshot();
  snapshot.bindings[0].limits = { tokenQuota: 1_000_000 };
  assert.throws(
    () =>
      evaluateGovernanceAuthorization({
        principalContext,
        assignmentSnapshot: assignmentSnapshot([adminAssignment()]),
        entitlementSnapshot: snapshot,
        evaluationTime,
      }),
    /tokenQuota and quotaPeriod together/,
  );
});

test('an accrual period without a token quota is refused', () => {
  const snapshot = entitlementSnapshot();
  snapshot.bindings[0].limits = { quotaPeriod: 'Monthly' };
  assert.throws(
    () =>
      evaluateGovernanceAuthorization({
        principalContext,
        assignmentSnapshot: assignmentSnapshot([adminAssignment()]),
        entitlementSnapshot: snapshot,
        evaluationTime,
      }),
    /tokenQuota and quotaPeriod together/,
  );
});

test('an unsupported accrual period is refused', () => {
  const snapshot = entitlementSnapshot();
  snapshot.bindings[0].limits = { tokenQuota: 1_000_000, quotaPeriod: 'Fortnightly' };
  assert.throws(
    () =>
      evaluateGovernanceAuthorization({
        principalContext,
        assignmentSnapshot: assignmentSnapshot([adminAssignment()]),
        entitlementSnapshot: snapshot,
        evaluationTime,
      }),
    /quotaPeriod is unsupported/,
  );
});

test('a binding carrying both axes is accepted', () => {
  const snapshot = entitlementSnapshot();
  snapshot.bindings[0].limits = {
    requestsPerMinute: 80,
    tokensPerMinute: 80_000,
    tokenQuota: 40_000_000,
    quotaPeriod: 'Monthly',
  };
  const decision = evaluateGovernanceAuthorization({
    principalContext,
    assignmentSnapshot: assignmentSnapshot([adminAssignment()]),
    entitlementSnapshot: snapshot,
    evaluationTime,
  });
  assert.equal(decision.decision, 'allow');
});