import assert from 'node:assert/strict';
import test from 'node:test';

import { effectivePolicyDocumentId } from '../../app/persistence/cosmos-governance-store.mjs';
import { usageRollupDocumentId } from '../../app/governance-domain/usage/usage-rollup-validator.mjs';
import {
  createScheduleCheckpoint,
  planScheduleRun,
} from '../../app/governance-domain/scheduling/schedule-recovery.mjs';
import { createRevision } from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';
import { raiseNotification } from '../../app/governance-domain/notification/notification-delivery.mjs';
import {
  governanceSnapshotDocument,
  GOVERNANCE_SNAPSHOT_KINDS,
  GOVERNANCE_SNAPSHOT_PROPERTIES,
} from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { principalMembershipDocument } from '../../app/governance-domain/directory/principal-membership-document.mjs';
import { configurationDraftDocument } from '../../app/governance-domain/lifecycle/configuration-draft-document.mjs';
import { projectUsageRecords } from '../../app/governance-domain/usage/usage-record-projector.mjs';

const SNAPSHOT_EVALUATION_TIME = '2026-07-24T10:00:00.000Z';

/**
 * The behaviour every governance store must have, whichever one it is.
 *
 * The in-memory store exists so a conflict can be provoked without a container
 * runtime. That is only worth anything if it behaves like the real one, so both are
 * held to this suite rather than to their own separate expectations.
 */
export function runGovernanceStoreContract({ label, store, uniqueKey }) {
  function policyDocument(overrides = {}) {
    const scopeGroupId = overrides.scopeGroupId ?? 'team-platform';
    const principalKey = overrides.principalKey ?? uniqueKey();
    return {
      contractVersion: 'v1',
      documentType: 'effective-policy',
      id: effectivePolicyDocumentId({ scopeGroupId, principalKey }),
      scopeGroupId,
      principalKey,
      configVersion: 1,
      resolution: 'resolved',
      resolvedAt: '2026-08-04T00:00:00.000Z',
      expiresAt: '2026-08-04T00:01:00.000Z',
      attribution: {
        subjectKey: 'sk1-contract000000000000000000000000',
        applicationKey: 'ak1-contract000000000000000000000000',
        teamKey: scopeGroupId,
      },
      allowedModels: ['model-mini'],
      modelDeployments: [{ modelKey: 'model-mini', providerDeploymentName: 'deployment-mini' }],
      limits: [
        { scope: 'organization', modelScope: 'all-models', tokenQuota: 1000, quotaPeriod: 'Monthly' },
      ],
      fallback: { enabled: false, maxDepth: 1, chain: [] },
      ...overrides,
    };
  }

  function rollupDocument({ scopeGroupId, windowStart, requests }) {
    const hour = Number(windowStart.slice(11, 13));
    const at = (offset) => `${windowStart.slice(0, 11)}${String(hour + offset).padStart(2, '0')}${windowStart.slice(13)}`;
    return {
      contractVersion: 'v1',
      documentType: 'usage-rollup',
      id: usageRollupDocumentId({ scopeGroupId, grain: 'organization', windowStart }),
      scopeGroupId,
      grain: 'organization',
      windowStart,
      windowEnd: at(1),
      asOf: at(2),
      sourceRevision: 'contract-1',
      completeness: { state: 'complete', reason: 'window-closed' },
      totals: {
        requests,
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
        tokenQuality: 'reported',
      },
      byModel: [
        {
          model: 'model-mini',
          measures: {
            requests,
            promptTokens: 10,
            completionTokens: 10,
            totalTokens: 20,
            tokenQuality: 'reported',
          },
        },
      ],
    };
  }

  test(`${label}: an absent document reads as null rather than throwing`, async () => {
    const result = await store.readEffectivePolicy({
      scopeGroupId: 'team-platform',
      principalKey: uniqueKey(),
    });
    assert.equal(result, null);
  });

  test(`${label}: a written document reads back with an entity tag`, async () => {
    const document = policyDocument();
    const written = await store.putEffectivePolicy(document, { ifMatch: null });
    assert.equal(written.document.id, document.id);
    assert.ok(written.etag, 'a write must return the tag its next writer will need');

    const read = await store.readEffectivePolicy(document);
    assert.equal(read.etag, written.etag);
    assert.equal(read.document.principalKey, document.principalKey);
  });

  test(`${label}: store metadata never reaches the domain document`, async () => {
    const document = policyDocument();
    await store.putEffectivePolicy(document, { ifMatch: null });
    const read = await store.readEffectivePolicy(document);
    for (const property of ['_rid', '_self', '_etag', '_ts', '_attachments']) {
      assert.equal(Object.hasOwn(read.document, property), false, property);
    }
  });

  test(`${label}: creating the same document twice is a conflict`, async () => {
    const document = policyDocument();
    await store.putEffectivePolicy(document, { ifMatch: null });
    await assert.rejects(
      () => store.putEffectivePolicy(document, { ifMatch: null }),
      (error) => error.name === 'ConcurrencyConflictError',
    );
  });

  test(`${label}: a replace carrying the tag it read succeeds and issues a new one`, async () => {
    const document = policyDocument();
    const first = await store.putEffectivePolicy(document, { ifMatch: null });
    const second = await store.putEffectivePolicy(
      { ...document, configVersion: 2 },
      { ifMatch: first.etag },
    );

    assert.equal(second.document.configVersion, 2);
    assert.notEqual(second.etag, first.etag, 'a write must invalidate the tag it consumed');
  });

  test(`${label}: a replace carrying a stale tag is refused and does not apply`, async () => {
    // The whole point of the precondition. A second publisher that read the same
    // revision must lose, rather than overwrite the first one's work.
    const document = policyDocument();
    const first = await store.putEffectivePolicy(document, { ifMatch: null });
    await store.putEffectivePolicy({ ...document, configVersion: 2 }, { ifMatch: first.etag });

    await assert.rejects(
      () => store.putEffectivePolicy({ ...document, configVersion: 99 }, { ifMatch: first.etag }),
      (error) => error.name === 'ConcurrencyConflictError',
    );

    const read = await store.readEffectivePolicy(document);
    assert.equal(read.document.configVersion, 2, 'the refused write must not have applied');
  });

  test(`${label}: a rollup window is replaced outright rather than merged`, async () => {
    const scopeGroupId = `rollup-${uniqueKey()}`;
    const windowStart = '2026-08-04T06:00:00.000Z';

    await store.putRollup(rollupDocument({ scopeGroupId, windowStart, requests: 1 }));
    await store.putRollup(rollupDocument({ scopeGroupId, windowStart, requests: 2 }));

    const read = await store.readRollup({
      scopeGroupId,
      id: usageRollupDocumentId({ scopeGroupId, grain: 'organization', windowStart }),
    });
    assert.equal(read.document.totals.requests, 2, 'a recomputed window must replace the old one');
  });

  test(`${label}: a window query is scoped to its partition and ordered by window`, async () => {
    const scopeGroupId = `query-${uniqueKey()}`;
    const other = `query-${uniqueKey()}`;

    await store.putRollup(rollupDocument({ scopeGroupId, windowStart: '2026-08-04T07:00:00.000Z', requests: 1 }));
    await store.putRollup(rollupDocument({ scopeGroupId, windowStart: '2026-08-04T05:00:00.000Z', requests: 1 }));
    await store.putRollup(rollupDocument({ scopeGroupId: other, windowStart: '2026-08-04T07:00:00.000Z', requests: 1 }));

    const windows = await store.queryRollupWindows({
      scopeGroupId,
      sinceWindowStart: '2026-08-04T06:00:00.000Z',
    });

    assert.equal(windows.length, 1, 'the older window is outside the range and the other scope is not ours');
    assert.equal(windows[0].windowStart, '2026-08-04T07:00:00.000Z');
  });

  test(`${label}: a schedule checkpoint reads back with the tag a second runner must beat`, async () => {
    const scopeGroupId = `schedule-${uniqueKey()}`;
    const seed = createScheduleCheckpoint({
      scopeGroupId,
      scheduleId: 'usage-rollup',
      intervalSeconds: 3600,
      startedFrom: '2026-08-10T00:00:00.000Z',
    });

    assert.equal(await store.readScheduleCheckpoint({ scopeGroupId, scheduleId: 'usage-rollup' }), null);

    const written = await store.putScheduleCheckpoint(seed, { ifMatch: null });
    assert.ok(written.etag);

    const held = await store.readScheduleCheckpoint({ scopeGroupId, scheduleId: 'usage-rollup' });
    assert.equal(held.document.completedThrough, null);
    assert.equal(held.etag, written.etag);
  });

  test(`${label}: the runner that lost the race cannot write its lease`, async () => {
    // Both read the same checkpoint and both planned. Only one may hold the lease,
    // and the loser must find out from the store rather than from the work colliding.
    const scopeGroupId = `schedule-${uniqueKey()}`;
    const seed = createScheduleCheckpoint({
      scopeGroupId,
      scheduleId: 'usage-rollup',
      intervalSeconds: 3600,
      startedFrom: '2026-08-10T00:00:00.000Z',
    });
    const { etag } = await store.putScheduleCheckpoint(seed, { ifMatch: null });

    const plan = (ownerCode) =>
      planScheduleRun({ checkpoint: seed, now: '2026-08-10T03:00:00.000Z', ownerCode, leaseSeconds: 300 })
        .checkpoint;

    await store.putScheduleCheckpoint(plan('worker-a'), { ifMatch: etag });
    await assert.rejects(
      () => store.putScheduleCheckpoint(plan('worker-b'), { ifMatch: etag }),
      (error) => error.name === 'ConcurrencyConflictError',
    );

    const held = await store.readScheduleCheckpoint({ scopeGroupId, scheduleId: 'usage-rollup' });
    assert.equal(held.document.lease.ownerCode, 'worker-a');
  });

  test(`${label}: revisions come back scoped to their partition and in a stable order`, async () => {
    const scopeGroupId = `revisions-${uniqueKey()}`;
    const other = `revisions-${uniqueKey()}`;
    const draft = (revisionId, scope) =>
      createRevision({
        revisionId,
        scopeGroupId: scope,
        revisionNumber: 1,
        authoredBy: 'admin-a',
        authoredAt: '2026-08-10T09:00:00.000Z',
        targets: ['gateway-policy'],
      });

    await store.putConfigurationRevision(draft('revision-b', scopeGroupId), { ifMatch: null });
    await store.putConfigurationRevision(draft('revision-a', scopeGroupId), { ifMatch: null });
    await store.putConfigurationRevision(draft('revision-c', other), { ifMatch: null });

    const revisions = await store.queryConfigurationRevisions({ scopeGroupId });
    assert.deepEqual(
      revisions.map((revision) => revision.revisionId),
      ['revision-a', 'revision-b'],
    );
    // The store's own identifier is not part of the domain document.
    assert.equal(Object.hasOwn(revisions[0], 'id'), false);
  });

  test(`${label}: a notification is removed only against the version that was read`, async () => {
    const scopeGroupId = `retention-${uniqueKey()}`;
    const key = `notification|${scopeGroupId}|aggregate-stale|||2026-01-01T00:00:00.000Z|organization||`;
    const record = raiseNotification({
      scopeGroupId,
      key,
      kind: 'aggregate-stale',
      severity: 'warning',
      scope: 'organization',
      periodStart: '2026-01-01T00:00:00.000Z',
      raisedAt: '2026-08-10T00:00:00.000Z',
    });
    const { etag } = await store.putNotification(record, { ifMatch: null });

    await assert.rejects(
      () => store.deleteNotification({ scopeGroupId, key }, { ifMatch: '"not-the-tag"' }),
      (error) => error.name === 'ConcurrencyConflictError',
    );
    assert.notEqual(await store.readNotification({ scopeGroupId, key }), null);

    assert.equal(await store.deleteNotification({ scopeGroupId, key }, { ifMatch: etag }), true);
    assert.equal(await store.readNotification({ scopeGroupId, key }), null);
    // Removing what is already gone is not an error; two sweeps may overlap.
    assert.equal(await store.deleteNotification({ scopeGroupId, key }, { ifMatch: etag }), false);
  });

  test(`${label}: a write that never states a precondition is refused rather than guessed`, async () => {
    // An optional precondition that quietly creates is the same hole as no precondition
    // at all: a caller that forgot one is indistinguishable from a caller that meant it.
    const document = policyDocument();
    for (const options of [undefined, {}, { ifMatch: undefined }]) {
      await assert.rejects(
        () => store.putEffectivePolicy(document, options),
        (error) => error instanceof TypeError,
        `omitting the precondition must throw (${JSON.stringify(options) ?? 'no argument'})`,
      );
    }
    assert.equal(await store.readEffectivePolicy(document), null, 'the refused write must not have applied');
  });

  test(`${label}: an empty precondition is refused rather than treated as absent`, async () => {
    const document = policyDocument();
    await assert.rejects(
      () => store.putEffectivePolicy(document, { ifMatch: '' }),
      (error) => error instanceof TypeError,
    );
    assert.equal(await store.readEffectivePolicy(document), null);
  });

  test(`${label}: a stated-absent precondition creates, then refuses a second create`, async () => {
    const document = policyDocument();
    const written = await store.putEffectivePolicy(document, { ifMatch: null });
    assert.ok(written.etag);
    await assert.rejects(
      () => store.putEffectivePolicy(document, { ifMatch: null }),
      (error) => error.name === 'ConcurrencyConflictError',
    );
  });

  test(`${label}: a removal without the version it read is refused`, async () => {
    const scopeGroupId = `retention-${uniqueKey()}`;
    const key = `notification|${scopeGroupId}|aggregate-stale|||2026-01-01T00:00:00.000Z|organization||`;
    for (const options of [undefined, {}, { ifMatch: null }]) {
      await assert.rejects(
        () => store.deleteNotification({ scopeGroupId, key }, options),
        (error) => error instanceof TypeError,
      );
    }
  });

  function snapshotDocument(scopeGroupId, kind) {
    const snapshots = getDeterministicGovernanceSnapshots();
    return governanceSnapshotDocument({
      scopeGroupId,
      kind,
      snapshot: snapshots[GOVERNANCE_SNAPSHOT_PROPERTIES[kind]],
    });
  }

  test(`${label}: all five governance snapshots round-trip as their own documents`, async () => {
    const scopeGroupId = `snapshots-${uniqueKey()}`;
    for (const kind of GOVERNANCE_SNAPSHOT_KINDS) {
      const written = await store.putGovernanceSnapshot(snapshotDocument(scopeGroupId, kind), {
        ifMatch: null,
        evaluationTime: SNAPSHOT_EVALUATION_TIME,
      });
      assert.ok(written.etag, kind);
    }

    const all = await store.queryGovernanceSnapshots({
      scopeGroupId,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    assert.deepEqual(all.map((document) => document.kind), [...GOVERNANCE_SNAPSHOT_KINDS].sort());

    const one = await store.readGovernanceSnapshot({
      scopeGroupId,
      kind: 'budget',
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    assert.equal(one.document.kind, 'budget');
    assert.ok(Array.isArray(one.document.snapshot.budgets));
  });

  test(`${label}: one kind is replaced without disturbing the other four`, async () => {
    const scopeGroupId = `snapshots-${uniqueKey()}`;
    for (const kind of GOVERNANCE_SNAPSHOT_KINDS) {
      await store.putGovernanceSnapshot(snapshotDocument(scopeGroupId, kind), {
        ifMatch: null,
        evaluationTime: SNAPSHOT_EVALUATION_TIME,
      });
    }
    const held = await store.readGovernanceSnapshot({
      scopeGroupId,
      kind: 'budget',
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    const revised = structuredClone(held.document);
    revised.snapshot.version += 1;

    await store.putGovernanceSnapshot(revised, {
      ifMatch: held.etag,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    await assert.rejects(
      () => store.putGovernanceSnapshot(revised, { ifMatch: held.etag, evaluationTime: SNAPSHOT_EVALUATION_TIME }),
      (error) => error.name === 'ConcurrencyConflictError',
      'a second editor holding the same version must lose',
    );

    const all = await store.queryGovernanceSnapshots({
      scopeGroupId,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    assert.equal(all.length, GOVERNANCE_SNAPSHOT_KINDS.length);
    assert.equal(all.find((document) => document.kind === 'budget').snapshot.version, revised.snapshot.version);
  });

  test(`${label}: a snapshot that is wrong on the way out is refused, not served`, async () => {
    // The store is the last thing that touched a stored document, so validating only
    // where it was constructed proves nothing about what comes back.
    const scopeGroupId = `snapshots-${uniqueKey()}`;
    const document = snapshotDocument(scopeGroupId, 'entitlement');
    await store.putGovernanceSnapshot(document, {
      ifMatch: null,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });

    await assert.rejects(
      () =>
        store.readGovernanceSnapshot({
          scopeGroupId,
          kind: 'entitlement',
          // A clock before the snapshot was captured makes the stored document invalid
          // without editing it, which is the only way to provoke this on a real store.
          evaluationTime: '2020-01-01T00:00:00.000Z',
        }),
      (error) => error instanceof RangeError || error instanceof TypeError,
    );
  });

  test(`${label}: a snapshot is refused without a clock to validate it against`, async () => {
    const scopeGroupId = `snapshots-${uniqueKey()}`;
    const document = snapshotDocument(scopeGroupId, 'assignment');
    await assert.rejects(
      () => store.putGovernanceSnapshot(document, { ifMatch: null }),
      (error) => error instanceof TypeError,
    );
    await assert.rejects(
      () => store.putGovernanceSnapshot(document, { ifMatch: null, evaluationTime: 'whenever' }),
      (error) => error instanceof TypeError,
    );
  });

  test(`${label}: an unknown kind never reaches the store`, async () => {
    const scopeGroupId = `snapshots-${uniqueKey()}`;
    const document = snapshotDocument(scopeGroupId, 'budget');
    await assert.rejects(
      () =>
        store.putGovernanceSnapshot(
          { ...document, kind: 'pricing' },
          { ifMatch: null, evaluationTime: SNAPSHOT_EVALUATION_TIME },
        ),
      (error) => error instanceof TypeError,
    );
    assert.deepEqual(
      await store.queryGovernanceSnapshots({ scopeGroupId, evaluationTime: SNAPSHOT_EVALUATION_TIME }),
      [],
    );
  });

  test(`${label}: a snapshot of one kind stored under another identifier is refused`, async () => {
    const scopeGroupId = `snapshots-${uniqueKey()}`;
    const budget = snapshotDocument(scopeGroupId, 'budget');
    await assert.rejects(
      () =>
        store.putGovernanceSnapshot(
          { ...budget, kind: 'assignment' },
          { ifMatch: null, evaluationTime: SNAPSHOT_EVALUATION_TIME },
        ),
      (error) => error instanceof TypeError,
      'the identifier and the payload must agree about which kind this is',
    );
  });

  test(`${label}: snapshots never cross a scope group`, async () => {
    const mine = `snapshots-${uniqueKey()}`;
    const theirs = `snapshots-${uniqueKey()}`;
    await store.putGovernanceSnapshot(snapshotDocument(mine, 'budget'), {
      ifMatch: null,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    await store.putGovernanceSnapshot(snapshotDocument(theirs, 'assignment'), {
      ifMatch: null,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });

    const read = await store.queryGovernanceSnapshots({
      scopeGroupId: mine,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    assert.deepEqual(read.map((document) => document.kind), ['budget']);
  });

  function draftMembership(subjectId = 'user-contract') {
    return {
      snapshotId: 'membership-contract',
      status: 'complete',
      source: 'control-plane',
      tenantId: 'tenant-contract',
      subjectId,
      resolvedAt: '2026-07-24T09:58:00.000Z',
      expiresAt: '2026-07-24T10:03:00.000Z',
      maxAgeSeconds: 300,
      sourceRevision: 'directory-contract',
      groups: [{ groupId: 'group-contract', membership: 'direct', authorizationRelevant: true }],
    };
  }

  function membershipDocument(scopeGroupId, subjectId) {
    return principalMembershipDocument({ scopeGroupId, memberships: draftMembership(subjectId) });
  }

  test(`${label}: membership is stored per principal and read back as evidence`, async () => {
    const scopeGroupId = `membership-${uniqueKey()}`;
    const subjectId = `subject-${uniqueKey()}`;
    const written = await store.putPrincipalMembership(membershipDocument(scopeGroupId, subjectId), {
      ifMatch: null,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    assert.ok(written.etag);

    const held = await store.readPrincipalMembership({
      scopeGroupId,
      tenantId: 'tenant-contract',
      subjectId,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    assert.equal(held.document.memberships.status, 'complete');
    assert.deepEqual(held.document.memberships.groups.map((group) => group.groupId), ['group-contract']);

    assert.equal(
      await store.readPrincipalMembership({
        scopeGroupId,
        tenantId: 'tenant-contract',
        subjectId: `absent-${uniqueKey()}`,
        evaluationTime: SNAPSHOT_EVALUATION_TIME,
      }),
      null,
      'an unpublished principal reads as absent rather than as an empty membership',
    );
  });

  test(`${label}: expired membership is refused on the way out`, async () => {
    const scopeGroupId = `membership-${uniqueKey()}`;
    const subjectId = `subject-${uniqueKey()}`;
    await store.putPrincipalMembership(membershipDocument(scopeGroupId, subjectId), {
      ifMatch: null,
      evaluationTime: SNAPSHOT_EVALUATION_TIME,
    });
    await assert.rejects(
      () =>
        store.readPrincipalMembership({
          scopeGroupId,
          tenantId: 'tenant-contract',
          subjectId,
          evaluationTime: '2026-07-24T11:00:00.000Z',
        }),
      (error) => error instanceof RangeError,
    );
  });

  // Built through the projector rather than by hand, so the contract exercises the
  // record shape the product actually produces instead of one written to pass.
  function usageRecord(scopeGroupId, correlationId, { observedAt = '2026-07-24T10:00:00.000Z' } = {}) {
    const { records } = projectUsageRecords({
      rows: [
        {
          correlationId,
          observedAt,
          subjectKey: 'sk1-contract000000000000000000000000',
          applicationKey: 'ak1-contract000000000000000000000000',
          teamKey: scopeGroupId,
          applicationId: 'app-local-console',
          requestedModel: 'coding-primary',
          effectiveModel: 'coding-primary',
          outcome: 'served',
          promptTokens: 10,
          completionTokens: 5,
          tokenQuality: 'reported',
        },
      ],
      scopeGroupId,
      registry: getDeterministicGovernanceSnapshots().modelRegistrySnapshot,
      configVersion: 1,
      sourceRevision: 'contract-1',
      projectedAt: '2026-07-24T13:00:00.000Z',
    });
    if (records.length !== 1) throw new Error(`the projector refused the contract row: ${JSON.stringify(records)}`);
    return records[0];
  }

  test(`${label}: a usage record is created once and a replay never overwrites it`, async () => {
    // Two runs disagreeing about the same request is a finding. Overwriting the stored
    // record would erase exactly the evidence that says so.
    const scopeGroupId = `usage-${uniqueKey()}`;
    const correlationId = `correlation-${uniqueKey()}`;

    const first = await store.putUsageRecord(usageRecord(scopeGroupId, correlationId));
    assert.equal(first.created, true);
    const originalTotal = first.document.usage.totalTokens;

    // The projector freezes what it emits, so the disagreeing replay is built as a copy.
    // The disagreement is internally consistent, otherwise the validator would refuse it
    // and the test would prove nothing about the store's create-once behaviour.
    const disagreeing = JSON.parse(JSON.stringify(usageRecord(scopeGroupId, correlationId)));
    disagreeing.usage = {
      ...disagreeing.usage,
      promptTokens: disagreeing.usage.promptTokens + 1000,
      totalTokens: originalTotal + 1000,
    };
    const replay = await store.putUsageRecord(disagreeing);
    assert.equal(replay.created, false, 'a second write of the same request is not a create');
    assert.equal(replay.document.usage.totalTokens, originalTotal, 'the stored record is returned, not the new one');

    const held = await store.readUsageRecord({ scopeGroupId, correlationId });
    assert.equal(held.document.usage.totalTokens, originalTotal);
  });

  test(`${label}: usage records come back in observation order and never cross a scope`, async () => {
    const scopeGroupId = `usage-${uniqueKey()}`;
    const other = `usage-${uniqueKey()}`;
    await store.putUsageRecord(
      usageRecord(scopeGroupId, `correlation-${uniqueKey()}`, { observedAt: '2026-07-24T12:00:00.000Z' }),
    );
    await store.putUsageRecord(
      usageRecord(scopeGroupId, `correlation-${uniqueKey()}`, { observedAt: '2026-07-24T09:00:00.000Z' }),
    );
    await store.putUsageRecord(usageRecord(other, `correlation-${uniqueKey()}`));

    const read = await store.queryUsageRecords({ scopeGroupId, sinceObservedAt: '2026-07-24T00:00:00.000Z' });
    assert.deepEqual(
      read.map((document) => document.observedAt),
      ['2026-07-24T09:00:00.000Z', '2026-07-24T12:00:00.000Z'],
    );

    const bounded = await store.queryUsageRecords({ scopeGroupId, sinceObservedAt: '2026-07-24T10:00:00.000Z' });
    assert.equal(bounded.length, 1, 'the lower bound is applied');
  });

  test(`${label}: a draft is replaced under its own version and a stale one loses`, async () => {
    const scopeGroupId = `draft-${uniqueKey()}`;
    const revisionId = 'revision-0001';
    const document = configurationDraftDocument({
      scopeGroupId,
      revisionId,
      content: { snapshots: getDeterministicGovernanceSnapshots(), memberships: [draftMembership()] },
      authoredBy: 'governance-administrator',
      authoredAt: '2026-07-24T10:00:00.000Z',
    });

    const created = await store.putConfigurationDraft(document, { ifMatch: null });
    const held = await store.readConfigurationDraft({ scopeGroupId, revisionId });
    assert.equal(held.etag, created.etag);
    assert.equal(held.document.revisionId, revisionId);

    const edited = { ...document, authoredAt: '2026-07-24T11:00:00.000Z' };
    const replaced = await store.putConfigurationDraft(edited, { ifMatch: created.etag });
    assert.notEqual(replaced.etag, created.etag);

    await assert.rejects(
      () => store.putConfigurationDraft(edited, { ifMatch: created.etag }),
      (error) => error.name === 'ConcurrencyConflictError',
      'a second administrator writing against the version they read must lose',
    );
  });

  // The one break that would matter: an unpublished proposal governing live traffic.
  test(`${label}: a draft is never returned as a published governance snapshot`, async () => {
    const scopeGroupId = `draft-${uniqueKey()}`;
    await store.putConfigurationDraft(
      configurationDraftDocument({
        scopeGroupId,
        revisionId: 'revision-0001',
        content: { snapshots: getDeterministicGovernanceSnapshots(), memberships: [draftMembership()] },
        authoredBy: 'governance-administrator',
        authoredAt: '2026-07-24T10:00:00.000Z',
      }),
      { ifMatch: null },
    );

    const published = await store.queryGovernanceSnapshots({
      scopeGroupId,
      evaluationTime: '2026-07-24T10:00:00.000Z',
    });
    assert.deepEqual(published, [], 'a draft in the same partition is not a published snapshot');
    assert.equal(
      await store.readGovernanceSnapshot({
        scopeGroupId,
        kind: 'budget',
        evaluationTime: '2026-07-24T10:00:00.000Z',
      }),
      null,
      'the snapshot a draft proposes does not exist until it is published',
    );
  });
}
