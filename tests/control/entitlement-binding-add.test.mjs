import test from 'node:test';
import assert from 'node:assert/strict';

import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import {
  addEntitlementBinding,
  ENTITLEMENT_EDIT_REASONS,
  EntitlementEditRefusedError,
} from '../../app/governance-domain/authorization/entitlement-edit.mjs';

const AT = '2026-07-24T10:00:00.000Z';
const ISSUER = Object.freeze({ kind: 'subject', key: 'user-local-admin' });

function snapshots() {
  return getDeterministicGovernanceSnapshots();
}

function add(overrides = {}) {
  const { entitlementSnapshot, modelRegistrySnapshot } = snapshots();
  return addEntitlementBinding({
    snapshot: entitlementSnapshot,
    registry: modelRegistrySnapshot,
    bindingId: 'binding-subject-new-hire-001',
    target: { kind: 'subject', key: 'user-new-hire' },
    modelAllowlist: ['coding-fast'],
    issuedBy: ISSUER,
    reasonCode: 'individual-allowance',
    at: AT,
    ...overrides,
  });
}

function refusal(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof EntitlementEditRefusedError, `expected a refusal, got ${error.name}`);
    return error;
  }
  assert.fail('the edit was accepted when it should have been refused');
}

test('a subject with no team can be brought under governance on their own', () => {
  const before = snapshots().entitlementSnapshot;
  const next = add();
  const created = next.bindings.find((binding) => binding.bindingId === 'binding-subject-new-hire-001');

  assert.equal(created.target.kind, 'subject');
  assert.equal(created.target.key, 'user-new-hire');
  assert.equal(created.state, 'active');
  assert.equal(created.bindingVersion, 1);
  assert.equal(created.validUntil, null);
  assert.equal(next.version, before.version + 1);
  // Nothing about the team catalogue moved: this governs a person, not a team.
  assert.deepEqual(next.teamCatalog, before.teamCatalog);
});

test('bindings stay sorted by identifier, because the snapshot validator requires it', () => {
  const next = add({ bindingId: 'binding-aaa-first-001' });
  const ids = next.bindings.map((binding) => binding.bindingId);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(ids[0], 'binding-aaa-first-001');
});

test('the allowlist is sorted rather than left in the order it was typed', () => {
  const next = add({ modelAllowlist: ['coding-primary', 'coding-fast'] });
  const created = next.bindings.find((binding) => binding.bindingId === 'binding-subject-new-hire-001');
  assert.deepEqual(created.modelAllowlist, ['coding-fast', 'coding-primary']);
});

test('a target that already has a binding is refused, naming the one that governs it', () => {
  const error = refusal(() => add({ target: { kind: 'subject', key: 'user-local-admin' } }));
  assert.equal(error.code, ENTITLEMENT_EDIT_REASONS.targetGoverned);
  assert.equal(error.detail, 'binding-subject-local-admin-001');
});

test('a second organization-wide binding is not something this can express', () => {
  const error = refusal(() => add({ target: { kind: 'global', key: null } }));
  assert.equal(error.code, ENTITLEMENT_EDIT_REASONS.targetKindUnsupported);
});

test('a team the catalogue does not name is refused before the snapshot is rebuilt', () => {
  const error = refusal(() => add({
    bindingId: 'binding-team-unknown-001',
    target: { kind: 'team', key: 'no-such-team' },
  }));
  assert.equal(error.code, ENTITLEMENT_EDIT_REASONS.teamUnknown);
});

test('an administrator cannot grant an entitlement to themselves', () => {
  // The issuer must be somebody with no binding yet, or "already governed" answers
  // first and this rule is never reached.
  const error = refusal(() => add({
    issuedBy: { kind: 'subject', key: 'user-new-hire' },
    target: { kind: 'subject', key: 'user-new-hire' },
  }));
  assert.equal(error.code, ENTITLEMENT_EDIT_REASONS.selfIssued);
});

test('a model the catalogue does not carry is refused, naming the models', () => {
  const error = refusal(() => add({ modelAllowlist: ['coding-fast', 'no-such-model'] }));
  assert.equal(error.code, ENTITLEMENT_EDIT_REASONS.modelUnregistered);
  assert.deepEqual(error.detail, ['no-such-model']);
});

test('an empty allowlist is refused, because entitling nobody is a retirement', () => {
  assert.equal(refusal(() => add({ modelAllowlist: [] })).code, ENTITLEMENT_EDIT_REASONS.allowlistEmpty);
});

test('an unknown limit key is refused rather than silently dropped', () => {
  const error = refusal(() => add({ limits: { tokensPerHour: 10 } }));
  assert.equal(error.code, ENTITLEMENT_EDIT_REASONS.limitUnknown);
  assert.deepEqual(error.detail, ['tokensPerHour']);
});

test('a reason is required, as a code rather than typed prose', () => {
  for (const reasonCode of [undefined, '', 'Individual Allowance', 'because they asked nicely for it']) {
    assert.equal(refusal(() => add({ reasonCode })).code, ENTITLEMENT_EDIT_REASONS.reasonRequired);
  }
});

test('an issuer the server did not supply throws rather than defaulting to somebody', () => {
  assert.throws(
    () => add({ issuedBy: undefined }),
    /issuedBy must be supplied by the server/,
  );
});

test('a quota without its period is refused by the snapshot validator, as a refusal', () => {
  const error = refusal(() => add({ limits: { tokenQuota: 1000 } }));
  assert.equal(error.code, ENTITLEMENT_EDIT_REASONS.resultInvalid);
});
