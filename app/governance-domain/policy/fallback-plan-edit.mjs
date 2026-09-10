import { AUTHORED_POLICY_RETENTION_SECONDS } from '../lifecycle/authored-policy-retention.mjs';
import { assertFallbackPolicySnapshotV1 } from './fallback-plan-compiler.mjs';

/**
 * Changing an existing downgrade ladder and its request-time settings.
 *
 * Authoring the ladder and opting callers into it are separate decisions, which is
 * why the intent lives on the plan rather than on a request: the caller neither asks
 * for a downgrade nor is meant to notice one. So this edits the plan, and what a plan
 * may say is left to the snapshot's own validator rather than restated here.
 */

const EDITABLE = Object.freeze(['enabled', 'modelSelectionIntent', 'substitutionNotice', 'state', 'edges']);

export const FALLBACK_EDIT_REASONS = Object.freeze({
  planUnknown: 'fallback-edit-target-unknown',
  fieldUnknown: 'fallback-edit-field-unknown',
  noChange: 'fallback-edit-no-change',
  noticeRequiresPreferred: 'fallback-edit-notice-requires-preferred',
  resultInvalid: 'fallback-edit-result-invalid',
});

export class FallbackEditRefusedError extends Error {
  constructor(reasonCode, detail = null) {
    super(`The fallback edit was refused: ${reasonCode}.`);
    this.name = 'FallbackEditRefusedError';
    this.code = reasonCode;
    this.detail = detail;
  }
}

function refuse(reasonCode, detail) {
  throw new FallbackEditRefusedError(reasonCode, detail);
}

function canonicalEdges(edges) {
  if (!Array.isArray(edges)) return edges;
  if (!edges.every((edge) =>
    edge !== null
    && typeof edge === 'object'
    && !Array.isArray(edge)
    && Object.keys(edge).length === 2
    && Object.hasOwn(edge, 'from')
    && Object.hasOwn(edge, 'to')
    && typeof edge.from === 'string'
    && typeof edge.to === 'string')) {
    return edges;
  }
  return edges
    .map(({ from, to }) => ({ from, to }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
}

function sameEditableValue(key, before, after) {
  if (key !== 'edges') return before === after;
  return JSON.stringify(canonicalEdges(before)) === JSON.stringify(canonicalEdges(after));
}

export function editFallbackPlan({ snapshot, planId, changes, at, retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS }) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new TypeError('changes must be an object.');
  }
  const unknown = Object.keys(changes).filter((key) => !EDITABLE.includes(key));
  if (unknown.length > 0) refuse(FALLBACK_EDIT_REASONS.fieldUnknown, unknown);
  if (Object.keys(changes).length === 0) refuse(FALLBACK_EDIT_REASONS.noChange);

  const target = snapshot.plans.find((plan) => plan.planId === planId);
  if (target === undefined) refuse(FALLBACK_EDIT_REASONS.planUnknown, planId);

  const edited = { ...target, planVersion: target.planVersion + 1 };
  for (const key of EDITABLE) {
    if (Object.hasOwn(changes, key)) {
      edited[key] = key === 'edges' ? canonicalEdges(changes[key]) : changes[key];
    }
  }
  // An inline notice describes a substitution, so a pinned plan carrying one would
  // promise the caller a message about something that cannot happen.
  if (edited.substitutionNotice === 'inline' && edited.modelSelectionIntent !== 'preferred') {
    refuse(FALLBACK_EDIT_REASONS.noticeRequiresPreferred);
  }
  for (const key of EDITABLE) {
    if (edited[key] === undefined) delete edited[key];
  }
  if (
    Object.keys(changes).every((key) =>
      sameEditableValue(key, target[key], edited[key]))
  ) {
    refuse(FALLBACK_EDIT_REASONS.noChange);
  }

  const next = {
    ...snapshot,
    version: snapshot.version + 1,
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + retentionSeconds * 1000).toISOString(),
    plans: snapshot.plans.map((plan) => (plan.planId === planId ? edited : plan)),
  };

  try {
    assertFallbackPolicySnapshotV1(next, { evaluationTime: at });
  } catch (error) {
    refuse(FALLBACK_EDIT_REASONS.resultInvalid, error.message);
  }
  return next;
}
