import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalGovernanceSource } from '../../app/control-api/local-governance-source.mjs';
import { addTeam } from '../../app/governance-domain/authorization/team-catalog-edit.mjs';
import { editEntitlementBinding } from '../../app/governance-domain/authorization/entitlement-edit.mjs';
import { addBudget } from '../../app/governance-domain/policy/budget-edit.mjs';
import {
  applyGovernanceRemoval,
  GovernanceRemovalRefusedError,
  planGovernanceRemoval,
} from '../../app/governance-domain/removal/governance-removal.mjs';

const AT = '2026-07-24T10:00:00.000Z';

async function snapshots() {
  return structuredClone(
    await createLocalGovernanceSource({ evaluationTime: AT }).readGovernanceSnapshots(),
  );
}

test('team plan includes active, revoked, assignment, and fallback references without directory identifiers', async () => {
  const current = await snapshots();
  current.entitlementSnapshot = editEntitlementBinding({
    snapshot: current.entitlementSnapshot,
    bindingId: 'binding-team-developer-experience-001',
    changes: { state: 'revoked' },
    registry: current.modelRegistrySnapshot,
    at: AT,
  });
  current.assignmentSnapshot.assignments[0].scope = {
    kind: 'team',
    key: 'developer-experience',
  };
  current.fallbackPolicySnapshot.plans[0].target = {
    kind: 'team',
    key: 'developer-experience',
  };

  const plan = planGovernanceRemoval({
    snapshots: current,
    target: { kind: 'team', key: 'developer-experience' },
    reasonCode: 'team-dissolved',
  });

  assert.equal(plan.readModelVersion, 'removal-plan.v1');
  assert.equal(plan.canPropose, true);
  assert.deepEqual(
    plan.references.map(({ kind, state, action }) => ({ kind, state, action })),
    [
      { kind: 'assignment-scope', state: 'active', action: 'remove-assignment' },
      { kind: 'entitlement-binding', state: 'revoked', action: 'remove-binding' },
      { kind: 'fallback-plan', state: 'active', action: 'remove-plan' },
    ],
  );
  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /group-end-user/);
  assert.doesNotMatch(serialized, /user-local-auditor/);

  const next = applyGovernanceRemoval({
    snapshots: current,
    target: plan.target,
    reasonCode: plan.reasonCode,
    planDigest: plan.planDigest,
    selectedReferenceIds: plan.references.map((entry) => entry.referenceId),
    at: AT,
  });
  assert.equal(next.entitlementSnapshot.teamCatalog.some((entry) => entry.teamKey === plan.target.key), false);
  assert.equal(next.entitlementSnapshot.bindings.some((entry) => entry.target.key === plan.target.key), false);
  assert.equal(next.assignmentSnapshot.assignments.some((entry) => entry.scope.key === plan.target.key), false);
  assert.equal(next.fallbackPolicySnapshot.plans.some((entry) => entry.target.key === plan.target.key), false);
  assert.equal(current.entitlementSnapshot.teamCatalog.some((entry) => entry.teamKey === plan.target.key), true);
});

test('model plan covers allowlists, per-model budgets, and every affected fallback edge', async () => {
  const current = await snapshots();
  current.entitlementSnapshot.bindings = current.entitlementSnapshot.bindings.map((binding) => ({
    ...binding,
    modelAllowlist: binding.modelAllowlist.includes('coding-fast')
      ? ['coding-fast', 'coding-primary']
      : binding.modelAllowlist,
  }));
  const budget = {
    ...current.budgetSnapshot.budgets[0],
    budgetId: 'budget-coding-fast',
    budgetVersion: 1,
    modelScope: 'per-model',
    modelKey: 'coding-fast',
  };
  current.budgetSnapshot = addBudget({
    snapshot: current.budgetSnapshot,
    budget,
    at: AT,
  });

  const plan = planGovernanceRemoval({
    snapshots: current,
    target: { kind: 'model', key: 'coding-fast' },
    reasonCode: 'retired-by-provider',
  });
  assert.equal(plan.canPropose, true);
  assert.ok(plan.references.some((entry) => entry.action === 'remove-model-from-allowlist'));
  assert.ok(plan.references.some((entry) => entry.action === 'remove-budget'));
  assert.ok(plan.references.some((entry) => entry.action === 'remove-edge'));

  const next = applyGovernanceRemoval({
    snapshots: current,
    target: plan.target,
    reasonCode: plan.reasonCode,
    planDigest: plan.planDigest,
    selectedReferenceIds: plan.references.map((entry) => entry.referenceId),
    at: AT,
  });
  assert.equal(next.modelRegistrySnapshot.models.some((entry) => entry.modelKey === 'coding-fast'), false);
  assert.equal(next.entitlementSnapshot.bindings.some((entry) => entry.modelAllowlist.includes('coding-fast')), false);
  assert.equal(next.budgetSnapshot.budgets.some((entry) => entry.modelKey === 'coding-fast'), false);
  assert.equal(next.fallbackPolicySnapshot.plans.some(
    (entry) => entry.edges.some((edge) => edge.from === 'coding-fast' || edge.to === 'coding-fast'),
  ), false);
});

test('planning exposes actionable target, last-model, empty-allowlist, and reason blockers', async () => {
  const current = await snapshots();
  const emptyAllowlist = planGovernanceRemoval({
    snapshots: current,
    target: { kind: 'model', key: 'coding-fast' },
    reasonCode: 'not-a-supported-reason',
  });
  assert.deepEqual(
    emptyAllowlist.blockers.map((entry) => entry.reasonCode),
    ['removal-reason-unsupported', 'removal-empty-model-allowlist'],
  );

  current.modelRegistrySnapshot.models = [current.modelRegistrySnapshot.models[0]];
  const last = planGovernanceRemoval({
    snapshots: current,
    target: { kind: 'model', key: current.modelRegistrySnapshot.models[0].modelKey },
    reasonCode: 'retired-by-provider',
  });
  assert.ok(last.blockers.some((entry) => entry.reasonCode === 'removal-last-model'));

  const absent = planGovernanceRemoval({
    snapshots: await snapshots(),
    target: { kind: 'team', key: 'absent-team' },
    reasonCode: 'team-dissolved',
  });
  assert.deepEqual(absent.blockers, [{ reasonCode: 'removal-target-unknown' }]);
});

test('an unreferenced team can be planned and exact acknowledgments are mandatory', async () => {
  const current = await snapshots();
  current.entitlementSnapshot = addTeam({
    snapshot: current.entitlementSnapshot,
    teamKey: 'unreferenced-team',
    membershipGroupId: 'sensitive-group-id',
    at: AT,
  });
  const plan = planGovernanceRemoval({
    snapshots: current,
    target: { kind: 'team', key: 'unreferenced-team' },
    reasonCode: 'team-dissolved',
  });
  assert.equal(plan.canPropose, true);
  assert.deepEqual(plan.references, []);
  assert.doesNotMatch(JSON.stringify(plan), /sensitive-group-id/);

  assert.throws(
    () => applyGovernanceRemoval({
      snapshots: current,
      target: { kind: 'team', key: 'developer-experience' },
      reasonCode: 'team-dissolved',
      planDigest: planGovernanceRemoval({
        snapshots: current,
        target: { kind: 'team', key: 'developer-experience' },
        reasonCode: 'team-dissolved',
      }).planDigest,
      selectedReferenceIds: ['forged-reference'],
      at: AT,
    }),
    (error) => error instanceof GovernanceRemovalRefusedError && error.code === 'removal-selection-incomplete',
  );
});

test('digest binds the target, reason, and complete active snapshot set', async () => {
  const current = await snapshots();
  const input = {
    snapshots: current,
    target: { kind: 'team', key: 'developer-experience' },
    reasonCode: 'team-dissolved',
  };
  const plan = planGovernanceRemoval(input);
  assert.notEqual(plan.planDigest, planGovernanceRemoval({ ...input, reasonCode: 'team-merged' }).planDigest);
  assert.notEqual(
    plan.planDigest,
    planGovernanceRemoval({ ...input, target: { kind: 'team', key: 'platform-engineering' } }).planDigest,
  );
  const changed = structuredClone(current);
  changed.assignmentSnapshot.version += 1;
  assert.notEqual(plan.planDigest, planGovernanceRemoval({ ...input, snapshots: changed }).planDigest);
});
