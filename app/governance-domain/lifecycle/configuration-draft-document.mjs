import {
  GOVERNANCE_SNAPSHOT_KINDS,
  GOVERNANCE_SNAPSHOT_PROPERTIES,
} from '../policy/governance-snapshot-document.mjs';

/**
 * What a revision proposes, stored apart from what happened to it.
 *
 * A revision is the audit record: it says who authored, who approved, and how each
 * target ended. The proposed content is none of those things, and it is read on every
 * lifecycle screen load and every publish concurrency check, so carrying several
 * kilobytes of policy inside it would make every state transition pay for a payload
 * only the publish step reads.
 *
 * Splitting them admits a torn state - a revision whose draft was never written. That
 * is why the absence has a named reason rather than an empty publish: content that is
 * missing must stop a revision, never quietly become a governance set with nothing in
 * it.
 */

const DOCUMENT_TYPE = 'configuration-draft';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const RAW_PRINCIPAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DRAFT_REASONS = Object.freeze({
  contentAbsent: 'draft-content-absent',
  contentIncomplete: 'draft-content-incomplete',
  contentUnreadable: 'draft-content-unreadable',
});

const EXPECTED_KEYS = Object.freeze([
  'id',
  'documentType',
  'scopeGroupId',
  'revisionId',
  'content',
  'authoredBy',
  'authoredAt',
]);

function fail(message) {
  throw new TypeError(message);
}

function assertId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${name} must be a bounded identifier.`);
  if (RAW_PRINCIPAL.test(value)) fail(`${name} must not be a directory object identifier.`);
}

export function configurationDraftDocumentId({ scopeGroupId, revisionId }) {
  assertId(scopeGroupId, 'scopeGroupId');
  assertId(revisionId, 'revisionId');
  return `${DOCUMENT_TYPE}|${scopeGroupId}|${revisionId}`;
}

/**
 * Structural completeness only. Whether each snapshot is servable depends on a clock,
 * and the publisher already decides that against the clock at publish time; deciding it
 * here would either judge a proposal by the wrong moment or invite publishing without
 * judging it again.
 */
export function assertPublishableContent(content, path = 'content') {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    fail(`${path} must be an object.`);
  }
  const present = Object.keys(content).sort();
  const unknown = present.filter((key) => !['snapshots', 'memberships'].includes(key));
  if (unknown.length > 0) fail(`${path} carries unknown ${unknown.join(', ')}.`);

  const { snapshots } = content;
  if (snapshots === null || typeof snapshots !== 'object' || Array.isArray(snapshots)) {
    fail(`${path}.snapshots must be an object.`);
  }
  const expectedProperties = GOVERNANCE_SNAPSHOT_KINDS.map((kind) => GOVERNANCE_SNAPSHOT_PROPERTIES[kind]);
  const absent = expectedProperties.filter((property) => {
    const snapshot = snapshots[property];
    return snapshot === null || snapshot === undefined;
  });
  if (absent.length > 0) {
    throw Object.assign(new TypeError(`${path}.snapshots is missing ${absent.join(', ')}.`), {
      code: DRAFT_REASONS.contentIncomplete,
      absentProperties: Object.freeze(absent),
    });
  }
  const unknownSnapshots = Object.keys(snapshots).filter((key) => !expectedProperties.includes(key));
  if (unknownSnapshots.length > 0) fail(`${path}.snapshots carries unknown ${unknownSnapshots.join(', ')}.`);

  // Membership is directory-derived evidence, not something an operator authors, so a
  // proposal that only changes policy leaves it out rather than republishing a copy
  // that was already stale when the edit began. Which targets a publish must cover is
  // declared by the revision.
  if (Object.hasOwn(content, 'memberships')) {
    if (!Array.isArray(content.memberships) || content.memberships.length === 0) {
      throw Object.assign(new TypeError(`${path}.memberships must list at least one principal when present.`), {
        code: DRAFT_REASONS.contentIncomplete,
        absentProperties: Object.freeze(['memberships']),
      });
    }
  }
  return true;
}

/**
 * A draft records exactly what an author submitted, including a set that may later
 * fail target validation. Publishing still validates every snapshot; retaining this
 * bounded shape lets an author withdraw and replace an invalid proposal safely.
 */
export function assertStorableProposalContent(content, path = 'content') {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    fail(`${path} must be an object.`);
  }
  const present = Object.keys(content).sort();
  const unknown = present.filter((key) => !['snapshots', 'memberships'].includes(key));
  if (unknown.length > 0) fail(`${path} carries unknown ${unknown.join(', ')}.`);
  if (content.snapshots === null || typeof content.snapshots !== 'object' || Array.isArray(content.snapshots)) {
    fail(`${path}.snapshots must be an object.`);
  }
  if (Object.hasOwn(content, 'memberships')
      && (!Array.isArray(content.memberships) || content.memberships.length === 0)) {
    fail(`${path}.memberships must list at least one principal when present.`);
  }
  return true;
}

export function configurationDraftDocument({ scopeGroupId, revisionId, content, authoredBy, authoredAt }) {
  return {
    id: configurationDraftDocumentId({ scopeGroupId, revisionId }),
    documentType: DOCUMENT_TYPE,
    scopeGroupId,
    revisionId,
    content,
    authoredBy,
    authoredAt,
  };
}

export function assertConfigurationDraftDocument(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail('A configuration draft document is required.');
  }
  const present = Object.keys(document).sort();
  const missing = EXPECTED_KEYS.filter((key) => !present.includes(key));
  const unknown = present.filter((key) => !EXPECTED_KEYS.includes(key));
  if (missing.length > 0) fail(`Draft document is missing ${missing.join(', ')}.`);
  if (unknown.length > 0) fail(`Draft document carries unknown ${unknown.join(', ')}.`);

  if (document.documentType !== DOCUMENT_TYPE) fail(`documentType must be ${DOCUMENT_TYPE}.`);
  assertId(document.scopeGroupId, 'scopeGroupId');
  assertId(document.revisionId, 'revisionId');
  assertId(document.authoredBy, 'authoredBy');
  if (typeof document.authoredAt !== 'string' || Number.isNaN(Date.parse(document.authoredAt))) {
    fail('authoredAt must be an ISO-8601 instant.');
  }
  if (document.id !== configurationDraftDocumentId(document)) {
    fail('id must be derived from scopeGroupId and revisionId.');
  }
  assertStorableProposalContent(document.content);
  return true;
}

export const CONFIGURATION_DRAFT_DOCUMENT_TYPE = DOCUMENT_TYPE;
