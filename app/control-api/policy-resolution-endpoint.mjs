import {
  evaluateGovernanceAuthorization,
  isAdmissionRefusedReason,
  rosterRefusalReason,
} from '../governance-domain/authorization/governance-authorization-evaluator.mjs';
import { derivePrincipalIdentifiers } from '../governance-domain/identity/principal-key-derivation.mjs';
import { publishBudgets } from '../governance-domain/policy/budget-publication.mjs';
import {
  compileFallbackPlan,
  selectFallbackPlan,
} from '../governance-domain/policy/fallback-plan-compiler.mjs';
import { composeEffectivePolicyDocument } from '../governance-domain/policy/effective-policy-composer.mjs';
import { API_FAMILIES } from '../governance-domain/registry/model-registry-validator.mjs';
import { isStrictMembershipEligible } from '../governance-domain/principal-context/principal-context-validator.mjs';
import { DEPLOYED_THROTTLE_TIER_CODES } from './throttle-tier-codes.mjs';

/**
 * Serves the document the gateway fetches on a cache miss.
 *
 * One outcome carries a document: a caller whose entitlement was actually read. Every
 * other outcome is one of two refusals. A caller whose entitlement was read and found
 * wanting is refused 403; a caller whose entitlement could not be established at all is
 * refused 503, because a conservative document is still a grant, and granting one on
 * evidence nobody gathered widens access beyond what that caller was ever entitled to.
 *
 * The cost is deliberate and belongs in the open: inference availability is now control
 * plane availability. A resolver that cannot answer stops the request instead of
 * guessing, so an outage here is an outage there.
 */

/** Entitlement could not be established. None of these is an answer about the caller. */
const UNRESOLVABLE_REASONS = Object.freeze({
  membershipUnresolved: 'membership-unresolved',
  notAuthorized: 'not-authorized',
  compositionFailed: 'composition-failed',
});

/**
 * Settings that configured the degraded grant. A deployment still carrying one of these
 * is describing behaviour that no longer exists, so it is refused rather than ignored.
 */
const WITHDRAWN_CONFIG_KEYS = Object.freeze([
  'degradedLimit',
  'degradedAllowedModels',
  'unattributedTeamKey',
]);

function assertConfig(config) {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('config is required.');
  }
  for (const key of WITHDRAWN_CONFIG_KEYS) {
    if (Object.hasOwn(config, key)) {
      throw new TypeError(
        `config.${key} has been withdrawn: an unresolvable entitlement is refused, not capped.`,
      );
    }
  }
  if (!Number.isSafeInteger(config.cacheTtlSeconds) || config.cacheTtlSeconds < 1) {
    throw new TypeError('config.cacheTtlSeconds must be a positive integer.');
  }
  return config;
}

/**
 * Team attribution and authorization answer different questions.
 *
 * Exactly one governed team can be named canonically. Zero or several teams produce
 * null so telemetry never assigns consumption to a team that did not solely incur it;
 * the authorization evaluator independently combines every applicable grant by OR.
 */
function resolveAttributionTeamKey(principalContext, entitlementSnapshot, evaluationTime) {
  if (!isStrictMembershipEligible(principalContext, evaluationTime)) {
    return { reasonCode: UNRESOLVABLE_REASONS.membershipUnresolved };
  }
  const teamByGroup = new Map(
    entitlementSnapshot.teamCatalog.map((mapping) => [mapping.membershipGroupId, mapping.teamKey]),
  );
  const teamKeys = [
    ...new Set(
      principalContext.memberships.groups
        .filter((group) => group.authorizationRelevant)
        .map((group) => teamByGroup.get(group.groupId))
        .filter(Boolean),
    ),
  ];
  return { teamKey: teamKeys.length === 1 ? teamKeys[0] : null };
}

const FALLBACK_DISABLED = Object.freeze({
  enabled: false,
  maxDepth: 1,
  chain: [],
  modelSelectionIntent: 'pinned',
  substitutionNotice: 'header',
});
const NO_BUDGETS = Object.freeze({
  limits: Object.freeze([]),
  warnThresholdPercent: null,
  throttleTiers: Object.freeze([]),
});
/**
 * Converts the caller's configured budgets into quotas the gateway can enforce.
 *
 * Absent or degraded budget evidence publishes nothing rather than an unconstrained
 * cap: the entitlement-derived organization quota still applies, so the caller is
 * never left uncapped, and no budget is silently reported as satisfied.
 */
function resolveBudgets({
  budgetSnapshot,
  modelRegistrySnapshot,
  allowedModels,
  observedMix,
  evaluationTime,
}) {
  if (!budgetSnapshot || !modelRegistrySnapshot) return NO_BUDGETS;

  const published = publishBudgets({
    budgetSnapshot,
    registry: modelRegistrySnapshot,
    allowedModels,
    observedMix,
    declaredTierCodes: DEPLOYED_THROTTLE_TIER_CODES,
    evaluationTime,
  });
  if (published.unenforceable.some((entry) => entry.reasonCode === 'throttle-tier-undeclared')) {
    throw new TypeError('A throttle tier is not deployed in the APIM policy.');
  }
  return {
    limits: published.limits,
    warnThresholdPercent: published.warnThresholdPercent,
    throttleTiers: published.throttleTiers,
  };
}

/**
 * Reduces the caller's applicable plan to hops this caller may actually take.
 *
 * Absent catalogue or plan evidence disables fallback rather than falling back to a
 * configured chain, because a hop cannot be shown to be cheaper, no less capable,
 * or inside the same residency boundary without the catalogue that states those
 * facts.
 */
function resolveFallback({
  modelRegistrySnapshot,
  fallbackPolicySnapshot,
  principalContext,
  teamKey,
  allowedModels,
  evaluationTime,
  apiFamily,
}) {
  if (!modelRegistrySnapshot || !fallbackPolicySnapshot) return FALLBACK_DISABLED;
  // A gateway that does not state the contract it is serving cannot be given a chain:
  // the substitute would be chosen without knowing whether it answers that route.
  if (!API_FAMILIES.includes(apiFamily)) return FALLBACK_DISABLED;

  const plan = selectFallbackPlan({
    plans: fallbackPolicySnapshot.plans,
    applicationId: principalContext.application?.applicationId,
    subjectId: principalContext.subject?.subjectId,
    teamKey,
  });
  if (plan === null) return FALLBACK_DISABLED;

  const compiled = compileFallbackPlan({
    plan,
    registry: modelRegistrySnapshot,
    allowedModels,
    evaluationTime,
    apiFamily,
  });
  return {
    enabled: compiled.enabled,
    maxDepth: compiled.maxDepth,
    chain: compiled.chain,
    modelSelectionIntent: compiled.modelSelectionIntent,
    substitutionNotice: compiled.substitutionNotice,
  };
}

export function createPolicyResolver({
  deriver,
  scopeGroupId,
  snapshotProvider,
  principalContextFactory,
  identityResolver,
  clock,
  config,
}) {
  if (deriver === null || typeof deriver !== 'object') throw new TypeError('deriver is required.');
  if (typeof scopeGroupId !== 'string' || !/^[a-z][a-z0-9-]{1,62}$/.test(scopeGroupId)) {
    throw new TypeError('scopeGroupId must be a canonical organization scope key.');
  }
  if (typeof snapshotProvider !== 'function') throw new TypeError('snapshotProvider is required.');
  if (principalContextFactory === null || typeof principalContextFactory !== 'object') {
    throw new TypeError('principalContextFactory is required.');
  }
  if (typeof identityResolver !== 'function') throw new TypeError('identityResolver is required.');
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');
  assertConfig(config);

  function window() {
    const resolvedAt = clock.nowIso();
    const expiresAt = new Date(
      Date.parse(resolvedAt) + config.cacheTtlSeconds * 1000,
    ).toISOString();
    return { resolvedAt, expiresAt };
  }

  /**
   * Entitlement could not be established, so nothing here is entitled to a document.
   *
   * This used to answer 200 with a conservative cap, which read as prudence and was a
   * grant: a caller entitled to one model was offered another, on evidence nobody had.
   * 503 is the honest status. 403 would state the caller is not permitted, which is not
   * what happened and which a coding agent treats as terminal; 503 says try again, and
   * trying again is exactly what may succeed once the control plane answers.
   */
  function unresolvable(reasonCode, diagnostics = null) {
    // The caller reads only status and reasonCode; diagnostics are for the host's log,
    // and naming the governance structure to an end user is not this refusal's business.
    return { status: 503, reasonCode, document: null, diagnostics };
  }

  /**
   * A refusal carries no document. The gateway has to tell "read the roster, not on it"
   * from "could not resolve", and a conservative document cannot express the first: it
   * would hand the caller a model.
   */
  function refuse(reasonCode) {
    return { status: 403, reasonCode, document: null };
  }

  async function resolve(request) {
    const identity = await identityResolver(request);
    const principalContext = await principalContextFactory.create(identity);
    const {
      assignmentSnapshot,
      entitlementSnapshot,
      modelRegistrySnapshot,
      fallbackPolicySnapshot,
      budgetSnapshot,
      observedMix,
    } = await snapshotProvider();
    const evaluationTime = clock.nowIso();

    // Ahead of the team resolution, which cannot establish entitlement from any
    // membership status that is not complete and would report a removal as a gap.
    const rosterRefusal = rosterRefusalReason(principalContext.memberships);
    if (rosterRefusal) return refuse(rosterRefusal);

    const team = resolveAttributionTeamKey(principalContext, entitlementSnapshot, evaluationTime);
    if (team.reasonCode) return unresolvable(team.reasonCode, team.diagnostics ?? null);

    const authorization = evaluateGovernanceAuthorization({
      principalContext,
      assignmentSnapshot,
      entitlementSnapshot,
      evaluationTime,
    });
    if (isAdmissionRefusedReason(authorization.reasonCode)) {
      return refuse(authorization.reasonCode);
    }
    if (authorization.decision !== 'allow') {
      return unresolvable(UNRESOLVABLE_REASONS.notAuthorized);
    }

    const identifiers = derivePrincipalIdentifiers(deriver, {
      principalContext,
      canonicalTeamKey: team.teamKey,
      scopeGroupId: team.teamKey ?? scopeGroupId,
    });
    const { resolvedAt, expiresAt } = window();
    const allowedModels = authorization.modelAllowlist ?? [];
    try {
      const budgets = resolveBudgets({
        budgetSnapshot,
        modelRegistrySnapshot,
        allowedModels,
        observedMix,
        evaluationTime,
      });
      const fallback = resolveFallback({
        modelRegistrySnapshot,
        fallbackPolicySnapshot,
        principalContext,
        teamKey: team.teamKey,
        allowedModels,
        evaluationTime,
        apiFamily: request.apiFamily,
      });
      return {
        status: 200,
        reasonCode: 'resolved',
        document: composeEffectivePolicyDocument({
          authorization,
          entitlementSnapshot,
          modelRegistrySnapshot,
          identifiers,
          fallback,
          warnThresholdPercent: config.warnThresholdPercent,
          budgetLimits: budgets.limits,
          budgetWarnThresholdPercent: budgets.warnThresholdPercent,
          throttleTiers: budgets.throttleTiers,
          modelSelectionIntent: fallback.modelSelectionIntent,
          substitutionNotice: fallback.substitutionNotice,
          configVersion: entitlementSnapshot.version,
          resolvedAt,
          expiresAt,
        }),
      };
    } catch {
      // A malformed or incomplete policy is a configuration fault, not a caller
      // fault. The reason is reported, but the detail is withheld because this
      // response crosses into the gateway and then into request telemetry.
      return unresolvable(UNRESOLVABLE_REASONS.compositionFailed);
    }
  }

  return Object.freeze({ resolve });
}

export { UNRESOLVABLE_REASONS };
