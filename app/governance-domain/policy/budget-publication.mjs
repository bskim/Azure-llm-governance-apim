import { assertEnforceableBudget, deriveTokenQuota } from './budget-token-quota.mjs';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TIER_CODE = /^[a-z][a-z0-9-]{1,62}$/;

const SNAPSHOT_STATUSES = new Set([
  'complete',
  'incomplete',
  'stale',
  'ambiguous',
  'source-unavailable',
]);
const SCOPE_ORDER = Object.freeze(['organization', 'team', 'subject', 'application']);

const MAX_BUDGETS = 16;
const MAX_TIERS = 4;
const BASIS_POINTS_FULL = 10_000;
const MAX_TOKEN_QUOTA = BigInt(Number.MAX_SAFE_INTEGER);
const BASIS_POINTS_FULL_BIGINT = BigInt(BASIS_POINTS_FULL);
const PERCENT_FULL_BIGINT = 100n;

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

function assertSafeId(value, path) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail(`${path} must be a bounded safe identifier.`);
  }
}

function assertBasisPoints(value, path, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${path} must be a whole number of basis points between ${min} and ${max}.`);
  }
}

function parseTime(value, path) {
  if (typeof value !== 'string') fail(`${path} must be an RFC 3339 timestamp.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${path} must be an RFC 3339 timestamp.`);
  return timestamp;
}

function assertSortedUnique(values, path) {
  if (new Set(values).size !== values.length) fail(`${path} contains duplicate entries.`);
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  if (values.some((value, index) => value !== sorted[index])) fail(`${path} must be sorted.`);
}

function assertThresholds(action, thresholds, path) {
  switch (action) {
    case 'HARD_BLOCK':
      // A hard block with a grace is a soft warning wearing the wrong name.
      assertExactKeys(thresholds, [], ['warnAtBasisPoints'], path);
      if (Object.hasOwn(thresholds, 'warnAtBasisPoints')) {
        assertBasisPoints(thresholds.warnAtBasisPoints, `${path}.warnAtBasisPoints`, {
          min: 1,
          max: BASIS_POINTS_FULL - 1,
        });
      }
      return;
    case 'SOFT_WARNING':
      assertExactKeys(thresholds, ['graceBasisPoints'], [], path);
      assertBasisPoints(thresholds.graceBasisPoints, `${path}.graceBasisPoints`, {
        min: 1,
        max: BASIS_POINTS_FULL,
      });
      return;
    case 'THROTTLE': {
      assertExactKeys(thresholds, ['tiers'], [], path);
      const { tiers } = thresholds;
      if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > MAX_TIERS) {
        fail(`${path}.tiers must declare between 1 and ${MAX_TIERS} entries.`);
      }
      let previous = 0;
      const codes = new Set();
      tiers.forEach((tier, index) => {
        const tierPath = `${path}.tiers[${index}]`;
        assertExactKeys(tier, ['atBasisPoints', 'tierCode'], [], tierPath);
        assertBasisPoints(tier.atBasisPoints, `${tierPath}.atBasisPoints`, {
          min: 1,
          max: 2 * BASIS_POINTS_FULL,
        });
        if (tier.atBasisPoints <= previous) {
          fail(`${path}.tiers must be strictly ascending by atBasisPoints.`);
        }
        previous = tier.atBasisPoints;
        if (typeof tier.tierCode !== 'string' || !TIER_CODE.test(tier.tierCode)) {
          fail(`${tierPath}.tierCode must be a bounded lower-case tier code.`);
        }
        if (codes.has(tier.tierCode)) fail(`${path} repeats tierCode ${tier.tierCode}.`);
        codes.add(tier.tierCode);
      });
      return;
    }
    default:
      fail(`${path} has no threshold shape for action ${action}.`);
  }
}

function assertBudget(entry, path) {
  assertExactKeys(
    entry,
    ['budgetId', 'budgetVersion', 'scope', 'action', 'modelScope', 'accountingBasis', 'limit', 'period', 'thresholds'],
    ['modelKey'],
    path,
  );
  // Everything the quota derivation needs is asserted by the derivation itself.
  // Restating those rules here is what let a snapshot publish a unit it refuses.
  assertEnforceableBudget(entry, path);
  assertThresholds(entry.action, entry.thresholds, `${path}.thresholds`);
}

export function apimCounterNamespace(budget) {
  return budget.action === 'THROTTLE' ? 'throttle' : 'quota';
}

export function budgetCounterIdentity(budget) {
  return [
    apimCounterNamespace(budget),
    budget.scope,
    budget.modelScope,
    budget.modelScope === 'per-model' ? budget.modelKey : 'all',
  ].join('|');
}

/**
 * Gives a persisted pre-accounting v1 token budget its sole historical meaning.
 *
 * This is intentionally a read migration rather than a relaxation of authoring:
 * new snapshots must state their accounting basis, while old token-only records can
 * only have meant APIM's estimated total-token counter.
 */
export class LegacyBudgetMigrationRequiredError extends TypeError {
  constructor({ persistedSnapshot, migrationRequirements }) {
    super('Persisted legacy budgets require review before they can be enforced.');
    this.name = 'LegacyBudgetMigrationRequiredError';
    this.code = 'legacy-budget-migration-required';
    this.persistedSnapshot = persistedSnapshot;
    this.migrationRequirements = Object.freeze(migrationRequirements);
  }
}

function legacyMigrationRequirement(budget, index) {
  const prefix = `budgetSnapshot.budgets[${index}]`;
  if (budget.limit?.amount === 0) {
    return { legacyShape: 'zero-token-limit', path: `${prefix}.limit.amount` };
  }
  if (
    budget.modelScope === 'per-model' &&
    (budget.scope === 'subject' || budget.scope === 'application')
  ) {
    return { legacyShape: `${budget.scope}-per-model`, path: prefix };
  }
  if (budget.modelScope === 'all-models' && Object.hasOwn(budget, 'modelKey')) {
    return { legacyShape: 'all-models-with-model-key', path: `${prefix}.modelKey` };
  }
  if (budget.modelScope === 'per-model' && !Object.hasOwn(budget, 'modelKey')) {
    return { legacyShape: 'per-model-without-model-key', path: `${prefix}.modelKey` };
  }
  return null;
}

export function upgradeLegacyBudgetSnapshotV1(snapshot) {
  assertRecord(snapshot, 'budgetSnapshot');
  if (!Array.isArray(snapshot.budgets)) return snapshot;

  const migrationRequirements = [];
  let changed = false;
  const budgets = snapshot.budgets.map((budget, index) => {
    if (
      budget !== null &&
      typeof budget === 'object' &&
      !Array.isArray(budget) &&
      !Object.hasOwn(budget, 'accountingBasis') &&
      budget.limit?.unit === 'tokens' &&
      budget.limit?.currency === null
    ) {
      const requirement = legacyMigrationRequirement(budget, index);
      if (requirement !== null) {
        migrationRequirements.push(Object.freeze(requirement));
        return budget;
      }
      changed = true;
      return { ...budget, accountingBasis: 'apim-estimated-total-tokens' };
    }
    return budget;
  });
  if (migrationRequirements.length > 0) {
    throw new LegacyBudgetMigrationRequiredError({
      persistedSnapshot: snapshot,
      migrationRequirements,
    });
  }
  const counterIdentities = new Map();
  for (const [index, budget] of budgets.entries()) {
    if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) continue;
    const identity = budgetCounterIdentity(budget);
    if (counterIdentities.has(identity)) {
      migrationRequirements.push(Object.freeze({
        legacyShape: `duplicate-${apimCounterNamespace(budget)}-counter`,
        path: `budgetSnapshot.budgets[${index}]`,
      }));
    } else {
      counterIdentities.set(identity, index);
    }
  }
  if (migrationRequirements.length > 0) {
    throw new LegacyBudgetMigrationRequiredError({
      persistedSnapshot: snapshot,
      migrationRequirements,
    });
  }
  return changed ? { ...snapshot, budgets } : snapshot;
}

export function assertBudgetSnapshotV1(snapshot, { evaluationTime, principalTenantId } = {}) {
  assertExactKeys(
    snapshot,
    [
      'contractVersion',
      'snapshotId',
      'tenantId',
      'version',
      'status',
      'capturedAt',
      'expiresAt',
      'sourceRevision',
      'budgets',
    ],
    ['reason'],
    'budgetSnapshot',
  );

  if (snapshot.contractVersion !== 'v1') fail('budgetSnapshot.contractVersion must be v1.');
  for (const key of ['snapshotId', 'tenantId', 'sourceRevision']) {
    assertSafeId(snapshot[key], `budgetSnapshot.${key}`);
  }
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
    fail('budgetSnapshot.version must be a positive integer.');
  }
  if (!SNAPSHOT_STATUSES.has(snapshot.status)) fail('budgetSnapshot.status is unsupported.');

  const capturedAt = parseTime(snapshot.capturedAt, 'budgetSnapshot.capturedAt');
  const expiresAt = parseTime(snapshot.expiresAt, 'budgetSnapshot.expiresAt');
  const now = parseTime(evaluationTime, 'evaluationTime');
  if (capturedAt > now) throw new RangeError('budgetSnapshot cannot be captured in the future.');
  if (capturedAt >= expiresAt) throw new RangeError('budgetSnapshot capture must precede expiry.');
  if (expiresAt <= now) throw new RangeError('budgetSnapshot has expired and carries no authority.');

  if (typeof principalTenantId === 'string' && snapshot.tenantId !== principalTenantId) {
    fail('budgetSnapshot.tenantId does not match the calling tenant.');
  }

  if (!Array.isArray(snapshot.budgets)) fail('budgetSnapshot.budgets must be an array.');
  if (snapshot.budgets.length > MAX_BUDGETS) {
    fail(`budgetSnapshot.budgets exceeds ${MAX_BUDGETS} entries.`);
  }

  if (snapshot.status !== 'complete') {
    if (typeof snapshot.reason !== 'string' || snapshot.reason.length === 0) {
      fail('budgetSnapshot degraded status requires a reason.');
    }
    if (snapshot.budgets.length !== 0) {
      fail('budgetSnapshot degraded status cannot carry budget records.');
    }
  }

  snapshot.budgets.forEach((entry, index) =>
    assertBudget(entry, `budgetSnapshot.budgets[${index}]`),
  );
  const counterIdentities = new Set();
  snapshot.budgets.forEach((entry, index) => {
    const identity = budgetCounterIdentity(entry);
    if (counterIdentities.has(identity)) {
      fail(`budgetSnapshot.budgets[${index}] duplicates APIM counter identity ${identity}.`);
    }
    counterIdentities.add(identity);
  });
  assertSortedUnique(
    snapshot.budgets.map((entry) => entry.budgetId),
    'budgetSnapshot.budgets',
  );

  return Object.freeze({
    ...snapshot,
    budgets: Object.freeze(
      snapshot.budgets.map((entry) =>
        Object.freeze({
          ...entry,
          limit: Object.freeze({ ...entry.limit }),
          thresholds: Object.freeze({
            ...entry.thresholds,
            ...(entry.action === 'THROTTLE'
              ? { tiers: Object.freeze(entry.thresholds.tiers.map((tier) => Object.freeze({ ...tier }))) }
              : {}),
          }),
        }),
      ),
    ),
  });
}

function unavailable(reasonCode) {
  return Object.freeze({
    state: 'unavailable',
    reasonCode,
    limits: Object.freeze([]),
    warnThresholdPercent: null,
    throttleTiers: Object.freeze([]),
    entries: Object.freeze([]),
    unenforceable: Object.freeze([]),
  });
}

function entryFor(budget, derivation, { enforcedTokenQuota = null, warnThresholdPercent = null } = {}) {
  return Object.freeze({
    budgetId: budget.budgetId,
    budgetVersion: budget.budgetVersion,
    scope: budget.scope,
    action: budget.action,
    modelScope: budget.modelScope,
    ...(budget.modelScope === 'per-model' ? { modelKey: budget.modelKey } : {}),
    period: budget.period,
    accountingBasis: budget.accountingBasis,
    thresholds: budget.thresholds,
    state: derivation.state,
    reasonCode: derivation.reasonCode,
    configuredLimit: derivation.configuredLimit,
    convertedTokenQuota: derivation.tokenQuota,
    enforcedTokenQuota,
    warnThresholdPercent,
    derivedAt: derivation.derivedAt,
  });
}

/**
 * Turns configured budgets into the quota shape the gateway enforces.
 *
 * Money never reaches the request path: each budget is converted to tokens here and
 * then expressed as a quota, a warning percentage, or a rate tier. A soft warning
 * becomes a quota of the limit plus its grace with the warning sitting where the
 * configured limit falls inside that larger quota, so nothing has to admit a request
 * above a quota.
 */
export function publishBudgets({
  budgetSnapshot,
  registry,
  allowedModels,
  observedMix,
  declaredTierCodes = null,
  evaluationTime,
} = {}) {
  assertRecord(budgetSnapshot, 'budgetSnapshot');
  assertRecord(registry, 'registry');

  if (budgetSnapshot.status !== 'complete') {
    return unavailable(`budget-snapshot-${budgetSnapshot.status}`);
  }

  const entries = [];
  const unenforceable = [];
  const throttleTiers = [];
  const quotaByKey = new Map();
  let warnPercent = null;

  for (const entry of budgetSnapshot.budgets) {
    const derivation = deriveTokenQuota({ budget: entry, allowedModels, evaluationTime });

    if (derivation.state !== 'enforceable') {
      entries.push(entryFor(entry, derivation));
      unenforceable.push(
        Object.freeze({
          budgetId: entry.budgetId,
          scope: entry.scope,
          action: entry.action,
          reasonCode: derivation.reasonCode,
        }),
      );
      continue;
    }

    const configured = derivation.tokenQuota;

    if (entry.action === 'THROTTLE') {
      // A tier the deployment does not declare would be published and then silently
      // ignored, which reads as enforcement that is not happening.
      const undeclared =
        declaredTierCodes === null
          ? null
          : entry.thresholds.tiers.find((tier) => !declaredTierCodes.includes(tier.tierCode));
      if (undeclared !== null && undeclared !== undefined) {
        entries.push(entryFor(entry, { ...derivation, state: 'unenforceable', reasonCode: 'throttle-tier-undeclared', tokenQuota: null }));
        unenforceable.push(
          Object.freeze({
            budgetId: entry.budgetId,
            scope: entry.scope,
            action: entry.action,
            reasonCode: 'throttle-tier-undeclared',
          }),
        );
        continue;
      }

      // A throttle reduces a rate; it never denies, so it publishes no quota.
      for (const tier of entry.thresholds.tiers) {
        throttleTiers.push(
          Object.freeze({
            scope: entry.scope,
            modelScope: entry.modelScope,
            ...(entry.modelScope === 'per-model' ? { modelKey: entry.modelKey } : {}),
            budgetId: entry.budgetId,
            budgetVersion: entry.budgetVersion,
            action: entry.action,
            quotaPeriod: entry.period,
            accountingBasis: entry.accountingBasis,
            atBasisPoints: tier.atBasisPoints,
            tierCode: tier.tierCode,
            againstTokenQuota: configured,
          }),
        );
      }
      entries.push(entryFor(entry, derivation));
      continue;
    }

    let enforced = configured;
    let percent = null;

    if (entry.action === 'SOFT_WARNING') {
      const grace = entry.thresholds.graceBasisPoints;
      const enforcedBigInt =
        (BigInt(configured) * BigInt(BASIS_POINTS_FULL + grace)) / BASIS_POINTS_FULL_BIGINT;
      if (enforcedBigInt > MAX_TOKEN_QUOTA) {
        fail(`budget ${entry.budgetId} soft-warning grace exceeds the maximum token quota.`);
      }
      enforced = Number(enforcedBigInt);
      percent = Number((BigInt(configured) * PERCENT_FULL_BIGINT) / enforcedBigInt);
    } else if (Object.hasOwn(entry.thresholds, 'warnAtBasisPoints')) {
      percent = Math.floor(entry.thresholds.warnAtBasisPoints / 100);
    }

    if (percent !== null && percent >= 1 && percent <= 99) {
      warnPercent = warnPercent === null ? percent : Math.min(warnPercent, percent);
    }

    entries.push(entryFor(entry, derivation, { enforcedTokenQuota: enforced, warnThresholdPercent: percent }));

    const key = budgetCounterIdentity(entry);
    const incumbent = quotaByKey.get(key);
    if (incumbent === undefined || enforced < incumbent.tokenQuota) {
      quotaByKey.set(key, {
        scope: entry.scope,
        modelScope: entry.modelScope,
        ...(entry.modelScope === 'per-model' ? { modelKey: entry.modelKey } : {}),
        tokenQuota: enforced,
        quotaPeriod: entry.period,
        budgetId: entry.budgetId,
        budgetVersion: entry.budgetVersion,
        budgetAction: entry.action,
        accountingBasis: entry.accountingBasis,
        budgetThresholds: entry.thresholds,
      });
    }
  }

  const limits = SCOPE_ORDER.flatMap((scope) =>
    [...quotaByKey.values()]
      .filter((limit) => limit.scope === scope)
      .sort((left, right) => left.modelScope.localeCompare(right.modelScope))
      .map((limit) => Object.freeze({ ...limit })),
  );

  return Object.freeze({
    state: 'published',
    reasonCode: 'budgets-published',
    limits: Object.freeze(limits),
    warnThresholdPercent: warnPercent,
    throttleTiers: Object.freeze(throttleTiers),
    entries: Object.freeze(entries),
    unenforceable: Object.freeze(unenforceable),
  });
}
