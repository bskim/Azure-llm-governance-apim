/**
 * Membership evidence for principals whose credential cannot carry it.
 *
 * A user's group claim is the strongest evidence there is: the identity provider decides
 * who is in which group at the moment it issues the token, so a principal removed from a
 * group simply stops being able to present one that says otherwise. That is why the claim
 * is preferred wherever it exists, and why nothing here replaces it.
 *
 * Microsoft Entra emits those claims for user principals only. A workload's membership is
 * equally real in the directory and merely absent from its token, so it is asked for
 * instead. The answer is a reading rather than an assertion, so unlike a claim it carries
 * a staleness budget and is trusted only for as long as that budget allows.
 *
 * What this is not is a roster. Nothing here records what an administrator believed about
 * a principal; every answer comes from the directory at the moment it is asked.
 */

const MAX_AGE_SECONDS = 300;
const GROUP_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function fail(message) {
  throw new TypeError(message);
}

function degraded({ status, reason, tenantId, subjectId, resolvedAt }) {
  return Object.freeze({
    snapshotId: `membership-${status}`,
    status,
    source: 'entra-adapter',
    tenantId,
    subjectId,
    resolvedAt,
    expiresAt: new Date(Date.parse(resolvedAt) + MAX_AGE_SECONDS * 1000).toISOString(),
    maxAgeSeconds: MAX_AGE_SECONDS,
    sourceRevision: 'directory-unread',
    reason,
    groups: Object.freeze([]),
  });
}

export function createDirectoryMembershipResolver({ claimResolver, directory, clock }) {
  if (typeof claimResolver?.resolve !== 'function') fail('claimResolver.resolve is required.');
  if (typeof directory?.readGroupIds !== 'function') fail('directory.readGroupIds is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');

  return Object.freeze({
    async resolve(request) {
      const { tenantId, subjectId, principalType } = request;
      if (principalType !== 'workload') return claimResolver.resolve(request);

      const resolvedAt = clock.nowIso();
      let groupIds;
      try {
        groupIds = await directory.readGroupIds({ principalType, subjectId });
      } catch (error) {
        // A directory that would not answer has established nothing. Reporting it as a
        // principal that belongs to no group would grant whatever such a caller is
        // entitled to, on evidence nobody gathered.
        return degraded({
          status: error?.code === 'directory-principal-absent' ? 'unmapped' : 'source-unavailable',
          reason: error?.code === 'directory-principal-absent'
            ? 'directory-principal-absent'
            : 'directory-unreadable',
          tenantId,
          subjectId,
          resolvedAt,
        });
      }

      const unique = [...new Set(groupIds)].sort();
      for (const groupId of unique) {
        if (typeof groupId !== 'string' || !GROUP_ID.test(groupId)) {
          const failure = new TypeError('The directory returned an unusable group identifier.');
          failure.reasonCode = 'membership-claim-unusable';
          throw failure;
        }
      }

      return Object.freeze({
        snapshotId: `membership-directory-${subjectId}`,
        // A workload placed in no group is an answer the directory gave, which the
        // evidence contract spells differently from belonging to several.
        status: unique.length === 0 ? 'empty-complete' : 'complete',
        source: 'entra-adapter',
        tenantId,
        subjectId,
        resolvedAt,
        expiresAt: new Date(Date.parse(resolvedAt) + MAX_AGE_SECONDS * 1000).toISOString(),
        maxAgeSeconds: MAX_AGE_SECONDS,
        sourceRevision: 'entra-transitive-member-of',
        groups: Object.freeze(unique.map((groupId) => Object.freeze({
          groupId,
          // The read walks nested groups, so which of the two a given membership is
          // was not asked and must not be asserted.
          membership: 'transitive',
          authorizationRelevant: true,
        }))),
      });
    },
  });
}
