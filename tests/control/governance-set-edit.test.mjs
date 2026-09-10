import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSIGNMENT_EDIT_REASONS,
  grantAssignment,
  revokeAssignment,
} from '../../app/governance-domain/authorization/assignment-edit.mjs';
import {
  ENTITLEMENT_EDIT_REASONS,
  editEntitlementBinding,
} from '../../app/governance-domain/authorization/entitlement-edit.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const AT = '2026-07-24T10:00:00.000Z';

function snapshots() {
  return getDeterministicGovernanceSnapshots();
}

function editBinding(changes, overrides = {}) {
  const { entitlementSnapshot, modelRegistrySnapshot } = snapshots();
  return editEntitlementBinding({
    snapshot: entitlementSnapshot,
    bindingId: 'binding-global-local-001',
    changes,
    registry: modelRegistrySnapshot,
    at: AT,
    ...overrides,
  });
}

test('a changed allowlist becomes the next version of the whole snapshot', () => {
  const before = snapshots().entitlementSnapshot;
  const next = editBinding({ modelAllowlist: ['coding-fast', 'coding-primary'] });

  assert.equal(next.version, before.version + 1);
  assert.equal(next.capturedAt, AT);
  assert.equal(Date.parse(next.expiresAt) - Date.parse(next.capturedAt), 30 * 24 * 60 * 60 * 1000);
  const binding = next.bindings.find((entry) => entry.bindingId === 'binding-global-local-001');
  assert.deepEqual(binding.modelAllowlist, ['coding-fast', 'coding-primary']);
  assert.equal(binding.bindingVersion, 2);
  // Everything else is carried, not rebuilt: an edit of one binding is not an edit of
  // the others, and a version bump on an untouched binding would claim it changed.
  const untouched = next.bindings.filter((entry) => entry.bindingId !== 'binding-global-local-001');
  assert.deepEqual(untouched, before.bindings.filter((entry) => entry.bindingId !== 'binding-global-local-001'));
});

test('a partial limit change keeps the values it did not mention', () => {
  const before = snapshots().entitlementSnapshot.bindings
    .find((entry) => entry.bindingId === 'binding-global-local-001');
  const next = editBinding({ limits: { requestsPerMinute: 20 } });
  const binding = next.bindings.find((entry) => entry.bindingId === 'binding-global-local-001');

  assert.equal(binding.limits.requestsPerMinute, 20);
  // A quota and its period travel together; dropping one would leave a cap nothing
  // can enforce, and the operator never asked for that.
  assert.equal(binding.limits.tokenQuota, before.limits.tokenQuota);
  assert.equal(binding.limits.quotaPeriod, before.limits.quotaPeriod);
  assert.equal(binding.limits.tokensPerMinute, before.limits.tokensPerMinute);
});

test('an allowlist naming a model nothing serves is refused', () => {
  assert.throws(
    () => editBinding({ modelAllowlist: ['coding-primary', 'coding-imaginary'] }),
    (error) => error.code === ENTITLEMENT_EDIT_REASONS.modelUnregistered
      && error.detail.includes('coding-imaginary'),
  );
});

test('an empty allowlist is refused rather than published as an entitlement to nothing', () => {
  assert.throws(
    () => editBinding({ modelAllowlist: [] }),
    (error) => error.code === ENTITLEMENT_EDIT_REASONS.allowlistEmpty,
  );
});

test('a non-global entitlement can be revoked and safely restored through its existing state contract', () => {
  const { entitlementSnapshot, modelRegistrySnapshot } = snapshots();
  const bindingId = 'binding-application-local-agent-001';
  const revoked = editEntitlementBinding({
    snapshot: entitlementSnapshot,
    bindingId,
    changes: { state: 'revoked' },
    registry: modelRegistrySnapshot,
    at: AT,
  });
  assert.equal(revoked.bindings.find((binding) => binding.bindingId === bindingId).state, 'revoked');

  const restored = editEntitlementBinding({
    snapshot: revoked,
    bindingId,
    changes: { state: 'active' },
    registry: modelRegistrySnapshot,
    at: AT,
  });
  assert.equal(restored.bindings.find((binding) => binding.bindingId === bindingId).state, 'active');
});

test('the required global ceiling cannot be revoked', () => {
  assert.throws(
    () => editBinding({ state: 'revoked' }),
    (error) => error.code === ENTITLEMENT_EDIT_REASONS.resultInvalid,
  );
});

test('an unknown field or limit is named rather than silently dropped', () => {
  assert.throws(
    () => editBinding({ modelAllowlst: ['coding-primary'] }),
    (error) => error.code === ENTITLEMENT_EDIT_REASONS.fieldUnknown,
  );
  assert.throws(
    () => editBinding({ limits: { tokensPerHour: 10 } }),
    (error) => error.code === ENTITLEMENT_EDIT_REASONS.limitUnknown,
  );
});

test('a registry that could not be read must be stated, not omitted', () => {
  assert.throws(
    () => editBinding({ modelAllowlist: ['coding-primary'] }, { registry: undefined }),
    TypeError,
  );
  // Supplied as null, the allowlist is accepted without a catalogue to check it
  // against — the operator was told which of the two happened.
  const next = editBinding({ modelAllowlist: ['coding-imaginary'] }, { registry: null });
  assert.deepEqual(
    next.bindings.find((entry) => entry.bindingId === 'binding-global-local-001').modelAllowlist,
    ['coding-imaginary'],
  );
});

test('a granted role takes its place in the order and carries its own reason', () => {
  const before = snapshots().assignmentSnapshot;
  const next = grantAssignment({
    snapshot: before,
    assignmentId: 'assignment-aaa-team-admin-001',
    roleCode: 'team-admin',
    assignee: { kind: 'group', key: 'group-end-user' },
    scope: { kind: 'team', key: 'developer-experience' },
    issuedBy: { kind: 'subject', key: 'user-local-admin' },
    reasonCode: 'delegated-team-administration',
    at: AT,
  });

  assert.equal(next.assignments.length, before.assignments.length + 1);
  assert.deepEqual(
    next.assignments.map((assignment) => assignment.assignmentId),
    [...next.assignments].map((assignment) => assignment.assignmentId).sort(),
  );
  const granted = next.assignments.find((assignment) => assignment.assignmentId === 'assignment-aaa-team-admin-001');
  assert.equal(granted.state, 'active');
  assert.equal(granted.reasonCode, 'delegated-team-administration');
  assert.equal(granted.validFrom, AT);
  assert.equal(Date.parse(next.expiresAt) - Date.parse(next.capturedAt), 30 * 24 * 60 * 60 * 1000);
});

test('a grant explained in prose is refused, because an audit record needs a code', () => {
  for (const reasonCode of ['Because it was needed, obviously', 'no', '', 'REASON_CODE']) {
    assert.throws(
      () => grantAssignment({
        snapshot: snapshots().assignmentSnapshot,
        assignmentId: 'assignment-aaa-team-admin-001',
        roleCode: 'team-admin',
        assignee: { kind: 'group', key: 'group-end-user' },
        scope: { kind: 'team', key: 'developer-experience' },
        issuedBy: { kind: 'subject', key: 'user-local-admin' },
        reasonCode,
        at: AT,
      }),
      (error) => error.code === ASSIGNMENT_EDIT_REASONS.reasonRequired,
      JSON.stringify(reasonCode),
    );
  }
});

test('the same role granted twice to the same principal is refused as a duplicate', () => {
  assert.throws(
    () => grantAssignment({
      snapshot: snapshots().assignmentSnapshot,
      assignmentId: 'assignment-aaa-duplicate-001',
      roleCode: 'auditor',
      assignee: { kind: 'group', key: 'group-auditor' },
      scope: { kind: 'global', key: null },
      issuedBy: { kind: 'subject', key: 'user-local-admin' },
      reasonCode: 'duplicate-attempt',
      at: AT,
    }),
    (error) => error.code === ASSIGNMENT_EDIT_REASONS.duplicateGrant,
  );
});

test('a revocation keeps the record and the window it was valid for', () => {
  const next = revokeAssignment({
    snapshot: snapshots().assignmentSnapshot,
    assignmentId: 'assignment-auditor-local-001',
    reasonCode: 'left-the-organization',
    at: AT,
  });

  const revoked = next.assignments.find((assignment) => assignment.assignmentId === 'assignment-auditor-local-001');
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.validUntil, AT);
  assert.equal(revoked.assignmentVersion, 2);
  assert.equal(revoked.reasonCode, 'left-the-organization');
  // Removing it would make the trail show access that was never granted.
  assert.equal(next.assignments.length, snapshots().assignmentSnapshot.assignments.length);
});

test('revoking twice is refused rather than recorded as a second revocation', () => {
  const once = revokeAssignment({
    snapshot: snapshots().assignmentSnapshot,
    assignmentId: 'assignment-auditor-local-001',
    reasonCode: 'left-the-organization',
    at: AT,
  });
  assert.throws(
    () => revokeAssignment({
      snapshot: once,
      assignmentId: 'assignment-auditor-local-001',
      reasonCode: 'left-the-organization',
      at: AT,
    }),
    (error) => error.code === ASSIGNMENT_EDIT_REASONS.alreadyRevoked,
  );
});

test('an unknown assignment is named rather than quietly doing nothing', () => {
  assert.throws(
    () => revokeAssignment({
      snapshot: snapshots().assignmentSnapshot,
      assignmentId: 'assignment-does-not-exist',
      reasonCode: 'left-the-organization',
      at: AT,
    }),
    (error) => error.code === ASSIGNMENT_EDIT_REASONS.assignmentUnknown,
  );
});
