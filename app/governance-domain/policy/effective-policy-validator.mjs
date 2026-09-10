const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PSEUDONYMOUS_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const SUBJECT_KEY = /^sk[0-9]+-[A-Za-z0-9._-]{16,120}$/;
const APPLICATION_KEY = /^ak[0-9]+-[A-Za-z0-9._-]{16,120}$/;
const CANONICAL_TEAM_KEY = /^[a-z][a-z0-9-]{1,62}$/;
const MODEL_ALIAS = /^[A-Za-z0-9._-]{1,64}$/;
const TIER_CODE = /^[a-z][a-z0-9-]{1,62}$/;
const FORBIDDEN_VALUE = /(https?:\/\/|bearer\s|api-key|sk-[A-Za-z0-9]{8})/i;

const LIMIT_SCOPES = new Set(['organization', 'team', 'subject', 'application']);
const MODEL_SCOPES = new Set(['all-models', 'per-model']);
const BUDGET_ACTIONS = new Set(['HARD_BLOCK', 'SOFT_WARNING']);
const THROTTLE_ACTION = 'THROTTLE';
const ACCOUNTING_BASIS = 'apim-estimated-total-tokens';
const MODEL_SELECTION_INTENTS = new Set(['pinned', 'preferred']);
const SUBSTITUTION_NOTICES = new Set(['header', 'inline']);
const QUOTA_PERIODS = new Set(['Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly']);
const MAX_TOKENS = Number.MAX_SAFE_INTEGER;

function fail(message) {
  throw new TypeError(message);
}

function assertRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
}

function assertExactKeys(value, required, optional, path) {
  assertRecord(value, path);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key} is not allowed.`);
  }
}

function assertTokenCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TOKENS) {
    fail(`${path} must be a positive whole token count.`);
  }
}

function assertInstant(value, path) {
  if (typeof value !== 'string') fail(`${path} must be an ISO-8601 instant.`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(`${path} must be an ISO-8601 instant.`);
  return parsed;
}

function assertNoForbiddenValues(node, path) {
  if (typeof node === 'string') {
    if (FORBIDDEN_VALUE.test(node)) fail(`${path} must not contain a URL or credential value.`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoForbiddenValues(item, `${path}[${index}]`));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      assertNoForbiddenValues(value, `${path}.${key}`);
    }
  }
}

function assertAllowedModels(models) {
  if (!Array.isArray(models) || models.length === 0) {
    fail('allowedModels must be a non-empty array.');
  }
  const seen = new Set();
  let previous = null;
  models.forEach((model, index) => {
    if (typeof model !== 'string' || !MODEL_ALIAS.test(model)) {
      fail(`allowedModels[${index}] must be a bounded model alias.`);
    }
    if (seen.has(model)) fail(`allowedModels[${index}] is a duplicate.`);
    seen.add(model);
    if (previous !== null && model <= previous) {
      fail('allowedModels must be sorted in ascending order.');
    }
    previous = model;
  });
  return seen;
}

function assertModelDeployments(modelDeployments, allowedModels) {
  if (!Array.isArray(modelDeployments) || modelDeployments.length !== allowedModels.size) {
    fail('modelDeployments must map every allowed model exactly once.');
  }
  let previous = null;
  const seen = new Set();
  modelDeployments.forEach((entry, index) => {
    const path = `modelDeployments[${index}]`;
    assertExactKeys(entry, ['modelKey', 'providerDeploymentName'], [], path);
    if (typeof entry.modelKey !== 'string' || !MODEL_ALIAS.test(entry.modelKey)) {
      fail(`${path}.modelKey must be a bounded model alias.`);
    }
    if (typeof entry.providerDeploymentName !== 'string' || !MODEL_ALIAS.test(entry.providerDeploymentName)) {
      fail(`${path}.providerDeploymentName must be a bounded deployment name.`);
    }
    if (!allowedModels.has(entry.modelKey)) fail(`${path}.modelKey is not allowed.`);
    if (seen.has(entry.modelKey)) fail(`${path}.modelKey is duplicated.`);
    if (previous !== null && entry.modelKey <= previous) fail('modelDeployments must be sorted by modelKey.');
    seen.add(entry.modelKey);
    previous = entry.modelKey;
  });
}

function assertLimits(limits) {
  if (!Array.isArray(limits) || limits.length === 0) fail('limits must be a non-empty array.');

  const pairs = new Set();
  limits.forEach((limit, index) => {
    const path = `limits[${index}]`;
    assertExactKeys(
      limit,
      ['scope', 'modelScope'],
      [
        'modelKey',
        'tokenQuota',
        'quotaPeriod',
        'tokensPerMinute',
        'requestsPerMinute',
        'budgetId',
        'budgetVersion',
        'budgetAction',
        'accountingBasis',
        'budgetThresholds',
      ],
      path,
    );
    if (!LIMIT_SCOPES.has(limit.scope)) fail(`${path}.scope is not a known scope.`);
    if (!MODEL_SCOPES.has(limit.modelScope)) fail(`${path}.modelScope is not a known model scope.`);
    if (limit.modelScope === 'per-model' && Object.hasOwn(limit, 'modelKey')) {
      if (typeof limit.modelKey !== 'string' || !MODEL_ALIAS.test(limit.modelKey)) {
        fail(`${path}.modelKey must be a bounded model alias.`);
      }
    } else if (Object.hasOwn(limit, 'modelKey')) {
      fail(`${path}.modelKey is allowed only for a per-model limit.`);
    }
    const hasQuota = Object.hasOwn(limit, 'tokenQuota');
    const hasPeriod = Object.hasOwn(limit, 'quotaPeriod');
    if (hasQuota !== hasPeriod) fail(`${path}.tokenQuota and quotaPeriod must be present together.`);
    if (!hasQuota && !Object.hasOwn(limit, 'tokensPerMinute') && !Object.hasOwn(limit, 'requestsPerMinute')) {
      fail(`${path} must declare at least one quota or rate.`);
    }
    if (hasQuota) {
      if (!QUOTA_PERIODS.has(limit.quotaPeriod)) fail(`${path}.quotaPeriod is not a known period.`);
      assertTokenCount(limit.tokenQuota, `${path}.tokenQuota`);
    }
    if (Object.hasOwn(limit, 'tokensPerMinute')) {
      assertTokenCount(limit.tokensPerMinute, `${path}.tokensPerMinute`);
    }
    if (Object.hasOwn(limit, 'requestsPerMinute')) {
      assertTokenCount(limit.requestsPerMinute, `${path}.requestsPerMinute`);
    }

    const budgetFields = ['budgetId', 'budgetVersion', 'budgetAction', 'accountingBasis', 'budgetThresholds'];
    const carriesBudget = budgetFields.some((field) => Object.hasOwn(limit, field));
    if (carriesBudget) {
      if (budgetFields.some((field) => !Object.hasOwn(limit, field))) {
        fail(`${path} must preserve every budget enforcement field together.`);
      }
      if (limit.modelScope === 'per-model' && !Object.hasOwn(limit, 'modelKey')) {
        fail(`${path}.modelKey is required for a budget-derived per-model limit.`);
      }
      if (typeof limit.budgetId !== 'string' || !SAFE_ID.test(limit.budgetId)) {
        fail(`${path}.budgetId must be a bounded safe identifier.`);
      }
      if (!Number.isSafeInteger(limit.budgetVersion) || limit.budgetVersion < 1) {
        fail(`${path}.budgetVersion must be a positive integer.`);
      }
      if (!BUDGET_ACTIONS.has(limit.budgetAction)) fail(`${path}.budgetAction is unsupported.`);
      if (limit.accountingBasis !== ACCOUNTING_BASIS) {
        fail(`${path}.accountingBasis is unsupported.`);
      }
      assertRecord(limit.budgetThresholds, `${path}.budgetThresholds`);
    }

    const pair = `${limit.scope}|${limit.modelScope}|${limit.modelKey ?? 'all'}`;
    if (pairs.has(pair)) fail(`${path} duplicates the ${pair} limit.`);
    pairs.add(pair);
  });

  // Without an organization-wide cap across all models there is no backstop when a
  // narrower scope is absent.
  const organization = limits.find(
    (limit) => limit.scope === 'organization' && limit.modelScope === 'all-models',
  );
  if (!organization || !Object.hasOwn(organization, 'tokenQuota')) {
    fail('limits must include an organization-wide all-models cap.');
  }
  return pairs;
}

function assertFallback(fallback, allowedModels, resolution) {
  assertExactKeys(fallback, ['enabled', 'maxDepth', 'chain'], [], 'fallback');
  if (typeof fallback.enabled !== 'boolean') fail('fallback.enabled must be a boolean.');
  if (!Number.isSafeInteger(fallback.maxDepth) || fallback.maxDepth < 1 || fallback.maxDepth > 4) {
    fail('fallback.maxDepth must be between 1 and 4.');
  }
  if (!Array.isArray(fallback.chain)) fail('fallback.chain must be an array.');

  if (resolution === 'default' && fallback.enabled) {
    fail('A degraded resolution must not enable fallback.');
  }
  if (!fallback.enabled && fallback.chain.length > 0) {
    fail('fallback.chain must be empty when fallback is disabled.');
  }

  const edges = new Map();
  fallback.chain.forEach((edge, index) => {
    const path = `fallback.chain[${index}]`;
    assertExactKeys(edge, ['from', 'to'], [], path);
    for (const side of ['from', 'to']) {
      if (typeof edge[side] !== 'string' || !MODEL_ALIAS.test(edge[side])) {
        fail(`${path}.${side} must be a bounded model alias.`);
      }
      // Fallback must never widen entitlement.
      if (!allowedModels.has(edge[side])) {
        fail(`${path}.${side} is outside the caller's allowed models.`);
      }
    }
    if (edge.from === edge.to) fail(`${path} must not point a model at itself.`);
    if (edges.has(edge.from)) fail(`${path} gives ${edge.from} more than one fallback target.`);
    edges.set(edge.from, edge.to);
  });

  for (const start of edges.keys()) {
    const visited = new Set([start]);
    let current = start;
    let depth = 0;
    while (edges.has(current)) {
      current = edges.get(current);
      depth += 1;
      if (visited.has(current)) fail(`fallback.chain forms a cycle starting at ${start}.`);
      visited.add(current);
      if (depth > fallback.maxDepth) {
        fail(`fallback.chain from ${start} exceeds maxDepth ${fallback.maxDepth}.`);
      }
    }
  }
}

/**
 * Tiers are declared rather than computed, because the gateway's rate attributes are
 * deployment-time literals until expression support for them is confirmed. The
 * document therefore carries which tier applies at which share of the quota, and the
 * deployment owns what each tier's rate actually is.
 */
function assertThrottleTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length > 64) {
    fail('document.throttleTiers must be an array of at most 64 tiers.');
  }
  const previousByBudget = new Map();
  const codesByBudget = new Map();
  const tierCountByBudget = new Map();
  tiers.forEach((tier, index) => {
    const path = `document.throttleTiers[${index}]`;
    assertExactKeys(
      tier,
      [
        'scope',
        'modelScope',
        'budgetId',
        'budgetVersion',
        'action',
        'quotaPeriod',
        'accountingBasis',
        'againstTokenQuota',
        'atBasisPoints',
        'tierCode',
      ],
      ['modelKey'],
      path,
    );
    if (!LIMIT_SCOPES.has(tier.scope)) fail(`${path}.scope is unsupported.`);
    if (!MODEL_SCOPES.has(tier.modelScope)) fail(`${path}.modelScope is unsupported.`);
    if (tier.modelScope === 'per-model') {
      if (typeof tier.modelKey !== 'string' || !MODEL_ALIAS.test(tier.modelKey)) {
        fail(`${path}.modelKey is required for a per-model throttle.`);
      }
    } else if (Object.hasOwn(tier, 'modelKey')) {
      fail(`${path}.modelKey is allowed only for a per-model throttle.`);
    }
    if (typeof tier.budgetId !== 'string' || !SAFE_ID.test(tier.budgetId)) {
      fail(`${path}.budgetId must be a bounded safe identifier.`);
    }
    if (!Number.isSafeInteger(tier.budgetVersion) || tier.budgetVersion < 1) {
      fail(`${path}.budgetVersion must be a positive integer.`);
    }
    if (tier.action !== THROTTLE_ACTION) fail(`${path}.action must be THROTTLE.`);
    if (!QUOTA_PERIODS.has(tier.quotaPeriod)) fail(`${path}.quotaPeriod is not a known period.`);
    if (tier.accountingBasis !== ACCOUNTING_BASIS) fail(`${path}.accountingBasis is unsupported.`);
    assertTokenCount(tier.againstTokenQuota, `${path}.againstTokenQuota`);
    if (!Number.isSafeInteger(tier.atBasisPoints) || tier.atBasisPoints < 1 || tier.atBasisPoints > 20000) {
      fail(`${path}.atBasisPoints must be between 1 and 20000.`);
    }
    const budgetIdentity = `${tier.scope}|${tier.modelScope}|${tier.modelKey ?? 'all'}|${tier.budgetId}|${tier.budgetVersion}`;
    const previous = previousByBudget.get(budgetIdentity) ?? 0;
    const tierCount = (tierCountByBudget.get(budgetIdentity) ?? 0) + 1;
    if (tierCount > 4) {
      fail(`document.throttleTiers must contain at most four tiers for ${budgetIdentity}.`);
    }
    tierCountByBudget.set(budgetIdentity, tierCount);
    if (tier.atBasisPoints <= previous) {
      fail(`document.throttleTiers must be strictly ascending by atBasisPoints for ${budgetIdentity}.`);
    }
    previousByBudget.set(budgetIdentity, tier.atBasisPoints);
    if (typeof tier.tierCode !== 'string' || !TIER_CODE.test(tier.tierCode)) {
      fail(`${path}.tierCode must be a bounded lower-case tier code.`);
    }
    const codes = codesByBudget.get(budgetIdentity) ?? new Set();
    if (codes.has(tier.tierCode)) {
      fail(`document.throttleTiers repeats ${tier.tierCode} for ${budgetIdentity}.`);
    }
    codes.add(tier.tierCode);
    codesByBudget.set(budgetIdentity, codes);
  });
}

/**
 * How far each model has burned its own budget, as a share of that budget.
 *
 * A model the caller may not reach has no place here: the document is addressed to one
 * caller, and another team's burn rate is not theirs to read.
 */
function assertModelPressure(pressure, allowedModels) {
  if (!Array.isArray(pressure) || pressure.length === 0) {
    fail('document.modelPressure must be a non-empty array when present.');
  }
  const seen = new Set();
  pressure.forEach((entry, index) => {
    const path = `document.modelPressure[${index}]`;
    assertExactKeys(entry, ['model', 'consumedBasisPoints'], [], path);
    if (typeof entry.model !== 'string' || !allowedModels.includes(entry.model)) {
      fail(`${path}.model is not a model this caller may use.`);
    }
    if (seen.has(entry.model)) fail(`document.modelPressure repeats ${entry.model}.`);
    seen.add(entry.model);
    // Above 10000 means the budget is already spent, which is a real state worth
    // carrying; a negative share is not.
    if (
      !Number.isSafeInteger(entry.consumedBasisPoints) ||
      entry.consumedBasisPoints < 0 ||
      entry.consumedBasisPoints > 100000
    ) {
      fail(`${path}.consumedBasisPoints must be between 0 and 100000.`);
    }
  });
}

function assertAttribution(attribution, scopeGroupId) {
  assertExactKeys(attribution, ['subjectKey', 'applicationKey', 'teamKey'], [], 'attribution');
  if (!SUBJECT_KEY.test(attribution.subjectKey ?? '')) {
    fail('attribution.subjectKey must be a versioned subject pseudonym.');
  }
  if (!APPLICATION_KEY.test(attribution.applicationKey ?? '')) {
    fail('attribution.applicationKey must be a versioned application pseudonym.');
  }
  if (attribution.teamKey !== null && !CANONICAL_TEAM_KEY.test(attribution.teamKey ?? '')) {
    fail('attribution.teamKey must be null or a canonical team key.');
  }
  if (attribution.teamKey !== null && attribution.teamKey !== scopeGroupId) {
    fail('attribution.teamKey must match the document scope group.');
  }
  if (attribution.subjectKey === attribution.applicationKey) {
    fail('attribution.subjectKey and attribution.applicationKey must differ.');
  }
}

export function assertEffectivePolicyDocument(document) {
  assertExactKeys(
    document,
    [
      'contractVersion',
      'documentType',
      'id',
      'scopeGroupId',
      'principalKey',
      'configVersion',
      'resolution',
      'resolvedAt',
      'expiresAt',
      'attribution',
      'allowedModels',
      'limits',
      'fallback',
    ],
    ['modelDeployments', 'warnThresholdPercent', 'throttleTiers', 'modelPressure', 'modelSelectionIntent', 'substitutionNotice'],
    'document',
  );

  if (document.contractVersion !== 'v1') fail('document.contractVersion must be v1.');
  if (document.documentType !== 'effective-policy') {
    fail('document.documentType must be effective-policy.');
  }
  if (typeof document.scopeGroupId !== 'string' || !SAFE_ID.test(document.scopeGroupId)) {
    fail('document.scopeGroupId must be a bounded safe identifier.');
  }
  if (typeof document.principalKey !== 'string' || !PSEUDONYMOUS_KEY.test(document.principalKey)) {
    fail('document.principalKey must be a bounded pseudonymous key.');
  }
  if (!Number.isSafeInteger(document.configVersion) || document.configVersion < 1) {
    fail('document.configVersion must be a positive integer.');
  }
  if (document.resolution !== 'resolved' && document.resolution !== 'default') {
    fail('document.resolution must be resolved or default.');
  }

  const expectedId = `effective-policy|${document.scopeGroupId}|${document.principalKey}`;
  if (document.id !== expectedId) {
    fail('document.id must be derived from scopeGroupId and principalKey.');
  }

  const resolvedAt = assertInstant(document.resolvedAt, 'document.resolvedAt');
  const expiresAt = assertInstant(document.expiresAt, 'document.expiresAt');
  if (expiresAt <= resolvedAt) fail('document.expiresAt must be after document.resolvedAt.');

  const allowedModels = assertAllowedModels(document.allowedModels);
  if (document.resolution === 'resolved' && !Object.hasOwn(document, 'modelDeployments')) {
    fail('A resolved document must carry modelDeployments.');
  }
  if (Object.hasOwn(document, 'modelDeployments')) {
    assertModelDeployments(document.modelDeployments, allowedModels);
  }
  assertAttribution(document.attribution, document.scopeGroupId);
  assertLimits(document.limits);
  assertFallback(document.fallback, allowedModels, document.resolution);

  if (document.fallback.enabled && !Object.hasOwn(document, 'warnThresholdPercent')) {
    fail('warnThresholdPercent is required when fallback is enabled.');
  }
  if (Object.hasOwn(document, 'warnThresholdPercent')) {
    const threshold = document.warnThresholdPercent;
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 99) {
      fail('document.warnThresholdPercent must be between 1 and 99.');
    }
  }
  if (Object.hasOwn(document, 'throttleTiers')) {
    assertThrottleTiers(document.throttleTiers);
  }
  if (Object.hasOwn(document, 'modelPressure')) {
    assertModelPressure(document.modelPressure, document.allowedModels);
  }
  if (Object.hasOwn(document, 'modelSelectionIntent')) {
    if (!MODEL_SELECTION_INTENTS.has(document.modelSelectionIntent)) {
      fail('document.modelSelectionIntent must be pinned or preferred.');
    }
    // An omitted intent already means pinned, so a degraded document may omit it but
    // must not assert the opposite: it could not read the entitlement that would
    // justify a substitute.
    if (document.resolution === 'default' && document.modelSelectionIntent !== 'pinned') {
      fail('A degraded resolution must not accept a model substitute.');
    }
  }
  if (Object.hasOwn(document, 'substitutionNotice')) {
    if (!SUBSTITUTION_NOTICES.has(document.substitutionNotice)) {
      fail('document.substitutionNotice must be header or inline.');
    }
    // Announcing a substitution that cannot happen would put a promise in the document
    // that nothing keeps.
    if (document.modelSelectionIntent !== 'preferred') {
      fail('document.substitutionNotice requires an accepted substitute.');
    }
  }

  assertNoForbiddenValues(document, 'document');
  return true;
}

export function isEffectivePolicyDocumentValid(document) {
  try {
    assertEffectivePolicyDocument(document);
    return true;
  } catch {
    return false;
  }
}
