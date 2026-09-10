/**
 * Membership evidence taken from the caller's own token.
 *
 * A published roster records what an administrator believed about a principal when
 * they last published; the directory records what is true now. When someone leaves,
 * only the second changes, so a roster keeps admitting them until it is republished.
 * Group claims move that answer onto the credential itself: the identity provider
 * decides who is in which group at the moment it issues the token, and a principal who
 * has been removed simply stops being able to present one that says otherwise.
 *
 * This resolver therefore reports `complete` -- the claim is an answer, not a cached
 * observation -- and it is authoritative for exactly as long as the token is, which is
 * why its lifetime comes from the credential rather than from a staleness budget.
 */

const GROUP_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function createTokenClaimsMembershipResolver({ clock }) {
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');

  return Object.freeze({
    async resolve({ tenantId, subjectId, directoryGroups, credentialExpiresAt }) {
      // An absent argument is not an empty group list. A caller assigned to the
      // application directly rather than through a group legitimately has none, and
      // that must not read the same as a gateway that forwarded nothing.
      if (!Array.isArray(directoryGroups)) {
        throw new TypeError('directoryGroups is required.');
      }
      if (typeof credentialExpiresAt !== 'string') {
        throw new TypeError('credentialExpiresAt is required.');
      }
      const resolvedAt = clock.nowIso();
      const expiresAt = Date.parse(credentialExpiresAt) > Date.parse(resolvedAt)
        ? credentialExpiresAt
        : resolvedAt;

      const groupIds = [...new Set(directoryGroups)].sort();
      for (const groupId of groupIds) {
        if (typeof groupId !== 'string' || !GROUP_ID.test(groupId)) {
          const failure = new TypeError('directoryGroups carries an unusable group identifier.');
          failure.reasonCode = 'membership-claim-unusable';
          throw failure;
        }
      }

      return Object.freeze({
        snapshotId: `membership-claim-${subjectId}`,
        // A principal assigned to the application directly belongs to no group, which is
        // an answer the evidence contract spells differently from belonging to several.
        status: groupIds.length === 0 ? 'empty-complete' : 'complete',
        source: 'directory-claim',
        tenantId,
        subjectId,
        resolvedAt,
        expiresAt,
        maxAgeSeconds: Math.max(
          1,
          Math.ceil((Date.parse(expiresAt) - Date.parse(resolvedAt)) / 1000),
        ),
        sourceRevision: 'entra-group-claim',
        groups: Object.freeze(groupIds.map((groupId) => Object.freeze({
          groupId,
          membership: 'direct',
          authorizationRelevant: true,
        }))),
      });
    },
  });
}
