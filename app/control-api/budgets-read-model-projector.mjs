import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';
import { assertBodyFreeReadModel } from './admin-read-model-projector.mjs';
import { projectWindowFreshness } from './read-model-freshness.mjs';
import { matchesBudgetObservation } from '../governance-domain/usage/period-consumption.mjs';

const SAFE_READ_MODEL_KEYS = new Set([
  'readModelVersion',
  'generatedAt',
  'readModelId',
  'quality',
  'freshness',
  'modelSelection',
  'records',
  'selection',
]);

// A read scope decides which budget scopes are visible. An organization budget is a
// ceiling that applies to every caller and carries no other principal's data, so it
// stays visible at every scope; a team or subject budget does not.
const VISIBLE_SCOPES = Object.freeze({
  global: Object.freeze(['organization', 'team', 'subject', 'application']),
  team: Object.freeze(['organization', 'team']),
  self: Object.freeze(['organization', 'subject', 'application']),
});

function assertSelection(selection) {
  if (!Object.hasOwn(VISIBLE_SCOPES, selection.scope)) {
    const error = new Error('scope-not-supported');
    error.code = 'scope-not-supported';
    throw error;
  }
}

/**
 * How much of a budget the period has actually used.
 *
 * The cap alone does not tell an administrator whether to act. The measured total
 * and its coverage travel together, because a period missing hours totals lower than
 * the truth and a remainder derived from it would be room the organization does not
 * have.
 */
function projectConsumption(entry, observations) {
  const unmeasured = (reasonCode) =>
    Object.freeze({
      state: 'unmeasured',
      reasonCode,
      consumedTokens: null,
      remainingTokens: null,
      consumedBasisPoints: null,
      overCap: null,
      exceededByTokens: null,
      windowsCovered: null,
      windowsMissing: null,
      observation: {
        requestedBudgetVersion: entry.budgetVersion,
        requestedWindow: null,
        latestClosedWindow: null,
        coveredWindows: null,
        missingWindows: null,
        coverageDetailState: 'not-collected',
        policyVersionEvidence: { state: 'not-collected', value: null, reasonCode: 'usage-rollup-policy-version-not-collected' },
        counterIdentityEvidence: { state: 'not-collected' },
      },
    });

  if (entry.enforcedTokenQuota === null) return unmeasured('no-quota-to-measure');
  const observation = observations.find((candidate) => matchesBudgetObservation(candidate, entry));
  if (observation === undefined) return unmeasured('no-observation');

  const consumedBasisPoints = Math.floor((observation.consumedTokens / entry.enforcedTokenQuota) * 10_000);
  const partial = observation.completeness !== 'complete';
  const overCap = consumedBasisPoints > 10_000;

  return Object.freeze({
    state: partial ? 'partial' : 'measured',
    reasonCode: partial ? observation.completenessReason : 'period-measured',
    consumedTokens: observation.consumedTokens,
    // A remainder computed from a period with a gap would be a guess presented as a
    // number, so it is withheld while the total itself is still shown.
    remainingTokens: partial ? null : Math.max(0, entry.enforcedTokenQuota - observation.consumedTokens),
    consumedBasisPoints,
    overCap,
    // What the cap was actually exceeded by, which is not the same question as how far
    // it could be exceeded. A gap lowers a total, so a period that is over is over even
    // when it is incomplete — the figure is then a floor rather than the final amount.
    exceededByTokens: overCap ? observation.consumedTokens - entry.enforcedTokenQuota : null,
    windowsCovered: observation.windowsCovered ?? null,
    windowsMissing: observation.windowsMissing ?? null,
    observation: {
      requestedBudgetVersion: entry.budgetVersion,
      requestedWindow: observation.requestedWindow ?? null,
      latestClosedWindow: observation.latestClosedWindow ?? null,
      coveredWindows: observation.coveredWindows ?? null,
      missingWindows: observation.missingWindows ?? null,
      coverageDetailState: observation.coverageDetailState ?? 'not-collected',
      policyVersionEvidence: { state: 'not-collected', value: null, reasonCode: 'usage-rollup-policy-version-not-collected' },
      // Rollups do not identify a deployed APIM counter. Do not manufacture one from
      // a budget version or represent this aggregate as an enforcement readback.
      counterIdentityEvidence: { state: 'not-collected' },
    },
  });
}

function projectRecord(entry, throttleTiers, observations) {
  return {
    budgetCode: entry.budgetId,
    budgetVersion: entry.budgetVersion,
    scopeKind: entry.scope,
    action: entry.action,
    modelScope: entry.modelScope,
    ...(entry.modelScope === 'per-model' ? { modelKey: entry.modelKey } : {}),
    period: entry.period,
    thresholds: {
      ...entry.thresholds,
      ...(entry.action === 'THROTTLE'
        ? { tiers: entry.thresholds.tiers.map((tier) => ({ ...tier })) }
        : {}),
    },
    state: entry.state,
    reasonCode: entry.reasonCode,
    // The configured budget and the quota it binds are shown separately, so a limit
    // widened by a grace threshold is never mistaken for the number entered.
    configuredLimit: { ...entry.configuredLimit },
    convertedTokenQuota: entry.convertedTokenQuota,
    enforcedTokenQuota: entry.enforcedTokenQuota,
    warnThresholdPercent: entry.warnThresholdPercent,
    derivedAt: entry.derivedAt,
    consumption: projectConsumption(entry, observations),
    throttleTiers: throttleTiers
      .filter((tier) => tier.budgetId === entry.budgetId)
      .map((tier) => ({ atBasisPoints: tier.atBasisPoints, tierCode: tier.tierCode })),
  };
}

/**
 * What budget pressure will actually do to this caller's model.
 *
 * A configured downgrade that a pin suppresses looks, from the budget alone, like a
 * budget that denies traffic. It is not, and an administrator sent to investigate the
 * budget would be investigating the wrong thing.
 *
 * The answer is per wire contract because a chain compiles against the contract the
 * request arrived on, and a model states which contracts it serves. Reducing that to
 * one boolean over every contract this product can name was unsatisfiable: no model
 * in the catalogue advertises them all, so a working downgrade reported as none.
 */
function projectModelSelection(modelSelection) {
  if (modelSelection === null) return null;
  const intent = modelSelection.modelSelectionIntent ?? 'pinned';
  const downgradeContracts = [...(modelSelection.contracts ?? [])].sort();
  const downgradeAvailable = downgradeContracts.length > 0;
  return {
    intent,
    substitutionNotice: modelSelection.substitutionNotice ?? 'header',
    downgradeAvailable,
    downgradeContracts,
    downgradeSuppressedBy: downgradeAvailable && intent !== 'preferred' ? 'model-pinned' : null,
  };
}

/**
 * Projects the budget screen a governance administrator reads.
 *
 * Everything a reader needs in order to distrust the number is present: which basis
 * priced it, at which price version, when it was derived, how far the cap can be
 * exceeded, and the smallest cap that would honour the published target. A budget
 * that could not be converted appears with its reason rather than disappearing,
 * because a missing row reads as an absent budget and that is the wrong conclusion.
 */
export function projectBudgets({
  authorization,
  publication,
  selection,
  freshness,
  modelSelection = null,
  observations = [],
}) {
  assertAuthorizedReadScope({
    authorization,
    scope: selection.scope,
    teamKey: selection.teamKey,
  });
  assertSelection(selection);
  const periodFreshness = projectWindowFreshness(freshness);

  const unavailable = publication.state !== 'published';
  const visible = VISIBLE_SCOPES[selection.scope];
  const records = unavailable
    ? []
    : publication.entries
        .filter((entry) => visible.includes(entry.scope))
        .map((entry) => projectRecord(entry, publication.throttleTiers, observations))
        .sort((left, right) => left.budgetCode.localeCompare(right.budgetCode));

  const readModel = {
    readModelVersion: 'budgets.v1',
    generatedAt: selection.generatedAt,
    readModelId: `budgets-${selection.scope}-${selection.teamKey ?? 'none'}`,
    quality: {
      state: unavailable ? 'unavailable' : 'complete',
      reasonCode: publication.reasonCode,
      freshnessState: periodFreshness.state,
    },
    freshness: periodFreshness,
    modelSelection: projectModelSelection(modelSelection),
    records,
    selection: { scope: selection.scope, teamKey: selection.teamKey ?? null },
  };

  assertBodyFreeReadModel(readModel, SAFE_READ_MODEL_KEYS);
  return readModel;
}
