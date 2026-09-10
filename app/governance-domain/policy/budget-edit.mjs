import { AUTHORED_POLICY_RETENTION_SECONDS } from '../lifecycle/authored-policy-retention.mjs';
import { isDeepStrictEqual } from 'node:util';
import { assertBudgetSnapshotV1, budgetCounterIdentity } from './budget-publication.mjs';

/**
 * One budget changed, expressed as the whole snapshot.
 *
 * An operator edits one limit, but a snapshot is versioned and validated as a unit, so
 * the edit produces the next version of the set rather than a patch applied somewhere
 * later. What a budget may say is decided by the snapshot's own validator rather than
 * restated here, because a second copy of those rules would drift from the one the
 * publisher enforces.
 */

const EDITABLE = Object.freeze([
  'amount',
  'action',
  'thresholds',
  'modelScope',
  'modelKey',
  'period',
  'accountingBasis',
]);

export const BUDGET_EDIT_REASONS = Object.freeze({
  budgetUnknown: 'budget-edit-target-unknown',
  fieldUnknown: 'budget-edit-field-unknown',
  thresholdsRequired: 'budget-edit-thresholds-required',
  noChange: 'budget-edit-no-change',
  resultInvalid: 'budget-edit-result-invalid',
  duplicateBudget: 'budget-edit-duplicate-budget',
  duplicateCoverage: 'budget-edit-duplicate-coverage',
  reasonRequired: 'budget-edit-reason-required',
});

// Removing a cap loosens governance, so it needs the same kind of stated reason a
// revoked role does. A free-text one would be an audit record nobody can group by.
const REASON_CODE = /^[a-z][a-z0-9-]{2,63}$/;

export class BudgetEditRefusedError extends Error {
  constructor(reasonCode, detail = null) {
    super(`The budget edit was refused: ${reasonCode}.`);
    this.name = 'BudgetEditRefusedError';
    this.code = reasonCode;
    this.detail = detail;
  }
}

function refuse(reasonCode, detail) {
  throw new BudgetEditRefusedError(reasonCode, detail);
}

export function assertDeclaredThrottleTierCodes(budget, declaredTierCodes) {
  if (declaredTierCodes === undefined || budget.action !== 'THROTTLE') return;
  const undeclared = budget.thresholds?.tiers?.find(
    (tier) => !declaredTierCodes.includes(tier.tierCode),
  );
  if (undeclared !== undefined) {
    refuse(BUDGET_EDIT_REASONS.resultInvalid, `throttle tier is not deployed: ${undeclared.tierCode}`);
  }
}

/**
 * @param retentionSeconds - how long the edited snapshot carries authority. A snapshot
 *   that never expires would keep serving after the source that produced it stopped.
 */
export function editBudget({
  snapshot,
  budgetId,
  changes,
  at,
  retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS,
  declaredTierCodes,
}) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new TypeError('changes must be an object.');
  }
  const unknown = Object.keys(changes).filter((key) => !EDITABLE.includes(key));
  if (unknown.length > 0) refuse(BUDGET_EDIT_REASONS.fieldUnknown, unknown);
  if (Object.keys(changes).length === 0) refuse(BUDGET_EDIT_REASONS.noChange);

  const target = snapshot.budgets.find((budget) => budget.budgetId === budgetId);
  if (target === undefined) refuse(BUDGET_EDIT_REASONS.budgetUnknown, budgetId);

  if (Object.hasOwn(changes, 'amount')) {
    if (!Number.isSafeInteger(changes.amount) || changes.amount < 1) {
      refuse(BUDGET_EDIT_REASONS.resultInvalid, 'amount must be a positive whole number.');
    }
  }
  // Each action carries a different threshold shape, so changing the action without
  // saying what replaces them would either publish the old action's thresholds or drop
  // a governance value the operator never mentioned.
  if (Object.hasOwn(changes, 'action') && changes.action !== target.action && !Object.hasOwn(changes, 'thresholds')) {
    refuse(BUDGET_EDIT_REASONS.thresholdsRequired, changes.action);
  }

  const modelScope = Object.hasOwn(changes, 'modelScope') ? changes.modelScope : target.modelScope;
  const modelKey = Object.hasOwn(changes, 'modelKey') ? changes.modelKey : target.modelKey;
  if (modelScope !== 'per-model' && Object.hasOwn(changes, 'modelKey')) {
    refuse(BUDGET_EDIT_REASONS.resultInvalid, 'modelKey is allowed only for a per-model budget.');
  }
  const edited = {
    ...target,
    budgetVersion: target.budgetVersion + 1,
    limit: Object.hasOwn(changes, 'amount') ? { ...target.limit, amount: changes.amount } : target.limit,
    action: Object.hasOwn(changes, 'action') ? changes.action : target.action,
    thresholds: Object.hasOwn(changes, 'thresholds') ? changes.thresholds : target.thresholds,
    modelScope,
    period: Object.hasOwn(changes, 'period') ? changes.period : target.period,
    accountingBasis: Object.hasOwn(changes, 'accountingBasis')
      ? changes.accountingBasis
      : target.accountingBasis,
    // Switching back to all models must not leave a legacy per-model key in the
    // snapshot. The snapshot validator deliberately rejects that ambiguous shape.
    ...(modelScope === 'per-model' ? { modelKey } : {}),
  };
  if (modelScope !== 'per-model') delete edited.modelKey;

  if (
    snapshot.budgets.some(
      (budget) => budget.budgetId !== budgetId && coverageOf(budget) === coverageOf(edited),
    )
  ) {
    refuse(BUDGET_EDIT_REASONS.duplicateCoverage, coverageOf(edited));
  }
  const next = {
    ...snapshot,
    version: snapshot.version + 1,
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + retentionSeconds * 1000).toISOString(),
    budgets: snapshot.budgets.map((budget) => (budget.budgetId === budgetId ? edited : budget)),
  };

  try {
    assertBudgetSnapshotV1(next, { evaluationTime: at });
  } catch (error) {
    refuse(BUDGET_EDIT_REASONS.resultInvalid, error.message);
  }
  assertDeclaredThrottleTierCodes(edited, declaredTierCodes);
  if (isDeepStrictEqual({ ...edited, budgetVersion: target.budgetVersion }, target)) {
    refuse(BUDGET_EDIT_REASONS.noChange);
  }
  return next;
}

function nextSnapshot(snapshot, budgets, at, retentionSeconds, declaredTierCodes) {
  const next = {
    ...snapshot,
    version: snapshot.version + 1,
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + retentionSeconds * 1000).toISOString(),
    // The validator requires the entries sorted and unique by identifier, so a new
    // budget takes its place in the order rather than being appended.
    budgets: [...budgets].sort((left, right) => left.budgetId.localeCompare(right.budgetId)),
  };
  try {
    assertBudgetSnapshotV1(next, { evaluationTime: at });
  } catch (error) {
    refuse(BUDGET_EDIT_REASONS.resultInvalid, error.message);
  }
  for (const budget of budgets) assertDeclaredThrottleTierCodes(budget, declaredTierCodes);
  return next;
}

/** What a budget applies to. Two budgets over the same traffic is an ambiguous cap. */
function coverageOf(budget) {
  return budgetCounterIdentity(budget).replace(/\|all$/, '|');
}

export function addBudget({
  snapshot,
  budget,
  at,
  retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS,
  declaredTierCodes,
}) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
    throw new TypeError('budget must be an object.');
  }
  if (snapshot.budgets.some((entry) => entry.budgetId === budget.budgetId)) {
    refuse(BUDGET_EDIT_REASONS.duplicateBudget, budget.budgetId);
  }
  // Two caps over the same scope, model, and period would both be enforced and the
  // tighter would silently win; which one an operator was editing is then a guess.
  if (snapshot.budgets.some((entry) => coverageOf(entry) === coverageOf(budget))) {
    refuse(BUDGET_EDIT_REASONS.duplicateCoverage, coverageOf(budget));
  }
  return nextSnapshot(
    snapshot,
    [...snapshot.budgets, { ...budget, budgetVersion: 1 }],
    at,
    retentionSeconds,
    declaredTierCodes,
  );
}

/**
 * A removed budget is gone rather than retired in place, because a budget is a live
 * cap rather than a record of access that existed: keeping a revoked one would leave
 * the publisher deciding whether a disabled cap still converts to a quota.
 */
export function removeBudget({ snapshot, budgetId, reasonCode, at, retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS }) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
    refuse(BUDGET_EDIT_REASONS.reasonRequired);
  }
  if (!snapshot.budgets.some((entry) => entry.budgetId === budgetId)) {
    refuse(BUDGET_EDIT_REASONS.budgetUnknown, budgetId);
  }

  return nextSnapshot(
    snapshot,
    snapshot.budgets.filter((entry) => entry.budgetId !== budgetId),
    at,
    retentionSeconds,
  );
}
