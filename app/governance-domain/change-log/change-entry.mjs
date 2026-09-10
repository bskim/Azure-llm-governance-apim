import { assertNoCredentialShapedValue, assertPseudonymousActor } from '../privacy/record-safety.mjs';

/**
 * A change entry: who changed what, when, and why.
 *
 * This is a change log, not an evidence store. It does not carry a sequence, a hash,
 * or a link to the entry before it, because it is not defending against someone
 * rewriting the store — an administrator of this deployment can do that, and pretending
 * otherwise would put a verdict on the screen that nothing backs.
 *
 * Entries are derived from the records that already exist: the revision history the
 * publishing screen renders, and the notification ledger. Nothing writes an entry, so
 * one fact cannot come to have two accounts of itself that drift apart.
 *
 * One shape covers every source, because a reader looking at differently-shaped logs
 * cannot tell whether two lines are the same change or two changes.
 */

export const CHANGE_CATEGORIES = Object.freeze([
  'permission',
  'policy',
  'budget',
  'publish',
  'notification',
  'drift',
]);

export const ACTOR_KINDS = Object.freeze(['user', 'system']);

// Deliberately short: this says which configuration a change happened under, not what
// the traffic contained.
export const EVIDENCE_KEYS = Object.freeze([
  'configVersion',
  'requestedModelKey',
  'effectiveModelKey',
  'quality',
  'freshness',
]);

const CODE = /^[a-z][a-z0-9-]{2,63}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// An entry code carries the identifier of the record it was derived from, and a store
// key uses a separator a plain identifier does not allow.
const ENTRY_CODE = /^[A-Za-z0-9._:|-]{1,192}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function fail(message) {
  throw new TypeError(message);
}

function assertCode(value, name) {
  if (typeof value !== 'string' || !CODE.test(value)) fail(`${name} must be a bounded lower-case code.`);
}

function assertSafeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${name} must be a bounded identifier.`);
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
}

function assertEvidence(evidence) {
  if (evidence === null) return null;
  if (typeof evidence !== 'object' || Array.isArray(evidence)) fail('evidence must be an object or null.');
  for (const [key, value] of Object.entries(evidence)) {
    if (!EVIDENCE_KEYS.includes(key)) {
      // An open evidence bag is how a prompt, a token count, or a credential ends up
      // in an export six months from now.
      fail(`evidence.${key} is not an allowed change-log field.`);
    }
    // An allowlisted key is not a licence for an arbitrary value.
    if (Number.isSafeInteger(value)) continue;
    if (typeof value !== 'string' || !SAFE_ID.test(value)) {
      fail(`evidence.${key} must be a bounded identifier or an integer.`);
    }
  }
  return evidence;
}

/** Narrows evidence to the permitted fields, so no consumer has to remember to. */
export function projectChangeEvidence(evidence) {
  if (evidence === null || evidence === undefined) return null;
  const projected = {};
  for (const key of EVIDENCE_KEYS) {
    if (key in evidence) projected[key] = evidence[key];
  }
  return projected;
}

export function assertChangeEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail('entry must be an object.');
  if (typeof entry.entryCode !== 'string' || !ENTRY_CODE.test(entry.entryCode)) {
    fail('entry.entryCode must be a bounded identifier.');
  }
  if (!CHANGE_CATEGORIES.includes(entry.category)) fail('entry.category is unsupported.');
  assertCode(entry.action, 'entry.action');
  assertInstant(entry.occurredAt, 'entry.occurredAt');
  assertPseudonymousActor(entry.actorCode, 'entry.actorCode');
  assertSafeId(entry.actorCode, 'entry.actorCode');
  if (!ACTOR_KINDS.includes(entry.actorKind)) fail('entry.actorKind is unsupported.');
  assertSafeId(entry.targetCode, 'entry.targetCode');
  if (entry.version !== null && !Number.isSafeInteger(entry.version)) {
    fail('entry.version must be a whole number or null.');
  }
  if (entry.reasonCode !== null) assertCode(entry.reasonCode, 'entry.reasonCode');
  assertEvidence(entry.evidence ?? null);
  assertNoCredentialShapedValue(entry, 'entry');
  return true;
}

/** Newest first, and stable when two changes share an instant. */
export function sortChangeEntries(entries) {
  return [...entries].sort((left, right) => {
    const byTime = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    return byTime !== 0 ? byTime : left.entryCode.localeCompare(right.entryCode);
  });
}
