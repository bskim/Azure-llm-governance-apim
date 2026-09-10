import {
  API_FAMILIES,
  resolveModelDescriptor,
} from '../registry/model-registry-validator.mjs';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL_ALIAS = /^[A-Za-z0-9._-]{1,64}$/;

const SNAPSHOT_STATUSES = new Set([
  'complete',
  'incomplete',
  'stale',
  'ambiguous',
  'source-unavailable',
]);
const RECORD_STATES = new Set(['active', 'revoked', 'expired']);
const TARGET_KINDS = new Set(['global', 'team', 'subject', 'application']);
const ISSUER_KINDS = new Set(['subject', 'system']);
const EXHAUSTION_POLICIES = new Set(['deny', 'continue-with-requested']);
const MODEL_SELECTION_INTENTS = new Set(['pinned', 'preferred']);
const SUBSTITUTION_NOTICES = new Set(['header', 'inline']);

const MAX_PLANS = 128;
const MAX_EDGES = 32;
// Downgrade takes exactly one hop: a primary model falls back to one cheaper
// alternative and stops. A plan may still map many primaries, so a graph path may
// be longer than one, but no single request ever walks more than one edge.
const WALK_DEPTH = 1;

/** Applied when a plan does not state one, so the warning band keeps serving. */
export const DEFAULT_ON_EXHAUSTED = 'continue-with-requested';
// A plan that does not say its callers accept a substitute has not said so. This matters
// most for a plan authored at a wide scope, which would otherwise opt in every
// application beneath it, including the ones whose wire format depends on the model.
export const DEFAULT_MODEL_SELECTION_INTENT = 'pinned';
// Headers are the only channel available to a streamed response, so they are the one
// the product guarantees. An inline notice is an addition for callers that read prose.
export const DEFAULT_SUBSTITUTION_NOTICE = 'header';

// A rejection an administrator has to act on carries a code as well as a message,
// so a screen can name the rule that was broken without reading English prose.
function fail(message, code) {
  const error = new TypeError(message);
  if (code !== undefined) error.code = code;
  throw error;
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

function assertModelAlias(value, path) {
  if (typeof value !== 'string' || !MODEL_ALIAS.test(value)) {
    fail(`${path} must be a bounded model alias.`);
  }
}

function assertPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${path} must be a positive integer.`);
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

function assertTarget(target, path) {
  assertExactKeys(target, ['kind', 'key'], [], path);
  if (!TARGET_KINDS.has(target.kind)) fail(`${path}.kind is unsupported.`);
  if (target.kind === 'global') {
    if (target.key !== null) fail(`${path}.key must be null for a global target.`);
    return;
  }
  assertSafeId(target.key, `${path}.key`);
}

function assertIssuer(issuer, path) {
  assertExactKeys(issuer, ['kind', 'key'], [], path);
  if (!ISSUER_KINDS.has(issuer.kind)) fail(`${path}.kind is unsupported.`);
  assertSafeId(issuer.key, `${path}.key`);
}

/**
 * Rejects a cyclic plan by colouring the whole authored graph, not by walking from
 * each start with a visited set. Both detect a cycle, but this one visits each node
 * once and can name the back edge that closes it, which is what an administrator
 * needs in order to fix the plan.
 */
function assertAcyclic(successors, path) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map();
  for (const from of successors.keys()) colour.set(from, WHITE);

  for (const start of successors.keys()) {
    if (colour.get(start) !== WHITE) continue;
    let current = start;
    const stack = [];
    while (current !== undefined && colour.get(current) === WHITE) {
      colour.set(current, GREY);
      stack.push(current);
      current = successors.get(current);
    }
    if (current !== undefined && colour.get(current) === GREY) {
      fail(
        `${path} forms a cycle: ${stack[stack.length - 1]} points back to ${current}.`,
        'authoring-cycle',
      );
    }
    for (const node of stack) colour.set(node, BLACK);
  }
}

function assertPlan(plan, path) {
  assertExactKeys(
    plan,
    [
      'planId',
      'planVersion',
      'state',
      'target',
      'enabled',
      'edges',
      'validFrom',
      'validUntil',
      'issuedBy',
      'reasonCode',
    ],
    ['onExhausted', 'modelSelectionIntent', 'substitutionNotice'],
    path,
  );

  assertSafeId(plan.planId, `${path}.planId`);
  assertPositiveInteger(plan.planVersion, `${path}.planVersion`);
  if (!RECORD_STATES.has(plan.state)) fail(`${path}.state is unsupported.`);
  assertTarget(plan.target, `${path}.target`);
  if (typeof plan.enabled !== 'boolean') fail(`${path}.enabled must be a boolean.`);

  if (Object.hasOwn(plan, 'onExhausted') && !EXHAUSTION_POLICIES.has(plan.onExhausted)) {
    fail(`${path}.onExhausted must be deny or continue-with-requested.`);
  }
  if (
    Object.hasOwn(plan, 'modelSelectionIntent') &&
    !MODEL_SELECTION_INTENTS.has(plan.modelSelectionIntent)
  ) {
    fail(`${path}.modelSelectionIntent must be pinned or preferred.`);
  }
  if (Object.hasOwn(plan, 'substitutionNotice') && !SUBSTITUTION_NOTICES.has(plan.substitutionNotice)) {
    fail(`${path}.substitutionNotice must be header or inline.`);
  }

  if (!Array.isArray(plan.edges) || plan.edges.length > MAX_EDGES) {
    fail(`${path}.edges must be an array of at most ${MAX_EDGES} hops.`, 'authoring-too-many-edges');
  }

  const successors = new Map();
  plan.edges.forEach((edge, index) => {
    const edgePath = `${path}.edges[${index}]`;
    assertExactKeys(edge, ['from', 'to'], [], edgePath);
    assertModelAlias(edge.from, `${edgePath}.from`);
    assertModelAlias(edge.to, `${edgePath}.to`);
    if (edge.from === edge.to) {
      fail(`${edgePath} must not point a model at itself.`, 'authoring-self-loop');
    }
    if (successors.has(edge.from)) {
      fail(`${edgePath} gives ${edge.from} more than one fallback target.`, 'authoring-multiple-targets');
    }
    successors.set(edge.from, edge.to);
  });

  // Runs on the authored plan, before any caller's allowlist is known. A cycle is a
  // property of the configuration, not of who asked for it. The walk is one hop, so
  // a cycle cannot loop a request, but it still describes two models each claiming
  // to be the cheaper alternative to the other.
  assertAcyclic(successors, `${path}.edges`);

  const validFrom = parseTime(plan.validFrom, `${path}.validFrom`);
  if (plan.validUntil !== null) {
    const validUntil = parseTime(plan.validUntil, `${path}.validUntil`);
    if (validUntil <= validFrom) {
      fail(`${path}.validUntil must follow validFrom.`, 'authoring-window-inverted');
    }
  }

  assertIssuer(plan.issuedBy, `${path}.issuedBy`);
  assertSafeId(plan.reasonCode, `${path}.reasonCode`);
}

function freezePlan(plan) {
  return Object.freeze({
    ...plan,
    target: Object.freeze({ ...plan.target }),
    issuedBy: Object.freeze({ ...plan.issuedBy }),
    edges: Object.freeze(plan.edges.map((edge) => Object.freeze({ ...edge }))),
  });
}

export const AUTHORING_REASON_CODES = Object.freeze([
  'authoring-cycle',
  'authoring-self-loop',
  'authoring-multiple-targets',
  'authoring-too-many-edges',
  'authoring-window-inverted',
  'authoring-malformed',
]);

/**
 * Reports whether an authored plan would be accepted, without throwing.
 *
 * The screen that lets an administrator see why a plan was refused cannot use the
 * assertion directly: a snapshot containing one bad plan throws before any plan is
 * visible. This runs the same rules against one plan and returns the verdict.
 */
export function classifyAuthoredPlan(plan) {
  try {
    assertPlan(plan, 'plan');
    return Object.freeze({ valid: true, reasonCode: 'authoring-accepted' });
  } catch (error) {
    return Object.freeze({
      valid: false,
      reasonCode: AUTHORING_REASON_CODES.includes(error.code) ? error.code : 'authoring-malformed',
    });
  }
}

export function assertFallbackPolicySnapshotV1(snapshot, { evaluationTime, principalTenantId } = {}) {
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
      'plans',
    ],
    ['reason'],
    'fallbackPolicy',
  );

  if (snapshot.contractVersion !== 'v1') fail('fallbackPolicy.contractVersion must be v1.');
  for (const key of ['snapshotId', 'tenantId', 'sourceRevision']) {
    assertSafeId(snapshot[key], `fallbackPolicy.${key}`);
  }
  assertPositiveInteger(snapshot.version, 'fallbackPolicy.version');
  if (!SNAPSHOT_STATUSES.has(snapshot.status)) fail('fallbackPolicy.status is unsupported.');

  const capturedAt = parseTime(snapshot.capturedAt, 'fallbackPolicy.capturedAt');
  const expiresAt = parseTime(snapshot.expiresAt, 'fallbackPolicy.expiresAt');
  const now = parseTime(evaluationTime, 'evaluationTime');
  if (capturedAt > now) throw new RangeError('fallbackPolicy cannot be captured in the future.');
  if (capturedAt >= expiresAt) throw new RangeError('fallbackPolicy capture must precede expiry.');
  if (expiresAt <= now) throw new RangeError('fallbackPolicy has expired and carries no authority.');

  if (typeof principalTenantId === 'string' && snapshot.tenantId !== principalTenantId) {
    fail('fallbackPolicy.tenantId does not match the calling tenant.');
  }

  if (!Array.isArray(snapshot.plans)) fail('fallbackPolicy.plans must be an array.');
  if (snapshot.plans.length > MAX_PLANS) fail(`fallbackPolicy.plans exceeds ${MAX_PLANS} entries.`);

  if (snapshot.status !== 'complete') {
    if (typeof snapshot.reason !== 'string' || snapshot.reason.length === 0) {
      fail('fallbackPolicy degraded status requires a reason.');
    }
    if (snapshot.plans.length !== 0) {
      fail('fallbackPolicy degraded status cannot carry plan records.');
    }
  }

  snapshot.plans.forEach((plan, index) => assertPlan(plan, `fallbackPolicy.plans[${index}]`));
  assertSortedUnique(
    snapshot.plans.map((plan) => plan.planId),
    'fallbackPolicy.plans',
  );

  return Object.freeze({
    ...snapshot,
    plans: Object.freeze(snapshot.plans.map(freezePlan)),
  });
}

// Most specific wins, and one plan governs entirely. This deliberately differs from the
// entitlement bindings, which intersect: a narrower scope may never widen which models
// are allowed, but it may decide its own downgrade behaviour, because the budget it was
// given already bounds what it can spend.
const TARGET_SPECIFICITY = Object.freeze({ application: 3, subject: 2, team: 1, global: 0 });

/**
 * Picks the one plan that governs a caller. Selection is separate from compilation
 * because a plan can be selected and then compile to nothing, and an administrator
 * needs to see which of those two happened.
 */
export function selectFallbackPlan({ plans, applicationId, subjectId, teamKey } = {}) {
  if (!Array.isArray(plans)) fail('plans must be an array.');
  const keyByKind = { application: applicationId, subject: subjectId, team: teamKey, global: null };

  let selected = null;
  for (const plan of plans) {
    const kind = plan.target.kind;
    if (kind !== 'global' && plan.target.key !== keyByKind[kind]) continue;
    if (kind !== 'global' && keyByKind[kind] === undefined) continue;
    if (selected === null || TARGET_SPECIFICITY[kind] > TARGET_SPECIFICITY[selected.target.kind]) {
      selected = plan;
    }
  }
  return selected;
}

/**
 * Evaluated in this order, and the first blocking class is reported. A fixed order
 * makes the reason an administrator sees deterministic rather than dependent on
 * which check happened to run first.
 */
const COMPATIBILITY_CLASSES = Object.freeze([
  Object.freeze({
    // Measured on the account: every deployment answers the same `/openai/v1` route
    // and is selected by the `model` field in the body, so a hop is reachable when
    // the target serves the contract the caller asked on, whoever published it. This
    // holds because the registry describes one backend; a second would need its own
    // reachability fact rather than this assumption.
    reasonCode: 'fallback-api-family-narrowed',
    permits: (_source, target, apiFamily) => target.apiFamilies.includes(apiFamily),
  }),
]);

export const FALLBACK_COMPATIBILITY_REASON_CODES = Object.freeze(
  COMPATIBILITY_CLASSES.map((entry) => entry.reasonCode),
);

function evaluateHop(edge, registry, allowed, apiFamily) {
  if (!allowed.has(edge.from)) return 'fallback-source-not-entitled';
  if (!allowed.has(edge.to)) return 'fallback-target-not-entitled';

  const source = resolveModelDescriptor(registry, edge.from);
  const target = resolveModelDescriptor(registry, edge.to);
  if (source === null || target === null) return 'fallback-model-unregistered';
  // A source that does not serve this contract is never the requested model on this
  // route, so the hop is not this chain's to offer.
  if (!source.apiFamilies.includes(apiFamily)) return 'fallback-source-api-family-absent';

  for (const { reasonCode, permits } of COMPATIBILITY_CLASSES) {
    if (!permits(source, target, apiFamily)) return reasonCode;
  }
  return null;
}

function unavailable(plan, reasonCode) {
  return Object.freeze({
    disposition: 'unavailable',
    enabled: false,
    maxDepth: WALK_DEPTH,
    onExhausted: plan.onExhausted ?? DEFAULT_ON_EXHAUSTED,
    modelSelectionIntent: plan.modelSelectionIntent ?? DEFAULT_MODEL_SELECTION_INTENT,
    substitutionNotice: plan.substitutionNotice ?? DEFAULT_SUBSTITUTION_NOTICE,
    chain: Object.freeze([]),
    rejections: Object.freeze([]),
    reasonCode,
  });
}

function disabled(plan, reasonCode) {
  return Object.freeze({
    disposition: 'disabled',
    enabled: false,
    maxDepth: WALK_DEPTH,
    onExhausted: plan.onExhausted ?? DEFAULT_ON_EXHAUSTED,
    modelSelectionIntent: plan.modelSelectionIntent ?? DEFAULT_MODEL_SELECTION_INTENT,
    substitutionNotice: plan.substitutionNotice ?? DEFAULT_SUBSTITUTION_NOTICE,
    chain: Object.freeze([]),
    rejections: Object.freeze([]),
    reasonCode,
  });
}

/**
 * Which targets an authored hop from `source` could actually name.
 *
 * The authoring screen asks this so an administrator picks from hops that will
 * compile, instead of writing one and finding out at runtime that it never applies.
 * It runs the same classes `compileFallbackPlan` runs, on purpose: a second copy of
 * the rules would be the looser one, and the looser one would decide what gets
 * stored. Prices and lifecycles change under a stored plan, so this narrows the
 * choice rather than guaranteeing it, and the compile-time evaluation still decides.
 */
export function derivePermittedTargets({ registry, allowedModels, source, apiFamily } = {}) {
  assertRecord(registry, 'registry');
  if (!Array.isArray(allowedModels)) fail('allowedModels must be an array.');
  if (typeof source !== 'string' || source.length === 0) fail('source must name a model.');
  if (!API_FAMILIES.includes(apiFamily)) {
    fail('apiFamily must name the wire contract the targets are judged for.');
  }
  if (registry.status !== 'complete') {
    return Object.freeze({ permitted: Object.freeze([]), refused: Object.freeze([]) });
  }

  const allowed = new Set(allowedModels);
  const permitted = [];
  const refused = [];
  for (const target of [...allowed].sort()) {
    if (target === source) continue;
    const blockedBy = evaluateHop({ from: source, to: target }, registry, allowed, apiFamily);
    if (blockedBy === null) permitted.push(target);
    else refused.push(Object.freeze({ modelKey: target, blockedBy }));
  }

  return Object.freeze({
    permitted: Object.freeze(permitted),
    refused: Object.freeze(refused),
  });
}

/**
 * Reduces an authored plan to the hops a specific caller may actually take.
 *
 * Filtering happens here rather than during composition so that the authored graph
 * has already been proven acyclic. The result is a compiled chain: every hop in it
 * is one this caller may take, which is what lets the composer assert rather than
 * quietly repair.
 */
export function compileFallbackPlan({ plan, registry, allowedModels, evaluationTime, apiFamily } = {}) {
  assertRecord(plan, 'plan');
  assertRecord(registry, 'registry');
  if (!Array.isArray(allowedModels)) fail('allowedModels must be an array.');
  // Required, never defaulted: a chain compiled without knowing the contract in use
  // is the superset comparison this replaced, which refused hops that would have
  // served the caller perfectly well.
  if (!API_FAMILIES.includes(apiFamily)) {
    fail('apiFamily must name the wire contract the chain is compiled for.');
  }

  if (registry.status !== 'complete') return unavailable(plan, 'model-registry-unavailable');
  if (plan.enabled !== true) return disabled(plan, 'fallback-not-opted-in');
  if (plan.state !== 'active') return disabled(plan, `fallback-plan-${plan.state}`);

  const now = parseTime(evaluationTime, 'evaluationTime');
  if (parseTime(plan.validFrom, 'plan.validFrom') > now) {
    return disabled(plan, 'fallback-plan-not-yet-valid');
  }
  if (plan.validUntil !== null && parseTime(plan.validUntil, 'plan.validUntil') <= now) {
    return disabled(plan, 'fallback-plan-window-closed');
  }

  const allowed = new Set(allowedModels);
  const chain = [];
  const rejections = [];

  for (const edge of plan.edges) {
    const blockedBy = evaluateHop(edge, registry, allowed, apiFamily);
    if (blockedBy === null) {
      chain.push(Object.freeze({ from: edge.from, to: edge.to }));
    } else {
      rejections.push(Object.freeze({ from: edge.from, to: edge.to, blockedBy }));
    }
  }

  const byFrom = (left, right) =>
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to);
  chain.sort(byFrom);
  rejections.sort(byFrom);

  return Object.freeze({
    disposition: 'compiled',
    enabled: chain.length > 0,
    maxDepth: WALK_DEPTH,
    onExhausted: plan.onExhausted ?? DEFAULT_ON_EXHAUSTED,
    modelSelectionIntent: plan.modelSelectionIntent ?? DEFAULT_MODEL_SELECTION_INTENT,
    substitutionNotice: plan.substitutionNotice ?? DEFAULT_SUBSTITUTION_NOTICE,
    chain: Object.freeze(chain),
    rejections: Object.freeze(rejections),
    reasonCode: chain.length > 0 ? 'fallback-compiled' : 'fallback-no-permitted-target',
  });
}
