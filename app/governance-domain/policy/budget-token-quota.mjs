const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL_ALIAS = /^[A-Za-z0-9._-]{1,64}$/;

const SCOPES = new Set(['organization', 'team', 'subject', 'application']);
const ACTIONS = new Set(['HARD_BLOCK', 'SOFT_WARNING', 'THROTTLE']);
const MODEL_SCOPES = new Set(['all-models', 'per-model']);
const PERIODS = new Set(['Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly']);
export const ACCOUNTING_BASIS = 'apim-estimated-total-tokens';

/**
 * What a budget may say, and the quota that follows from it.
 *
 * Budgets are denominated in tokens and nothing converts them. An earlier version
 * accepted a money limit and converted it at the models' published prices, which
 * required this module to pick which model's price to convert at and to state an
 * input/output split; both were assumptions, and the price underneath them is not a
 * single number per model. Tokens are what the gateway meters, so a token limit is
 * enforced as written and what it costs is answered by Azure Billing.
 */

function fail(message) {
  throw new TypeError(message);
}

function assertRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
}

/**
 * Exported because the snapshot validator must apply the same rules. A budget that
 * publishes and then cannot be enforced is a limit nobody applies, and the publisher
 * would have thrown rather than reported it, so the two must not drift apart.
 */
export function assertEnforceableBudget(budget, path = 'budget') {
  assertRecord(budget, path);
  if (typeof budget.budgetId !== 'string' || !SAFE_ID.test(budget.budgetId)) {
    fail(`${path}.budgetId must be a bounded safe identifier.`);
  }
  if (!Number.isSafeInteger(budget.budgetVersion) || budget.budgetVersion < 1) {
    fail(`${path}.budgetVersion must be a positive integer.`);
  }
  if (!SCOPES.has(budget.scope)) fail(`${path}.scope is unsupported.`);
  if (!ACTIONS.has(budget.action)) fail(`${path}.action is unsupported.`);
  if (!MODEL_SCOPES.has(budget.modelScope)) fail(`${path}.modelScope is unsupported.`);
  if (!PERIODS.has(budget.period)) fail(`${path}.period is unsupported.`);
  if (budget.accountingBasis !== ACCOUNTING_BASIS) {
    fail(`${path}.accountingBasis must be ${ACCOUNTING_BASIS}.`);
  }
  if (budget.modelScope === 'per-model' && !MODEL_ALIAS.test(budget.modelKey ?? '')) {
    fail(`${path}.modelKey is required for a per-model budget.`);
  }
  if (budget.modelScope !== 'per-model' && Object.hasOwn(budget, 'modelKey')) {
    fail(`${path}.modelKey is allowed only for a per-model budget.`);
  }
  if (
    budget.modelScope === 'per-model' &&
    (budget.scope === 'subject' || budget.scope === 'application')
  ) {
    fail(`${path} subject/application per-model budgets are not supported by APIM counters.`);
  }

  const limitPath = `${path}.limit`;
  assertRecord(budget.limit, limitPath);
  const { unit, currency, amount } = budget.limit;
  if (unit !== 'tokens') fail(`${limitPath}.unit must be tokens.`);
  if (currency !== null) fail(`${limitPath}.currency must be null for a token budget.`);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    fail(`${limitPath}.amount must be a positive integer.`);
  }
}

function unenforceable(budget, reasonCode) {
  return Object.freeze({
    budgetId: budget.budgetId,
    budgetVersion: budget.budgetVersion,
    scope: budget.scope,
    action: budget.action,
    modelScope: budget.modelScope,
    ...(budget.modelScope === 'per-model' ? { modelKey: budget.modelKey } : {}),
    period: budget.period,
    accountingBasis: budget.accountingBasis,
    configuredLimit: Object.freeze({ ...budget.limit }),
    state: 'unenforceable',
    reasonCode,
    tokenQuota: null,
    derivedAt: null,
  });
}

/** The quota a budget states, which for a token budget is the budget itself. */
export function deriveTokenQuota({ budget, allowedModels, evaluationTime }) {
  assertEnforceableBudget(budget);
  if (!Array.isArray(allowedModels)) throw new TypeError('allowedModels must be an array.');
  if (typeof evaluationTime !== 'string' || Number.isNaN(Date.parse(evaluationTime))) {
    throw new TypeError('evaluationTime must be an ISO-8601 instant.');
  }
  // A budget naming a model nobody may reach limits nothing. It is reported rather
  // than published as a quota, because a limit that cannot bind reads as one that does.
  if (budget.modelScope === 'per-model' && !allowedModels.includes(budget.modelKey)) {
    return unenforceable(budget, 'model-not-entitled');
  }
  if (budget.modelScope === 'all-models' && allowedModels.length === 0) {
    return unenforceable(budget, 'no-entitled-model');
  }
  return Object.freeze({
    budgetId: budget.budgetId,
    budgetVersion: budget.budgetVersion,
    scope: budget.scope,
    action: budget.action,
    modelScope: budget.modelScope,
    ...(budget.modelScope === 'per-model' ? { modelKey: budget.modelKey } : {}),
    period: budget.period,
    accountingBasis: budget.accountingBasis,
    configuredLimit: Object.freeze({ ...budget.limit }),
    state: 'enforceable',
    reasonCode: null,
    tokenQuota: budget.limit.amount,
    derivedAt: evaluationTime,
  });
}
