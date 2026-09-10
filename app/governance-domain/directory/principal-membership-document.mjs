import { assertMembershipEvidence } from '../principal-context/principal-context-validator.mjs';

/**
 * Membership evidence for one principal, as a stored document.
 *
 * Authorization asks which groups a caller belongs to, and nothing in a deployment
 * could answer that: the directory snapshot is a projection for a screen, carrying
 * relation counts against pseudonymous record keys rather than the group identifiers
 * an entitlement binds to. This is the document that answers it.
 *
 * It is deliberately per principal rather than one directory-wide document, because a
 * caller's resolution must not wait on, or be invalidated by, everyone else's.
 */

const DOCUMENT_TYPE = 'principal-membership';
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function principalMembershipDocumentId({ scopeGroupId, tenantId, subjectId }) {
  for (const [name, value] of [
    ['scopeGroupId', scopeGroupId],
    ['tenantId', tenantId],
    ['subjectId', subjectId],
  ]) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} is required.`);
  }
  return `${DOCUMENT_TYPE}|${scopeGroupId}|${tenantId}|${subjectId}`;
}

export function principalMembershipDocument({ scopeGroupId, memberships }) {
  if (memberships === null || typeof memberships !== 'object') {
    throw new TypeError('memberships is required.');
  }
  return {
    id: principalMembershipDocumentId({
      scopeGroupId,
      tenantId: memberships.tenantId,
      subjectId: memberships.subjectId,
    }),
    documentType: DOCUMENT_TYPE,
    scopeGroupId,
    tenantId: memberships.tenantId,
    subjectId: memberships.subjectId,
    memberships,
  };
}

export function assertPrincipalMembershipDocument(document, { evaluationTime } = {}) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('A principal membership document is required.');
  }
  const expected = ['id', 'documentType', 'scopeGroupId', 'tenantId', 'subjectId', 'memberships'];
  const present = Object.keys(document).sort();
  const missing = expected.filter((key) => !present.includes(key));
  const unknown = present.filter((key) => !expected.includes(key));
  if (missing.length > 0) throw new TypeError(`Membership document is missing ${missing.join(', ')}.`);
  if (unknown.length > 0) throw new TypeError(`Membership document carries unknown ${unknown.join(', ')}.`);
  if (document.documentType !== DOCUMENT_TYPE) throw new TypeError(`documentType must be ${DOCUMENT_TYPE}.`);
  if (document.id !== principalMembershipDocumentId(document)) {
    throw new TypeError('id must be derived from scopeGroupId, tenantId, and subjectId.');
  }

  assertMembershipEvidence(document.memberships, {
    subject: { tenantId: document.tenantId, subjectId: document.subjectId },
    evaluationTime,
    path: 'memberships',
  });
  return document;
}
