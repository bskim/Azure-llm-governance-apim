import { assertChangeEntry, sortChangeEntries } from './change-entry.mjs';

/**
 * The change log, derived from the records that already exist.
 *
 * Nothing writes an entry. The publishing screen renders a revision's history and this
 * reads the same history, so the two cannot come to disagree — which is exactly what a
 * second, separately written copy of the same fact would eventually do.
 *
 * A revision says which snapshots a publication touched, and that is what names the
 * category: a publication that wrote the budget snapshot is a budget change, whoever
 * happened to approve it.
 */

const CATEGORY_BY_TARGET = Object.freeze({
  'governance-snapshot-assignment': 'permission',
  'governance-snapshot-entitlement': 'permission',
  'principal-membership': 'permission',
  'governance-snapshot-modelRegistry': 'policy',
  'governance-snapshot-fallbackPolicy': 'policy',
  'governance-snapshot-budget': 'budget',
});

const DRIFT_KINDS = new Set(['usage-drift-detected', 'usage-drift-unverifiable']);

// A lifecycle transition is a change to the configuration's state, whatever it carried.
const PUBLISH_ACTIONS = Object.freeze({
  create: 'revision-created',
  edit: 'revision-edited',
  approve: 'revision-approved',
  withdraw: 'revision-withdrawn',
  publish: 'publish-started',
  complete: 'revision-published',
  fail: 'publish-failed',
  retry: 'publish-retried',
  supersede: 'revision-superseded',
});

function fail(message) {
  throw new TypeError(message);
}

function entriesForRevision(revision) {
  const entries = [];
  const history = Array.isArray(revision.history) ? revision.history : [];

  for (const [index, transition] of history.entries()) {
    if (transition.command === 'target-outcome') {
      // The reducer records the target in the actor field of this transition; the
      // actor is the publisher, not a person. One entry per target the publication
      // touched, so the reader sees which part of governance moved rather than only
      // that something did. A target this map does not name is still a publication
      // step, not nothing.
      const targetCode = transition.actor;
      entries.push({
        entryCode: `change-${revision.revisionCode ?? revision.revisionId}-${index}`,
        category: CATEGORY_BY_TARGET[targetCode] ?? 'publish',
        action: `target-${transition.to ?? 'written'}`,
        occurredAt: transition.at,
        actorCode: 'governance-publisher',
        actorKind: 'system',
        targetCode,
        version: revision.revisionNumber ?? null,
        reasonCode: transition.reasonCode ?? null,
        evidence: { configVersion: revision.revisionNumber ?? null },
      });
      continue;
    }

    const action = PUBLISH_ACTIONS[transition.command];
    if (action === undefined) continue;
    entries.push({
      entryCode: `change-${revision.revisionCode ?? revision.revisionId}-${index}`,
      category: 'publish',
      action,
      occurredAt: transition.at,
      actorCode: transition.actor,
      actorKind: 'user',
      targetCode: revision.revisionCode ?? revision.revisionId,
      version: revision.revisionNumber ?? null,
      reasonCode: transition.reasonCode ?? null,
      evidence: { configVersion: revision.revisionNumber ?? null },
    });
  }
  return entries;
}

function entryForNotification(notification) {
  return {
    entryCode: `change-notification-${notification.key ?? notification.notificationCode}`,
    category: DRIFT_KINDS.has(notification.kind) ? 'drift' : 'notification',
    action: notification.kind,
    occurredAt: notification.raisedAt,
    // Nobody raised it; a schedule observed something and said so.
    actorCode: 'governance-schedule',
    actorKind: 'system',
    targetCode: notification.scopeKey ?? notification.scope ?? 'organization',
    version: null,
    reasonCode: notification.reasonCode ?? null,
    evidence: null,
  };
}

export function deriveChangeEntries({ revisions = [], notifications = [] } = {}) {
  if (!Array.isArray(revisions)) fail('revisions must be an array.');
  if (!Array.isArray(notifications)) fail('notifications must be an array.');

  const entries = [
    ...revisions.flatMap((revision) => entriesForRevision(revision)),
    ...notifications.map((notification) => entryForNotification(notification)),
  ].map((entry) => Object.freeze({ ...entry, evidence: entry.evidence ?? null }));

  for (const entry of entries) assertChangeEntry(entry);
  return Object.freeze(sortChangeEntries(entries));
}
