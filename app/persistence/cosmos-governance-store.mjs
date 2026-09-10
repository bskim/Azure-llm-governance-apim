import { CosmosClient } from '@azure/cosmos';

import { assertEffectivePolicyDocument } from '../governance-domain/policy/effective-policy-validator.mjs';
import { assertConfigurationRevision } from '../governance-domain/lifecycle/configuration-lifecycle.mjs';
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
  assertUsageRecordDocument,
  usageRecordDocumentId,
} from '../governance-domain/usage/usage-record-validator.mjs';
import {
  assertConfigurationDraftDocument,
  configurationDraftDocumentId,
} from '../governance-domain/lifecycle/configuration-draft-document.mjs';
import { CONTAINER_TOPOLOGY, assertContainerTopology } from './container-topology.mjs';

const GOVERNANCE_CONTAINER = 'governance';
const ROLLUPS_CONTAINER = 'rollups';
const NOT_FOUND = 404;
const CONFLICT = 409;
const PRECONDITION_FAILED = 412;
const SYSTEM_PROPERTIES = Object.freeze(['_rid', '_self', '_etag', '_ts', '_attachments']);

/** Store metadata is never part of the domain contract. */
function toDomainDocument(resource) {
  const document = { ...resource };
  for (const property of SYSTEM_PROPERTIES) delete document[property];
  return document;
}

export class ConcurrencyConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConcurrencyConflictError';
    this.code = PRECONDITION_FAILED;
  }
}

/**
 * A precondition has three answers, not two. A tag replaces the version it names,
 * `null` states that the caller looked and found nothing, and an omitted argument
 * states that the caller never looked. Collapsing the last two makes a forgotten
 * precondition indistinguishable from a deliberate create.
 */
export function resolveWritePrecondition(ifMatch) {
  if (ifMatch === undefined) {
    throw new TypeError(
      'ifMatch is required: pass the entity tag that was read, or null when the document was absent.',
    );
  }
  if (ifMatch === null) return { expectAbsent: true };
  if (typeof ifMatch !== 'string' || ifMatch.length === 0) {
    throw new TypeError('ifMatch must be a non-empty entity tag, or null.');
  }
  return { expectAbsent: false, ifMatch };
}

/** A removal has no create to fall back to, so an absent version is never an answer. */
export function resolveDeletePrecondition(ifMatch) {
  if (ifMatch === undefined) {
    throw new TypeError('ifMatch is required: pass the entity tag that was read.');
  }
  if (typeof ifMatch !== 'string' || ifMatch.length === 0) {
    throw new TypeError('ifMatch must be a non-empty entity tag.');
  }
  return { ifMatch };
}

export function effectivePolicyDocumentId({ scopeGroupId, principalKey }) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }
  if (typeof principalKey !== 'string' || principalKey.length === 0) {
    throw new TypeError('principalKey is required.');
  }
  return `effective-policy|${scopeGroupId}|${principalKey}`;
}

export function configurationRevisionDocumentId({ scopeGroupId, revisionId }) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }
  if (typeof revisionId !== 'string' || revisionId.length === 0) {
    throw new TypeError('revisionId is required.');
  }
  return `configuration-revision|${scopeGroupId}|${revisionId}`;
}

export function createCosmosClient({ endpoint, credential, key }) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new TypeError('endpoint is required.');
  }
  if (credential) return new CosmosClient({ endpoint, aadCredentials: credential });
  if (typeof key === 'string' && key.length > 0) return new CosmosClient({ endpoint, key });
  throw new TypeError('Either a credential or a key is required.');
}

/**
 * Containers are provisioned by infrastructure because creating them is not an
 * allowed data-plane operation for a managed identity. This store only resolves
 * references to containers that must already exist.
 */
export function createGovernanceStore({ client, databaseId }) {
  if (client === null || typeof client !== 'object') throw new TypeError('client is required.');
  if (typeof databaseId !== 'string' || databaseId.length === 0) {
    throw new TypeError('databaseId is required.');
  }
  assertContainerTopology();

  const declared = new Set(CONTAINER_TOPOLOGY.map((container) => container.id));
  if (!declared.has(GOVERNANCE_CONTAINER)) {
    throw new TypeError('The governance container is not declared in the topology.');
  }
  if (!declared.has(ROLLUPS_CONTAINER)) {
    throw new TypeError('The rollups container is not declared in the topology.');
  }

  const database = client.database(databaseId);
  const governance = database.container(GOVERNANCE_CONTAINER);
  const rollups = database.container(ROLLUPS_CONTAINER);

  async function readEffectivePolicy({ scopeGroupId, principalKey }) {
    const id = effectivePolicyDocumentId({ scopeGroupId, principalKey });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  async function putEffectivePolicy(candidate, { ifMatch } = {}) {
    const precondition = resolveWritePrecondition(ifMatch);
    const document = toDomainDocument(candidate);
    assertEffectivePolicyDocument(document);
    const expectedId = effectivePolicyDocumentId(document);
    if (document.id !== expectedId) {
      throw new TypeError('document.id must be derived from scopeGroupId and principalKey.');
    }

    try {
      if (!precondition.expectAbsent) {
        const { resource } = await governance
          .item(document.id, document.scopeGroupId)
          .replace(document, { accessCondition: { type: 'IfMatch', condition: precondition.ifMatch } });
        return { document: toDomainDocument(resource), etag: resource._etag };
      }
      const { resource } = await governance.items.create(document);
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === PRECONDITION_FAILED) {
        throw new ConcurrencyConflictError('The stored policy changed since it was read.');
      }
      if (error?.code === CONFLICT) {
        throw new ConcurrencyConflictError('A policy already exists for this caller.');
      }
      throw error;
    }
  }

  /**
   * Rollups are replaced outright rather than merged, because a projector run
   * recomputes a whole window. Rewriting a window is therefore safe by design,
   * which is what makes a retry or a backfill harmless.
   */
  async function putRollup(candidate) {
    const document = toDomainDocument(candidate);
    assertUsageRollupDocument(document);
    const { resource } = await rollups.items.upsert(document);
    return { document: toDomainDocument(resource), etag: resource._etag };
  }

  async function readRollup({ scopeGroupId, id }) {
    try {
      const { resource } = await rollups.item(id, scopeGroupId).read();
      if (!resource) return null;
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  /**
   * Every grain is returned rather than the one a caller asked for, because the
   * grain a report needs is decided by the read model, not by the store, and the
   * whole set for a window is small.
   */
  async function queryRollupWindows({ scopeGroupId, sinceWindowStart }) {
    if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
      throw new TypeError('scopeGroupId is required.');
    }
    if (typeof sinceWindowStart !== 'string' || Number.isNaN(Date.parse(sinceWindowStart))) {
      throw new TypeError('sinceWindowStart must be an ISO-8601 instant.');
    }

    const { resources } = await rollups.items
      .query(
        {
          query:
            'SELECT * FROM c WHERE c.documentType = @documentType AND c.windowStart >= @since ORDER BY c.windowStart ASC',
          parameters: [
            { name: '@documentType', value: 'usage-rollup' },
            { name: '@since', value: sinceWindowStart },
          ],
        },
        { partitionKey: scopeGroupId },
      )
      .fetchAll();

    return resources.map((resource) => toDomainDocument(resource));
  }

  /**
   * A scope has one current snapshot. A projection replaces it outright, because a
   * run observes the whole membership it was asked about and a half-updated
   * directory would answer differently depending on which record a screen read.
   */
  async function putDirectorySnapshot(candidate) {
    const document = toDomainDocument(candidate);
    assertDirectorySnapshotDocument(document);
    const { resource } = await governance.items.upsert(document);
    return { document: toDomainDocument(resource), etag: resource._etag };
  }

  async function readDirectorySnapshot({ scopeGroupId }) {
    const id = directorySnapshotDocumentId({ scopeGroupId });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  async function readGovernanceSnapshot({ scopeGroupId, kind, evaluationTime }) {
    const id = governanceSnapshotDocumentId({ scopeGroupId, kind });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      const document = hydratePersistedGovernanceSnapshotDocument(toDomainDocument(resource), { evaluationTime });
      return { document, etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  async function putGovernanceSnapshot(candidate, { ifMatch, evaluationTime } = {}) {
    const precondition = resolveWritePrecondition(ifMatch);
    const document = assertGovernanceSnapshotDocument(toDomainDocument(candidate), { evaluationTime });

    try {
      if (!precondition.expectAbsent) {
        const { resource } = await governance
          .item(document.id, document.scopeGroupId)
          .replace(document, { accessCondition: { type: 'IfMatch', condition: precondition.ifMatch } });
        return { document: toDomainDocument(resource), etag: resource._etag };
      }
      const { resource } = await governance.items.create(document);
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === PRECONDITION_FAILED) {
        throw new ConcurrencyConflictError('The stored snapshot changed since it was read.');
      }
      if (error?.code === CONFLICT) {
        throw new ConcurrencyConflictError('A snapshot already exists for this kind.');
      }
      throw error;
    }
  }

  async function queryGovernanceSnapshots({ scopeGroupId, evaluationTime }) {
    const { resources } = await governance.items
      .query(
        {
          query: 'SELECT * FROM c WHERE c.documentType = @documentType ORDER BY c.kind',
          parameters: [{ name: '@documentType', value: 'governance-snapshot' }],
        },
        { partitionKey: scopeGroupId },
      )
      .fetchAll();
    return resources.map((resource) =>
      hydratePersistedGovernanceSnapshotDocument(toDomainDocument(resource), { evaluationTime }),
    );
  }

  async function readPrincipalMembership({ scopeGroupId, tenantId, subjectId, evaluationTime }) {
    const id = principalMembershipDocumentId({ scopeGroupId, tenantId, subjectId });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      const document = assertPrincipalMembershipDocument(toDomainDocument(resource), { evaluationTime });
      return { document, etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  async function putPrincipalMembership(candidate, { ifMatch, evaluationTime } = {}) {
    const precondition = resolveWritePrecondition(ifMatch);
    const document = assertPrincipalMembershipDocument(toDomainDocument(candidate), { evaluationTime });

    try {
      if (!precondition.expectAbsent) {
        const { resource } = await governance
          .item(document.id, document.scopeGroupId)
          .replace(document, { accessCondition: { type: 'IfMatch', condition: precondition.ifMatch } });
        return { document: toDomainDocument(resource), etag: resource._etag };
      }
      const { resource } = await governance.items.create(document);
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === PRECONDITION_FAILED) {
        throw new ConcurrencyConflictError('The stored membership changed since it was read.');
      }
      if (error?.code === CONFLICT) {
        throw new ConcurrencyConflictError('Membership already exists for this principal.');
      }
      throw error;
    }
  }

  /**
   * What version is stored, without asking whether it is still usable.
   *
   * Reading a document to serve it and reading it to replace it are different
   * questions. Validation on read is what keeps an altered document from reaching a
   * caller, but applying it here would mean a document that has gone stale could never
   * be replaced - the writer would have to serve it in order to overwrite it.
   */
  async function readDocumentVersion({ scopeGroupId, id }) {
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      return { etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  async function readGovernanceSnapshotVersion({ scopeGroupId, kind }) {
    return readDocumentVersion({ scopeGroupId, id: governanceSnapshotDocumentId({ scopeGroupId, kind }) });
  }

  async function readPrincipalMembershipVersion({ scopeGroupId, tenantId, subjectId }) {
    return readDocumentVersion({
      scopeGroupId,
      id: principalMembershipDocumentId({ scopeGroupId, tenantId, subjectId }),
    });
  }

  /**
   * One record per request, created once. A projector that replays a window must not
   * be able to overwrite what it already wrote: a disagreement between two runs is a
   * finding, and overwriting the stored record would erase the finding.
   */
  async function putUsageRecord(candidate) {
    const document = toDomainDocument(candidate);
    // These validators answer "is this acceptable", not "give me the document": they
    // return true. Assigning from them silently substitutes a boolean for the record.
    assertUsageRecordDocument(document);
    try {
      const { resource } = await governance.items.create(document);
      return { document: toDomainDocument(resource), etag: resource._etag, created: true };
    } catch (error) {
      if (error?.code === CONFLICT) {
        const held = await readUsageRecord(document);
        return { document: held?.document ?? null, etag: held?.etag ?? null, created: false };
      }
      throw error;
    }
  }

  async function readUsageRecord({ scopeGroupId, correlationId }) {
    const id = usageRecordDocumentId({ scopeGroupId, correlationId });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      const document = toDomainDocument(resource);
      assertUsageRecordDocument(document);
      return { document, etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  async function queryUsageRecords({ scopeGroupId, sinceObservedAt }) {
    const { resources } = await governance.items
      .query(
        {
          query:
            'SELECT * FROM c WHERE c.documentType = @documentType AND c.observedAt >= @since ORDER BY c.observedAt',
          parameters: [
            { name: '@documentType', value: 'usage-record' },
            { name: '@since', value: sinceObservedAt },
          ],
        },
        { partitionKey: scopeGroupId },
      )
      .fetchAll();
    return resources.map((resource) => {
      const document = toDomainDocument(resource);
      assertUsageRecordDocument(document);
      return document;
    });
  }

  async function readConfigurationRevision({ scopeGroupId, revisionId }) {
    const id = configurationRevisionDocumentId({ scopeGroupId, revisionId });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      const document = toDomainDocument(resource);
      delete document.id;
      return { document: assertConfigurationRevision(document), etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  /**
   * The write a second administrator has to lose.
   *
   * Without the precondition the later save wins silently, which is the one outcome
   * the whole revision lifecycle exists to prevent.
   */
  async function putConfigurationRevision(candidate, { ifMatch } = {}) {
    const precondition = resolveWritePrecondition(ifMatch);
    const revision = assertConfigurationRevision(toDomainDocument(candidate));
    const document = { ...revision, id: configurationRevisionDocumentId(revision) };

    try {
      if (!precondition.expectAbsent) {
        const { resource } = await governance
          .item(document.id, document.scopeGroupId)
          .replace(document, { accessCondition: { type: 'IfMatch', condition: precondition.ifMatch } });
        return { document: toDomainDocument(resource), etag: resource._etag };
      }
      const { resource } = await governance.items.create(document);
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === PRECONDITION_FAILED) {
        throw new ConcurrencyConflictError('The stored revision changed since it was read.');
      }
      if (error?.code === CONFLICT) {
        throw new ConcurrencyConflictError('A revision already exists with this identifier.');
      }
      throw error;
    }
  }

  async function readConfigurationDraft({ scopeGroupId, revisionId }) {
    const id = configurationDraftDocumentId({ scopeGroupId, revisionId });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      const document = toDomainDocument(resource);
      assertConfigurationDraftDocument(document);
      return { document, etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  async function putConfigurationDraft(candidate, { ifMatch } = {}) {
    const precondition = resolveWritePrecondition(ifMatch);
    const document = toDomainDocument(candidate);
    assertConfigurationDraftDocument(document);
    try {
      if (!precondition.expectAbsent) {
        const { resource } = await governance
          .item(document.id, document.scopeGroupId)
          .replace(document, { accessCondition: { type: 'IfMatch', condition: precondition.ifMatch } });
        return { document: toDomainDocument(resource), etag: resource._etag };
      }
      const { resource } = await governance.items.create(document);
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === PRECONDITION_FAILED) {
        throw new ConcurrencyConflictError('The stored draft changed since it was read.');
      }
      if (error?.code === CONFLICT) {
        throw new ConcurrencyConflictError('A draft already exists for this revision.');
      }
      throw error;
    }
  }

  async function readScheduleCheckpoint({ scopeGroupId, scheduleId }) {
    const id = scheduleCheckpointDocumentId({ scopeGroupId, scheduleId });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      return { document: assertScheduleCheckpoint(toDomainDocument(resource)), etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  /**
   * The precondition is the whole point: two runners can both hold a plan, and only
   * the one whose lease is still the stored one may keep it.
   */
  async function putScheduleCheckpoint(candidate, { ifMatch } = {}) {
    const precondition = resolveWritePrecondition(ifMatch);
    const document = assertScheduleCheckpoint(toDomainDocument(candidate));
    try {
      if (!precondition.expectAbsent) {
        const { resource } = await governance
          .item(document.id, document.scopeGroupId)
          .replace(document, { accessCondition: { type: 'IfMatch', condition: precondition.ifMatch } });
        return { document: toDomainDocument(resource), etag: resource._etag };
      }
      const { resource } = await governance.items.create(document);
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === PRECONDITION_FAILED) {
        throw new ConcurrencyConflictError('The stored checkpoint changed since it was read.');
      }
      if (error?.code === CONFLICT) {
        throw new ConcurrencyConflictError('A checkpoint already exists for this schedule.');
      }
      throw error;
    }
  }

  async function queryConfigurationRevisions({ scopeGroupId }) {
    const { resources } = await governance.items
      .query(
        {
          query: 'SELECT * FROM c WHERE c.documentType = @documentType ORDER BY c.revisionId',
          parameters: [{ name: '@documentType', value: 'configuration-revision' }],
        },
        { partitionKey: scopeGroupId },
      )
      .fetchAll();
    return resources.map((resource) => {
      const document = toDomainDocument(resource);
      delete document.id;
      return assertConfigurationRevision(document);
    });
  }

  async function readNotification({ scopeGroupId, key }) {
    const id = notificationDocumentId({ scopeGroupId, key });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      return { document: assertNotificationRecord(toDomainDocument(resource)), etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  async function readNotificationChannel({ scopeGroupId }) {
    const id = notificationChannelDocumentId({ scopeGroupId });
    try {
      const { resource } = await governance.item(id, scopeGroupId).read();
      if (!resource) return null;
      return { document: assertNotificationChannelRecord(toDomainDocument(resource)), etag: resource._etag };
    } catch (error) {
      if (error?.code === NOT_FOUND) return null;
      throw error;
    }
  }

  async function putNotificationChannel(candidate, { ifMatch } = {}) {
    const precondition = resolveWritePrecondition(ifMatch);
    const document = assertNotificationChannelRecord(toDomainDocument(candidate));
    try {
      if (!precondition.expectAbsent) {
        const { resource } = await governance
          .item(document.id, document.scopeGroupId)
          .replace(document, { accessCondition: { type: 'IfMatch', condition: precondition.ifMatch } });
        return { document: toDomainDocument(resource), etag: resource._etag };
      }
      const { resource } = await governance.items.create(document);
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === PRECONDITION_FAILED || error?.code === CONFLICT) {
        throw new ConcurrencyConflictError('The stored notification channel changed since it was read.');
      }
      throw error;
    }
  }

  /**
   * Creating without a tag is how a duplicate is detected: two workers that both
   * decided the same threshold was crossed produce the same identifier, and the
   * store refuses the second rather than sending the notification twice.
   */
  async function putNotification(candidate, { ifMatch } = {}) {
    const precondition = resolveWritePrecondition(ifMatch);
    const document = assertNotificationRecord(toDomainDocument(candidate));
    try {
      if (!precondition.expectAbsent) {
        const { resource } = await governance
          .item(document.id, document.scopeGroupId)
          .replace(document, { accessCondition: { type: 'IfMatch', condition: precondition.ifMatch } });
        return { document: toDomainDocument(resource), etag: resource._etag };
      }
      const { resource } = await governance.items.create(document);
      return { document: toDomainDocument(resource), etag: resource._etag };
    } catch (error) {
      if (error?.code === PRECONDITION_FAILED) {
        throw new ConcurrencyConflictError('The stored notification changed since it was read.');
      }
      if (error?.code === CONFLICT) {
        throw new ConcurrencyConflictError('This notification was already raised.');
      }
      throw error;
    }
  }

  async function deleteNotification({ scopeGroupId, key }, { ifMatch } = {}) {
    const precondition = resolveDeletePrecondition(ifMatch);
    const id = notificationDocumentId({ scopeGroupId, key });
    try {
      await governance
        .item(id, scopeGroupId)
        .delete({ accessCondition: { type: 'IfMatch', condition: precondition.ifMatch } });
      return true;
    } catch (error) {
      if (error?.code === NOT_FOUND) return false;
      if (error?.code === PRECONDITION_FAILED) {
        throw new ConcurrencyConflictError('The stored notification changed since it was read.');
      }
      throw error;
    }
  }

  async function queryNotifications({ scopeGroupId, sinceRaisedAt }) {
    const { resources } = await governance.items
      .query(
        {
          query:
            'SELECT * FROM c WHERE c.documentType = @documentType AND c.raisedAt >= @since ORDER BY c.raisedAt',
          parameters: [
            { name: '@documentType', value: 'governance-notification' },
            { name: '@since', value: sinceRaisedAt },
          ],
        },
        { partitionKey: scopeGroupId },
      )
      .fetchAll();
    return resources.map(toDomainDocument);
  }

  return Object.freeze({
    databaseId,
    containerId: GOVERNANCE_CONTAINER,
    rollupContainerId: ROLLUPS_CONTAINER,
    readEffectivePolicy,
    putEffectivePolicy,
    readGovernanceSnapshot,
    readGovernanceSnapshotVersion,
    putGovernanceSnapshot,
    queryGovernanceSnapshots,
    readPrincipalMembership,
    readPrincipalMembershipVersion,
    putPrincipalMembership,
    putUsageRecord,
    readUsageRecord,
    queryUsageRecords,
    putRollup,
    readRollup,
    queryRollupWindows,
    putDirectorySnapshot,
    readDirectorySnapshot,
    readConfigurationRevision,
    putConfigurationRevision,
    queryConfigurationRevisions,
    readConfigurationDraft,
    putConfigurationDraft,
    readScheduleCheckpoint,
    putScheduleCheckpoint,
    readNotification,
    putNotification,
    deleteNotification,
    queryNotifications,
    readNotificationChannel,
    putNotificationChannel,
  });
}
