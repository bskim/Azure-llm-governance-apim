function membershipKey({ tenantId, subjectId }) {
  return `${tenantId}:${subjectId}`;
}

export function createDeterministicMembershipResolver(snapshots) {
  const fixedSnapshots = new Map(
    snapshots.map((snapshot) => [
      membershipKey(snapshot),
      structuredClone(snapshot.memberships),
    ]),
  );

  return Object.freeze({
    async resolve(identity) {
      const snapshot = fixedSnapshots.get(membershipKey(identity));
      if (!snapshot) {
        throw new Error('membership-snapshot-not-found');
      }
      return structuredClone(snapshot);
    },
  });
}