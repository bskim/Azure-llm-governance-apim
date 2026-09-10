import { AUTHORED_POLICY_RETENTION_SECONDS } from '../lifecycle/authored-policy-retention.mjs';
import { assertEntitlementPolicySnapshotV1 } from './governance-authorization-validator.mjs';

/**
 * Which directory group is which governed team, expressed as the whole snapshot.
 *
 * The catalogue is what turns a group in the identity provider into a team this
 * product governs. Until this module existed there was no way to author it: a team
 * could only be introduced by publishing an entire governance set from a script, so
 * onboarding a team was a developer task rather than an administrative one.
 *
 * Membership is deliberately not here. Who belongs to a team is answered by the
 * caller's own credential, so the directory owns it and a second store would be a
 * competing answer to a question that already has one.
 */

const REASON_CODE = /^[a-z][a-z0-9-]{2,63}$/;

export const TEAM_CATALOG_EDIT_REASONS = Object.freeze({
  duplicateTeam: 'team-catalog-duplicate-team',
  groupAlreadyMapped: 'team-catalog-group-already-mapped',
  teamUnknown: 'team-catalog-team-unknown',
  teamInUse: 'team-catalog-team-in-use',
  reasonRequired: 'team-catalog-reason-required',
  resultInvalid: 'team-catalog-result-invalid',
});

/** Why a team is leaving the catalogue. Offered, never typed. */
export const TEAM_REMOVAL_REASONS = Object.freeze([
  'team-dissolved',
  'team-merged',
  'team-renamed',
  'group-replaced',
  'no-longer-governed',
]);

export class TeamCatalogEditRefusedError extends Error {
  constructor(reasonCode, detail = null) {
    super(`The team catalogue edit was refused: ${reasonCode}.`);
    this.name = 'TeamCatalogEditRefusedError';
    this.code = reasonCode;
    this.detail = detail;
  }
}

function refuse(reasonCode, detail) {
  throw new TeamCatalogEditRefusedError(reasonCode, detail);
}

function assertInstant(at) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
}

function nextSnapshot(snapshot, teamCatalog, at, retentionSeconds) {
  const next = {
    ...snapshot,
    version: snapshot.version + 1,
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + retentionSeconds * 1000).toISOString(),
    // The validator requires the catalogue sorted by team key, so ordering is applied
    // here rather than left to the caller to remember.
    teamCatalog: [...teamCatalog].sort((left, right) => (left.teamKey < right.teamKey ? -1 : 1)),
  };
  try {
    assertEntitlementPolicySnapshotV1(next, { evaluationTime: at });
  } catch (error) {
    refuse(TEAM_CATALOG_EDIT_REASONS.resultInvalid, error.message);
  }
  return next;
}

export function addTeam({ snapshot, teamKey, membershipGroupId, at, retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS }) {
  assertInstant(at);
  const catalogue = snapshot.teamCatalog;
  if (catalogue.some((mapping) => mapping.teamKey === teamKey)) {
    refuse(TEAM_CATALOG_EDIT_REASONS.duplicateTeam, teamKey);
  }
  // One group naming two teams would make every member of it ambiguous, which is a
  // refusal at request time rather than anything a screen would show.
  const claimed = catalogue.find((mapping) => mapping.membershipGroupId === membershipGroupId);
  if (claimed !== undefined) {
    refuse(TEAM_CATALOG_EDIT_REASONS.groupAlreadyMapped, claimed.teamKey);
  }
  return nextSnapshot(snapshot, [...catalogue, { teamKey, membershipGroupId }], at, retentionSeconds);
}

export function removeTeam({ snapshot, teamKey, reasonCode, at, retentionSeconds = AUTHORED_POLICY_RETENTION_SECONDS }) {
  assertInstant(at);
  if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
    refuse(TEAM_CATALOG_EDIT_REASONS.reasonRequired);
  }
  if (!snapshot.teamCatalog.some((mapping) => mapping.teamKey === teamKey)) {
    refuse(TEAM_CATALOG_EDIT_REASONS.teamUnknown, teamKey);
  }
  // Any binding at all, not only an active one: the snapshot validator refuses a
  // binding naming an uncatalogued team whatever its state, so leaving one behind
  // would make the whole set unpublishable rather than just that team unreachable.
  const referencing = snapshot.bindings
    .filter((binding) => binding.target.kind === 'team' && binding.target.key === teamKey)
    .map((binding) => binding.bindingId);
  if (referencing.length > 0) refuse(TEAM_CATALOG_EDIT_REASONS.teamInUse, referencing);

  return nextSnapshot(
    snapshot,
    snapshot.teamCatalog.filter((mapping) => mapping.teamKey !== teamKey),
    at,
    retentionSeconds,
  );
}
