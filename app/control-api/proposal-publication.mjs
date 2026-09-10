import { applyLifecycleCommand, summariseTargets } from '../governance-domain/lifecycle/configuration-lifecycle.mjs';

/**
 * Applying a proposal that was already approved.
 *
 * The content comes from the stored draft rather than from the request that asks for
 * the publish, so what an approver reviewed is what lands. A request that carried its
 * own content could be approved as one set and published as another, and nothing in
 * the audit trail would show the difference.
 */

export function createProposalPublisher({ store, publisher, drafts, scopeGroupId, clock }) {
  for (const method of ['readConfigurationRevision', 'putConfigurationRevision']) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`store must implement ${method}.`);
  }
  if (typeof publisher?.publish !== 'function') throw new TypeError('publisher is required.');
  if (typeof drafts?.proposedContent !== 'function') throw new TypeError('drafts is required.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');

  return Object.freeze({
    /**
     * @param inFlightRevisionId - what the caller found already publishing, or `null`
     *   when it looked and found nothing. Omitting it means it never looked.
     */
    async publish({ revisionId, actor, inFlightRevisionId }) {
      if (inFlightRevisionId === undefined) {
        throw new TypeError('inFlightRevisionId is required: state what is already in flight, or null.');
      }

      const stored = await store.readConfigurationRevision({ scopeGroupId, revisionId });
      if (stored === null) return { outcome: 'refused', reasonCode: 'revision-absent' };

      // The content is read before the state moves. A revision left in `publishing`
      // with nothing to publish would need an operator to clear it.
      let content;
      try {
        content = await drafts.proposedContent({ revisionId });
      } catch (error) {
        return { outcome: 'refused', reasonCode: error.code ?? 'draft-content-absent' };
      }

      const started = applyLifecycleCommand({
        revision: stored.document,
        command: 'publish',
        actor,
        at: clock.nowIso(),
        expectedRevisionNumber: stored.document.revisionNumber,
        publishingRevisionId: inFlightRevisionId,
      });
      if (started.ok !== true) return { outcome: 'refused', reasonCode: started.code };

      let held = started.revision;
      let { etag } = await store.putConfigurationRevision(held, { ifMatch: stored.etag });

      const published = await publisher.publish({ revision: held, content, actor });
      held = published.revision;
      ({ etag } = await store.putConfigurationRevision(held, { ifMatch: etag }));

      const summary = summariseTargets(held);
      if (summary.verified === summary.total) {
        const completed = applyLifecycleCommand({
          revision: held,
          command: 'complete',
          actor,
          at: clock.nowIso(),
          expectedRevisionNumber: held.revisionNumber,
          publishingRevisionId: held.revisionId,
        });
        if (completed.ok === true) {
          held = completed.revision;
          ({ etag } = await store.putConfigurationRevision(held, { ifMatch: etag }));
        }
      } else if (summary.failed > 0) {
        const failure = held.targets.find((target) => target.outcome === 'failed');
        const failed = applyLifecycleCommand({
          revision: held,
          command: 'fail',
          actor,
          at: clock.nowIso(),
          expectedRevisionNumber: held.revisionNumber,
          reasonCode: failure?.reasonCode ?? 'publish-incomplete',
        });
        if (failed.ok === true) {
          held = failed.revision;
          ({ etag } = await store.putConfigurationRevision(held, { ifMatch: etag }));
        }
      }

      return {
        outcome: held.state === 'active' ? 'published' : 'incomplete',
        revisionId,
        state: held.state,
        etag,
        // Per target, so an operator sees which one is unfinished rather than only that
        // something is.
        targets: held.targets.map((target) => ({
          targetCode: target.targetCode,
          outcome: target.outcome,
          reasonCode: target.reasonCode,
        })),
      };
    },
  });
}
