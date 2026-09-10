import { principalMembershipDocumentId } from '../governance-domain/directory/principal-membership-document.mjs';

/**
 * Membership evidence read from the store, and an honest answer when there is none.
 *
 * The distinction that matters is between "this principal belongs to no groups" and
 * "nobody has established what this principal belongs to". Both produce an empty group
 * list, and only the first is an answer. Reporting the second as the first would grant
 * whatever a no-group caller is entitled to, on evidence that was never collected.
 *
 * So an absent document is `unmapped` and an unreachable store is `source-unavailable`.
 * Neither is strict-eligible, so resolution degrades and the gateway keeps its
 * conservative default until membership is actually published.
 */

const MAX_AGE_SECONDS = 300;

function degraded({ status, reason, tenantId, subjectId, resolvedAt }) {
  return Object.freeze({
    snapshotId: `membership-${status}`,
    status,
    source: 'control-plane',
    tenantId,
    subjectId,
    resolvedAt,
    expiresAt: new Date(Date.parse(resolvedAt) + MAX_AGE_SECONDS * 1000).toISOString(),
    maxAgeSeconds: MAX_AGE_SECONDS,
    sourceRevision: 'membership-not-published',
    reason,
    groups: Object.freeze([]),
  });
}

export function createStoredMembershipResolver({ store, scopeGroupId, clock }) {
  if (typeof store?.readPrincipalMembership !== 'function') {
    throw new TypeError('store must be able to read principal membership.');
  }
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');

  return Object.freeze({
    async resolve({ tenantId, subjectId }) {
      const resolvedAt = clock.nowIso();
      // Deriving the identifier first keeps a malformed principal from being reported
      // as a store failure, which would send an operator to the wrong component.
      principalMembershipDocumentId({ scopeGroupId, tenantId, subjectId });

      let held;
      try {
        held = await store.readPrincipalMembership({
          scopeGroupId,
          tenantId,
          subjectId,
          evaluationTime: resolvedAt,
        });
      } catch {
        return degraded({
          status: 'source-unavailable',
          reason: 'membership-store-unreadable',
          tenantId,
          subjectId,
          resolvedAt,
        });
      }

      if (held === null) {
        return degraded({
          status: 'unmapped',
          reason: 'membership-not-published',
          tenantId,
          subjectId,
          resolvedAt,
        });
      }
      return held.document.memberships;
    },
  });
}
