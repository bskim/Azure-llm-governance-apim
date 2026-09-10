import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';
import { assertBodyFreeReadModel } from './admin-read-model-projector.mjs';
import { classifyAuthoredPlan } from '../governance-domain/policy/fallback-plan-compiler.mjs';

/**
 * Projects what a downgrade will actually do, and what it will refuse to do.
 *
 * Three different things get confused on this screen if they are merged: what an
 * administrator authored, what compiles for a particular caller's entitlement, and
 * what happens to a request right now. A hop can be authored and never compile, or
 * compile and never be taken because the caller pinned its model. Each is shown
 * separately with the rule that decided it, because "no downgrade happened" has
 * several causes and they need different fixes.
 */

const SAFE_READ_MODEL_KEYS = new Set([
  'readModelVersion',
  'generatedAt',
  'readModelId',
  'quality',
  'authored',
  'compiled',
  'candidates',
  'decision',
  'selection',
]);

function projectAuthored(plan) {
  if (plan === null) return null;
  const verdict = classifyAuthoredPlan(plan);
  return {
    planCode: plan.planId,
    planVersion: plan.planVersion,
    state: plan.state,
    targetKind: plan.target.kind,
    targetCode: plan.target.key,
    optedIn: plan.enabled === true,
    modelSelectionIntent: plan.modelSelectionIntent,
    substitutionNotice: plan.substitutionNotice,
    validFrom: plan.validFrom,
    validUntil: plan.validUntil,
    reasonCode: plan.reasonCode,
    accepted: verdict.valid,
    authoringReasonCode: verdict.reasonCode,
    // The authored graph is shown even when it is refused, because an administrator
    // cannot fix a plan they cannot see.
    edges: Array.isArray(plan.edges)
      ? plan.edges.map((edge) => ({ from: edge.from, to: edge.to }))
      : [],
  };
}

function projectCompiled(compiledByContract) {
  if (compiledByContract === null) return null;
  // One entry per wire contract: the same authored hop can be permitted on Chat
  // Completions and refused on Responses, and a single merged view would have to
  // pick one of those to report.
  return compiledByContract.map(({ apiFamily, compiled }) => ({
    apiFamily,
    disposition: compiled.disposition,
    enabled: compiled.enabled,
    reasonCode: compiled.reasonCode,
    // One hop, always. A longer authored path is never walked transitively, so the
    // number is shown rather than left for a reader to assume.
    maxDepth: compiled.maxDepth,
    onExhausted: compiled.onExhausted,
    modelSelectionIntent: compiled.modelSelectionIntent,
    substitutionNotice: compiled.substitutionNotice,
    permittedHops: compiled.chain.map((hop) => ({ from: hop.from, to: hop.to })),
    refusedHops: compiled.rejections.map((hop) => ({
      from: hop.from,
      to: hop.to,
      blockedBy: hop.blockedBy,
    })),
  }));
}

function projectCandidates(candidates) {
  return candidates.map(({ apiFamily, bySource }) => ({
    apiFamily,
    bySource: bySource.map(({ source, permitted, refused }) => ({
      source,
      permitted: [...permitted],
      refused: refused.map((entry) => ({ modelKey: entry.modelKey, blockedBy: entry.blockedBy })),
    })),
  }));
}

function projectModel(model) {
  return model === null ? null : { modelKey: model.modelKey, providerCode: model.providerKey };
}

function projectDecision(decision) {
  if (decision === null) return null;
  return {
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    requested: projectModel(decision.requested),
    effective: projectModel(decision.effective),
    hops: decision.hops,
    modelSelectionIntent: decision.modelSelectionIntent,
    triggerKind: decision.trigger.kind,
    breachedScopes: [...decision.trigger.breachedScopes],
    warnThresholdPercent: decision.trigger.warnThresholdPercent,
    configVersion: decision.configVersion,
    // A denial the deployment could not carry out is the finding an auditor needs;
    // hiding it would present a configured policy as if it were in force.
    exhausted:
      decision.exhausted === null
        ? null
        : {
            modelKey: decision.exhausted.modelKey,
            providerCode: decision.exhausted.providerKey,
            blockedBy: decision.exhausted.blockedBy,
            unenforcedPolicy: decision.exhausted.unenforcedPolicy,
          },
  };
}

export function projectFallback({ authorization, plan, compiled, candidates = null, decision, selection }) {
  assertAuthorizedReadScope({
    authorization,
    scope: selection.scope,
    teamKey: selection.teamKey,
  });

  const authored = projectAuthored(plan ?? null);
  const readModel = {
    readModelVersion: 'fallback.v1',
    generatedAt: selection.generatedAt,
    readModelId: `fallback-${selection.scope}-${selection.teamKey ?? 'none'}`,
    quality: {
      // No plan applying to a scope is a complete answer, not a degraded one.
      state: authored === null ? 'no-plan' : authored.accepted ? 'complete' : 'plan-refused',
      reasonCode: authored === null ? 'fallback-no-plan-for-scope' : authored.authoringReasonCode,
    },
    authored,
    compiled: projectCompiled(compiled ?? null),
    // What an administrator could author next, judged by the rules that will judge it
    // when it runs. Offered per contract because a target valid on one route is not
    // valid on another.
    candidates: candidates === null ? null : projectCandidates(candidates),
    decision: projectDecision(decision ?? null),
    selection: {
      scope: selection.scope,
      teamKey: selection.scope === 'team' ? selection.teamKey : null,
    },
  };

  assertBodyFreeReadModel(readModel, SAFE_READ_MODEL_KEYS);
  return readModel;
}
