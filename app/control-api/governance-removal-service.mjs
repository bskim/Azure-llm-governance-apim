import {
  applyGovernanceRemoval,
  planGovernanceRemoval,
} from '../governance-domain/removal/governance-removal.mjs';

export function createGovernanceRemovalService({
  readPublishedSnapshots,
  drafts,
  clock,
}) {
  if (typeof readPublishedSnapshots !== 'function') {
    throw new TypeError('readPublishedSnapshots is required.');
  }
  if (typeof drafts?.propose !== 'function') throw new TypeError('drafts.propose is required.');
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');

  return Object.freeze({
    async plan({ target, reasonCode }) {
      const snapshots = await readPublishedSnapshots();
      return planGovernanceRemoval({ snapshots, target, reasonCode });
    },

    async propose({
      target,
      reasonCode,
      planDigest,
      selectedReferenceIds,
      authoredBy,
    }) {
      const snapshots = await readPublishedSnapshots();
      const content = {
        snapshots: applyGovernanceRemoval({
          snapshots,
          target,
          reasonCode,
          planDigest,
          selectedReferenceIds,
          at: clock.nowIso(),
        }),
      };
      const { revision } = await drafts.propose({ content, authoredBy });
      return Object.freeze({
        outcome: 'proposed',
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        state: revision.state,
      });
    },
  });
}
