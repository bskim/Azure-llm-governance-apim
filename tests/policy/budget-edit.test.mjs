import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addBudget,
  BUDGET_EDIT_REASONS,
  BudgetEditRefusedError,
  editBudget,
} from '../../app/governance-domain/policy/budget-edit.mjs';
import { AUTHORED_POLICY_RETENTION_SECONDS } from '../../app/governance-domain/lifecycle/authored-policy-retention.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const AT = '2026-07-24T10:00:00.000Z';
const TARGET = 'budget-organization-monthly';

const snapshot = () => getDeterministicGovernanceSnapshots().budgetSnapshot;

const budgetOf = (set, budgetId) => set.budgets.find((budget) => budget.budgetId === budgetId);

function refusal(run) {
  try {
    run();
    assert.fail('the edit was accepted');
  } catch (error) {
    assert.ok(error instanceof BudgetEditRefusedError, `unexpected error: ${error.message}`);
    return error;
  }
}

test('an edited budget produces the next version of the whole snapshot', () => {
  const before = snapshot();
  const after = editBudget({ snapshot: before, budgetId: TARGET, changes: { amount: 30_000_000 }, at: AT });

  assert.equal(after.version, before.version + 1);
  assert.equal(after.capturedAt, AT);
  assert.ok(Date.parse(after.expiresAt) > Date.parse(AT));
  assert.equal(budgetOf(after, TARGET).limit.amount, 30_000_000);
  assert.equal(budgetOf(after, TARGET).budgetVersion, budgetOf(before, TARGET).budgetVersion + 1);
});

// A one-hour default meant one console edit took every caller back to the deployment
// default an hour later, because the published source requires every snapshot
// unexpired. The window is the publisher's liveness, not the policy's age.
test('an edited budget governs for thirty days rather than an hour', () => {
  const after = editBudget({ snapshot: snapshot(), budgetId: TARGET, changes: { amount: 30_000_000 }, at: AT });

  assert.equal(AUTHORED_POLICY_RETENTION_SECONDS, 30 * 24 * 3600);
  assert.equal(
    Date.parse(after.expiresAt) - Date.parse(after.capturedAt),
    AUTHORED_POLICY_RETENTION_SECONDS * 1000,
  );
});

test('a caller that states its own window still gets exactly that window', () => {
  const after = editBudget({
    snapshot: snapshot(),
    budgetId: TARGET,
    changes: { amount: 30_000_000 },
    at: AT,
    retentionSeconds: 3600,
  });

  assert.equal(Date.parse(after.expiresAt) - Date.parse(after.capturedAt), 3_600_000);
});

test('the budgets that were not edited are carried through untouched', () => {
  const before = snapshot();
  const after = editBudget({ snapshot: before, budgetId: TARGET, changes: { amount: 30_000_000 }, at: AT });

  for (const budget of before.budgets.filter((entry) => entry.budgetId !== TARGET)) {
    assert.deepEqual(budgetOf(after, budget.budgetId), budget);
  }
  assert.equal(after.budgets.length, before.budgets.length);
});

test('the edit does not change the snapshot it was given', () => {
  const before = snapshot();
  const originalAmount = budgetOf(before, TARGET).limit.amount;
  editBudget({ snapshot: before, budgetId: TARGET, changes: { amount: 30_000_000 }, at: AT });
  assert.equal(budgetOf(before, TARGET).limit.amount, originalAmount);
});

test('a budget nobody defined is refused rather than created by an edit', () => {
  const error = refusal(() =>
    editBudget({ snapshot: snapshot(), budgetId: 'budget-invented', changes: { amount: 1 }, at: AT }),
  );
  assert.equal(error.code, BUDGET_EDIT_REASONS.budgetUnknown);
});

test('only the fields an operator may change are accepted', () => {
  const error = refusal(() =>
    editBudget({ snapshot: snapshot(), budgetId: TARGET, changes: { scope: 'global' }, at: AT }),
  );
  assert.equal(error.code, BUDGET_EDIT_REASONS.fieldUnknown);
  assert.deepEqual(error.detail, ['scope']);
});

test('an edit that changes nothing is refused rather than published as a version', () => {
  const error = refusal(() => editBudget({ snapshot: snapshot(), budgetId: TARGET, changes: {}, at: AT }));
  assert.equal(error.code, BUDGET_EDIT_REASONS.noChange);
});

test('a semantic no-op is refused after validation regardless of threshold key order', () => {
  const target = budgetOf(snapshot(), TARGET);
  const error = refusal(() =>
    editBudget({
      snapshot: snapshot(),
      budgetId: TARGET,
      changes: {
        amount: target.limit.amount,
        action: target.action,
        thresholds: { graceBasisPoints: target.thresholds.graceBasisPoints },
        modelScope: target.modelScope,
        period: target.period,
        accountingBasis: target.accountingBasis,
      },
      at: AT,
    }),
  );
  assert.equal(error.code, BUDGET_EDIT_REASONS.noChange);

  const throttled = editBudget({
    snapshot: snapshot(),
    budgetId: TARGET,
    changes: {
      action: 'THROTTLE',
      thresholds: {
        tiers: [
          { atBasisPoints: 8000, tierCode: 'tier-reduced' },
          { atBasisPoints: 9000, tierCode: 'tier-minimal' },
        ],
      },
    },
    at: AT,
  });
  assert.equal(
    refusal(() =>
      editBudget({
        snapshot: throttled,
        budgetId: TARGET,
        changes: {
          action: 'THROTTLE',
          thresholds: {
            tiers: [
              { tierCode: 'tier-reduced', atBasisPoints: 8000 },
              { tierCode: 'tier-minimal', atBasisPoints: 9000 },
            ],
          },
        },
        at: AT,
      }),
    ).code,
    BUDGET_EDIT_REASONS.noChange,
  );
});
test('a limit that is not a positive whole amount never reaches the snapshot', () => {
  for (const amount of [0, -1, 1.5, '1000', null]) {
    const error = refusal(() =>
      editBudget({ snapshot: snapshot(), budgetId: TARGET, changes: { amount }, at: AT }),
    );
    assert.equal(error.code, BUDGET_EDIT_REASONS.resultInvalid);
  }
});

test('changing the action without saying what replaces the thresholds is refused', () => {
  // Each action carries a different threshold shape. Carrying the old ones over would
  // publish a hard block wearing a soft warning's grace.
  const error = refusal(() =>
    editBudget({ snapshot: snapshot(), budgetId: TARGET, changes: { action: 'HARD_BLOCK' }, at: AT }),
  );
  assert.equal(error.code, BUDGET_EDIT_REASONS.thresholdsRequired);
  assert.equal(error.detail, 'HARD_BLOCK');

  const accepted = editBudget({
    snapshot: snapshot(),
    budgetId: TARGET,
    changes: { action: 'HARD_BLOCK', thresholds: {} },
    at: AT,
  });
  assert.equal(budgetOf(accepted, TARGET).action, 'HARD_BLOCK');
  assert.deepEqual(budgetOf(accepted, TARGET).thresholds, {});
});

test('thresholds that do not fit the action are refused by the snapshot validator', () => {
  // A hand-written list here would drift from the one the publisher enforces.
  const error = refusal(() =>
    editBudget({
      snapshot: snapshot(),
      budgetId: TARGET,
      changes: { action: 'HARD_BLOCK', thresholds: { graceBasisPoints: 1000 } },
      at: AT,
    }),
  );
  assert.equal(error.code, BUDGET_EDIT_REASONS.resultInvalid);

  const unsupported = refusal(() =>
    editBudget({
      snapshot: snapshot(),
      budgetId: TARGET,
      changes: { action: 'DELETE_EVERYTHING', thresholds: {} },
      at: AT,
    }),
  );
  assert.equal(unsupported.code, BUDGET_EDIT_REASONS.resultInvalid);
});

test('malformed throttle thresholds are refused by the snapshot validator before tier lookup', () => {
  for (const thresholds of [null, { tiers: null }, { tiers: [null] }]) {
    const error = refusal(() =>
      editBudget({
        snapshot: snapshot(),
        budgetId: TARGET,
        changes: { action: 'THROTTLE', thresholds },
        declaredTierCodes: ['tier-reduced', 'tier-minimal'],
        at: AT,
      }),
    );
    assert.equal(error.code, BUDGET_EDIT_REASONS.resultInvalid);
  }
});

test('a complete edit changes action, thresholds, period, model scope, and accounting basis', () => {
  const after = editBudget({
    snapshot: snapshot(),
    budgetId: TARGET,
    changes: {
      action: 'THROTTLE',
      thresholds: { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-reduced' }] },
      period: 'Daily',
      modelScope: 'per-model',
      modelKey: 'coding-primary',
      accountingBasis: 'apim-estimated-total-tokens',
    },
    at: AT,
  });
  const edited = budgetOf(after, TARGET);

  assert.equal(edited.action, 'THROTTLE');
  assert.deepEqual(edited.thresholds, { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-reduced' }] });
  assert.equal(edited.period, 'Daily');
  assert.equal(edited.modelScope, 'per-model');
  assert.equal(edited.modelKey, 'coding-primary');
  assert.equal(edited.accountingBasis, 'apim-estimated-total-tokens');
});

test('an all-models edit clears an old model key and a per-model edit requires one', () => {
  const perModel = editBudget({
    snapshot: snapshot(),
    budgetId: TARGET,
    changes: { modelScope: 'per-model', modelKey: 'coding-primary' },
    at: AT,
  });
  const allModels = editBudget({
    snapshot: perModel,
    budgetId: TARGET,
    changes: { modelScope: 'all-models' },
    at: AT,
  });

  assert.equal(budgetOf(allModels, TARGET).modelScope, 'all-models');
  assert.equal(Object.hasOwn(budgetOf(allModels, TARGET), 'modelKey'), false);
  assert.equal(
    refusal(() =>
      editBudget({
        snapshot: snapshot(),
        budgetId: TARGET,
        changes: { modelScope: 'per-model' },
        at: AT,
      }),
    ).code,
    BUDGET_EDIT_REASONS.resultInvalid,
  );
  assert.equal(
    refusal(() =>
      editBudget({
        snapshot: snapshot(),
        budgetId: TARGET,
        changes: { modelKey: 'coding-primary' },
        at: AT,
      }),
    ).code,
    BUDGET_EDIT_REASONS.resultInvalid,
  );
});

test('an edit cannot collide with another budget counter, including after an action change', () => {
  const existing = budgetOf(snapshot(), TARGET);
  const withThrottle = addBudget({
    snapshot: snapshot(),
    budget: {
      ...existing,
      budgetId: 'budget-organization-throttle',
      action: 'THROTTLE',
      thresholds: { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-reduced' }] },
    },
    at: AT,
  });

  const error = refusal(() =>
    editBudget({
      snapshot: withThrottle,
      budgetId: TARGET,
      changes: {
        action: 'THROTTLE',
        thresholds: { tiers: [{ atBasisPoints: 9000, tierCode: 'tier-minimal' }] },
      },
      at: AT,
    }),
  );
  assert.equal(error.code, BUDGET_EDIT_REASONS.duplicateCoverage);
  assert.equal(error.detail, 'throttle|organization|all-models|');
});

test('a grace outside its own range is refused, and the edge of it is accepted', () => {
  const error = refusal(() =>
    editBudget({ snapshot: snapshot(), budgetId: TARGET, changes: { thresholds: { graceBasisPoints: 0 } }, at: AT }),
  );
  assert.equal(error.code, BUDGET_EDIT_REASONS.resultInvalid);

  const accepted = editBudget({
    snapshot: snapshot(),
    budgetId: TARGET,
    changes: { thresholds: { graceBasisPoints: 10_000 } },
    at: AT,
  });
  assert.equal(budgetOf(accepted, TARGET).thresholds.graceBasisPoints, 10_000);
});

test('adding a quota budget cannot create a second quota counter with another period', () => {
  const existing = budgetOf(snapshot(), TARGET);
  const error = refusal(() =>
    addBudget({
      snapshot: snapshot(),
      budget: {
        ...existing,
        budgetId: 'budget-organization-daily',
        period: 'Daily',
      },
      at: AT,
    }),
  );

  assert.equal(error.code, BUDGET_EDIT_REASONS.duplicateCoverage);
  assert.equal(error.detail, 'quota|organization|all-models|');
});

test('a throttle may share quota coverage because APIM measures it in a separate namespace', () => {
  const existing = budgetOf(snapshot(), TARGET);
  const added = addBudget({
    snapshot: snapshot(),
    budget: {
      ...existing,
      budgetId: 'budget-organization-throttle',
      action: 'THROTTLE',
      thresholds: { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-reduced' }] },
    },
    at: AT,
  });

  assert.equal(added.budgets.length, snapshot().budgets.length + 1);
  assert.equal(budgetOf(added, 'budget-organization-throttle').action, 'THROTTLE');
});
