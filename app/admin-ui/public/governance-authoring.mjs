export const QUOTA_PERIODS = Object.freeze(['Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly']);

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REASON_CODE = /^[a-z][a-z0-9-]{2,63}$/;
const FALLBACK_DEFAULTS = Object.freeze({
  modelSelectionIntent: 'pinned',
  substitutionNotice: 'header',
});
export const MAX_FALLBACK_EDGES = 32;
const RATE_LIMITS = Object.freeze([
  ['requestsPerMinute', 1_000_000_000],
  ['tokensPerMinute', 1_000_000_000_000],
]);

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameLimits(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

function readInteger(value, { minimum, maximum, optional = true } = {}) {
  const text = String(value ?? '').trim();
  if (text.length === 0) return optional ? { ok: true, omitted: true } : { ok: false };
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum
    ? { ok: true, omitted: false, value: number }
    : { ok: false };
}

export function buildLimits(values, existing = {}) {
  const limits = {};
  for (const [name, maximum] of RATE_LIMITS) {
    const parsed = readInteger(values[name], { minimum: 0, maximum });
    if (!parsed.ok) return { ok: false, error: 'limitsInvalid' };
    if (parsed.omitted) {
      if (Object.hasOwn(existing, name)) return { ok: false, error: 'limitsRequired' };
    } else {
      limits[name] = parsed.value;
    }
  }

  const quota = readInteger(values.tokenQuota, {
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  if (!quota.ok) return { ok: false, error: 'limitsInvalid' };
  const quotaPeriod = String(values.quotaPeriod ?? '');
  if (quota.omitted !== (quotaPeriod.length === 0)) {
    return { ok: false, error: 'quotaPairRequired' };
  }
  if (quota.omitted) {
    if (Object.hasOwn(existing, 'tokenQuota') || Object.hasOwn(existing, 'quotaPeriod')) {
      return { ok: false, error: 'limitsRequired' };
    }
  } else {
    if (!QUOTA_PERIODS.includes(quotaPeriod)) return { ok: false, error: 'quotaPairRequired' };
    limits.tokenQuota = quota.value;
    limits.quotaPeriod = quotaPeriod;
  }
  return { ok: true, limits };
}

export function buildEntitlementEditPayload(binding, values) {
  const modelAllowlist = [...new Set(values.modelCodes ?? [])].sort();
  if (modelAllowlist.length === 0) return { ok: false, error: 'modelsRequired' };
  const limits = buildLimits(values, binding.limits);
  if (!limits.ok) return limits;

  const changes = {};
  if (!sameValues(modelAllowlist, [...binding.modelCodes].sort())) {
    changes.modelAllowlist = modelAllowlist;
  }
  if (!sameLimits(limits.limits, binding.limits)) changes.limits = limits.limits;
  if (Object.keys(changes).length === 0) return { ok: false, error: 'noChange' };
  return {
    ok: true,
    payload: { bindingId: binding.bindingCode, changes },
  };
}

export function buildEntitlementStatePayload(binding, nextState) {
  if (binding.targetKind === 'global') {
    return { ok: false, error: 'globalBindingRequired' };
  }
  const transitionAllowed =
    (binding.state === 'active' && nextState === 'revoked')
    || (binding.state === 'revoked' && binding.canRestore === true && nextState === 'active');
  if (!transitionAllowed) return { ok: false, error: 'bindingStateUnavailable' };
  return {
    ok: true,
    payload: {
      bindingId: binding.bindingCode,
      changes: { state: nextState },
    },
  };
}

export function buildEntitlementAddPayload(values) {
  const targetKind = String(values.targetKind ?? '');
  const targetKey = String(values.targetKey ?? '').trim();
  const bindingId = String(values.bindingId ?? '').trim() || `binding-${targetKind}-${targetKey}`;
  if (!['subject', 'team', 'application'].includes(targetKind)) {
    return { ok: false, error: 'targetKindRequired' };
  }
  if (!SAFE_ID.test(targetKey) || !SAFE_ID.test(bindingId)) {
    return { ok: false, error: 'keyRequired' };
  }
  const modelAllowlist = [...new Set(values.modelCodes ?? [])].sort();
  if (modelAllowlist.length === 0) return { ok: false, error: 'modelsRequired' };
  const limits = buildLimits(values);
  if (!limits.ok) return limits;
  return {
    ok: true,
    payload: {
      command: 'add',
      bindingId,
      target: { kind: targetKind, key: targetKey },
      modelAllowlist,
      limits: limits.limits,
      reasonCode: values.reasonCode,
    },
  };
}

export function buildAssignmentGrantPayload(values, rule) {
  const assignmentId = String(values.assignmentId ?? '').trim();
  const assigneeKey = String(values.assigneeKey ?? '').trim();
  const reasonCode = String(values.reasonCode ?? '').trim();
  if (!SAFE_ID.test(assignmentId) || !SAFE_ID.test(assigneeKey) || !REASON_CODE.test(reasonCode)) {
    return { ok: false, error: 'assignmentFieldsRequired' };
  }
  if (
    rule?.roleCode !== values.roleCode ||
    !rule.assigneeKinds.includes(values.assigneeKind) ||
    !rule.scopeKinds.includes(values.scopeKind)
  ) {
    return { ok: false, error: 'assignmentCombinationInvalid' };
  }
  const scopeKey = values.scopeKind === 'team' ? String(values.scopeKey ?? '').trim() : null;
  if (values.scopeKind === 'team' && !SAFE_ID.test(scopeKey)) {
    return { ok: false, error: 'assignmentFieldsRequired' };
  }
  return {
    ok: true,
    payload: {
      command: 'grant',
      assignmentId,
      roleCode: values.roleCode,
      assignee: { kind: values.assigneeKind, key: assigneeKey },
      scope: { kind: values.scopeKind, key: scopeKey },
      reasonCode,
    },
  };
}

function canonicalFallbackEdges(edges, modelCodes) {
  if (!Array.isArray(edges)) return { ok: false, error: 'fallbackEdgesInvalid' };
  if (edges.length > MAX_FALLBACK_EDGES) {
    return { ok: false, error: 'fallbackEdgesTooMany' };
  }
  const knownModels = Array.isArray(modelCodes) ? new Set(modelCodes) : null;
  const successors = new Map();
  const normalized = [];
  for (const edge of edges) {
    const from = String(edge?.from ?? '');
    const to = String(edge?.to ?? '');
    if (!SAFE_ID.test(from) || !SAFE_ID.test(to)) {
      return { ok: false, error: 'fallbackEdgesInvalid' };
    }
    if (knownModels !== null && (!knownModels.has(from) || !knownModels.has(to))) {
      return { ok: false, error: 'fallbackModelUnknown' };
    }
    if (from === to) return { ok: false, error: 'fallbackSelfLoop' };
    if (successors.has(from)) return { ok: false, error: 'fallbackDuplicateSource' };
    successors.set(from, to);
    normalized.push({ from, to });
  }

  for (const start of successors.keys()) {
    const visited = new Set();
    let current = start;
    while (successors.has(current)) {
      if (visited.has(current)) return { ok: false, error: 'fallbackCycle' };
      visited.add(current);
      current = successors.get(current);
    }
  }
  normalized.sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
  return { ok: true, edges: normalized };
}

export function buildFallbackEditPayload(authored, values) {
  const changes = {
    enabled: values.enabled,
    modelSelectionIntent: values.modelSelectionIntent,
    substitutionNotice: values.substitutionNotice,
  };
  let edgesUnchanged = true;
  if (Object.hasOwn(values, 'edges')) {
    const existingAliases = (authored.edges ?? []).flatMap(({ from, to }) => [from, to]);
    const modelCodes = Array.isArray(values.modelCodes)
      ? [...new Set([...values.modelCodes, ...existingAliases])]
      : undefined;
    const edges = canonicalFallbackEdges(values.edges, modelCodes);
    if (!edges.ok) return edges;
    changes.edges = edges.edges;
    const existingEdges = canonicalFallbackEdges(authored.edges ?? []);
    edgesUnchanged = existingEdges.ok && sameValues(existingEdges.edges, edges.edges);
  }
  // These optional authored fields have explicit compiler defaults. Compare against
  // their effective authored values because the select necessarily displays those
  // defaults; do not treat merely making an omitted default visible as a change.
  const existing = {
    enabled: authored.optedIn,
    modelSelectionIntent:
      authored.modelSelectionIntent ?? FALLBACK_DEFAULTS.modelSelectionIntent,
    substitutionNotice:
      authored.substitutionNotice ?? FALLBACK_DEFAULTS.substitutionNotice,
  };
  if (
    existing.enabled === changes.enabled &&
    existing.modelSelectionIntent === changes.modelSelectionIntent &&
    existing.substitutionNotice === changes.substitutionNotice &&
    edgesUnchanged
  ) {
    return { ok: false, error: 'noChange' };
  }
  return { ok: true, payload: { planId: authored.planCode, changes } };
}
