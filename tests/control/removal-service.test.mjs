import assert from 'node:assert/strict';
import test from 'node:test';

import { createGovernanceRemovalService } from '../../app/control-api/governance-removal-service.mjs';
import { createLocalGovernanceSource } from '../../app/control-api/local-governance-source.mjs';
import { createDraftAuthor } from '../../app/control-api/draft-authoring.mjs';
import { governancePublicationTargets } from '../../app/control-api/governance-publisher.mjs';
import { createProposalPublisher } from '../../app/control-api/proposal-publication.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import {
  applyLifecycleCommand,
  recordTargetOutcome,
} from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';

const AT = '2026-07-24T10:00:00.000Z';

async function fixture() {
  return structuredClone(
    await createLocalGovernanceSource({ evaluationTime: AT }).readGovernanceSnapshots(),
  );
}

test('planning is read-only and proposal stores one whole candidate without changing active snapshots', async () => {
  const active = await fixture();
  const original = structuredClone(active);
  const writes = [];
  let reads = 0;
  const service = createGovernanceRemovalService({
    readPublishedSnapshots: async () => {
      reads += 1;
      return active;
    },
    drafts: {
      async propose(input) {
        writes.push(structuredClone(input));
        return {
          revision: {
            revisionId: 'revision-0012',
            revisionNumber: 12,
            state: 'draft',
          },
        };
      },
    },
    clock: { nowIso: () => AT },
  });

  const plan = await service.plan({
    target: { kind: 'team', key: 'developer-experience' },
    reasonCode: 'team-dissolved',
  });
  assert.equal(reads, 1);
  assert.equal(writes.length, 0);
  assert.deepEqual(active, original);

  const result = await service.propose({
    target: plan.target,
    reasonCode: plan.reasonCode,
    planDigest: plan.planDigest,
    selectedReferenceIds: plan.references.map((entry) => entry.referenceId),
    authoredBy: 'actor-code',
  });
  assert.deepEqual(result, {
    outcome: 'proposed',
    revisionId: 'revision-0012',
    revisionNumber: 12,
    state: 'draft',
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].authoredBy, 'actor-code');
  assert.equal(
    writes[0].content.snapshots.entitlementSnapshot.teamCatalog.some(
      (entry) => entry.teamKey === 'developer-experience',
    ),
    false,
  );
  assert.deepEqual(active, original, 'published input remains immutable');
});

test('proposal re-reads and refuses stale plans, duplicate acknowledgments, and forged sets before writing', async () => {
  const active = await fixture();
  let current = active;
  let writes = 0;
  const service = createGovernanceRemovalService({
    readPublishedSnapshots: async () => current,
    drafts: { propose: async () => { writes += 1; } },
    clock: { nowIso: () => AT },
  });
  const plan = await service.plan({
    target: { kind: 'team', key: 'developer-experience' },
    reasonCode: 'team-dissolved',
  });

  await assert.rejects(
    service.propose({
      ...plan,
      selectedReferenceIds: [plan.references[0].referenceId, plan.references[0].referenceId],
      authoredBy: 'actor-code',
    }),
    (error) => error.code === 'removal-selection-duplicate',
  );
  await assert.rejects(
    service.propose({
      ...plan,
      selectedReferenceIds: ['forged'],
      authoredBy: 'actor-code',
    }),
    (error) => error.code === 'removal-selection-incomplete',
  );

  current = structuredClone(active);
  current.assignmentSnapshot.version += 1;
  await assert.rejects(
    service.propose({
      ...plan,
      selectedReferenceIds: plan.references.map((entry) => entry.referenceId),
      authoredBy: 'actor-code',
    }),
    (error) => error.code === 'removal-plan-stale',
  );
  assert.equal(writes, 0);
});

test('a failed publication preserves the removal draft, history, and previously active content', async () => {
  const active = await fixture();
  const original = structuredClone(active);
  const store = createInMemoryGovernanceStore();
  const clock = { nowIso: () => AT };
  const drafts = createDraftAuthor({
    store,
    scopeGroupId: 'platform-engineering',
    clock,
    targets: governancePublicationTargets({ includeMembership: false }),
  });
  const service = createGovernanceRemovalService({
    readPublishedSnapshots: async () => active,
    drafts,
    clock,
  });
  const plan = await service.plan({
    target: { kind: 'team', key: 'developer-experience' },
    reasonCode: 'team-dissolved',
  });
  const proposal = await service.propose({
    target: plan.target,
    reasonCode: plan.reasonCode,
    planDigest: plan.planDigest,
    selectedReferenceIds: plan.references.map((entry) => entry.referenceId),
    authoredBy: 'author',
  });
  const stored = await store.readConfigurationRevision({
    scopeGroupId: 'platform-engineering',
    revisionId: proposal.revisionId,
  });
  const approved = applyLifecycleCommand({
    revision: stored.document,
    command: 'approve',
    actor: 'approver',
    at: AT,
    expectedRevisionNumber: stored.document.revisionNumber,
    publishingRevisionId: undefined,
  });
  assert.equal(approved.ok, true);
  await store.putConfigurationRevision(approved.revision, { ifMatch: stored.etag });

  const publisher = createProposalPublisher({
    store,
    drafts,
    scopeGroupId: 'platform-engineering',
    clock,
    publisher: {
      async publish({ revision }) {
        let next = revision;
        for (const target of revision.targets) {
          const recorded = recordTargetOutcome({
            revision: next,
            targetCode: target.targetCode,
            outcome: 'failed',
            reasonCode: 'simulated-write-refused',
            at: AT,
          });
          assert.equal(recorded.ok, true);
          next = recorded.revision;
        }
        return { revision: next };
      },
    },
  });
  const result = await publisher.publish({
    revisionId: proposal.revisionId,
    actor: 'approver',
    inFlightRevisionId: null,
  });
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.state, 'failed');
  assert.notEqual(await store.readConfigurationDraft({
    scopeGroupId: 'platform-engineering',
    revisionId: proposal.revisionId,
  }), null);
  assert.deepEqual(
    await store.queryGovernanceSnapshots({
      scopeGroupId: 'platform-engineering',
      evaluationTime: AT,
    }),
    [],
  );
  assert.deepEqual(active, original);
  const failed = await store.readConfigurationRevision({
    scopeGroupId: 'platform-engineering',
    revisionId: proposal.revisionId,
  });
  assert.ok(failed.document.history.some((entry) => entry.command === 'approve'));
  assert.ok(failed.document.history.some((entry) => entry.command === 'fail'));
});
