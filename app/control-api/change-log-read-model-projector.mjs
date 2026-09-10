import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';
import { assertBodyFreeReadModel } from './admin-read-model-projector.mjs';
import { assertNoCredentialShapedValue, assertPseudonymousActor } from '../governance-domain/privacy/record-safety.mjs';
import { CHANGE_CATEGORIES, projectChangeEvidence } from '../governance-domain/change-log/change-entry.mjs';

/**
 * The change log a reader sees, and the copy they may take away.
 *
 * There is no linkage verdict here. This is a record of what changed, derived from the
 * revisions and notifications that already exist; it is not evidence against someone
 * who can rewrite the store, and a verdict on the screen would say otherwise.
 *
 * What leaves in an export is an allowlist rather than a redaction pass, because a
 * denylist has to anticipate every field a later change adds, and the field nobody
 * thought to deny is the one that leaks.
 */

const SAFE_READ_MODEL_KEYS = new Set([
  'readModelVersion',
  'generatedAt',
  'readModelId',
  'quality',
  'summary',
  'records',
  'export',
  'selection',
]);

const EXPORT_ROW_KEYS = Object.freeze([
  'entryCode',
  'occurredAt',
  'category',
  'action',
  'actorCode',
  'actorKind',
  'targetCode',
  'version',
  'reasonCode',
  'evidence',
]);

// A self-scoped reader gets the changes to their own configuration surface, not the
// organization's permission and publication history.
const VISIBLE_CATEGORIES = Object.freeze({
  global: null,
  team: null,
  self: Object.freeze(['budget', 'notification', 'policy']),
});

// Taking a copy away is a separate act from reading on a screen: the copy leaves the
// product's access controls behind.
export const EXPORTING_ROLES = Object.freeze(['auditor', 'governance-admin', 'platform-operator']);

function fail(code, detail = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, detail);
  throw error;
}

export function resolveExportPermission(authorization) {
  const roles = Array.isArray(authorization?.effectiveRoles) ? authorization.effectiveRoles : [];
  return roles.some((role) => EXPORTING_ROLES.includes(role));
}

function projectRecord(entry) {
  // The screen is where a value reaches a person, so the guards run here and not only
  // where the entry was derived: a store is mutable and a derivation is not evidence
  // about what came back out of it.
  assertPseudonymousActor(entry.actorCode);
  const record = {
    entryCode: entry.entryCode,
    occurredAt: entry.occurredAt,
    category: entry.category,
    action: entry.action,
    actorCode: entry.actorCode,
    actorKind: entry.actorKind,
    targetCode: entry.targetCode,
    version: entry.version,
    reasonCode: entry.reasonCode,
    evidence: projectChangeEvidence(entry.evidence),
  };
  assertNoCredentialShapedValue(record, 'record');
  return record;
}

export function buildChangeLogExport({ entries, authorization, selection, generatedAt }) {
  if (!Array.isArray(entries)) fail('export-entries-required');
  if (
    authorization?.contractVersion !== 'v1' ||
    authorization.readAuthority !== 'authoritative' ||
    !Array.isArray(authorization.permittedReadScopes)
  ) {
    fail('membership-not-authoritative');
  }
  if (!authorization.permittedReadScopes.includes(selection.scope)) fail('scope-denied');
  if (!Object.hasOwn(VISIBLE_CATEGORIES, selection.scope)) fail('scope-not-supported');
  if (!resolveExportPermission(authorization)) fail('export-not-permitted');

  const permitted = VISIBLE_CATEGORIES[selection.scope];
  const visible = entries.filter((entry) => permitted === null || permitted.includes(entry.category));
  const rows = visible.map((entry) => {
    const row = projectRecord(entry);
    for (const key of Object.keys(row)) {
      if (!EXPORT_ROW_KEYS.includes(key)) fail('export-field-refused', { field: key });
    }
    return Object.freeze(row);
  });

  return Object.freeze({
    contractVersion: 'v1',
    documentType: 'change-log-export',
    manifest: Object.freeze({
      generatedAt,
      scope: selection.scope,
      teamKey: selection.scope === 'team' ? selection.teamKey : null,
      rowCount: rows.length,
      categories: permitted === null ? 'all' : [...permitted],
      // Named as classes rather than as the field names themselves: a disclosure that
      // repeats the forbidden words trips every guard that looks for them.
      excluded: Object.freeze(['message-bodies', 'token-counts', 'credentials']),
      retained: Object.freeze([...EXPORT_ROW_KEYS]),
    }),
    rows: Object.freeze(rows),
  });
}

export function projectChangeLog({ authorization, entries, selection }) {
  assertAuthorizedReadScope({
    authorization,
    scope: selection.scope,
    teamKey: selection.teamKey,
  });
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array.');

  const permitted = VISIBLE_CATEGORIES[selection.scope] ?? null;
  const visible = entries.filter((entry) => permitted === null || permitted.includes(entry.category));

  const byCategory = CHANGE_CATEGORIES.map((category) => ({
    category,
    count: visible.filter((entry) => entry.category === category).length,
  })).filter((entry) => entry.count > 0);

  const exportPermitted = resolveExportPermission(authorization);

  const readModel = {
    readModelVersion: 'change-log.v1',
    generatedAt: selection.generatedAt,
    readModelId: `change-log-${selection.scope}-${selection.teamKey ?? 'none'}`,
    quality: {
      // Whether the reader is seeing everything there is, which is the only
      // completeness claim this screen can honestly make.
      state: permitted === null ? 'complete' : 'partial',
      reasonCode: permitted === null ? 'change-log-read' : 'categories-limited-by-scope',
      categories: permitted === null ? 'all' : [...permitted],
    },
    summary: {
      total: visible.length,
      // Entries are newest first, so the newest is the first one.
      lastAt: visible.length === 0 ? null : visible[0].occurredAt,
      firstAt: visible.length === 0 ? null : visible.at(-1).occurredAt,
      byCategory,
    },
    export: {
      permitted: exportPermitted,
      reasonCode: exportPermitted ? 'export-permitted' : 'export-not-permitted',
      manifest: exportPermitted
        ? buildChangeLogExport({ entries, authorization, selection, generatedAt: selection.generatedAt }).manifest
        : null,
    },
    records: visible.map((entry) => projectRecord(entry)),
    selection: {
      scope: selection.scope,
      teamKey: selection.scope === 'team' ? selection.teamKey : null,
    },
  };

  assertBodyFreeReadModel(readModel, SAFE_READ_MODEL_KEYS);
  return readModel;
}
