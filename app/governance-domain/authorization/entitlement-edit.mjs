import { AUTHORED_POLICY_RETENTION_SECONDS } from '../lifecycle/authored-policy-retention.mjs';
import { assertEntitlementPolicySnapshotV1 } from '../authorization/governance-authorization-validator.mjs';

/**
 * One binding changed, expressed as the whole snapshot.
 *
 * The same shape as a budget edit and for the same reason: a snapshot is versioned and
 * validated as a unit, so an edit produces the next version of the set rather than a
 * patch applied somewhere later. What a binding may say is decided by the snapshot's
 * own validator rather than restated here, because a second copy of those rules would
 * drift from the one authorization enforces.
 */

const EDITABLE = Object.freeze(['modelAllowlist', 'limits', 'state']);
const LIMIT_KEYS = Object.freeze(['requestsPerMinute', 'tokensPerMinute', 'tokenQuota', 'quotaPeriod']);
const TARGET_KINDS = Object.freeze(['team', 'subject', 'application']);
const REASON_CODE = /^[a-z][a-z0-9-]{2,63}$/;

export const ENTITLEMENT_EDIT_REASONS = Object.freeze({
  bindingUnknown: 'entitlement-edit-target-unknown',
  fieldUnknown: 'entitlement-edit-field-unknown',
  limitUnknown: 'entitlement-edit-limit-unknown',
  modelUnregistered: 'entitlement-edit-model-unregistered',
  allowlistEmpty: 'entitlement-edit-allowlist-empty',
  noChange: 'entitlement-edit-no-change',
  resultInvalid: 'entitlement-edit-result-invalid',
  bindingExists: 'entitlement-add-binding-exists',
  targetGoverned: 'entitlement-add-target-already-governed',
  targetKindUnsupported: 'entitlement-add-target-kind-unsupported',
  teamUnknown: 'entitlement-add-team-unknown',
  selfIssued: 'entitlement-add-self-issued',
  reasonRequired: 'entitlement-add-reason-required',
});

/** Why a caller is being brought under governance. Offered, never typed. */
export const ENTITLEMENT_GRANT_REASONS = Object.freeze([
  'individual-allowance',
  'team-exception',
  'contractor-access',
  'pilot-participant',
  'temporary-elevation',
]);

export class EntitlementEditRefusedError extends Error {
  constructor(reasonCode, detail = null) {
    super(`The entitlement edit was refused: ${reasonCode}.`);
    this.name = 'EntitlementEditRefusedError';
    this.code = reasonCode;
    this.detail = detail;
  }
}

function refuse(reasonCode, detail) {
  throw new EntitlementEditRefusedError(reasonCode, detail);
}

/**
 * @param registry - the catalogue the allowlist is checked against. An allowlist naming
 *   a model nothing serves is not a narrower entitlement, it is a caller who will be
 *   refused at the gateway for a reason no screen showed.
 */
export function editEntitlementBinding({ snapshot, bindingId, changes, registry, at, retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS }) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new TypeError('changes must be an object.');
  }
  if (registry === undefined) {
    throw new TypeError('registry must be supplied, or supplied as null when unavailable.');
  }

  const unknown = Object.keys(changes).filter((key) => !EDITABLE.includes(key));
  if (unknown.length > 0) refuse(ENTITLEMENT_EDIT_REASONS.fieldUnknown, unknown);
  if (Object.keys(changes).length === 0) refuse(ENTITLEMENT_EDIT_REASONS.noChange);

  const target = snapshot.bindings.find((binding) => binding.bindingId === bindingId);
  if (target === undefined) refuse(ENTITLEMENT_EDIT_REASONS.bindingUnknown, bindingId);

  if (Object.hasOwn(changes, 'modelAllowlist')) {
    const allowlist = changes.modelAllowlist;
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
      // Entitling nobody to anything is expressed by retiring the binding, not by an
      // empty list that reads as an allowlist somebody forgot to fill in.
      refuse(ENTITLEMENT_EDIT_REASONS.allowlistEmpty);
    }
    if (registry !== null) {
      const known = new Set(registry.models.map((model) => model.modelKey));
      const missing = allowlist.filter((modelKey) => !known.has(modelKey));
      if (missing.length > 0) refuse(ENTITLEMENT_EDIT_REASONS.modelUnregistered, missing);
    }
  }

  if (Object.hasOwn(changes, 'limits')) {
    const limits = changes.limits;
    if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
      refuse(ENTITLEMENT_EDIT_REASONS.resultInvalid, 'limits must be an object.');
    }
    const unknownLimits = Object.keys(limits).filter((key) => !LIMIT_KEYS.includes(key));
    if (unknownLimits.length > 0) refuse(ENTITLEMENT_EDIT_REASONS.limitUnknown, unknownLimits);
  }

  const edited = {
    ...target,
    bindingVersion: target.bindingVersion + 1,
    state: Object.hasOwn(changes, 'state') ? changes.state : target.state,
    modelAllowlist: Object.hasOwn(changes, 'modelAllowlist')
      ? [...changes.modelAllowlist]
      : target.modelAllowlist,
    // A quota and its period move together, so a partial limit change keeps the values
    // it did not mention rather than dropping them.
    limits: Object.hasOwn(changes, 'limits') ? { ...target.limits, ...changes.limits } : target.limits,
  };

  const next = {
    ...snapshot,
    version: snapshot.version + 1,
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + retentionSeconds * 1000).toISOString(),
    bindings: snapshot.bindings.map((binding) => (binding.bindingId === bindingId ? edited : binding)),
  };

  try {
    assertEntitlementPolicySnapshotV1(next, { evaluationTime: at });
  } catch (error) {
    refuse(ENTITLEMENT_EDIT_REASONS.resultInvalid, error.message);
  }
  return next;
}

/**
 * Bringing a caller under governance for the first time.
 *
 * Editing a binding could only change one that already existed, so a subject nobody
 * had governed yet could not be governed at all without publishing a whole set from
 * a script. A subject binding is independent of any team: it governs one person
 * whether or not they belong to a governed group, which is the case an administrator
 * reaches for when somebody needs their own allowance.
 *
 * @param issuedBy - the acting administrator, derived by the caller of this function
 *   rather than taken from a request, because a binding names who granted it.
 */
export function addEntitlementBinding({
  snapshot,
  bindingId,
  target,
  modelAllowlist,
  limits = {},
  issuedBy,
  reasonCode,
  registry,
  at,
  retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS,
}) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (registry === undefined) {
    throw new TypeError('registry must be supplied, or supplied as null when unavailable.');
  }
  if (issuedBy === undefined) {
    throw new TypeError('issuedBy must be supplied by the server, never taken from a request.');
  }
  if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
    refuse(ENTITLEMENT_EDIT_REASONS.reasonRequired);
  }
  if (target === null || typeof target !== 'object' || !TARGET_KINDS.includes(target.kind)) {
    // Global is deliberately absent: the organization-wide binding is a ceiling every
    // snapshot must already carry exactly one of, so adding another is never the act.
    refuse(ENTITLEMENT_EDIT_REASONS.targetKindUnsupported, target?.kind ?? null);
  }
  if (snapshot.bindings.some((binding) => binding.bindingId === bindingId)) {
    refuse(ENTITLEMENT_EDIT_REASONS.bindingExists, bindingId);
  }
  const governed = snapshot.bindings.find(
    (binding) => binding.target.kind === target.kind && binding.target.key === target.key,
  );
  if (governed !== undefined) {
    // One binding per target, so this is an edit of the existing one rather than a
    // second grant that would silently contend with it.
    refuse(ENTITLEMENT_EDIT_REASONS.targetGoverned, governed.bindingId);
  }
  if (target.kind === 'team') {
    const known = new Set(snapshot.teamCatalog.map((mapping) => mapping.teamKey));
    if (!known.has(target.key)) refuse(ENTITLEMENT_EDIT_REASONS.teamUnknown, target.key);
  }
  if (issuedBy.kind === 'subject' && target.kind === 'subject' && issuedBy.key === target.key) {
    refuse(ENTITLEMENT_EDIT_REASONS.selfIssued, target.key);
  }
  if (!Array.isArray(modelAllowlist) || modelAllowlist.length === 0) {
    refuse(ENTITLEMENT_EDIT_REASONS.allowlistEmpty);
  }
  if (registry !== null) {
    const known = new Set(registry.models.map((model) => model.modelKey));
    const missing = modelAllowlist.filter((modelKey) => !known.has(modelKey));
    if (missing.length > 0) refuse(ENTITLEMENT_EDIT_REASONS.modelUnregistered, missing);
  }
  const unknownLimits = Object.keys(limits).filter((key) => !LIMIT_KEYS.includes(key));
  if (unknownLimits.length > 0) refuse(ENTITLEMENT_EDIT_REASONS.limitUnknown, unknownLimits);

  const binding = {
    bindingId,
    bindingVersion: 1,
    state: 'active',
    target: { kind: target.kind, key: target.key },
    modelAllowlist: [...modelAllowlist].sort(),
    limits: { ...limits },
    validFrom: at,
    validUntil: null,
    issuedBy: { kind: issuedBy.kind, key: issuedBy.key },
    reasonCode,
  };

  const next = {
    ...snapshot,
    version: snapshot.version + 1,
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + retentionSeconds * 1000).toISOString(),
    // The validator requires the bindings sorted by identifier, so ordering is applied
    // here rather than left to the caller to remember.
    bindings: [...snapshot.bindings, binding].sort((left, right) =>
      left.bindingId < right.bindingId ? -1 : 1),
  };

  try {
    assertEntitlementPolicySnapshotV1(next, { evaluationTime: at });
  } catch (error) {
    refuse(ENTITLEMENT_EDIT_REASONS.resultInvalid, error.message);
  }
  return next;
}
