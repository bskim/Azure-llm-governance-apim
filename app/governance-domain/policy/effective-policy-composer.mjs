import { assertEffectivePolicyDocument } from './effective-policy-validator.mjs';

/**
 * Composes the single document the gateway reads once per request.
 *
 * The evaluator answers whether a caller may use a model and flattens the rate
 * axis to one number. The gateway instead needs one counter per governed scope,
 * so this module reads the bindings that actually applied and projects them into
 * the hierarchical limit set described in ADR-0002. Nothing here re-decides
 * authorization; it only reshapes a decision that has already been made.
 */

const SCOPE_BY_TARGET_KIND = Object.freeze({
  global: 'organization',
  team: 'team',
  subject: 'subject',
  application: 'application',
});

/** Used only to compare quotas that accrue over different periods. */
const PERIOD_HOURS = Object.freeze({
  Hourly: 1,
  Daily: 24,
  Weekly: 168,
  Monthly: 730,
  Yearly: 8760,
});

const SCOPE_ORDER = Object.freeze(['organization', 'team', 'subject', 'application']);

function fail(message) {
  throw new TypeError(message);
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive integer.`);
  return value;
}

function assertIsoInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return value;
}

/**
 * Two bindings can cap the same scope with different periods, so restrictiveness
 * is compared as an hourly rate. The winning binding keeps its own quota and
 * period rather than being rewritten into a normalized period, because the
 * gateway enforces the period the administrator configured.
 */
function moreRestrictive(candidate, incumbent) {
  if (!incumbent || !Object.hasOwn(incumbent, 'tokenQuota')) return true;
  const candidateRate = candidate.tokenQuota / PERIOD_HOURS[candidate.quotaPeriod];
  const incumbentRate = incumbent.tokenQuota / PERIOD_HOURS[incumbent.quotaPeriod];
  if (candidateRate !== incumbentRate) return candidateRate < incumbentRate;
  return candidate.tokenQuota < incumbent.tokenQuota;
}

/** Counters that cap independently of the quota and of each other. */
const RATE_COUNTERS = Object.freeze(['tokensPerMinute', 'requestsPerMinute']);

function collectLimits(appliedBindings, { teamAttributable = true } = {}) {
  const byScope = new Map();

  for (const binding of appliedBindings) {
    const declaredScope = SCOPE_BY_TARGET_KIND[binding.target.kind];
    const scope = declaredScope === 'team' && !teamAttributable ? 'subject' : declaredScope;
    if (!scope) fail(`Binding target kind '${binding.target.kind}' has no governed scope.`);

    const limits = binding.limits ?? {};
    // Every counter caps on its own axis. Taking the whole limit set from whichever
    // binding won the quota discards the other binding's rate cap, which is how a
    // caller in two groups ends up served at the looser group's rate.
    const entry = byScope.get(scope) ?? { scope, modelScope: 'all-models', quota: null, rates: new Map() };
    for (const counter of RATE_COUNTERS) {
      if (!Object.hasOwn(limits, counter)) continue;
      const held = entry.rates.get(counter);
      if (held === undefined || limits[counter] < held) entry.rates.set(counter, limits[counter]);
    }

    if (Object.hasOwn(limits, 'tokenQuota')) {
      const candidate = { tokenQuota: limits.tokenQuota, quotaPeriod: limits.quotaPeriod };
      if (moreRestrictive(candidate, entry.quota)) entry.quota = candidate;
    }
    byScope.set(scope, entry);
  }

  return SCOPE_ORDER.filter((scope) => {
    const entry = byScope.get(scope);
    return entry && (entry.quota !== null || entry.rates.size > 0);
  }).map((scope) => {
    const entry = byScope.get(scope);
    return {
      scope: entry.scope,
      modelScope: entry.modelScope,
      ...(entry.quota === null ? {} : {
        tokenQuota: entry.quota.tokenQuota,
        quotaPeriod: entry.quota.quotaPeriod,
      }),
      ...Object.fromEntries(entry.rates),
    };
  });
}

/**
 * Folds budget-derived quotas into the entitlement-derived ones.
 *
 * A budget and an entitlement can cap the same scope, and neither is authoritative
 * over the other, so the tighter of the two wins by the same hourly-rate comparison
 * used within each source.
 */
function mergeBudgetLimits(limits, budgetLimits) {
  if (budgetLimits.length === 0) return limits;

  const identityOf = (limit) =>
    [limit.scope, limit.modelScope, limit.modelScope === 'per-model' ? limit.modelKey : 'all'].join('|');
  const byPair = new Map(limits.map((limit) => [identityOf(limit), limit]));
  for (const candidate of budgetLimits) {
    const key = identityOf(candidate);
    const incumbent = byPair.get(key);
    // A budget caps tokens over a period; it says nothing about a per-minute rate.
    // Replacing the whole entry would drop the entitlement's rate caps on the way in.
    if (!moreRestrictive(candidate, incumbent)) continue;
    const rates = Object.fromEntries(
      RATE_COUNTERS.filter((counter) => incumbent !== undefined && Object.hasOwn(incumbent, counter)).map(
        (counter) => [counter, incumbent[counter]],
      ),
    );
    byPair.set(key, { ...candidate, ...rates });
  }

  return SCOPE_ORDER.flatMap((scope) =>
    [...byPair.values()]
      .filter((limit) => limit.scope === scope)
      .sort((left, right) =>
        `${left.modelScope}|${left.modelKey ?? ''}`.localeCompare(`${right.modelScope}|${right.modelKey ?? ''}`),
      ),
  );
}

/**
 * The chain reaching here has already been compiled against this caller's
 * entitlement, so a hop outside the allowlist is a defect in the compiler rather
 * than configuration to repair. Filtering it away here is what previously let an
 * authored cycle be reported as merely disabled, so the same plan was valid or
 * invalid depending on who asked.
 */
function assertCompiledFallback(fallback, allowedModels) {
  if (!fallback || fallback.enabled !== true) {
    return { enabled: false, maxDepth: 1, chain: [] };
  }
  const allowed = new Set(allowedModels);
  const chain = fallback.chain ?? [];
  for (const hop of chain) {
    for (const side of ['from', 'to']) {
      if (!allowed.has(hop[side])) {
        fail(`Compiled fallback hop ${hop.from}->${hop.to} leaves the caller's allowed models.`);
      }
    }
  }
  if (chain.length === 0) return { enabled: false, maxDepth: 1, chain: [] };
  return { enabled: true, maxDepth: fallback.maxDepth ?? 1, chain: [...chain] };
}

function collectModelDeployments(modelRegistrySnapshot, allowedModels) {
  const models = modelRegistrySnapshot !== null && typeof modelRegistrySnapshot === 'object'
      && Array.isArray(modelRegistrySnapshot.models)
    ? modelRegistrySnapshot.models
    : [];
  const byKey = new Map(models.map((model) => [model.modelKey, model]));
  return allowedModels.map((modelKey) => {
    const descriptor = byKey.get(modelKey);
    if (!descriptor || typeof descriptor.providerDeploymentName !== 'string') {
      fail(`Allowed model '${modelKey}' has no provider deployment mapping.`);
    }
    return {
      modelKey,
      providerDeploymentName: descriptor.providerDeploymentName,
    };
  });
}

function baseDocument({ identifiers, configVersion, resolvedAt, expiresAt }) {
  return {
    contractVersion: 'v1',
    documentType: 'effective-policy',
    id: `effective-policy|${identifiers.scopeGroupId}|${identifiers.principalKey}`,
    scopeGroupId: identifiers.scopeGroupId,
    principalKey: identifiers.principalKey,
    configVersion,
    resolvedAt,
    expiresAt,
    attribution: {
      subjectKey: identifiers.subjectKey,
      applicationKey: identifiers.applicationKey,
      teamKey: identifiers.teamKey,
    },
  };
}

export function composeEffectivePolicyDocument({
  authorization,
  entitlementSnapshot,
  modelRegistrySnapshot,
  identifiers,
  fallback,
  warnThresholdPercent,
  budgetLimits = [],
  budgetWarnThresholdPercent = null,
  throttleTiers = [],
  modelPressure = [],
  modelSelectionIntent = 'pinned',
  substitutionNotice = 'header',
  configVersion,
  resolvedAt,
  expiresAt,
}) {
  if (authorization === null || typeof authorization !== 'object') fail('authorization is required.');
  if (entitlementSnapshot === null || typeof entitlementSnapshot !== 'object') {
    fail('entitlementSnapshot is required.');
  }
  if (identifiers === null || typeof identifiers !== 'object') fail('identifiers is required.');

  if (authorization.decision !== 'allow') {
    fail(`Cannot compose a resolved policy from a '${authorization.decision}' decision.`);
  }
  if (identifiers.teamKey !== null && identifiers.teamKey !== identifiers.scopeGroupId) {
    fail('A team-attributed policy must use that team as its scope group.');
  }

  const allowedModels = [...new Set(authorization.modelAllowlist ?? [])].sort();
  if (allowedModels.length === 0) fail('An allowed decision must carry at least one model.');

  const bindingsById = new Map(
    entitlementSnapshot.bindings.map((binding) => [binding.bindingId, binding]),
  );
  const appliedBindings = (authorization.appliedBindings ?? []).map((applied) => {
    const binding = bindingsById.get(applied.bindingId);
    if (!binding) fail(`Applied binding '${applied.bindingId}' is absent from the snapshot.`);
    if (binding.bindingVersion !== applied.bindingVersion) {
      fail(`Applied binding '${applied.bindingId}' changed version during composition.`);
    }
    return binding;
  });

  const limits = mergeBudgetLimits(
    collectLimits(appliedBindings, { teamAttributable: identifiers.teamKey !== null }),
    budgetLimits,
  );
  if (!limits.some((limit) => limit.scope === 'organization')) {
    fail('No organization-wide token quota is configured, so consumption would be uncapped.');
  }

  const document = {
    ...baseDocument({
      identifiers,
      configVersion: assertPositiveInteger(configVersion, 'configVersion'),
      resolvedAt: assertIsoInstant(resolvedAt, 'resolvedAt'),
      expiresAt: assertIsoInstant(expiresAt, 'expiresAt'),
    }),
    resolution: 'resolved',
    allowedModels,
    modelDeployments: collectModelDeployments(modelRegistrySnapshot, allowedModels),
    limits,
    fallback: assertCompiledFallback(fallback, allowedModels),
  };
  // Fallback is triggered by approaching a cap, so an enabled chain without the
  // threshold that arms it would never fire. A budget may supply the signal too, and
  // the earlier of the two wins because it is the more conservative warning.
  const candidates = [warnThresholdPercent, budgetWarnThresholdPercent].filter(
    (value) => value !== undefined && value !== null,
  );
  const effectiveWarn = candidates.length === 0 ? undefined : Math.min(...candidates);
  if (document.fallback.enabled && effectiveWarn === undefined) {
    fail('warnThresholdPercent is required when a fallback chain is enabled.');
  }
  if (effectiveWarn !== undefined) {
    document.warnThresholdPercent = assertPositiveInteger(effectiveWarn, 'warnThresholdPercent');
  }
  if (throttleTiers.length > 0) {
    document.throttleTiers = throttleTiers.map((tier) => ({ ...tier }));
  }
  // How far each model has burned its own budget. A model-scoped budget cannot be read
  // from a gateway counter before the model is chosen, and moving that counter earlier
  // would charge the requested model for a request it did not serve. Only models this
  // caller may reach are carried; the rest are not this caller's business.
  const pressure = modelPressure
    .filter((entry) => allowedModels.includes(entry.model))
    .map((entry) => ({ model: entry.model, consumedBasisPoints: entry.consumedBasisPoints }))
    .sort((left, right) => left.model.localeCompare(right.model));
  if (pressure.length > 0) document.modelPressure = pressure;
  // Emitted only when it permits something, so the document says what the application
  // opted into rather than restating the default in every response.
  if (modelSelectionIntent === 'preferred') {
    document.modelSelectionIntent = 'preferred';
  } else if (modelSelectionIntent !== 'pinned') {
    fail('modelSelectionIntent must be pinned or preferred.');
  }
  if (substitutionNotice === 'inline') {
    if (modelSelectionIntent !== 'preferred') {
      fail('substitutionNotice requires an accepted substitute.');
    }
    document.substitutionNotice = 'inline';
  } else if (substitutionNotice !== 'header') {
    fail('substitutionNotice must be header or inline.');
  }

  assertEffectivePolicyDocument(document);
  return Object.freeze(document);
}
