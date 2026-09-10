import {
  assertEntitlementPolicySnapshotV1,
  assertGovernanceAssignmentSnapshotV1,
} from '../authorization/governance-authorization-validator.mjs';
import { assertBudgetSnapshotV1, upgradeLegacyBudgetSnapshotV1 } from './budget-publication.mjs';
import { assertFallbackPolicySnapshotV1 } from './fallback-plan-compiler.mjs';
import { assertModelRegistrySnapshotV1 } from '../registry/model-registry-validator.mjs';

/**
 * The five inputs that decide what a caller may do, as stored documents.
 *
 * They are five documents rather than one, so that an administrator editing budgets
 * does not collide with one editing the model registry for no reason beyond storage
 * layout, and so that a narrow change stays narrow in the audit trail.
 *
 * Each snapshot already has a validator, and each validator fixes an exact key set, so
 * the store's own fields wrap the snapshot rather than joining it.
 */

const DOCUMENT_TYPE = 'governance-snapshot';

const VALIDATORS = Object.freeze({
  assignment: assertGovernanceAssignmentSnapshotV1,
  entitlement: assertEntitlementPolicySnapshotV1,
  modelRegistry: assertModelRegistrySnapshotV1,
  fallbackPolicy: assertFallbackPolicySnapshotV1,
  budget: assertBudgetSnapshotV1,
});

/** The property each kind carries in the resolved set the application already passes around. */
const SNAPSHOT_PROPERTIES = Object.freeze({
  assignment: 'assignmentSnapshot',
  entitlement: 'entitlementSnapshot',
  modelRegistry: 'modelRegistrySnapshot',
  fallbackPolicy: 'fallbackPolicySnapshot',
  budget: 'budgetSnapshot',
});

export const GOVERNANCE_SNAPSHOT_KINDS = Object.freeze(Object.keys(VALIDATORS));
export const GOVERNANCE_SNAPSHOT_PROPERTIES = SNAPSHOT_PROPERTIES;

export function governanceSnapshotDocumentId({ scopeGroupId, kind }) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }
  if (!GOVERNANCE_SNAPSHOT_KINDS.includes(kind)) {
    throw new TypeError(`kind must be one of: ${GOVERNANCE_SNAPSHOT_KINDS.join(', ')}.`);
  }
  return `${DOCUMENT_TYPE}|${scopeGroupId}|${kind}`;
}

export function governanceSnapshotDocument({ scopeGroupId, kind, snapshot }) {
  return {
    id: governanceSnapshotDocumentId({ scopeGroupId, kind }),
    documentType: DOCUMENT_TYPE,
    scopeGroupId,
    kind,
    snapshot,
  };
}

/**
 * Runs on the way out as well as the way in. A document that was correct when written
 * and is not correct when read has been changed by something other than this code, and
 * serving it would be serving whatever that something decided.
 */
export function assertGovernanceSnapshotDocument(document, { evaluationTime } = {}) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('A governance snapshot document is required.');
  }
  const expected = ['id', 'documentType', 'scopeGroupId', 'kind', 'snapshot'];
  const present = Object.keys(document).sort();
  const missing = expected.filter((key) => !present.includes(key));
  const unknown = present.filter((key) => !expected.includes(key));
  if (missing.length > 0) throw new TypeError(`Snapshot document is missing ${missing.join(', ')}.`);
  if (unknown.length > 0) throw new TypeError(`Snapshot document carries unknown ${unknown.join(', ')}.`);

  if (document.documentType !== DOCUMENT_TYPE) {
    throw new TypeError(`documentType must be ${DOCUMENT_TYPE}.`);
  }
  const validator = VALIDATORS[document.kind];
  if (validator === undefined) {
    throw new TypeError(`kind must be one of: ${GOVERNANCE_SNAPSHOT_KINDS.join(', ')}.`);
  }
  if (document.id !== governanceSnapshotDocumentId(document)) {
    throw new TypeError('id must be derived from scopeGroupId and kind.');
  }
  if (typeof evaluationTime !== 'string' || Number.isNaN(Date.parse(evaluationTime))) {
    throw new TypeError('evaluationTime must be an ISO-8601 instant: a snapshot is validated against a clock.');
  }
  validator(document.snapshot, { evaluationTime });
  return document;
}

/**
 * Materializes the unambiguous accounting basis used by legacy persisted token budgets.
 *
 * This is deliberately separate from the strict document assertion: only persistence
 * readers call it, so new authoring and writes cannot acquire an omitted basis.
 */
export function hydratePersistedGovernanceSnapshotDocument(document, { evaluationTime } = {}) {
  const hydrated =
    document?.kind === 'budget'
      ? { ...document, snapshot: upgradeLegacyBudgetSnapshotV1(document.snapshot) }
      : document;
  return assertGovernanceSnapshotDocument(hydrated, { evaluationTime });
}

/**
 * The application resolves policy from all five at once, so a partial set is refused
 * here rather than allowed to produce a document governed by some rules and not others.
 */
export function assembleGovernanceSnapshots(documents) {
  const byKind = new Map();
  for (const document of documents) {
    if (byKind.has(document.kind)) throw new TypeError(`Two documents claim kind ${document.kind}.`);
    byKind.set(document.kind, document);
  }
  const absent = GOVERNANCE_SNAPSHOT_KINDS.filter((kind) => !byKind.has(kind));
  if (absent.length > 0) {
    const failure = new TypeError(`The published snapshot set is missing: ${absent.join(', ')}.`);
    failure.code = 'published-policy-source-incomplete';
    failure.absentKinds = Object.freeze(absent);
    throw failure;
  }
  const assembled = {};
  for (const kind of GOVERNANCE_SNAPSHOT_KINDS) {
    assembled[SNAPSHOT_PROPERTIES[kind]] = byKind.get(kind).snapshot;
  }
  return assembled;
}
