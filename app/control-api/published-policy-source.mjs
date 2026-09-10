import {
  assembleGovernanceSnapshots,
  GOVERNANCE_SNAPSHOT_KINDS,
} from '../governance-domain/policy/governance-snapshot-document.mjs';

/**
 * Governance read from what was published, or nothing at all.
 *
 * The deployed gateway keeps an explicit conservative default for the case where the
 * control plane cannot answer. This source preserves that default by construction: any
 * outcome short of five valid snapshots is reported as unavailable, so there is no
 * arrangement of stored documents that produces a partially governed request.
 *
 * That distinction is the point. A request governed by some of the rules and not others
 * looks exactly like one governed by all of them, and is worse than a request governed
 * conservatively, because nothing downstream can tell them apart.
 */

export const PUBLISHED_POLICY_REASONS = Object.freeze({
  unreadable: 'published-policy-source-unreadable',
  incomplete: 'published-policy-source-incomplete',
  invalid: 'published-policy-source-invalid',
});

export class PolicySourceUnavailableError extends Error {
  constructor(reasonCode, detail = {}) {
    super('published-policy-source-unavailable');
    this.name = 'PolicySourceUnavailableError';
    this.reasonCode = reasonCode;
    Object.assign(this, detail);
  }
}

export function createPublishedPolicySource({ store, scopeGroupId, clock }) {
  if (typeof store?.queryGovernanceSnapshots !== 'function') {
    throw new TypeError('store must be able to query governance snapshots.');
  }
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');

  return async function readPublishedSnapshots() {
    const evaluationTime = clock.nowIso();

    let documents;
    try {
      documents = await store.queryGovernanceSnapshots({ scopeGroupId, evaluationTime });
    } catch (error) {
      // A document that no longer validates is a different failure from a store that
      // cannot be reached, and an operator needs to be able to tell them apart.
      const reasonCode =
        error instanceof TypeError || error instanceof RangeError
          ? PUBLISHED_POLICY_REASONS.invalid
          : PUBLISHED_POLICY_REASONS.unreadable;
      throw new PolicySourceUnavailableError(reasonCode);
    }

    try {
      return assembleGovernanceSnapshots(documents);
    } catch (error) {
      if (error?.code === 'published-policy-source-incomplete') {
        throw new PolicySourceUnavailableError(PUBLISHED_POLICY_REASONS.incomplete, {
          absentKinds: error.absentKinds,
        });
      }
      throw new PolicySourceUnavailableError(PUBLISHED_POLICY_REASONS.invalid);
    }
  };
}
