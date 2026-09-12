import { errorResponse, jsonResponse, readJsonBody } from './http-response.mjs';
import { deriveAuthenticatedAdministratorActor } from './authenticated-admin-actor.mjs';
import { readVerifiedCaller } from '../../control-api/client-principal.mjs';
import { createGovernancePublisher, governancePublicationTargets } from '../../control-api/governance-publisher.mjs';
import { createDraftAuthor } from '../../control-api/draft-authoring.mjs';
import { createProposalPublisher } from '../../control-api/proposal-publication.mjs';
import { applyLifecycleCommand, summariseTargets } from '../../governance-domain/lifecycle/configuration-lifecycle.mjs';
import {
  assertPublishableContent,
  DRAFT_REASONS,
} from '../../governance-domain/lifecycle/configuration-draft-document.mjs';
import {
  assertGovernanceCapability,
  authorizeGovernanceAccess,
  ENTRA_ROLE_MAPPING,
} from '../../governance-domain/authorization/admin-role-authorization.mjs';

/**
 * Publishing a governance set, from inside the network.
 *
 * The store is closed to the public network, so nothing outside can write to it. That
 * is the reason this exists as a route rather than as a script somebody runs: the
 * alternative is opening the store, which would trade the product's posture for the
 * convenience of whoever is bootstrapping it.
 *
 * The content arrives in the request. The deployed host holds no governance content of
 * its own, so there is no arrangement in which it publishes something nobody authored.
 */

const BOOTSTRAP_AUTHOR = 'bootstrap-import';
const LEGACY_SHARED_AUTHOR = 'governance-administrator';

// A governance set carries five snapshots and one record per governed principal, so it
// is legitimately larger than a resolution request. It is still bounded, because an
// administration route that accepts an unbounded body is a way to exhaust the host.
const PUBLICATION_BODY_LIMIT_BYTES = 262_144;

function fail(message) {
  throw new TypeError(message);
}

function nextRevisionState(revisions) {
  let highest = 0;
  let inFlight = null;
  for (const revision of revisions) {
    if (revision.revisionNumber > highest) highest = revision.revisionNumber;
    if (['draft', 'approved', 'publishing', 'failed'].includes(revision.state)) inFlight = revision;
  }
  return { revisionNumber: highest + 1, inFlight };
}

/**
 * A publish that left targets unfinished is a state an operator resolves, not one the
 * next request steps around. Resuming is therefore explicit: without it an in-flight
 * revision refuses a new one, and with it the same revision is retried rather than a
 * second one racing it.
 */
function firstFailureReason(revision) {
  const failed = revision.targets.find((target) => target.outcome === 'failed');
  return failed?.reasonCode ?? 'publish-incomplete';
}

const REVISION_ID = /^revision-[0-9]{4}$/;

function requiresElevatedRecoveryAbandonment(authoredBy) {
  return authoredBy === BOOTSTRAP_AUTHOR || authoredBy === LEGACY_SHARED_AUTHOR;
}

async function abandonUnpublishedProposal({
  store,
  clock,
  scopeGroupId,
  actorCode,
  revisionId,
  authorization,
  requestId,
}) {
  if (typeof revisionId !== 'string' || !REVISION_ID.test(revisionId)) {
    return errorResponse(400, 'revision_not_supported', { requestId });
  }
  const stored = await store.readConfigurationRevision({ scopeGroupId, revisionId });
  if (stored?.document.state === 'publishing') {
    return jsonResponse(
      409,
      { outcome: 'refused', reasonCode: 'proposal-abandonment-publishing', requestId },
      { requestId },
    );
  }
  if (stored === null || !['draft', 'approved', 'failed'].includes(stored.document.state)) {
    return jsonResponse(409, { outcome: 'refused', reasonCode: 'proposal-abandonment-denied', requestId }, { requestId });
  }
  // A normal draft has its author's narrow withdrawal route. Recovery abandonment is
  // reserved for identities no current administrator can match, never an alternate
  // way for another administrator to erase a colleague's proposal.
  if (!requiresElevatedRecoveryAbandonment(stored.document.authoredBy)) {
    return jsonResponse(409, { outcome: 'refused', reasonCode: 'proposal-abandonment-denied', requestId }, { requestId });
  }
  if (!authorization.capabilities.includes('abandon-legacy-configuration')) {
    return errorResponse(403, 'governance_access_denied', {
      requestId,
      reasonCode: 'recovery-abandonment-requires-owner',
    });
  }
  const abandoned = applyLifecycleCommand({
    revision: stored.document,
    command: 'abandon',
    actor: actorCode,
    at: clock.nowIso(),
    expectedRevisionNumber: stored.document.revisionNumber,
  });
  if (abandoned.ok !== true) {
    return jsonResponse(409, { outcome: 'refused', reasonCode: abandoned.code, requestId }, { requestId });
  }
  await store.putConfigurationRevision(abandoned.revision, { ifMatch: stored.etag });
  return publicationResponse({
    revisionId: abandoned.revision.revisionId,
    revisionNumber: abandoned.revision.revisionNumber,
    state: abandoned.revision.state,
    targets: abandoned.revision.targets,
  }, requestId);
}

/**
 * A resume is an approval or recovery operation over a proposal already held by the
 * service. It deliberately has no edit surface: accepting replacement content here
 * would make the recorded author differ from the content the reviewer publishes.
 */
export function parseStoredProposalResume(body, { allowInitialOnly = false } = {}) {
  if (body?.resume !== true) return { resume: false };
  const allowed = new Set(['resume', 'revisionId', ...(allowInitialOnly ? ['initialOnly'] : [])]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return { failureCode: 'resume-mutation-not-allowed' };
  }
  if (typeof body.revisionId !== 'string' || !REVISION_ID.test(body.revisionId)) {
    return { failureCode: 'resume-revision-required' };
  }
  if (allowInitialOnly && body.initialOnly !== true) {
    return { failureCode: 'resume-initial-only-required' };
  }
  return { resume: true, revisionId: body.revisionId };
}

function publicationResponse({ revisionId, revisionNumber, state, targets }, requestId) {
  return jsonResponse(
    200,
    {
      revisionId,
      revisionNumber,
      state,
      targets,
      requestId,
    },
    { requestId },
  );
}

export async function withdrawGovernanceProposal({
  store,
  clock,
  scopeGroupId,
  actorCode,
  revisionId,
  requestId,
}) {
  if (typeof revisionId !== 'string' || !/^revision-[0-9]{4}$/.test(revisionId)) {
    return errorResponse(400, 'revision_not_supported', { requestId });
  }

  const stored = await store.readConfigurationRevision({ scopeGroupId, revisionId });
  // A proposal can only be discarded by the actor that authored its still-unapproved
  // draft. This preserves both the audit record and another administrator's review.
  if (stored === null || stored.document.state !== 'draft' || stored.document.authoredBy !== actorCode) {
    return jsonResponse(409, { outcome: 'refused', reasonCode: 'proposal-withdrawal-denied', requestId }, { requestId });
  }
  const withdrawn = applyLifecycleCommand({
    revision: stored.document,
    command: 'withdraw',
    actor: actorCode,
    at: clock.nowIso(),
    expectedRevisionNumber: stored.document.revisionNumber,
    publishingRevisionId: null,
  });
  if (withdrawn.ok !== true) {
    return jsonResponse(409, { outcome: 'refused', reasonCode: withdrawn.code, requestId }, { requestId });
  }
  await store.putConfigurationRevision(withdrawn.revision, { ifMatch: stored.etag });
  return publicationResponse({
    revisionId: withdrawn.revision.revisionId,
    revisionNumber: withdrawn.revision.revisionNumber,
    state: withdrawn.revision.state,
    targets: withdrawn.revision.targets.map((target) => ({
      targetCode: target.targetCode,
      outcome: target.outcome,
      reasonCode: target.reasonCode,
    })),
  }, requestId);
}

/**
 * Save a complete governance proposal; explicitly resume it to approve and publish.
 *
 * Exported so a route that computes the next set from an edit publishes it through
 * exactly this path. A second copy of the lifecycle sequence would be a second answer
 * to what publishing means, and the two would drift.
 */
export async function publishGovernanceContent({
  store,
  publisher,
  clock,
  scopeGroupId,
  actorCode,
  content,
  resumeRevisionId = null,
  includeMembership = true,
  initialOnly = false,
  selfApprovalGranted = false,
  requestId,
}) {
  const at = clock.nowIso();
  let held;
  let etag = null;
  let proposedContent = content;
  const drafts = createDraftAuthor({
    store,
    scopeGroupId,
    clock,
    targets: governancePublicationTargets({ includeMembership }),
    assertContent: assertPublishableContent,
  });
  const proposals = createProposalPublisher({ store, publisher, drafts, scopeGroupId, clock });

  const revisions = await store.queryConfigurationRevisions({ scopeGroupId });
  const { revisionNumber, inFlight } = nextRevisionState(revisions);

  const priorToInFlight = revisions.filter((revision) => revision.revisionId !== inFlight?.revisionId);
  const firstRevisionInFlight = inFlight !== null
    && inFlight.revisionNumber === 1
    && priorToInFlight.length === 0;
  if (initialOnly === true && revisions.length > 0 && !firstRevisionInFlight) {
    return jsonResponse(
      409,
      { outcome: 'refused', reasonCode: 'governance-already-initialized', requestId },
      { requestId },
    );
  }

  const step = (revision, command, extra = {}) => applyLifecycleCommand({
    revision,
    command,
    actor: actorCode,
    at,
    expectedRevisionNumber: revision.revisionNumber,
    publishingRevisionId: null,
    selfApprovalGranted,
    ...extra,
  });

  if (inFlight !== null && resumeRevisionId === null) {
    return jsonResponse(
      409,
      { outcome: 'refused', reasonCode: 'publish-in-progress', revisionId: inFlight.revisionId, requestId },
      { requestId },
    );
  }

  if (resumeRevisionId !== null && (inFlight === null || inFlight.revisionId !== resumeRevisionId)) {
    return jsonResponse(
      409,
      { outcome: 'refused', reasonCode: 'resume-revision-not-held', revisionId: resumeRevisionId, requestId },
      { requestId },
    );
  }

  if (inFlight !== null) {
    const stored = await store.readConfigurationRevision({
      scopeGroupId,
      revisionId: inFlight.revisionId,
    });
    held = stored.document;
    etag = stored.etag;
    if (held.authoredBy === BOOTSTRAP_AUTHOR && initialOnly !== true) {
      return jsonResponse(
        409,
        { outcome: 'refused', reasonCode: 'resume-initial-only-required', revisionId: held.revisionId, requestId },
        { requestId },
      );
    }
    try {
      proposedContent = await drafts.proposedContent({ revisionId: held.revisionId });
    } catch (error) {
      if (held.targets.some((target) => target.outcome === 'verified')) {
        return jsonResponse(
          409,
          { outcome: 'refused', reasonCode: 'legacy-recovery-required', requestId },
          { requestId },
        );
      }
      return jsonResponse(
        409,
        { outcome: 'refused', reasonCode: 'legacy-recovery-abandon-required', requestId },
        { requestId },
      );
    }
    const commands =
      held.state === 'draft'
        ? ['approve']
        : held.state === 'approved'
          ? []
          : held.state === 'publishing'
            ? ['fail', 'retry']
            : ['retry'];
    for (const command of commands) {
      const applied = step(held, command, {
        ...(command === 'fail' ? { reasonCode: firstFailureReason(held) } : {}),
      });
      if (applied.ok !== true) {
        return jsonResponse(409, { outcome: 'refused', command, reasonCode: applied.code, requestId }, { requestId });
      }
      held = applied.revision;
      ({ etag } = await store.putConfigurationRevision(held, { ifMatch: etag }));
    }
  } else {
    ({ revision: held, etag } = await drafts.propose({
      content,
      // `initialOnly` is the import path's server-checked declaration. A bare first
      // write is still an administrative change, so it must not borrow the import
      // actor merely because a deployment has no revisions yet.
      authoredBy: initialOnly === true ? BOOTSTRAP_AUTHOR : actorCode,
    }));

    if (initialOnly !== true) {
      return jsonResponse(201, {
        outcome: 'proposed',
        revisionId: held.revisionId,
        revisionNumber: held.revisionNumber,
        state: held.state,
        etag,
        targets: held.targets.map(({ targetCode, outcome, reasonCode }) => ({ targetCode, outcome, reasonCode })),
        requestId,
      }, { requestId });
    }

    for (const command of ['approve']) {
      const applied = step(held, command);
      if (applied.ok !== true) {
        return jsonResponse(409, { outcome: 'refused', command, reasonCode: applied.code, requestId }, { requestId });
      }
      held = applied.revision;
      ({ etag } = await store.putConfigurationRevision(held, { ifMatch: etag }));
    }
  }

  if (held.state === 'approved') {
    const published = await proposals.publish({
      revisionId: held.revisionId,
      actor: actorCode,
      inFlightRevisionId: null,
    });
    if (published.outcome === 'refused') {
      return jsonResponse(409, { outcome: 'refused', reasonCode: published.reasonCode, requestId }, { requestId });
    }
    return publicationResponse({
      revisionId: published.revisionId,
      revisionNumber: held.revisionNumber,
      state: published.state,
      targets: published.targets,
    }, requestId);
  }

  const published = await publisher.publish({ revision: held, content: proposedContent, actor: actorCode });
  held = published.revision;
  ({ etag } = await store.putConfigurationRevision(held, { ifMatch: etag }));

  const summary = summariseTargets(held);
  if (summary.verified === summary.total) {
    const completed = applyLifecycleCommand({
      revision: held,
      command: 'complete',
      actor: actorCode,
      at: clock.nowIso(),
      expectedRevisionNumber: held.revisionNumber,
      publishingRevisionId: held.revisionId,
    });
    if (completed.ok === true) {
      held = completed.revision;
      await store.putConfigurationRevision(held, { ifMatch: etag });
    }
  } else if (summary.failed > 0) {
    const failed = applyLifecycleCommand({
      revision: held,
      command: 'fail',
      actor: actorCode,
      at: clock.nowIso(),
      expectedRevisionNumber: held.revisionNumber,
      reasonCode: firstFailureReason(held),
    });
    if (failed.ok === true) {
      held = failed.revision;
      await store.putConfigurationRevision(held, { ifMatch: etag });
    }
  }

  // The response reports what happened to each target and nothing about the content
  // itself, because it crosses back out of the network.
  return publicationResponse({
    revisionId: held.revisionId,
    revisionNumber: held.revisionNumber,
    state: held.state,
    targets: held.targets.map((target) => ({
      targetCode: target.targetCode,
      outcome: target.outcome,
      reasonCode: target.reasonCode,
    })),
  }, requestId);
}

export function createPublishGovernanceHandler({
  store,
  publisher,
  clock,
  scopeGroupId,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  deriver,
} = {}) {
  if (typeof store?.queryConfigurationRevisions !== 'function') fail('store is required.');
  if (typeof publisher?.publish !== 'function') fail('publisher is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    fail('expectedAudience is required.');
  }
  if (typeof deriver?.deriveActorCode !== 'function') fail('deriver.deriveActorCode is required.');

  return async function publishGovernance(request, context) {
    const requestId = context?.invocationId;

    let caller;
    try {
      caller = readVerifiedCaller({ headers: request.headers, expectedAudience, rolesClaim });
    } catch (error) {
      return errorResponse(401, 'caller_not_authenticated', { requestId, reasonCode: error.reasonCode });
    }

    let authorization;
    try {
      authorization = authorizeGovernanceAccess({ roles: caller.roles, roleMapping });
      assertGovernanceCapability(authorization, 'publish-configuration');
    } catch (error) {
      return errorResponse(403, 'governance_access_denied', { requestId, reasonCode: error.reasonCode });
    }
    const attributed = deriveAuthenticatedAdministratorActor({ caller, deriver, requestId });
    if (attributed.failure) return attributed.failure;
    const { actorCode } = attributed;

    let body;
    try {
      body = await readJsonBody(request, PUBLICATION_BODY_LIMIT_BYTES);
    } catch (error) {
      return errorResponse(400, error.message.replaceAll('-', '_'), { requestId });
    }
    if (body?.command === 'withdraw') {
      try {
        return await withdrawGovernanceProposal({
          store,
          clock,
          scopeGroupId,
          actorCode,
          revisionId: body.revisionId,
          requestId,
        });
      } catch (error) {
        context?.error?.('Governance proposal withdrawal failed.', { reason: error?.name });
        return errorResponse(500, 'proposal_withdrawal_failed', { requestId });
      }
    }
    if (body?.command === 'abandon') {
      try {
        return await abandonUnpublishedProposal({
          store,
          clock,
          scopeGroupId,
          actorCode,
          revisionId: body.revisionId,
          authorization,
          requestId,
        });
      } catch (error) {
        context?.error?.('Governance proposal abandonment failed.', { reason: error?.name });
        return errorResponse(500, 'proposal_abandonment_failed', { requestId });
      }
    }
    const resume = parseStoredProposalResume(body, { allowInitialOnly: body?.initialOnly === true });
    if (resume.failureCode) {
      return errorResponse(400, resume.failureCode.replaceAll('-', '_'), { requestId });
    }
    if (resume.resume) {
      try {
        return await publishGovernanceContent({
          store,
          publisher,
          clock,
          scopeGroupId,
          actorCode,
          initialOnly: body.initialOnly === true,
          resumeRevisionId: resume.revisionId,
          selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'),
          requestId,
        });
      } catch (error) {
        context?.error?.('Governance publication resume failed.', { reason: error?.name });
        return errorResponse(500, 'publication_failed', { requestId });
      }
    }
    if (body?.content === null || typeof body?.content !== 'object') {
      return errorResponse(400, 'publication_content_required', { requestId });
    }
    if (Object.hasOwn(body.content, 'memberships')
        && (!Array.isArray(body.content.memberships) || body.content.memberships.length === 0)) {
      return errorResponse(400, 'publication_membership_empty', { requestId });
    }
    try {
      assertPublishableContent(body.content);
    } catch (error) {
      return errorResponse(
        400,
        error.code === DRAFT_REASONS.contentIncomplete
          ? 'publication_content_incomplete'
          : 'publication_content_invalid',
        { requestId },
      );
    }

    try {
      return await publishGovernanceContent({
        store,
        publisher,
        clock,
        scopeGroupId,
        actorCode,
        content: body.content,
        includeMembership: Object.hasOwn(body.content, 'memberships'),
        initialOnly: body.initialOnly === true,
        selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'),
        requestId,
      });
    } catch (error) {
      context?.error?.('Governance publication failed.', { reason: error?.name });
      return errorResponse(500, 'publication_failed', { requestId });
    }
  };
}
