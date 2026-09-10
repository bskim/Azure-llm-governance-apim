import {
  assertGovernanceSnapshotDocument,
  governanceSnapshotDocument,
  GOVERNANCE_SNAPSHOT_KINDS,
  GOVERNANCE_SNAPSHOT_PROPERTIES,
} from '../governance-domain/policy/governance-snapshot-document.mjs';
import {
  assertPrincipalMembershipDocument,
  principalMembershipDocument,
} from '../governance-domain/directory/principal-membership-document.mjs';
import { recordTargetOutcome } from '../governance-domain/lifecycle/configuration-lifecycle.mjs';

/**
 * Carries out what a revision declared, one target at a time.
 *
 * The lifecycle already refuses to activate a revision whose targets are merely
 * written, so a target is only reported verified once the document has been read back
 * out of the store and found to be the one that was written. A write that returned
 * successfully is evidence about the request, not about what a later reader will see.
 *
 * Publishing is therefore replayable by construction: a target already verified is left
 * alone, and a target that failed is attempted again against whatever is stored now.
 */

const SNAPSHOT_TARGET_PREFIX = 'governance-snapshot-';
const MEMBERSHIP_TARGET = 'principal-membership';

export const PUBLISH_REASONS = Object.freeze({
  contentAbsent: 'publish-content-absent',
  contentInvalid: 'publish-content-invalid',
  writeRefused: 'publish-write-refused',
  readBackAbsent: 'publish-read-back-absent',
  readBackDiffers: 'publish-read-back-differs',
  targetUnknown: 'publish-target-unknown',
});

export function snapshotTargetCode(kind) {
  if (!GOVERNANCE_SNAPSHOT_KINDS.includes(kind)) throw new TypeError(`kind ${kind} is unsupported.`);
  return `${SNAPSHOT_TARGET_PREFIX}${kind}`;
}

export const MEMBERSHIP_TARGET_CODE = MEMBERSHIP_TARGET;

/** The targets a revision must declare to publish a complete governance set. */
export function governancePublicationTargets({ includeMembership = true } = {}) {
  const targets = GOVERNANCE_SNAPSHOT_KINDS.map(snapshotTargetCode);
  return includeMembership ? [...targets, MEMBERSHIP_TARGET] : targets;
}

function stableForm(document) {
  return JSON.stringify(document, Object.keys(document).sort());
}

export function createGovernancePublisher({ store, scopeGroupId, clock }) {
  for (const method of [
    'readGovernanceSnapshot',
    'readGovernanceSnapshotVersion',
    'putGovernanceSnapshot',
    'readPrincipalMembership',
    'readPrincipalMembershipVersion',
    'putPrincipalMembership',
  ]) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`store must implement ${method}.`);
  }
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');

  async function writeAndVerify({ document, readVersion, read, put, evaluationTime }) {
    // The version is asked for without validating what is there. A stored document that
    // has gone stale is exactly the one that most needs replacing, and validating it
    // here would mean it could only be replaced by something able to serve it first.
    const held = await readVersion();
    try {
      await put(document, { ifMatch: held === null ? null : held.etag, evaluationTime });
    } catch (error) {
      return { outcome: 'failed', reasonCode: PUBLISH_REASONS.writeRefused, cause: error };
    }

    // The read-back does validate, because what was just written has to be servable.
    const stored = await read();
    if (stored === null) return { outcome: 'failed', reasonCode: PUBLISH_REASONS.readBackAbsent };
    if (stableForm(stored.document) !== stableForm(document)) {
      return { outcome: 'failed', reasonCode: PUBLISH_REASONS.readBackDiffers };
    }
    return { outcome: 'verified' };
  }

  async function publishSnapshot(kind, snapshot, evaluationTime) {
    if (snapshot === undefined || snapshot === null) {
      return { outcome: 'failed', reasonCode: PUBLISH_REASONS.contentAbsent };
    }
    let document;
    try {
      document = assertGovernanceSnapshotDocument(
        governanceSnapshotDocument({ scopeGroupId, kind, snapshot }),
        { evaluationTime },
      );
    } catch {
      // Content the store would refuse is a failed target with a reason an operator can
      // act on, not an exception the publish loop dies inside.
      return { outcome: 'failed', reasonCode: PUBLISH_REASONS.contentInvalid };
    }
    return writeAndVerify({
      document,
      readVersion: () => store.readGovernanceSnapshotVersion({ scopeGroupId, kind }),
      read: () => store.readGovernanceSnapshot({ scopeGroupId, kind, evaluationTime }),
      put: store.putGovernanceSnapshot,
      evaluationTime,
    });
  }

  async function publishMemberships(memberships, evaluationTime) {
    if (!Array.isArray(memberships) || memberships.length === 0) {
      return { outcome: 'failed', reasonCode: PUBLISH_REASONS.contentAbsent };
    }
    for (const evidence of memberships) {
      let document;
      try {
        document = assertPrincipalMembershipDocument(
          principalMembershipDocument({ scopeGroupId, memberships: evidence }),
          { evaluationTime },
        );
      } catch {
        return { outcome: 'failed', reasonCode: PUBLISH_REASONS.contentInvalid };
      }
      const result = await writeAndVerify({
        document,
        readVersion: () =>
          store.readPrincipalMembershipVersion({
            scopeGroupId,
            tenantId: document.tenantId,
            subjectId: document.subjectId,
          }),
        read: () =>
          store.readPrincipalMembership({
            scopeGroupId,
            tenantId: document.tenantId,
            subjectId: document.subjectId,
            evaluationTime,
          }),
        put: store.putPrincipalMembership,
        evaluationTime,
      });
      // One principal failing means the target failed. Reporting the target verified
      // because most of them worked would activate a revision nobody fully published.
      if (result.outcome !== 'verified') return result;
    }
    return { outcome: 'verified' };
  }

  return Object.freeze({
    /**
     * Attempts every unverified target once and returns the revision as it now stands.
     * The caller decides whether that is enough to complete, because only the reducer
     * knows what completing requires.
     */
    async publish({ revision, content, actor }) {
      if (typeof actor !== 'string' || actor.length === 0) throw new TypeError('actor is required.');
      const evaluationTime = clock.nowIso();
      let current = revision;
      const attempted = [];

      for (const target of revision.targets) {
        // Only a pending target is attempted. `verified` and `failed` are both terminal
        // within an attempt, so a failed one is retried by the operator's retry command,
        // which resets it to pending; writing over it here would be a regression the
        // reducer refuses anyway.
        if (target.outcome !== 'pending') continue;

        let result;
        if (target.targetCode === MEMBERSHIP_TARGET) {
          result = await publishMemberships(content?.memberships, evaluationTime);
        } else if (target.targetCode.startsWith(SNAPSHOT_TARGET_PREFIX)) {
          const kind = target.targetCode.slice(SNAPSHOT_TARGET_PREFIX.length);
          result = GOVERNANCE_SNAPSHOT_KINDS.includes(kind)
            ? await publishSnapshot(
                kind,
                content?.snapshots?.[GOVERNANCE_SNAPSHOT_PROPERTIES[kind]],
                evaluationTime,
              )
            : { outcome: 'failed', reasonCode: PUBLISH_REASONS.targetUnknown };
        } else {
          result = { outcome: 'failed', reasonCode: PUBLISH_REASONS.targetUnknown };
        }

        const applied = recordTargetOutcome({
          revision: current,
          targetCode: target.targetCode,
          outcome: result.outcome,
          at: evaluationTime,
          reasonCode: result.outcome === 'failed' ? result.reasonCode : null,
        });
        if (applied.ok !== true) {
          throw Object.assign(new Error('target-outcome-refused'), { code: applied.code });
        }
        current = applied.revision;
        attempted.push({ targetCode: target.targetCode, outcome: result.outcome, reasonCode: result.reasonCode ?? null });
      }

      return Object.freeze({
        revision: current,
        attempted: Object.freeze(attempted),
        actor,
        at: evaluationTime,
      });
    },
  });
}
