import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluateGovernanceAuthorization } from '../governance-domain/authorization/governance-authorization-evaluator.mjs';
import {
  compileFallbackPlan,
  derivePermittedTargets,
  selectFallbackPlan,
} from '../governance-domain/policy/fallback-plan-compiler.mjs';
import { API_FAMILIES } from '../governance-domain/registry/model-registry-validator.mjs';
import { publishBudgets } from '../governance-domain/policy/budget-publication.mjs';
import { decideModelSelection } from '../governance-domain/policy/model-selection-decision.mjs';
import { projectAdminOverview } from './admin-read-model-projector.mjs';
import { projectBudgets } from './budgets-read-model-projector.mjs';
import {
  adaptRequest,
  createInvocationContext,
  writeHandlerResponse,
} from './functions-http-adapter.mjs';
import { projectUsersGroupsReadModel } from './users-groups-read-model-projector.mjs';
import { createEffectivePolicyHandler } from '../functions/handlers/effective-policy.mjs';
import {
  createLocalPolicyResolver,
  createPersonaRuntime,
  createPersonaScopedResolver,
  EVALUATION_TIME as evaluationTime,
  isKnownPersona,
  PERSONAS,
  PUBLISHED_CONFIGURATION as publishedConfiguration,
} from '../functions/composition-root.mjs';
import { createSequenceIdGenerator } from '../local-adapters/deterministic-time.mjs';
import { createLocalGovernanceSource } from './local-governance-source.mjs';
import {
  budgetObservationSelector,
  observePeriodConsumption,
} from '../governance-domain/usage/period-consumption.mjs';
import { startOfPeriod, scopeKeysInPeriod } from '../governance-domain/usage/budget-period.mjs';
import { buildOverviewFromRollups } from './overview-usage-source.mjs';
import { projectUsage } from './usage-read-model-projector.mjs';
import { projectModels } from './models-read-model-projector.mjs';
import { projectFallback } from './fallback-read-model-projector.mjs';
import { projectLifecycle } from './lifecycle-read-model-projector.mjs';
import { createConfigurationWriter } from './configuration-writer.mjs';
import { createInMemoryGovernanceStore } from '../persistence/in-memory-governance-store.mjs';
import {
  createNotificationChannelRecord,
  describeNotificationChannel,
  SUPPORTED_CHANNEL_KINDS,
} from '../governance-domain/notification/notification-channel.mjs';
import { availableCommands } from '../governance-domain/lifecycle/configuration-lifecycle.mjs';
import { assembleGovernanceSnapshots } from '../governance-domain/policy/governance-snapshot-document.mjs';
import { addBudget, editBudget, removeBudget } from '../governance-domain/policy/budget-edit.mjs';
import { editFallbackPlan } from '../governance-domain/policy/fallback-plan-edit.mjs';
import { addEntitlementBinding, editEntitlementBinding, ENTITLEMENT_GRANT_REASONS } from '../governance-domain/authorization/entitlement-edit.mjs';
import { addTeam, removeTeam, TEAM_REMOVAL_REASONS } from '../governance-domain/authorization/team-catalog-edit.mjs';
import {
  ASSIGNMENT_GRANT_RULES,
  grantAssignment,
  revokeAssignment,
} from '../governance-domain/authorization/assignment-edit.mjs';
import { addModel, captureModel, recaptureModels, removeModel } from '../governance-domain/registry/model-capture.mjs';
import { referencePricesFor } from '../governance-domain/registry/price-reference.mjs';
import { createDraftAuthor, DraftUnavailableError } from './draft-authoring.mjs';
import { createGovernancePublisher, governancePublicationTargets } from './governance-publisher.mjs';
import { createProposalPublisher } from './proposal-publication.mjs';
import { projectChangeLog } from './change-log-read-model-projector.mjs';
import { deriveChangeEntries } from '../governance-domain/change-log/derive-change-entries.mjs';
import { projectNotifications } from './notifications-read-model-projector.mjs';
import { createNotificationLedger } from './notification-ledger.mjs';
import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';
import { DEPLOYED_THROTTLE_TIER_CODES } from './throttle-tier-codes.mjs';

// Reading governance and changing it are different authorities. An auditor sees every
// scope and may change nothing, so the panel is not offered to them rather than offered
// and refused after the click.
const GOVERNANCE_AUTHORING_ROLES = Object.freeze(['governance-admin']);

// Offered rather than typed, for the same reason the publish failures are: a free-text
// field is a memory test, and an audit record needs a code an auditor can group by.
const REVOCATION_REASON_CODES = Object.freeze([
  'left-the-organization',
  'changed-role',
  'access-review-removed',
  'granted-in-error',
  'temporary-access-expired',
]);

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(moduleDirectory, '..', 'admin-ui', 'public');
const LOCAL_POLICY_AUDIENCE = 'local-policy-resolution';
const LOCAL_POLICY_PRINCIPAL = Buffer.from(JSON.stringify({
  auth_typ: 'local',
  role_typ: 'roles',
  claims: [
    { typ: 'aud', val: LOCAL_POLICY_AUDIENCE },
    { typ: 'tid', val: 'tenant-local-demo' },
    { typ: 'oid', val: 'gateway-local-demo' },
    { typ: 'roles', val: 'Policy.Resolve' },
  ],
}), 'utf8').toString('base64');

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
});

function json(response, statusCode, value, requestId) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Local-Demo': 'true',
    'X-Request-Id': requestId,
  });
  response.end(JSON.stringify(value));
}

// Two of the states are refusals rather than readings, so they are answered before a
// read model is built. Every screen answers them the same way, and a screen that does
// not declare a state refuses the selection instead of substituting another.
function refuseUnreadableState({ response, requestId, declared, fixtureName }) {
  if (!declared.includes(fixtureName)) {
    json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
    return true;
  }
  if (fixtureName === 'error') {
    json(response, 503, { error: { code: 'local_fixture_unavailable', requestId } }, requestId);
    return true;
  }
  if (fixtureName === 'denied') {
    json(response, 403, { error: { code: 'scope_denied', requestId } }, requestId);
    return true;
  }
  return false;
}

function assertGovernanceAuthor(authorization) {
  const roles = authorization.effectiveRoles ?? [];
  if (!roles.some((role) => GOVERNANCE_AUTHORING_ROLES.includes(role))) {
    const error = new Error('not-a-governance-author');
    error.code = 'not-a-governance-author';
    throw error;
  }
}

function evaluateLocalAuthorization(context, snapshots) {
  return {
    authorization: evaluateGovernanceAuthorization({
      principalContext: context,
      assignmentSnapshot: snapshots.assignmentSnapshot,
      entitlementSnapshot: snapshots.entitlementSnapshot,
      evaluationTime,
    }),
    entitlementSnapshot: snapshots.entitlementSnapshot,
  };
}

async function serveStatic(response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const targetPath = path.resolve(publicRoot, relativePath);
  if (!targetPath.startsWith(`${publicRoot}${path.sep}`) && targetPath !== path.join(publicRoot, 'index.html')) {
    return false;
  }
  try {
    await access(targetPath);
    const fileStat = await stat(targetPath);
    if (!fileStat.isFile()) return false;
  } catch {
    return false;
  }
  const contentType = CONTENT_TYPES[path.extname(targetPath)] ?? 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Frame-Options': 'DENY',
  });
  createReadStream(targetPath).pipe(response);
  return true;
}

/**
 * What each proposal route changes, and nothing else about it.
 *
 * One route shape, one write path, and a table of the edits it can apply, so adding a
 * governance surface is a row rather than another copy of the propose-approve-publish
 * plumbing. Each entry returns the next whole set, because that is what publishes.
 *
 * An entry may be asynchronous and is given the read source, because capturing a model
 * is the one edit whose input is not in the request: what the registry keeps is read
 * from the provider's own answer about the deployment, never typed by an administrator.
 */

function findDeployment(quota, deploymentName) {
  const deployment = quota.deployments.find((entry) => entry.deploymentName === deploymentName);
  if (deployment === undefined) {
    const refused = new Error(`No deployment is named ${deploymentName}.`);
    refused.code = 'model-capture-deployment-unknown';
    throw refused;
  }
  return deployment;
}
const PROPOSAL_ROUTES = new Map([
  ['/api/local/budgets/propose', (snapshots, body, at) => ({
    ...snapshots,
    budgetSnapshot: body.command === 'add'
      ? addBudget({
          snapshot: snapshots.budgetSnapshot,
          budget: body.budget,
          declaredTierCodes: DEPLOYED_THROTTLE_TIER_CODES,
          at,
        })
      : body.command === 'remove'
        ? removeBudget({
            snapshot: snapshots.budgetSnapshot,
            budgetId: body.budgetId,
            reasonCode: body.reasonCode,
            at,
          })
        : editBudget({
            snapshot: snapshots.budgetSnapshot,
            budgetId: body.budgetId,
            changes: body.changes ?? {},
            declaredTierCodes: DEPLOYED_THROTTLE_TIER_CODES,
            at,
          }),
  })],
  ['/api/local/fallback/propose', (snapshots, body, at) => ({
    ...snapshots,
    fallbackPolicySnapshot: editFallbackPlan({
      snapshot: snapshots.fallbackPolicySnapshot,
      planId: body.planId,
      changes: body.changes ?? {},
      at,
    }),
  })],
  ['/api/local/entitlements/propose', (snapshots, body, at) => ({
    ...snapshots,
    entitlementSnapshot: body.command === 'add'
      ? addEntitlementBinding({
        snapshot: snapshots.entitlementSnapshot,
        bindingId: body.bindingId,
        target: body.target,
        modelAllowlist: body.modelAllowlist,
        limits: body.limits ?? {},
        issuedBy: { kind: 'subject', key: 'local-governance-admin' },
        reasonCode: body.reasonCode,
        registry: snapshots.modelRegistrySnapshot,
        at,
      })
      : editEntitlementBinding({
        snapshot: snapshots.entitlementSnapshot,
        bindingId: body.bindingId,
        changes: body.changes ?? {},
        registry: snapshots.modelRegistrySnapshot,
        at,
      }),
  })],
  ['/api/local/teams/propose', (snapshots, body, at) => ({
    ...snapshots,
    entitlementSnapshot: body.command === 'remove'
      ? removeTeam({
        snapshot: snapshots.entitlementSnapshot,
        teamKey: body.teamKey,
        reasonCode: body.reasonCode,
        at,
      })
      : addTeam({
        snapshot: snapshots.entitlementSnapshot,
        teamKey: body.teamKey,
        membershipGroupId: body.membershipGroupId,
        at,
      }),
  })],
  ['/api/local/assignments/propose', (snapshots, body, at) => ({
    ...snapshots,
    assignmentSnapshot: body.command === 'revoke'
      ? revokeAssignment({
          snapshot: snapshots.assignmentSnapshot,
          assignmentId: body.assignmentId,
          reasonCode: body.reasonCode,
          at,
        })
      : grantAssignment({
          snapshot: snapshots.assignmentSnapshot,
          assignmentId: body.assignmentId,
          roleCode: body.roleCode,
          assignee: body.assignee,
          scope: body.scope,
          // The authority behind a grant is the signed-in administrator, so it is
          // taken from the actor rather than from anything the request names.
          issuedBy: { kind: 'subject', key: body.actor },
          reasonCode: body.reasonCode,
          at,
        }),
  })],
  ['/api/local/models/propose', async (snapshots, body, at, { source }) => ({
    ...snapshots,
    modelRegistrySnapshot: body.command === 'remove'
      ? removeModel({
          snapshot: snapshots.modelRegistrySnapshot,
          modelKey: body.modelKey,
          reasonCode: body.reasonCode,
          // Supplied explicitly, including as null, so "there was no entitlement set to
          // check" is never mistaken for "nothing is entitled to this model".
          entitlementSnapshot: snapshots.entitlementSnapshot ?? null,
          at,
        })
      : body.command === 'recapture'
        ? recaptureModels({
            snapshot: snapshots.modelRegistrySnapshot,
            deployments: (await source.readProviderQuota()).deployments,
            at,
          })
        : addModel({
          snapshot: snapshots.modelRegistrySnapshot,
          model: captureModel({
            deployment: findDeployment(await source.readProviderQuota(), body.deploymentName),
            modelKey: body.modelKey,
          }),
          at,
        }),
  })],
]);

export function createLocalAdminServer({ source = createLocalGovernanceSource({ evaluationTime }) } = {}) {
  const idGenerator = createSequenceIdGenerator('local-admin');
  // One store for the life of the process, so two requests can race the way two
  // administrators do. A per-request store would make every save the first one.
  const revisionStore = createInMemoryGovernanceStore();
  const revisionWriter = createConfigurationWriter({ store: revisionStore });
  const SCOPE_GROUP_ID = 'platform-engineering';
  const clock = { nowIso: () => evaluationTime };
  // A policy edit publishes the five snapshots. Membership is directory-derived, so a
  // proposal that only changes policy does not declare it as a target.
  const POLICY_TARGETS = governancePublicationTargets({ includeMembership: false });
  const drafts = createDraftAuthor({
    store: revisionStore,
    scopeGroupId: SCOPE_GROUP_ID,
    clock,
    targets: POLICY_TARGETS,
  });
  const proposals = createProposalPublisher({
    store: revisionStore,
    publisher: createGovernancePublisher({ store: revisionStore, scopeGroupId: SCOPE_GROUP_ID, clock }),
    drafts,
    scopeGroupId: SCOPE_GROUP_ID,
    clock,
  });

  /**
   * What an edit starts from, and what the screens show. Before anything is published
   * the seed is the current set; after a publish it is what was published, because an
   * edit that vanished from the screen it was made on is worse than one that failed.
   */
  async function currentSnapshots() {
    const documents = await revisionStore.queryGovernanceSnapshots({
      scopeGroupId: SCOPE_GROUP_ID,
      evaluationTime,
    });
    if (documents.length === 0) return await source.readGovernanceSnapshots();
    return assembleGovernanceSnapshots(documents);
  }

  const notificationLedger = createNotificationLedger({
    store: revisionStore,
    scopeGroupId: 'platform-engineering',
  });
  let seeded = null;
  let notificationsSeeded = null;

  async function seedNotifications() {
    if (notificationsSeeded === null) {
      notificationsSeeded = (async () => {
        for (const record of await source.readNotificationSeed()) {
          await revisionStore.putNotification(record, { ifMatch: null });
        }
      })();
    }
    return notificationsSeeded;
  }

  async function seedRevisions() {
    if (seeded === null) {
      seeded = (async () => {
        for (const revision of await source.readConfigurationRevisions()) {
          await revisionStore.putConfigurationRevision(revision, { ifMatch: null });
        }
      })();
    }
    return seeded;
  }

  async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 64_000) throw new TypeError('body-too-large');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  return http.createServer(async (request, response) => {
    const requestId = idGenerator.next();
    const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
    const url = new URL(request.url ?? '/', origin);

    // The gateway resolves caller policy here on a cache miss. It runs the same
    // handler the Functions host runs, reached through a transport shim.
    if (url.pathname === '/api/v1/internal/effective-policy') {
      if (request.method !== 'POST') {
        json(response, 405, { error: { code: 'method_not_allowed', requestId } }, requestId);
        return;
      }
      const handler = createEffectivePolicyHandler({
        resolver: createPersonaScopedResolver(idGenerator),
        personaGuard: isKnownPersona,
        expectedAudience: LOCAL_POLICY_AUDIENCE,
        requiredRole: 'Policy.Resolve',
      });
      // Local development has no identity provider. Overwrite rather than trust a
      // caller-supplied platform header, then exercise the same handler boundary.
      request.headers['x-ms-client-principal'] = LOCAL_POLICY_PRINCIPAL;
      const result = await handler(
        adaptRequest(request, url),
        createInvocationContext(requestId),
      );
      writeHandlerResponse(response, result);
      return;
    }

    // Saving a revision. The caller states the version it read, so a second
    // administrator who read the same one is refused rather than silently winning.
    if (url.pathname === '/api/local/lifecycle/save') {
      if (request.method !== 'POST') {
        json(response, 405, { error: { code: 'method_not_allowed', requestId } }, requestId);
        return;
      }
      await seedRevisions();
      let body;
      try {
        body = await readJsonBody(request);
      } catch {
        json(response, 400, { error: { code: 'body_not_readable', requestId } }, requestId);
        return;
      }
      const {
        revisionId,
        etag,
        command,
        actor,
        force = false,
        acknowledgedEtag,
        expectedRevisionNumber,
        loaded,
        // Named here only to keep it out of `rest`. An authority a caller can assert
        // about itself is not an authority.
        selfApprovalGranted: _ignoredSelfApproval,
        ...rest
      } = body;
      if (typeof revisionId !== 'string' || typeof command !== 'string' || typeof actor !== 'string') {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      const held = await revisionWriter.readForEdit({ scopeGroupId: 'platform-engineering', revisionId });
      if (held === null) {
        json(response, 404, { error: { code: 'revision_absent', requestId } }, requestId);
        return;
      }
      try {
        // The command is applied to the stored revision, never to a copy the caller
        // supplied: a caller that could choose its own base could hand back a doctored
        // revision and have the write land on top of the real one. What the caller read
        // is used only to say what a save would discard, so at worst it misleads itself.
        const result = await revisionWriter.save({
          loaded: held.revision,
          priorReading: loaded ?? null,
          etag: typeof etag === 'string' ? etag : held.etag,
          expectedRevisionNumber:
            typeof expectedRevisionNumber === 'number' ? expectedRevisionNumber : undefined,
          command,
          actor,
          at: evaluationTime,
          selfApprovalGranted: source.capabilities.selfApprovalActors.includes(actor),
          force: force === true,
          acknowledgedEtag: typeof acknowledgedEtag === 'string' ? acknowledgedEtag : null,
          ...rest,
        });
        json(response, result.outcome === 'saved' ? 200 : 409, result, requestId);
      } catch (error) {
        json(response, 400, { error: { code: error.code ?? 'save_refused', requestId } }, requestId);
      }
      return;
    }

    // Editing governance. Every change becomes a complete proposal, because what
    // publishes is the versioned set and a partial write would land unvalidated
    // against the rest. One path in, whatever was edited.
    if (PROPOSAL_ROUTES.has(url.pathname)) {
      if (request.method !== 'POST') {
        json(response, 405, { error: { code: 'method_not_allowed', requestId } }, requestId);
        return;
      }
      await seedRevisions();
      let body;
      try {
        body = await readJsonBody(request);
      } catch {
        json(response, 400, { error: { code: 'body_not_readable', requestId } }, requestId);
        return;
      }
      const { actor } = body;
      if (typeof actor !== 'string' || actor.length === 0) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      try {
        // The authority is derived from the acting persona, never from the request
        // naming an actor: a name in a body is a claim, not a permission.
        const runtime = createPersonaRuntime(url.searchParams.get('persona') ?? 'governance-admin', idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const snapshots = await currentSnapshots();
        const { authorization } = evaluateLocalAuthorization(context, snapshots);
        assertGovernanceAuthor(authorization);
        const proposed = await drafts.propose({
          content: { snapshots: await PROPOSAL_ROUTES.get(url.pathname)(snapshots, body, evaluationTime, { source }) },
          authoredBy: actor,
        });
        json(
          response,
          201,
          {
            outcome: 'proposed',
            revisionId: proposed.revision.revisionId,
            revisionNumber: proposed.revision.revisionNumber,
            state: proposed.revision.state,
            etag: proposed.etag,
          },
          requestId,
        );
      } catch (error) {
        // Not being allowed to change governance is a refusal of the caller, not of
        // the edit, so it answers 403 rather than joining the edit's own reasons.
        if (error.code === 'not-a-governance-author') {
          json(response, 403, { outcome: 'refused', reasonCode: error.code, requestId }, requestId);
          return;
        }
        // A refused edit is the operator's answer, not a fault. Only something with no
        // reason code of its own is treated as one.
        const refused = typeof error.code === 'string' || error instanceof DraftUnavailableError;
        json(
          response,
          refused ? 409 : 500,
          { outcome: 'refused', reasonCode: error.code ?? 'propose_failed', requestId },
          requestId,
        );
      }
      return;
    }

    // Applying an approved proposal. There is nowhere to put content: what publishes is
    // what was approved, read from the store.
    if (url.pathname === '/api/local/lifecycle/publish') {
      if (request.method !== 'POST') {
        json(response, 405, { error: { code: 'method_not_allowed', requestId } }, requestId);
        return;
      }
      await seedRevisions();
      let body;
      try {
        body = await readJsonBody(request);
      } catch {
        json(response, 400, { error: { code: 'body_not_readable', requestId } }, requestId);
        return;
      }
      const { revisionId, actor } = body;
      if (typeof revisionId !== 'string' || typeof actor !== 'string') {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      const revisions = await revisionStore.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
      const inFlight = revisions.find(
        (revision) => revision.state === 'publishing' && revision.revisionId !== revisionId,
      );
      const result = await proposals.publish({
        revisionId,
        actor,
        // `null` says the caller looked and found nothing, which is not the same answer
        // as never having looked.
        inFlightRevisionId: inFlight?.revisionId ?? null,
      });
      json(response, result.outcome === 'refused' ? 409 : 200, { ...result, requestId }, requestId);
      return;
    }

    // Acknowledging says a person has seen it. It never claims the channel worked.
    if (url.pathname === '/api/local/notifications/channel') {
      if (request.method === 'GET') {
        const held = await revisionStore.readNotificationChannel({ scopeGroupId: 'platform-engineering' });
        json(
          response,
          200,
          { ...describeNotificationChannel(held?.document ?? null), supportedKinds: SUPPORTED_CHANNEL_KINDS },
          requestId,
        );
        return;
      }
      if (request.method !== 'PUT') {
        json(response, 405, { error: { code: 'method_not_allowed', requestId } }, requestId);
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch {
        json(response, 400, { error: { code: 'body_not_readable', requestId } }, requestId);
        return;
      }
      let record;
      try {
        record = createNotificationChannelRecord({
          scopeGroupId: 'platform-engineering',
          channelKind: body?.channelKind,
          endpoint: body?.endpoint,
          updatedByCode: 'local-auditor',
          at: evaluationTime,
        });
      } catch (error) {
        // The endpoint is a credential, so the refusal names the rule and not the value.
        json(response, 400, { error: { code: 'channel_not_acceptable', reasonCode: error?.reasonCode ?? 'endpoint-refused', requestId } }, requestId);
        return;
      }
      const held = await revisionStore.readNotificationChannel({ scopeGroupId: 'platform-engineering' });
      await revisionStore.putNotificationChannel(record, { ifMatch: held?.etag ?? null });
      json(response, 200, { ok: true, ...describeNotificationChannel(record) }, requestId);
      return;
    }

    if (url.pathname === '/api/local/notifications/acknowledge') {
      if (request.method !== 'POST') {
        json(response, 405, { error: { code: 'method_not_allowed', requestId } }, requestId);
        return;
      }
      await seedNotifications();
      let body;
      try {
        body = await readJsonBody(request);
      } catch {
        json(response, 400, { error: { code: 'body_not_readable', requestId } }, requestId);
        return;
      }
      const { key, actorCode } = body;
      if (typeof key !== 'string' || typeof actorCode !== 'string') {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      try {
        const result = await notificationLedger.acknowledge({ key, actorCode, at: evaluationTime });
        json(response, result.ok === true ? 200 : 409, result, requestId);
      } catch (error) {
        json(response, 400, { error: { code: error.code ?? 'acknowledge_refused', requestId } }, requestId);
      }
      return;
    }

    if (request.method !== 'GET') {
      json(response, 405, { error: { code: 'method_not_allowed', requestId } }, requestId);
      return;
    }
    // The edit form loads the entity and its version, because the list is a
    // projection and cannot say which version a save should be written against.
    if (url.pathname === '/api/local/lifecycle/revision') {
      await seedRevisions();
      const revisionId = url.searchParams.get('revisionId') ?? '';
      const viewer = url.searchParams.get('viewer') ?? source.capabilities.defaultLifecycleViewer;
      const held = await revisionWriter.readForEdit({ scopeGroupId: 'platform-engineering', revisionId });
      if (held === null) {
        json(response, 404, { error: { code: 'revision_absent', requestId } }, requestId);
        return;
      }
      json(
        response,
        200,
        {
          revisionId: held.revision.revisionId,
          revisionNumber: held.revision.revisionNumber,
          state: held.revision.state,
          etag: held.etag,
          revision: held.revision,
          availableCommands: availableCommands(held.revision, {
            actor: viewer,
            selfApprovalGranted: source.capabilities.selfApprovalActors.includes(viewer),
          }),
        },
        requestId,
      );
      return;
    }
    // What an access change may choose from. It is a management surface rather than a
    // screen projection, so it names the identifiers an edit needs instead of widening
    // the pseudonymous read model that the directory table is built from.
    if (url.pathname === '/api/local/access-options') {
      const personaName = url.searchParams.get('persona') ?? 'governance-admin';
      if (!Object.hasOwn(PERSONAS, personaName)) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      try {
        const runtime = createPersonaRuntime(personaName, idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const snapshots = await currentSnapshots();
        const { authorization } = evaluateLocalAuthorization(context, snapshots);
        // Changing access is a global act, so it is authorized as one rather than
        // being offered to a reader who may only see their own team.
        assertAuthorizedReadScope({ authorization, scope: 'global', teamKey: null });
        assertGovernanceAuthor(authorization);
        json(
          response,
          200,
          {
            readModelVersion: 'access-options.v1',
            generatedAt: evaluationTime,
            models: snapshots.modelRegistrySnapshot.models.map((model) => model.modelKey),
            budgetOptions: { throttleTierCodes: [...DEPLOYED_THROTTLE_TIER_CODES] },
            teams: snapshots.entitlementSnapshot.teamCatalog.map((mapping) => ({
              teamCode: mapping.teamKey,
              membershipGroupCode: mapping.membershipGroupId,
              bindingCodes: snapshots.entitlementSnapshot.bindings
                .filter((binding) => binding.target.kind === 'team' && binding.target.key === mapping.teamKey)
                .map((binding) => binding.bindingId),
            })),
            bindings: snapshots.entitlementSnapshot.bindings
              .map((binding) => ({
                bindingCode: binding.bindingId,
                targetKind: binding.target.kind,
                targetCode: binding.target.key,
                state: binding.state,
                canRestore:
                  binding.state === 'revoked'
                  && (binding.validUntil === null || Date.parse(binding.validUntil) > Date.parse(evaluationTime)),
                modelCodes: [...binding.modelAllowlist],
                limits: structuredClone(binding.limits),
              })),
            assignments: snapshots.assignmentSnapshot.assignments
              .filter((assignment) => assignment.state === 'active')
              .map((assignment) => ({
                assignmentCode: assignment.assignmentId,
                roleCode: assignment.roleCode,
                assigneeKind: assignment.assignee.kind,
                assigneeCode: assignment.assignee.key,
                scopeKind: assignment.scope.kind,
                scopeCode: assignment.scope.key,
              })),
            revocationReasonCodes: REVOCATION_REASON_CODES,
            grantReasonCodes: ENTITLEMENT_GRANT_REASONS,
            assignmentGrantRules: ASSIGNMENT_GRANT_RULES.map((rule) => ({
              roleCode: rule.roleCode,
              assigneeKinds: [...rule.assigneeKinds],
              scopeKinds: [...rule.scopeKinds],
            })),
            teamRemovalReasonCodes: TEAM_REMOVAL_REASONS,
          },
          requestId,
        );
      } catch (error) {
        const status = ['scope-denied', 'team-scope-denied', 'membership-not-authoritative', 'not-a-governance-author'].includes(error.code)
          ? 403
          : 500;
        json(response, status, { error: { code: error.code ?? 'local_read_model_failed', requestId } }, requestId);
      }
      return;
    }

    if (url.pathname === '/healthz') {
      json(response, 200, { status: 'ok' }, requestId);
      return;
    }
    // Local development has no identity provider, and the console has to be told so
    // rather than left to guess from a failed request.
    if (url.pathname === '/admin-config.json') {
      json(response, 200, { mode: 'local' }, requestId);
      return;
    }
    if (url.pathname === '/api/v1/internal/principal-context') {
      json(response, 404, { error: { code: 'not_found', requestId } }, requestId);
      return;
    }
    if (url.pathname === '/api/local/overview') {
      const fixtureName = url.searchParams.get('fixture') ?? 'complete';
      const personaName = url.searchParams.get('persona') ?? 'governance-admin';
      const scope = url.searchParams.get('scope') ?? 'global';
      const range = url.searchParams.get('range') ?? '24h';
      const teamKey = url.searchParams.get('team') ?? 'platform-engineering';
      const overviewSource = url.searchParams.get('source') ?? 'fixture';
      if (!source.capabilities.overviewSources.includes(overviewSource)) {
        json(response, 400, { error: { code: 'source_not_supported', requestId } }, requestId);
        return;
      }
      if (!source.capabilities.overviewFixtures.includes(fixtureName) || !Object.hasOwn(PERSONAS, personaName)) {
        json(response, 400, { error: { code: 'fixture_not_supported', requestId } }, requestId);
        return;
      }
      if (fixtureName === 'error') {
        json(response, 503, { error: { code: 'local_fixture_unavailable', requestId } }, requestId);
        return;
      }
      if (fixtureName === 'denied') {
        json(response, 403, { error: { code: 'scope_denied', requestId } }, requestId);
        return;
      }
      try {
        const runtime = createPersonaRuntime(personaName, idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const { authorization } = evaluateLocalAuthorization(context, await source.readGovernanceSnapshots());
        const readModel = projectAdminOverview({
          authorization,
          fixture:
            overviewSource === 'rollup'
              ? buildOverviewFromRollups({
                  documents: await source.readRollups(),
                  scope,
                  teamKey,
                  range,
                  asOf: evaluationTime,
                  // Configuration state is published by the control plane, not measured
                  // by the usage source, so it is supplied rather than derived.
                  configuration: publishedConfiguration,
                })
              : await source.readOverview({ fixtureName, scope, teamKey }),
          selection: { scope, range, teamKey },
        });
        json(response, 200, readModel, requestId);
      } catch (error) {
        const status = ['scope-denied', 'team-scope-denied'].includes(error.code)
          ? 403
          : error.code === 'range-not-supported'
            ? 400
            : 500;
        const code = error.code ?? 'local_read_model_failed';
        json(response, status, { error: { code, requestId } }, requestId);
      }
      return;
    }
    if (url.pathname === '/api/local/users-groups') {
      const fixtureName = url.searchParams.get('fixture') ?? 'complete';
      const personaName = url.searchParams.get('persona') ?? 'governance-admin';
      const scope = url.searchParams.get('scope') ?? 'global';
      const view = url.searchParams.get('view') ?? 'users';
      const teamKey = url.searchParams.get('team') ?? 'platform-engineering';
      if (
        !source.capabilities.usersGroupsFixtures.includes(fixtureName) ||
        !Object.hasOwn(PERSONAS, personaName) ||
        !['self', 'team', 'global'].includes(scope) ||
        !['users', 'groups', 'applications'].includes(view)
      ) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      if (fixtureName === 'error') {
        json(response, 503, { error: { code: 'local_fixture_unavailable', requestId } }, requestId);
        return;
      }
      if (fixtureName === 'denied') {
        json(response, 403, { error: { code: 'scope_denied', requestId } }, requestId);
        return;
      }
      try {
        const runtime = createPersonaRuntime(
          personaName,
          idGenerator,
          fixtureName === 'ambiguous' ? { membershipStatus: 'ambiguous' } : undefined,
        );
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const snapshots = await source.readGovernanceSnapshots();
        const { authorization, entitlementSnapshot } = evaluateLocalAuthorization(context, snapshots);
        const readModel = projectUsersGroupsReadModel({
          context,
          authorization,
          entitlementSnapshot,
          assignmentSnapshot: snapshots.assignmentSnapshot,
          fixture: await source.readUsersGroups({ fixtureName }),
          selection: { scope, view, teamKey },
        });
        json(response, 200, readModel, requestId);
      } catch (error) {
        const status = [
          'scope-denied',
          'team-scope-denied',
          'membership-not-authoritative',
          'view-not-permitted-for-scope',
        ].includes(error.code)
          ? 403
          : error.code === 'view-not-supported'
            ? 400
            : 500;
        const body = { code: error.code ?? 'local_read_model_failed', requestId };
        if (error.reasonCode) body.reasonCode = error.reasonCode;
        json(response, status, { error: body }, requestId);
      }
      return;
    }
    if (url.pathname === '/api/local/usage') {
      const personaName = url.searchParams.get('persona') ?? 'governance-admin';
      const scope = url.searchParams.get('scope') ?? 'global';
      const view = url.searchParams.get('view') ?? 'users';
      const teamKey = url.searchParams.get('team') ?? 'platform-engineering';
      const fixtureName = url.searchParams.get('fixture') ?? 'complete';
      // A deployment derives the viewer's pseudonymous key from the verified
      // identity. Locally it is a parameter so both self-scope answers can be read.
      const viewerSubjectKey = url.searchParams.get('viewer') ?? 'sk1-local-platform-engineering-1';
      if (
        !Object.hasOwn(PERSONAS, personaName) ||
        !['self', 'team', 'global'].includes(scope) ||
        !['users', 'groups'].includes(view) ||
        !source.capabilities.usageFixtures.includes(fixtureName)
      ) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      if (fixtureName === 'error') {
        json(response, 503, { error: { code: 'local_fixture_unavailable', requestId } }, requestId);
        return;
      }
      if (fixtureName === 'denied') {
        json(response, 403, { error: { code: 'scope_denied', requestId } }, requestId);
        return;
      }
      try {
        const runtime = createPersonaRuntime(personaName, idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const snapshots = await source.readGovernanceSnapshots();
        const { authorization } = evaluateLocalAuthorization(context, snapshots);
        const usage = await source.readUsageRecords({
          registry: snapshots.modelRegistrySnapshot,
          fixtureName,
        });
        const readModel = projectUsage({
          authorization,
          records: usage.records,
          window: usage.window,
          selection: {
            view,
            scope,
            teamKey: scope === 'team' ? teamKey : null,
            generatedAt: evaluationTime,
          },
          viewer: { subjectKey: viewerSubjectKey },
        });
        json(response, 200, readModel, requestId);
      } catch (error) {
        const status = [
          'scope-denied',
          'team-scope-denied',
          'membership-not-authoritative',
          'view-not-permitted-for-scope',
        ].includes(error.code)
          ? 403
          : ['view-not-supported', 'scope-not-supported', 'viewer-subject-key-unavailable'].includes(error.code)
            ? 400
            : 500;
        json(
          response,
          status,
          { error: { code: error.code ?? 'local_read_model_failed', requestId } },
          requestId,
        );
      }
      return;
    }
    // The published meters for the account's deployments. A route of its own, and not
    // part of the models reading, because the live list is a paged source of well over
    // a thousand meters and nothing here enforces a price.
    if (url.pathname === '/api/local/model-prices') {
      if (!source.capabilities.modelPriceReference) {
        json(response, 400, { error: { code: 'model_prices_not_offered', requestId } }, requestId);
        return;
      }
      const { meters } = await source.readModelPrices();
      const quota = await source.readProviderQuota();
      json(
        response,
        200,
        {
          readModelVersion: 'model-prices.v1',
          generatedAt: evaluationTime,
          region: quota.region,
          // Stated on the answer, because the reader is being shown a reference and the
          // authority for what was actually charged is not this product.
          authority: 'azure-billing',
          deployments: quota.deployments
            .map((deployment) => ({
              deploymentName: deployment.deploymentName,
              modelName: deployment.modelName,
              skuName: deployment.skuName,
              ...referencePricesFor({
                modelName: deployment.modelName,
                skuName: deployment.skuName,
                meters,
              }),
            }))
            .sort((left, right) => left.deploymentName.localeCompare(right.deploymentName)),
        },
        requestId,
      );
      return;
    }
    if (url.pathname === '/api/local/models') {
      const personaName = url.searchParams.get('persona') ?? 'governance-admin';
      const scope = url.searchParams.get('scope') ?? 'global';
      const teamKey = url.searchParams.get('team') ?? 'platform-engineering';
      const fixtureName = url.searchParams.get('fixture') ?? 'complete';
      const quotaSource = url.searchParams.get('quota') ?? 'reader';
      const viewerSubjectKey = url.searchParams.get('viewer') ?? 'sk1-local-platform-engineering-1';
      if (
        !Object.hasOwn(PERSONAS, personaName) ||
        !['self', 'team', 'global'].includes(scope) ||
        !source.capabilities.modelsFixtures.includes(fixtureName) ||
        !['reader', 'unavailable'].includes(quotaSource)
      ) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      if (fixtureName === 'error') {
        json(response, 503, { error: { code: 'local_fixture_unavailable', requestId } }, requestId);
        return;
      }
      if (fixtureName === 'denied') {
        json(response, 403, { error: { code: 'scope_denied', requestId } }, requestId);
        return;
      }
      try {
        const runtime = createPersonaRuntime(personaName, idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const snapshots = await source.readGovernanceSnapshots();
        const { authorization } = evaluateLocalAuthorization(context, snapshots);
        const usage = await source.readUsageRecords({
          registry: snapshots.modelRegistrySnapshot,
          fixtureName,
        });
        const readModel = projectModels({
          authorization,
          registry: snapshots.modelRegistrySnapshot,
          entitlementSnapshot: snapshots.entitlementSnapshot,
          records: usage.records,
          window: usage.window,
          selection: {
            scope,
            teamKey: scope === 'team' ? teamKey : null,
            generatedAt: evaluationTime,
          },
          viewer: { subjectKey: viewerSubjectKey },
          providerQuota: quotaSource === 'reader' ? await source.readProviderQuota() : null,
        });
        json(response, 200, readModel, requestId);
      } catch (error) {
        const status = ['scope-denied', 'team-scope-denied', 'membership-not-authoritative'].includes(error.code)
          ? 403
          : error.code === 'viewer-subject-key-unavailable'
            ? 400
            : 500;
        json(
          response,
          status,
          { error: { code: error.code ?? 'local_read_model_failed', requestId } },
          requestId,
        );
      }
      return;
    }
    if (url.pathname === '/api/local/fallback') {
      const personaName = url.searchParams.get('persona') ?? 'governance-admin';
      const scope = url.searchParams.get('scope') ?? 'global';
      const teamKey = url.searchParams.get('team') ?? 'platform-engineering';
      // A deployment reads pressure from live counters. Locally it is a parameter so
      // both the calm and the breached decision can be read on the same fixture.
      const pressure = url.searchParams.get('pressure') ?? 'breach';
      // The fixture's global entitlement deliberately withholds the cheaper model, so
      // the default view is the refusal. Widening it is how the permitted hop can be
      // read on the same fixture, exactly as the resolution tests do.
      const entitlement = url.searchParams.get('entitlement') ?? 'fixture';
      const fixtureName = url.searchParams.get('fixture') ?? 'complete';
      if (
        !Object.hasOwn(PERSONAS, personaName) ||
        !['self', 'team', 'global'].includes(scope) ||
        !['none', 'breach'].includes(pressure) ||
        !source.capabilities.entitlementViews.includes(entitlement)
      ) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      if (refuseUnreadableState({
        response,
        requestId,
        declared: source.capabilities.fallbackFixtures,
        fixtureName,
      })) return;
      try {
        const runtime = createPersonaRuntime(personaName, idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const snapshots = await source.readGovernanceSnapshots({ entitlementView: entitlement });
        const { authorization } = evaluateLocalAuthorization(context, snapshots);
        const allowedModels = authorization.modelAllowlist ?? [];
        // No plan authored at all, which the screen must tell apart from a plan whose
        // hops were all refused.
        const plan = fixtureName === 'empty'
          ? null
          : selectFallbackPlan({
              plans: snapshots.fallbackPolicySnapshot.plans,
              applicationId: context.application?.applicationId,
              subjectId: context.subject?.subjectId,
              teamKey,
            });
        const compiled =
          plan === null
            ? null
            : API_FAMILIES.map((apiFamily) => ({
                apiFamily,
                compiled: compileFallbackPlan({
                  plan,
                  registry: snapshots.modelRegistrySnapshot,
                  allowedModels,
                  evaluationTime,
                  apiFamily,
                }),
              }));
        const candidates = API_FAMILIES.map((apiFamily) => ({
          apiFamily,
          bySource: allowedModels.map((source) => ({
            source,
            ...derivePermittedTargets({
              registry: snapshots.modelRegistrySnapshot,
              allowedModels,
              source,
              apiFamily,
            }),
          })),
        }));

        // The decision below is about one route, so the resolver is asked for that
        // route's chain rather than a contract-free one it could not compile.
        const decisionApiFamily = url.searchParams.get('apiFamily') ?? 'openai-responses';
        const decisionContract =
          compiled?.find((entry) => entry.apiFamily === decisionApiFamily)?.compiled ?? null;
        const resolved = await createLocalPolicyResolver(personaName, idGenerator, () => snapshots)
          .resolve({ persona: personaName, apiFamily: decisionApiFamily });
        const document = resolved.status === 200 ? resolved.document : null;
        // The decision is always about one requested model. Defaulting to the source of
        // a permitted hop shows what the plan actually does; a caller can name another.
        const requestedModel =
          url.searchParams.get('model') ??
          decisionContract?.chain?.[0]?.from ??
          document?.allowedModels?.[0] ??
          allowedModels[0] ??
          null;
        let decision = null;
        if (document !== null && requestedModel !== null) {
          const quota = document.limits?.find(
            (limit) => limit.scope === 'subject' && limit.modelScope === 'all-models',
          )?.tokenQuota ?? null;
          decision = decideModelSelection({
            requestedModel,
            effectivePolicy: document,
            remainingTokensByScope:
              pressure === 'breach' && quota !== null ? { subject: Math.floor(quota * 0.02) } : {},
            registry: snapshots.modelRegistrySnapshot,
            applicationId: context.application?.applicationId,
            applicationKey: 'ak1-local-console-0000',
            fallbackRejections: decisionContract?.rejections ?? [],
            onExhausted: decisionContract?.onExhausted ?? 'continue-with-requested',
            evaluationTime,
          });
        }

        const readModel = projectFallback({
          authorization,
          plan,
          compiled,
          candidates,
          decision,
          selection: {
            scope,
            teamKey: scope === 'team' ? teamKey : null,
            generatedAt: evaluationTime,
          },
        });
        json(response, 200, readModel, requestId);
      } catch (error) {
        const status = ['scope-denied', 'team-scope-denied', 'membership-not-authoritative'].includes(error.code)
          ? 403
          : 500;
        json(
          response,
          status,
          { error: { code: error.code ?? 'local_read_model_failed', requestId } },
          requestId,
        );
      }
      return;
    }
    if (url.pathname === '/api/local/lifecycle') {
      const personaName = url.searchParams.get('persona') ?? 'governance-admin';
      const scope = url.searchParams.get('scope') ?? 'global';
      const teamKey = url.searchParams.get('team') ?? 'platform-engineering';
      // A deployment reads the acting principal from the token. Locally it is a
      // parameter so separation of duties can be seen from both sides.
      const viewer = url.searchParams.get('viewer') ?? source.capabilities.defaultLifecycleViewer;
      const stock = url.searchParams.get('revisions') ?? 'all';
      const fixtureName = url.searchParams.get('fixture') ?? 'complete';
      if (
        !Object.hasOwn(PERSONAS, personaName) ||
        !['self', 'team', 'global'].includes(scope) ||
        !['all', 'none-active'].includes(stock)
      ) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      if (refuseUnreadableState({
        response,
        requestId,
        declared: source.capabilities.lifecycleFixtures,
        fixtureName,
      })) return;
      try {
        const runtime = createPersonaRuntime(personaName, idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const { authorization } = evaluateLocalAuthorization(context, await source.readGovernanceSnapshots());
        // Read what the writer wrote. Reading the seed instead would make every save
        // durable and invisible, which is worse than a save that fails.
        await seedRevisions();
        const revisions = fixtureName === 'empty'
          ? []
          : (
              await revisionStore.queryConfigurationRevisions({ scopeGroupId: 'platform-engineering' })
            ).filter((revision) => stock === 'all' || revision.state !== 'active');
        const readModel = projectLifecycle({
          authorization,
          revisions,
          selection: {
            scope,
            teamKey: scope === 'team' ? teamKey : null,
            generatedAt: evaluationTime,
          },
          viewerCode: viewer,
          selfApprovalGranted: source.capabilities.selfApprovalActors.includes(viewer),
        });
        json(response, 200, readModel, requestId);
      } catch (error) {
        const status = ['scope-denied', 'team-scope-denied', 'membership-not-authoritative'].includes(error.code)
          ? 403
          : 500;
        json(
          response,
          status,
          { error: { code: error.code ?? 'local_read_model_failed', requestId } },
          requestId,
        );
      }
      return;
    }
    if (url.pathname === '/api/local/notifications') {
      const personaName = url.searchParams.get('persona') ?? 'governance-admin';
      const scope = url.searchParams.get('scope') ?? 'global';
      const teamKey = url.searchParams.get('team') ?? 'platform-engineering';
      // A deployment reads the stored ledger. Locally the unreadable case is a state,
      // because the difference between no notifications and no answer is the point.
      const fixtureName = url.searchParams.get('fixture') ?? 'complete';
      if (
        !Object.hasOwn(PERSONAS, personaName) ||
        !['self', 'team', 'global'].includes(scope)
      ) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      if (refuseUnreadableState({
        response,
        requestId,
        declared: source.capabilities.notificationsFixtures,
        fixtureName,
      })) return;
      try {
        const runtime = createPersonaRuntime(personaName, idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const { authorization } = evaluateLocalAuthorization(context, await source.readGovernanceSnapshots());
        await seedNotifications();
        const readModel = projectNotifications({
          authorization,
          records:
            fixtureName === 'degraded'
              ? null
              : fixtureName === 'empty'
                ? []
                : await notificationLedger.list({ sinceRaisedAt: '1970-01-01T00:00:00.000Z' }),
          selection: {
            scope,
            teamKey: scope === 'team' ? teamKey : null,
            generatedAt: evaluationTime,
          },
        });
        json(response, 200, readModel, requestId);
      } catch (error) {
        json(
          response,
          error?.code === 'scope-denied' || error?.code === 'team-scope-denied' ? 403 : 500,
          { error: { code: error?.code ?? 'read_model_unavailable', requestId } },
          requestId,
        );
      }
      return;
    }

    if (url.pathname === '/api/local/audit') {
      const personaName = url.searchParams.get('persona') ?? 'auditor';
      const scope = url.searchParams.get('scope') ?? 'global';
      const teamKey = url.searchParams.get('team') ?? 'platform-engineering';
      const fixtureName = url.searchParams.get('fixture') ?? 'complete';
      if (
        !Object.hasOwn(PERSONAS, personaName) ||
        !['self', 'team', 'global'].includes(scope)
      ) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      if (refuseUnreadableState({
        response,
        requestId,
        declared: source.capabilities.auditFixtures,
        fixtureName,
      })) return;
      try {
        const runtime = createPersonaRuntime(personaName, idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        const { authorization } = evaluateLocalAuthorization(context, await source.readGovernanceSnapshots());
        await seedRevisions();
        await seedNotifications();
        const readModel = projectChangeLog({
          authorization,
          entries:
            fixtureName === 'empty'
              ? []
              : deriveChangeEntries({
                  revisions: await revisionStore.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }),
                  notifications: await notificationLedger.list({ sinceRaisedAt: '1970-01-01T00:00:00.000Z' }),
                }),
          selection: {
            scope,
            teamKey: scope === 'team' ? teamKey : null,
            generatedAt: evaluationTime,
          },
        });
        json(response, 200, readModel, requestId);
      } catch (error) {
        const status = [
          'scope-denied',
          'team-scope-denied',
          'membership-not-authoritative',
          'export-not-permitted',
        ].includes(error.code)
          ? 403
          : 500;
        json(
          response,
          status,
          { error: { code: error.code ?? 'local_read_model_failed', requestId } },
          requestId,
        );
      }
      return;
    }
    if (url.pathname === '/api/local/budgets') {
      const personaName = url.searchParams.get('persona') ?? 'governance-admin';
      const scope = url.searchParams.get('scope') ?? 'global';
      const teamKey = url.searchParams.get('team') ?? 'platform-engineering';
      const intent = url.searchParams.get('intent') ?? 'preferred';
      const fixtureName = url.searchParams.get('fixture') ?? 'complete';
      if (
        !Object.hasOwn(PERSONAS, personaName) ||
        !['self', 'team', 'global'].includes(scope) ||
        !['pinned', 'preferred'].includes(intent)
      ) {
        json(response, 400, { error: { code: 'selection_not_supported', requestId } }, requestId);
        return;
      }
      if (refuseUnreadableState({
        response,
        requestId,
        declared: source.capabilities.budgetsFixtures,
        fixtureName,
      })) return;
      try {
        const runtime = createPersonaRuntime(personaName, idGenerator);
        const verifiedIdentity = await runtime.identityAdapter.getVerifiedIdentity();
        const context = await runtime.factory.create(verifiedIdentity);
        // Read what was published, not the seed: an edit that disappeared from the
        // screen it was made on is worse than one that failed.
        const snapshots = await currentSnapshots();
        const { authorization } = evaluateLocalAuthorization(context, snapshots);
        const allowedModels = authorization.modelAllowlist ?? [];
        const plan = selectFallbackPlan({
          plans: snapshots.fallbackPolicySnapshot.plans,
          applicationId: context.application?.applicationId,
          subjectId: context.subject?.subjectId,
          teamKey,
        });
        // The intent is a query parameter here only so the screen can be read both ways
        // without editing a fixture. A deployment reads it from the plan.
        const modelSelection =
          plan === null
            ? null
            : {
                contracts: API_FAMILIES.filter(
                  (apiFamily) =>
                    compileFallbackPlan({
                      plan,
                      registry: snapshots.modelRegistrySnapshot,
                      allowedModels,
                      evaluationTime,
                      apiFamily,
                    }).enabled,
                ),
                substitutionNotice: plan.substitutionNotice ?? 'header',
                modelSelectionIntent: intent,
              };
        const budgetPublication = publishBudgets({
          budgetSnapshot: fixtureName === 'empty'
            ? { ...snapshots.budgetSnapshot, budgets: [] }
            : snapshots.budgetSnapshot,
          registry: snapshots.modelRegistrySnapshot,
          allowedModels,
          evaluationTime,
        });
        const allRollups = await source.readRollups();
        // A window withheld from inside the period, so the period totals lower than
        // the truth and has to say so instead of deriving a remainder from it. Taking
        // one off an end would simply make the period shorter, which is not a gap.
        const windowStarts = [...new Set(allRollups.map((document) => document.windowStart))].sort();
        const withheld = windowStarts[Math.floor(windowStarts.length / 2)];
        const rollups = fixtureName === 'partial'
          ? allRollups.filter((document) => document.windowStart !== withheld)
          : allRollups;
        const covered = fixtureName === 'partial' ? windowStarts : windowStarts.filter(
          (start) => rollups.some((document) => document.windowStart === start),
        );
        const periodEnd = covered.length === 0
          ? evaluationTime
          : new Date(Date.parse(covered.at(-1)) + 3_600_000).toISOString();
        const entriesByPeriod = new Map();
        for (const entry of budgetPublication.entries ?? []) {
          const entries = entriesByPeriod.get(entry.period) ?? [];
          entries.push(entry);
          entriesByPeriod.set(entry.period, entries);
        }
        const observations = [];
        for (const [period, entries] of entriesByPeriod) {
          const periodStart = startOfPeriod(period, evaluationTime);
          const scopes = entries.flatMap((entry) => {
            if (entry.scope === 'organization') return [budgetObservationSelector(entry)];
            return scopeKeysInPeriod(allRollups, entry.scope, periodStart, evaluationTime)
              .map((scopeKey) => budgetObservationSelector({ ...entry, scopeKey }));
          });
          if (scopes.length > 0) {
            observations.push(...observePeriodConsumption({
              rollups,
              periodStart,
              periodEnd: evaluationTime,
              windowSeconds: 3600,
              scopes,
            }));
          }
        }
        const readModel = projectBudgets({
          authorization,
          publication: budgetPublication,
          selection: { scope, teamKey: scope === 'team' ? teamKey : null, generatedAt: evaluationTime },
          freshness: {
            // Read late, but read: what was observed is still published.
            state: fixtureName === 'stale' ? 'stale' : 'fresh',
            reportedAt: periodEnd,
            lagSeconds: Math.max(
              0,
              Math.round((Date.parse(evaluationTime) - Date.parse(periodEnd)) / 1000),
            ) + (fixtureName === 'stale' ? 10_800 : 0),
          },
          modelSelection,
          observations,
        });
        json(response, 200, readModel, requestId);
      } catch (error) {
        const status = ['scope-denied', 'team-scope-denied'].includes(error.code)
          ? 403
          : error.code === 'scope-not-supported'
            ? 400
            : 500;
        json(
          response,
          status,
          { error: { code: error.code ?? 'local_read_model_failed', requestId } },
          requestId,
        );
      }
      return;
    }
    if (await serveStatic(response, url.pathname)) return;
    json(response, 404, { error: { code: 'not_found', requestId } }, requestId);  });
}

/**
 * A run pointed at a store reads it; anything else keeps the development fixtures.
 * The selector is imported only when a store is named, because it carries the cloud
 * client and an ordinary local run must not need it.
 */
async function selectConfiguredSource(environment = process.env) {
  if (!environment.GOVERNANCE_STORE_ENDPOINT || !environment.GOVERNANCE_DATABASE_NAME) {
    return undefined;
  }
  const { createGovernanceReadSource } = await import('../functions/composition-root.mjs');
  return createGovernanceReadSource(environment) ?? undefined;
}

export async function startLocalAdminServer({ port = 4173, host = '127.0.0.1', source } = {}) {
  if (host !== '127.0.0.1') {
    throw new TypeError('Local Admin UI may bind only to 127.0.0.1.');
  }
  const server = createLocalAdminServer({ source: source ?? (await selectConfiguredSource()) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number.parseInt(process.env.PORT ?? '4173', 10);
  const server = await startLocalAdminServer({ port });
  const address = server.address();
  console.log(`Local governance admin UI: http://127.0.0.1:${address.port}`);
}
