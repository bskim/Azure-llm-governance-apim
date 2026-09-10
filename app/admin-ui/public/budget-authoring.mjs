export const BUDGET_SCOPES = Object.freeze(['organization', 'team', 'subject', 'application']);
export const BUDGET_ACTIONS = Object.freeze(['HARD_BLOCK', 'SOFT_WARNING', 'THROTTLE']);
export const BUDGET_MODEL_SCOPES = Object.freeze(['all-models', 'per-model']);
export const BUDGET_PERIODS = Object.freeze(['Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly']);

function integer(value) {
  const parsed = Number(String(value).trim().replaceAll(',', ''));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function invalid(error, field) {
  return { ok: false, error, field };
}

function thresholdsOf(values, throttleTierCodes) {
  if (values.action === 'HARD_BLOCK') {
    if (String(values.warnAtBasisPoints ?? '').trim() === '') return { ok: true, value: {} };
    const warning = integer(values.warnAtBasisPoints);
    return warning !== null && warning >= 1 && warning <= 9_999
      ? { ok: true, value: { warnAtBasisPoints: warning } }
      : invalid('hardWarning', 'warnAtBasisPoints');
  }
  if (values.action === 'SOFT_WARNING') {
    const grace = integer(values.graceBasisPoints);
    return grace !== null && grace >= 1 && grace <= 10_000
      ? { ok: true, value: { graceBasisPoints: grace } }
      : invalid('softGrace', 'graceBasisPoints');
  }

  if (!Array.isArray(throttleTierCodes) || throttleTierCodes.length === 0) {
    return invalid('throttleUnavailable', 'tiers');
  }
  const tiers = (values.tiers ?? [])
    .filter((tier) => String(tier.atBasisPoints ?? '').trim() || String(tier.tierCode ?? '').trim())
    .map((tier) => ({
      atBasisPoints: integer(tier.atBasisPoints),
      tierCode: String(tier.tierCode ?? '').trim(),
    }));
  const maximum = Math.min(4, throttleTierCodes.length);
  if (tiers.length < 1 || tiers.length > maximum) return invalid('throttleTiers', 'tiers');
  let previous = 0;
  const codes = new Set();
  for (const tier of tiers) {
    if (tier.atBasisPoints === null || tier.atBasisPoints < 1 || tier.atBasisPoints > 20_000
      || tier.atBasisPoints <= previous) return invalid('throttleAscending', 'tiers');
    if (!throttleTierCodes.includes(tier.tierCode) || codes.has(tier.tierCode)) {
      return invalid('throttleCode', 'tiers');
    }
    previous = tier.atBasisPoints;
    codes.add(tier.tierCode);
  }
  return { ok: true, value: { tiers } };
}

function commonBudget(values, options) {
  const models = options?.models ?? [];
  const amount = integer(values.amount);
  if (amount === null || amount < 1) return invalid('amount', 'amount');
  if (!BUDGET_ACTIONS.includes(values.action)) return invalid('action', 'action');
  if (!BUDGET_MODEL_SCOPES.includes(values.modelScope)) return invalid('modelScope', 'modelScope');
  if (!BUDGET_PERIODS.includes(values.period)) return invalid('period', 'period');
  if (values.modelScope === 'per-model' && !models.includes(values.modelKey)) {
    return invalid('modelKey', 'modelKey');
  }
  const thresholds = thresholdsOf(values, options?.throttleTierCodes);
  if (!thresholds.ok) return thresholds;
  const budget = {
    action: values.action,
    modelScope: values.modelScope,
    accountingBasis: 'apim-estimated-total-tokens',
    limit: { unit: 'tokens', currency: null, amount },
    period: values.period,
    thresholds: thresholds.value,
  };
  if (values.modelScope === 'per-model') budget.modelKey = values.modelKey;
  return { ok: true, budget };
}

export function buildBudgetAddPayload(values, options, budgetId) {
  if (!BUDGET_SCOPES.includes(values.scope)) return invalid('scope', 'scope');
  if (values.modelScope === 'per-model' && !['organization', 'team'].includes(values.scope)) {
    return invalid('perModelScope', 'modelScope');
  }
  const result = commonBudget(values, options);
  if (!result.ok) return result;
  return {
    ok: true,
    payload: { command: 'add', budget: { budgetId, scope: values.scope, ...result.budget } },
  };
}

function editableChanges(budget) {
  const { limit, accountingBasis: _accountingBasis, ...changes } = budget;
  return { amount: limit.amount, ...changes };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function recordChanges(record) {
  return {
    amount: record.configuredLimit.amount,
    action: record.action,
    modelScope: record.modelScope,
    ...(record.modelScope === 'per-model' ? { modelKey: record.modelKey } : {}),
    period: record.period,
    thresholds: record.thresholds,
  };
}

export function buildBudgetEditPayload(record, values, options) {
  if (values.modelScope === 'per-model' && !['organization', 'team'].includes(record.scopeKind)) {
    return invalid('perModelScope', 'modelScope');
  }
  const result = commonBudget(values, options);
  if (!result.ok) return result;
  const changes = editableChanges(result.budget);
  if (canonicalJson(changes) === canonicalJson(recordChanges(record))) {
    return invalid('noChange', 'amount');
  }
  return {
    ok: true,
    payload: {
      command: 'edit',
      budgetId: record.budgetCode,
      changes,
    },
  };
}
