const SCOPE_ORDER = Object.freeze(['organization', 'team', 'subject', 'application']);
const EXHAUSTION_POLICIES = new Set(['deny', 'continue-with-requested']);

function fail(message) {
  throw new TypeError(message);
}

function assertRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
}

/**
 * Which budget scopes have consumed at least the warning share of their quota.
 *
 * A scope with no reported remainder is skipped rather than treated as exhausted:
 * the gateway only reports a remainder for a limit it actually applied, so an
 * absent value means the limit did not run, not that nothing is left.
 */
function breachedScopes(limits, remainingTokensByScope, threshold) {
  const breached = [];
  for (const scope of SCOPE_ORDER) {
    if (!Object.hasOwn(remainingTokensByScope, scope)) continue;
    const limit = limits.find(
      (candidate) => candidate.scope === scope && candidate.modelScope === 'all-models',
    );
    if (limit === undefined) continue;
    const quota = limit.tokenQuota;
    if (!Number.isFinite(quota) || quota <= 0) continue;
    const remaining = remainingTokensByScope[scope];
    if (!Number.isFinite(remaining)) continue;
    if (((quota - remaining) / quota) * 100 >= threshold) breached.push(scope);
  }
  return breached;
}

/**
 * The local reference for the effective model the gateway selects.
 *
 * It reads only fields the effective policy document already carries, so the
 * deployed policy expression can reach the same answer from the same cached
 * document. That constraint is the point: an evaluator that needed an extra input
 * would be a parallel implementation rather than a reference, and two
 * implementations of one selection rule drift.
 *
 * The chain is expected to be already compiled, so every hop in it is a hop this
 * caller may take. The allowlist check below is defence in depth, not the place
 * where entitlement is established.
 */
/**
 * Whether the requested model has burned at least the warning share of its own budget.
 *
 * A model-scoped budget cannot be read from a gateway counter before the model is
 * chosen, so the resolver carries the share in the document. An absent reading is not
 * a reading of zero: it means nobody measured, and inventing pressure would downgrade
 * a caller who is nowhere near their cap.
 */
function modelUnderPressure(effectivePolicy, requestedModel, threshold) {
  const pressure = effectivePolicy.modelPressure;
  if (!Array.isArray(pressure)) return false;
  const entry = pressure.find((candidate) => candidate.model === requestedModel);
  if (entry === undefined || !Number.isFinite(entry.consumedBasisPoints)) return false;
  return entry.consumedBasisPoints >= threshold * 100;
}

export function selectEffectiveModel({
  requestedModel,
  effectivePolicy,
  remainingTokensByScope = {},
  onExhausted = 'continue-with-requested',
} = {}) {
  if (typeof requestedModel !== 'string' || requestedModel.length === 0) {
    fail('requestedModel is required.');
  }
  assertRecord(effectivePolicy, 'effectivePolicy');
  assertRecord(remainingTokensByScope, 'remainingTokensByScope');
  if (!EXHAUSTION_POLICIES.has(onExhausted)) {
    fail('onExhausted must be deny or continue-with-requested.');
  }

  const served = (reasonCode, breached = [], modelBreached = false) =>
    Object.freeze({
      decision: 'selected',
      effectiveModel: requestedModel,
      requestedModel,
      hops: 0,
      breachedScopes: Object.freeze(breached),
      modelPressureBreached: modelBreached,
      reasonCode,
    });

  // Pressure is measured before any early return. Whether a downgrade was configured
  // and whether the caller is over the warning threshold are separate facts, and an
  // audit record needs the second one even when the answer to the first is no.
  const threshold = effectivePolicy.warnThresholdPercent ?? 0;
  const limits = Array.isArray(effectivePolicy.limits) ? effectivePolicy.limits : [];
  const measurable = Number.isFinite(threshold) && threshold > 0;
  const breached = measurable ? breachedScopes(limits, remainingTokensByScope, threshold) : [];
  // Either axis arms the downgrade. A shared cap running out and one model burning its
  // own budget are different reasons to reach for something cheaper, and a product with
  // a budget per model would otherwise wait for the organization-wide cap.
  const modelBreached = measurable && modelUnderPressure(effectivePolicy, requestedModel, threshold);

  const fallback = effectivePolicy.fallback;
  if (!fallback || fallback.enabled !== true) return served('fallback-disabled', breached, modelBreached);
  // An absent intent pins. A caller that never opted into a substitute has not opted
  // into one, and refusing to reroute removes no cap.
  if ((effectivePolicy.modelSelectionIntent ?? 'pinned') !== 'preferred') {
    return served('model-pinned', breached, modelBreached);
  }
  if (!measurable) return served('fallback-no-threshold');
  if (breached.length === 0 && !modelBreached) return served('within-budget');

  const allowed = new Set(effectivePolicy.allowedModels ?? []);
  const chain = Array.isArray(fallback.chain) ? fallback.chain : [];
  const maxDepth = fallback.maxDepth ?? 1;

  let current = requestedModel;
  let hops = 0;
  while (hops < maxDepth) {
    const step = current;
    const edge = chain.find((candidate) => candidate.from === step);
    if (edge === undefined) break;
    if (!allowed.has(edge.to)) break;
    current = edge.to;
    hops += 1;
  }

  if (hops === 0) {
    if (onExhausted === 'deny') {
      return Object.freeze({
        decision: 'denied',
        effectiveModel: null,
        requestedModel,
        hops: 0,
        breachedScopes: Object.freeze(breached),
        modelPressureBreached: modelBreached,
        reasonCode: 'fallback-exhausted',
      });
    }
    return served('fallback-exhausted-served-as-requested', breached, modelBreached);
  }

  return Object.freeze({
    decision: 'selected',
    effectiveModel: current,
    requestedModel,
    hops,
    breachedScopes: Object.freeze(breached),
    modelPressureBreached: modelBreached,
    reasonCode: 'fallback-applied',
  });
}
