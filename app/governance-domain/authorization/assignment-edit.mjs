import { AUTHORED_POLICY_RETENTION_SECONDS } from '../lifecycle/authored-policy-retention.mjs';
import {
  GOVERNANCE_ASSIGNMENT_RULES,
  assertGovernanceAssignmentSnapshotV1,
} from './governance-authorization-validator.mjs';

/**
 * Who holds which governance role, expressed as the whole snapshot.
 *
 * Granting and revoking are separate acts rather than one edit with a state field,
 * because they are different decisions with different evidence: a grant names who is
 * being trusted with what, and a revocation names something that was true and no
 * longer is. A revocation keeps the record and marks it revoked rather than deleting
 * it, so the trail still shows the access that existed.
 */

export const ASSIGNMENT_EDIT_REASONS = Object.freeze({
  assignmentUnknown: 'assignment-edit-target-unknown',
  alreadyRevoked: 'assignment-edit-already-revoked',
  duplicateGrant: 'assignment-edit-duplicate-grant',
  reasonRequired: 'assignment-edit-reason-required',
  resultInvalid: 'assignment-edit-result-invalid',
});

export const ASSIGNMENT_GRANT_RULES = GOVERNANCE_ASSIGNMENT_RULES;

const REASON_CODE = /^[a-z][a-z0-9-]{2,63}$/;

export class AssignmentEditRefusedError extends Error {
  constructor(reasonCode, detail = null) {
    super(`The assignment edit was refused: ${reasonCode}.`);
    this.name = 'AssignmentEditRefusedError';
    this.code = reasonCode;
    this.detail = detail;
  }
}

function refuse(reasonCode, detail) {
  throw new AssignmentEditRefusedError(reasonCode, detail);
}

function assertInstant(at) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
}

function nextSnapshot(snapshot, assignments, at, retentionSeconds) {
  const next = {
    ...snapshot,
    version: snapshot.version + 1,
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + retentionSeconds * 1000).toISOString(),
    // The validator requires the records sorted and unique by identifier, so a grant
    // takes its place in the order rather than being appended.
    assignments: [...assignments].sort((left, right) =>
      left.assignmentId.localeCompare(right.assignmentId)),
  };
  try {
    assertGovernanceAssignmentSnapshotV1(next, { evaluationTime: at });
  } catch (error) {
    refuse(ASSIGNMENT_EDIT_REASONS.resultInvalid, error.message);
  }
  return next;
}

export function grantAssignment({
  snapshot,
  assignmentId,
  roleCode,
  assignee,
  scope,
  issuedBy,
  reasonCode,
  at,
  retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS,
}) {
  assertInstant(at);
  // A grant with a stock explanation is an audit record that says nothing. The role,
  // the principal, and the reason are the three things an auditor asks for.
  if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
    refuse(ASSIGNMENT_EDIT_REASONS.reasonRequired);
  }
  if (snapshot.assignments.some((assignment) => assignment.assignmentId === assignmentId)) {
    refuse(ASSIGNMENT_EDIT_REASONS.duplicateGrant, assignmentId);
  }
  // The validator refuses a duplicate role for the same principal and scope, but the
  // reason it gives is about the snapshot. Naming it here says what the operator did.
  const duplicate = snapshot.assignments.some(
    (assignment) =>
      assignment.state === 'active' &&
      assignment.roleCode === roleCode &&
      assignment.assignee.kind === assignee?.kind &&
      assignment.assignee.key === assignee?.key &&
      assignment.scope.kind === scope?.kind &&
      assignment.scope.key === (scope?.key ?? null),
  );
  if (duplicate) refuse(ASSIGNMENT_EDIT_REASONS.duplicateGrant, roleCode);

  const granted = {
    assignmentId,
    assignmentVersion: 1,
    state: 'active',
    roleCode,
    assignee,
    scope,
    validFrom: at,
    validUntil: null,
    issuedBy,
    reasonCode,
  };
  return nextSnapshot(snapshot, [...snapshot.assignments, granted], at, retentionSeconds);
}

export function revokeAssignment({ snapshot, assignmentId, reasonCode, at, retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS }) {
  assertInstant(at);
  if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
    refuse(ASSIGNMENT_EDIT_REASONS.reasonRequired);
  }
  const target = snapshot.assignments.find((assignment) => assignment.assignmentId === assignmentId);
  if (target === undefined) refuse(ASSIGNMENT_EDIT_REASONS.assignmentUnknown, assignmentId);
  if (target.state === 'revoked') refuse(ASSIGNMENT_EDIT_REASONS.alreadyRevoked, assignmentId);

  const revoked = {
    ...target,
    assignmentVersion: target.assignmentVersion + 1,
    state: 'revoked',
    // The record keeps the window it was valid for, so the trail still shows the
    // access that existed rather than access that was never granted.
    validUntil: at,
    reasonCode,
  };
  return nextSnapshot(
    snapshot,
    snapshot.assignments.map((assignment) =>
      (assignment.assignmentId === assignmentId ? revoked : assignment)),
    at,
    retentionSeconds,
  );
}
