import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUDGET_EDIT_REASONS,
  addBudget,
  removeBudget,
} from '../../app/governance-domain/policy/budget-edit.mjs';
import {
  FALLBACK_EDIT_REASONS,
  editFallbackPlan,
} from '../../app/governance-domain/policy/fallback-plan-edit.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const AT = '2026-07-24T10:00:00.000Z';

function snapshots() {
  return getDeterministicGovernanceSnapshots();
}

function budget(overrides = {}) {
  return {
    budgetId: 'budget-team-developer-experience-monthly',
    scope: 'team',
    action: 'HARD_BLOCK',
    modelScope: 'all-models',
    accountingBasis: 'apim-estimated-total-tokens',
    limit: { unit: 'tokens', currency: null, amount: 5_000_000 },
    period: 'Monthly',
    thresholds: {},
    ...overrides,
  };
}

test('a new budget takes its place in the order and starts at version one', () => {
  const before = snapshots().budgetSnapshot;
  const next = addBudget({ snapshot: before, budget: budget(), at: AT });

  assert.equal(next.version, before.version + 1);
  assert.equal(next.budgets.length, before.budgets.length + 1);
  assert.deepEqual(
    next.budgets.map((entry) => entry.budgetId),
    [...next.budgets].map((entry) => entry.budgetId).sort(),
  );
  const added = next.budgets.find((entry) => entry.budgetId === budget().budgetId);
  assert.equal(added.budgetVersion, 1);
});

test('a second cap over the same traffic is refused rather than silently stacked', () => {
  const before = snapshots().budgetSnapshot;
  const existing = before.budgets[0];
  assert.throws(
    () => addBudget({
      snapshot: before,
      budget: budget({
        budgetId: 'budget-organization-second',
        scope: existing.scope,
        modelScope: existing.modelScope,
        period: existing.period,
      }),
      at: AT,
    }),
    (error) => error.code === BUDGET_EDIT_REASONS.duplicateCoverage,
  );
});

test('reusing an identifier is refused even when the coverage differs', () => {
  const before = snapshots().budgetSnapshot;
  assert.throws(
    () => addBudget({ snapshot: before, budget: budget({ budgetId: before.budgets[0].budgetId }), at: AT }),
    (error) => error.code === BUDGET_EDIT_REASONS.duplicateBudget,
  );
});

test('a budget the snapshot would refuse never becomes the next version', () => {
  assert.throws(
    () => addBudget({
      snapshot: snapshots().budgetSnapshot,
      // A soft warning carries a grace band; without one the publisher refuses it.
      budget: budget({ action: 'SOFT_WARNING', thresholds: {} }),
      at: AT,
    }),
    (error) => error.code === BUDGET_EDIT_REASONS.resultInvalid,
  );
});

test('removing a cap needs a reason an auditor can group by', () => {
  const before = snapshots().budgetSnapshot;
  assert.throws(
    () => removeBudget({ snapshot: before, budgetId: before.budgets[0].budgetId, reasonCode: 'nope!', at: AT }),
    (error) => error.code === BUDGET_EDIT_REASONS.reasonRequired,
  );

  const next = removeBudget({
    snapshot: before,
    budgetId: before.budgets[0].budgetId,
    reasonCode: 'replaced-by-team-caps',
    at: AT,
  });
  // A cap is a live rule rather than a record of access that existed, so it goes
  // rather than staying as something the publisher must decide about.
  assert.deepEqual(next.budgets, []);
  assert.equal(next.version, before.version + 1);
});

test('removing a budget nobody has is named rather than quietly doing nothing', () => {
  assert.throws(
    () => removeBudget({
      snapshot: snapshots().budgetSnapshot,
      budgetId: 'budget-does-not-exist',
      reasonCode: 'replaced-by-team-caps',
      at: AT,
    }),
    (error) => error.code === BUDGET_EDIT_REASONS.budgetUnknown,
  );
});

test('turning a ladder off is a plan edit, and the plan keeps everything else', () => {
  const before = snapshots().fallbackPolicySnapshot;
  const next = editFallbackPlan({
    snapshot: before,
    planId: before.plans[0].planId,
    changes: { enabled: false },
    at: AT,
  });

  const edited = next.plans[0];
  assert.equal(edited.enabled, false);
  assert.equal(edited.planVersion, before.plans[0].planVersion + 1);
  assert.deepEqual(edited.edges, before.plans[0].edges);
  assert.equal(edited.modelSelectionIntent, before.plans[0].modelSelectionIntent);
  assert.equal(Date.parse(next.expiresAt) - Date.parse(next.capturedAt), 30 * 24 * 60 * 60 * 1000);
});

test('a pinned plan cannot carry an inline substitution notice', () => {
  const before = snapshots().fallbackPolicySnapshot;
  assert.throws(
    () => editFallbackPlan({
      snapshot: before,
      planId: before.plans[0].planId,
      changes: { modelSelectionIntent: 'pinned', substitutionNotice: 'inline' },
      at: AT,
    }),
    (error) => error.code === FALLBACK_EDIT_REASONS.noticeRequiresPreferred,
  );

  // Opting callers in is what makes the notice meaningful, so together they pass.
  const next = editFallbackPlan({
    snapshot: before,
    planId: before.plans[0].planId,
    changes: { modelSelectionIntent: 'preferred', substitutionNotice: 'inline' },
    at: AT,
  });
  assert.equal(next.plans[0].substitutionNotice, 'inline');
});

test('replacing the complete edge set preserves immutable plan fields and canonicalizes order', () => {
  const before = snapshots().fallbackPolicySnapshot;
  const original = before.plans[0];
  const next = editFallbackPlan({
    snapshot: before,
    planId: original.planId,
    changes: {
      edges: [
        { from: 'model-z', to: 'model-y' },
        { from: 'model-a', to: 'model-b' },
      ],
    },
    at: AT,
  });
  const edited = next.plans[0];

  assert.deepEqual(edited.edges, [
    { from: 'model-a', to: 'model-b' },
    { from: 'model-z', to: 'model-y' },
  ]);
  for (const key of ['planId', 'target', 'issuedBy', 'validFrom', 'validUntil', 'reasonCode']) {
    assert.deepEqual(edited[key], original[key], key);
  }
});

test('reordering the same edge set is a semantic no-op', () => {
  const before = structuredClone(snapshots().fallbackPolicySnapshot);
  before.plans[0].edges = [
    { from: 'model-a', to: 'model-b' },
    { from: 'model-z', to: 'model-y' },
  ];
  assert.throws(
    () => editFallbackPlan({
      snapshot: before,
      planId: before.plans[0].planId,
      changes: { edges: [...before.plans[0].edges].reverse() },
      at: AT,
    }),
    (error) => error.code === FALLBACK_EDIT_REASONS.noChange,
  );
});

test('edge replacement reuses the authored graph validator', () => {
  const before = snapshots().fallbackPolicySnapshot;
  const cases = [
    [[{ from: 'model-a', to: 'model-a' }], 'must not point a model at itself'],
    [[{ from: 'model-a', to: 'model-b' }, { from: 'model-a', to: 'model-c' }], 'more than one fallback target'],
    [[{ from: 'model-a', to: 'model-b' }, { from: 'model-b', to: 'model-a' }], 'forms a cycle'],
    [Array.from({ length: 33 }, (_, index) => ({ from: `model-${index}`, to: 'model-target' })), 'at most 32'],
    [[{ from: 'model-a', to: 'model-b', weight: 1 }], 'weight is not allowed'],
  ];
  for (const [edges, detail] of cases) {
    assert.throws(
      () => editFallbackPlan({
        snapshot: before,
        planId: before.plans[0].planId,
        changes: { edges },
        at: AT,
      }),
      (error) =>
        error.code === FALLBACK_EDIT_REASONS.resultInvalid
        && error.detail.includes(detail),
      detail,
    );
  }
});

test('an unknown plan or field is named rather than silently dropped', () => {
  const before = snapshots().fallbackPolicySnapshot;
  assert.throws(
    () => editFallbackPlan({ snapshot: before, planId: 'plan-nope', changes: { enabled: false }, at: AT }),
    (error) => error.code === FALLBACK_EDIT_REASONS.planUnknown,
  );
  assert.throws(
    () => editFallbackPlan({ snapshot: before, planId: before.plans[0].planId, changes: { planId: 'replacement' }, at: AT }),
    (error) => error.code === FALLBACK_EDIT_REASONS.fieldUnknown,
  );
});
