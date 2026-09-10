import { assertEffectivePolicyDocument } from '../governance-domain/policy/effective-policy-validator.mjs';
import { assertUsageRollupDocument } from '../governance-domain/usage/usage-rollup-validator.mjs';
import {
  assertDirectorySnapshotDocument,
  directorySnapshotDocumentId,
} from '../governance-domain/directory/directory-snapshot-validator.mjs';
import {
  assertScheduleCheckpoint,
  scheduleCheckpointDocumentId,
} from '../governance-domain/scheduling/schedule-recovery.mjs';
import {
  assertNotificationRecord,
  notificationDocumentId,
} from '../governance-domain/notification/notification-delivery.mjs';
import {
  assertNotificationChannelRecord,
  notificationChannelDocumentId,
} from '../governance-domain/notification/notification-channel.mjs';
import { CONTAINER_TOPOLOGY, assertContainerTopology } from './container-topology.mjs';
import {
  ConcurrencyConflictError,
  configurationRevisionDocumentId,
  effectivePolicyDocumentId,
  resolveDeletePrecondition,
  resolveWritePrecondition,
} from './cosmos-governance-store.mjs';
import { assertConfigurationRevision } from '../governance-domain/lifecycle/configuration-lifecycle.mjs';
import {
  assertGovernanceSnapshotDocument,
  governanceSnapshotDocumentId,
  hydratePersistedGovernanceSnapshotDocument,
} from '../governance-domain/policy/governance-snapshot-document.mjs';
import {
  assertPrincipalMembershipDocument,
  principalMembershipDocumentId,
} from '../governance-domain/directory/principal-membership-document.mjs';
import {
  assertConfigurationDraftDocument,
  configurationDraftDocumentId,
} from '../governance-domain/lifecycle/configuration-draft-document.mjs';
import {
  assertUsageRecordDocument,
  usageRecordDocumentId,
} from '../governance-domain/usage/usage-record-validator.mjs';

/**
 * The governance store, in memory, with the store's concurrency semantics.
 *
 * It exists so that a conflict can be provoked deterministically. The emulator can do
 * that too, but only where a container runtime is available, and a race that can only
 * be tested where Docker happens to be installed is a race that stops being tested.
 *
 * Its value depends entirely on being held to the same contract as the real store, so
 * the shared contract suite runs against both. A double nobody checks is a second
 * implementation of the same guesses.
 */

function clone(document) {
  return JSON.parse(JSON.stringify(document));
}

export function createInMemoryGovernanceStore({
  databaseId = 'governance-local',
  initialPersistedGovernanceSnapshots = [],
} = {}) {
  assertContainerTopology();
  const declared = new Set(CONTAINER_TOPOLOGY.map((container) => container.id));
  if (!declared.has('governance') || !declared.has('rollups')) {
    throw new TypeError('The store containers are not declared in the topology.');
  }

  // Keyed by partition then id, because a partition is the only scope the real store
  // can read within, and a flat map would let a test pass that the real one refuses.
  const containers = { governance: new Map(), rollups: new Map() };
  let etagSequence = 0;

  function partitionOf(container, scopeGroupId) {
    if (!containers[container].has(scopeGroupId)) containers[container].set(scopeGroupId, new Map());
    return containers[container].get(scopeGroupId);
  }

  function write(container, document, { ifMatch, expectAbsent = false } = {}) {
    const partition = partitionOf(container, document.scopeGroupId);
    const held = partition.get(document.id);
    if (expectAbsent && held !== undefined) {
      throw new ConcurrencyConflictError('A document already exists for this caller.');
    }
    if (ifMatch !== undefined && (held === undefined || held.etag !== ifMatch)) {
      throw new ConcurrencyConflictError('The stored document changed since it was read.');
    }
    etagSequence += 1;
    const stored = { document: clone(document), etag: `"${etagSequence}"` };
    partition.set(document.id, stored);
    return { document: clone(stored.document), etag: stored.etag };
  }

  function read(container, scopeGroupId, id) {
    const held = partitionOf(container, scopeGroupId).get(id);
    if (held === undefined) return null;
    return { document: clone(held.document), etag: held.etag };
  }

  if (!Array.isArray(initialPersistedGovernanceSnapshots)) {
    throw new TypeError('initialPersistedGovernanceSnapshots must be an array.');
  }
  for (const document of initialPersistedGovernanceSnapshots) {
    if (document?.documentType !== 'governance-snapshot') {
      throw new TypeError('An initial persisted document must be a governance snapshot.');
    }
    write('governance', clone(document), { expectAbsent: true });
  }

  return Object.freeze({
    databaseId,
    containerId: 'governance',
    rollupContainerId: 'rollups',
    durability: 'ephemeral',

    async readEffectivePolicy({ scopeGroupId, principalKey }) {
      return read('governance', scopeGroupId, effectivePolicyDocumentId({ scopeGroupId, principalKey }));
    },

    async putEffectivePolicy(candidate, { ifMatch } = {}) {
      const precondition = resolveWritePrecondition(ifMatch);
      const document = clone(candidate);
      assertEffectivePolicyDocument(document);
      if (document.id !== effectivePolicyDocumentId(document)) {
        throw new TypeError('document.id must be derived from scopeGroupId and principalKey.');
      }
      return write('governance', document, precondition);
    },

    async readGovernanceSnapshot({ scopeGroupId, kind, evaluationTime }) {
      const held = read('governance', scopeGroupId, governanceSnapshotDocumentId({ scopeGroupId, kind }));
      if (held === null) return null;
      return {
        document: hydratePersistedGovernanceSnapshotDocument(held.document, { evaluationTime }),
        etag: held.etag,
      };
    },

    async putGovernanceSnapshot(candidate, { ifMatch, evaluationTime } = {}) {
      const precondition = resolveWritePrecondition(ifMatch);
      const document = assertGovernanceSnapshotDocument(clone(candidate), { evaluationTime });
      return write('governance', document, precondition);
    },

    async queryGovernanceSnapshots({ scopeGroupId, evaluationTime }) {
      if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
        throw new TypeError('scopeGroupId is required.');
      }
      return [...partitionOf('governance', scopeGroupId).values()]
        .map((held) => clone(held.document))
        .filter((document) => document.documentType === 'governance-snapshot')
        .map((document) => hydratePersistedGovernanceSnapshotDocument(document, { evaluationTime }))
        .sort((left, right) => left.kind.localeCompare(right.kind));
    },

    async readPrincipalMembership({ scopeGroupId, tenantId, subjectId, evaluationTime }) {
      const held = read(
        'governance',
        scopeGroupId,
        principalMembershipDocumentId({ scopeGroupId, tenantId, subjectId }),
      );
      if (held === null) return null;
      return {
        document: assertPrincipalMembershipDocument(held.document, { evaluationTime }),
        etag: held.etag,
      };
    },

    async putPrincipalMembership(candidate, { ifMatch, evaluationTime } = {}) {
      const precondition = resolveWritePrecondition(ifMatch);
      const document = assertPrincipalMembershipDocument(clone(candidate), { evaluationTime });
      return write('governance', document, precondition);
    },

    async readGovernanceSnapshotVersion({ scopeGroupId, kind }) {
      const held = read('governance', scopeGroupId, governanceSnapshotDocumentId({ scopeGroupId, kind }));
      return held === null ? null : { etag: held.etag };
    },

    async readPrincipalMembershipVersion({ scopeGroupId, tenantId, subjectId }) {
      const held = read(
        'governance',
        scopeGroupId,
        principalMembershipDocumentId({ scopeGroupId, tenantId, subjectId }),
      );
      return held === null ? null : { etag: held.etag };
    },

    async putUsageRecord(candidate) {
      const document = clone(candidate);
      // These validators answer "is this acceptable", not "give me the document": they
      // return true. Assigning from them silently substitutes a boolean for the record.
      assertUsageRecordDocument(document);
      const partition = partitionOf('governance', document.scopeGroupId);
      const held = partition.get(document.id);
      // A replay must not overwrite what it already wrote: a disagreement between two
      // runs is a finding, and overwriting the record would erase it.
      if (held !== undefined) {
        return { document: clone(held.document), etag: held.etag, created: false };
      }
      return { ...write('governance', document, { expectAbsent: true }), created: true };
    },

    async readUsageRecord({ scopeGroupId, correlationId }) {
      const held = read('governance', scopeGroupId, usageRecordDocumentId({ scopeGroupId, correlationId }));
      if (held === null) return null;
      const document = clone(held.document);
      assertUsageRecordDocument(document);
      return { document, etag: held.etag };
    },

    async queryUsageRecords({ scopeGroupId, sinceObservedAt }) {
      if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
        throw new TypeError('scopeGroupId is required.');
      }
      const records = [...partitionOf('governance', scopeGroupId).values()]
        .map((held) => clone(held.document))
        .filter((document) => document.documentType === 'usage-record' && document.observedAt >= sinceObservedAt);
      for (const document of records) assertUsageRecordDocument(document);
      return records.sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    },

    async readConfigurationDraft({ scopeGroupId, revisionId }) {
      const held = read('governance', scopeGroupId, configurationDraftDocumentId({ scopeGroupId, revisionId }));
      if (held === null) return null;
      const document = clone(held.document);
      assertConfigurationDraftDocument(document);
      return { document, etag: held.etag };
    },

    async putConfigurationDraft(candidate, { ifMatch } = {}) {
      const precondition = resolveWritePrecondition(ifMatch);
      const document = clone(candidate);
      assertConfigurationDraftDocument(document);
      return write('governance', document, precondition);
    },

    async putRollup(candidate) {
      const document = clone(candidate);
      assertUsageRollupDocument(document);
      return write('rollups', document);
    },

    async readRollup({ scopeGroupId, id }) {
      return read('rollups', scopeGroupId, id);
    },

    async queryRollupWindows({ scopeGroupId, sinceWindowStart }) {
      if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
        throw new TypeError('scopeGroupId is required.');
      }
      if (typeof sinceWindowStart !== 'string' || Number.isNaN(Date.parse(sinceWindowStart))) {
        throw new TypeError('sinceWindowStart must be an ISO-8601 instant.');
      }
      return [...partitionOf('rollups', scopeGroupId).values()]
        .map((held) => clone(held.document))
        .filter(
          (document) => document.documentType === 'usage-rollup' && document.windowStart >= sinceWindowStart,
        )
        .sort((left, right) => left.windowStart.localeCompare(right.windowStart));
    },

    async putDirectorySnapshot(candidate) {
      const document = clone(candidate);
      assertDirectorySnapshotDocument(document);
      return write('governance', document);
    },

    async readDirectorySnapshot({ scopeGroupId }) {
      return read('governance', scopeGroupId, directorySnapshotDocumentId({ scopeGroupId }));
    },

    async readConfigurationRevision({ scopeGroupId, revisionId }) {
      const held = read('governance', scopeGroupId, configurationRevisionDocumentId({ scopeGroupId, revisionId }));
      if (held === null) return null;
      const document = { ...held.document };
      delete document.id;
      return { document: assertConfigurationRevision(document), etag: held.etag };
    },

    async putConfigurationRevision(candidate, { ifMatch } = {}) {
      const precondition = resolveWritePrecondition(ifMatch);
      const revision = assertConfigurationRevision(clone(candidate));
      const document = { ...revision, id: configurationRevisionDocumentId(revision) };
      return write('governance', document, precondition);
    },

    async queryConfigurationRevisions({ scopeGroupId }) {
      if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
        throw new TypeError('scopeGroupId is required.');
      }
      return [...partitionOf('governance', scopeGroupId).values()]
        .map((held) => clone(held.document))
        .filter((document) => document.documentType === 'configuration-revision')
        .map((document) => {
          const revision = { ...document };
          delete revision.id;
          return assertConfigurationRevision(revision);
        })
        .sort((left, right) => left.revisionId.localeCompare(right.revisionId));
    },

    async readScheduleCheckpoint({ scopeGroupId, scheduleId }) {
      const held = read('governance', scopeGroupId, scheduleCheckpointDocumentId({ scopeGroupId, scheduleId }));
      if (held === null) return null;
      return { document: assertScheduleCheckpoint(held.document), etag: held.etag };
    },

    async putScheduleCheckpoint(candidate, { ifMatch } = {}) {
      const precondition = resolveWritePrecondition(ifMatch);
      const document = assertScheduleCheckpoint(clone(candidate));
      return write('governance', document, precondition);
    },

    async readNotification({ scopeGroupId, key }) {
      const held = read('governance', scopeGroupId, notificationDocumentId({ scopeGroupId, key }));
      if (held === null) return null;
      return { document: assertNotificationRecord(held.document), etag: held.etag };
    },

    async readNotificationChannel({ scopeGroupId }) {
      const held = read('governance', scopeGroupId, notificationChannelDocumentId({ scopeGroupId }));
      if (held === null) return null;
      return { document: assertNotificationChannelRecord(held.document), etag: held.etag };
    },

    async putNotificationChannel(candidate, { ifMatch } = {}) {
      const precondition = resolveWritePrecondition(ifMatch);
      const document = assertNotificationChannelRecord(clone(candidate));
      return write('governance', document, precondition);
    },

    async putNotification(candidate, { ifMatch } = {}) {
      const precondition = resolveWritePrecondition(ifMatch);
      const document = assertNotificationRecord(clone(candidate));
      return write('governance', document, precondition);
    },

    async deleteNotification({ scopeGroupId, key }, { ifMatch } = {}) {
      const precondition = resolveDeletePrecondition(ifMatch);
      const partition = partitionOf('governance', scopeGroupId);
      const id = notificationDocumentId({ scopeGroupId, key });
      const held = partition.get(id);
      if (held === undefined) return false;
      if (held.etag !== precondition.ifMatch) {
        throw new ConcurrencyConflictError('The stored notification changed since it was read.');
      }
      partition.delete(id);
      return true;
    },

    async queryNotifications({ scopeGroupId, sinceRaisedAt }) {
      if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
        throw new TypeError('scopeGroupId is required.');
      }
      if (typeof sinceRaisedAt !== 'string' || Number.isNaN(Date.parse(sinceRaisedAt))) {
        throw new TypeError('sinceRaisedAt must be an ISO-8601 instant.');
      }
      return [...partitionOf('governance', scopeGroupId).values()]
        .map((held) => clone(held.document))
        .filter(
          (document) =>
            document.documentType === 'governance-notification' && document.raisedAt >= sinceRaisedAt,
        )
        .sort((left, right) => left.raisedAt.localeCompare(right.raisedAt) || left.key.localeCompare(right.key));
    },
  });
}
