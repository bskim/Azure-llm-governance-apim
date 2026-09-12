import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';
import { assertBodyFreeReadModel } from './admin-read-model-projector.mjs';
import {
  availableCommands,
  hasPublicationActivity,
  OPERATOR_FAILURE_REASONS,
  summariseTargets,
} from '../governance-domain/lifecycle/configuration-lifecycle.mjs';

/**
 * Projects the publication lifecycle an administrator has to operate.
 *
 * The screen exists for the states nobody wants: a publish that wrote some targets
 * and not others, one whose read-back disagreed, one another administrator started
 * first. Those are reported with what is recoverable from them, because an operator
 * looking at a stuck publish needs to know whether to retry it or roll it back.
 *
 * What the reader may do next is read from the same table the reducer uses, so the
 * screen cannot offer an action the reducer would refuse.
 */

const SAFE_READ_MODEL_KEYS = new Set([
  'readModelVersion',
  'generatedAt',
  'readModelId',
  'quality',
  'summary',
  'records',
  'selection',
  'failureReasonCodes',
]);

// The body-free assertion checks key names. An actor is a value, and a caller that
// passes a directory object identifier would put a raw principal on an admin screen
// without tripping any key check.
const RAW_PRINCIPAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECOVERY_SHARED_AUTHORS = new Set(['bootstrap-import', 'governance-administrator']);

function assertDisplayCode(value, path) {
  if (value === null) return value;
  if (RAW_PRINCIPAL.test(value)) {
    const error = new Error('actor-not-pseudonymous');
    error.code = 'actor-not-pseudonymous';
    error.path = path;
    throw error;
  }
  return value;
}

function projectHistory(history) {
  return history.map((entry, index) => ({
    at: entry.at,
    actorCode: assertDisplayCode(entry.actor, `history[${index}].actor`),
    from: entry.from,
    to: entry.to,
    command: entry.command,
    reasonCode: entry.reasonCode,
  }));
}

function projectRevision(
  revision,
  viewerCode,
  selfApprovalGranted,
  commandsAvailable,
  recoveryAbandonmentGranted,
  storedProposalAvailable,
  callerIdentifiable,
) {
  const targetSummary = summariseTargets(revision);
  return {
    revisionCode: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    state: revision.state,
    authoredByCode: assertDisplayCode(revision.authoredBy, 'authoredBy'),
    authoredAt: revision.authoredAt,
    approvedByCode: assertDisplayCode(revision.approvedBy, 'approvedBy'),
    approvedAt: revision.approvedAt,
    publishedByCode: assertDisplayCode(revision.publishedBy, 'publishedBy'),
    publishStartedAt: revision.publishStartedAt,
    publishCompletedAt: revision.publishCompletedAt,
    resumeInitialOnly: revision.authoredBy === 'bootstrap-import',
    previewAvailable:
      storedProposalAvailable === true
      && ['draft', 'approved', 'failed'].includes(revision.state),
    failure: revision.failure === null ? null : { reasonCode: revision.failure.reasonCode, at: revision.failure.at },
    supersededInFavourOf: revision.supersededInFavourOf,
    targets: revision.targets.map((target) => ({
      targetCode: target.targetCode,
      outcome: target.outcome,
      reasonCode: target.reasonCode,
    })),
    targetSummary: { ...targetSummary },
    // Offered actions exclude approving your own change unless the viewer holds the
    // authority for it, so the rule is visible as an absent action rather than as a
    // refusal after the click.
    availableCommands: commandsAvailable && callerIdentifiable
      ? [...availableCommands(revision, { actor: viewerCode, selfApprovalGranted })].filter((command) => {
        if (command === 'edit') return false;
        const isSharedRecovery = RECOVERY_SHARED_AUTHORS.has(revision.authoredBy);
        if (command === 'abandon') {
          return isSharedRecovery && recoveryAbandonmentGranted && !hasPublicationActivity(revision);
        }
        if (command === 'withdraw') {
          return revision.state === 'draft' && viewerCode === revision.authoredBy;
        }
        // A resume always uses the durable proposal, irrespective of who authored it.
        // Only a high-trust, untouched legacy proposal may be abandoned without one.
        if (storedProposalAvailable !== true) {
          return !['approve', 'publish', 'retry', 'fail'].includes(command);
        }
        return true;
      })
      : [],
    // Stated so the screen can say the approval will be recorded as the viewer's own,
    // rather than presenting it as an ordinary review.
    selfApproval:
      viewerCode !== null && viewerCode === revision.authoredBy
        ? { available: selfApprovalGranted === true }
        : null,
    history: projectHistory(revision.history),
  };
}

const ORDER = Object.freeze(['publishing', 'failed', 'approved', 'draft', 'active', 'superseded', 'withdrawn']);

export function projectLifecycle({
  authorization,
  revisions,
  selection,
  viewerCode = null,
  selfApprovalGranted = false,
  commandsAvailable = true,
  recoveryAbandonmentGranted = false,
  storedProposalAvailableByRevision = null,
  callerIdentifiable = true,
}) {
  assertAuthorizedReadScope({
    authorization,
    scope: selection.scope,
    teamKey: selection.teamKey,
  });
  if (!Array.isArray(revisions)) throw new TypeError('revisions must be an array.');

  const records = revisions
    .map((revision) => projectRevision(
      revision,
      viewerCode,
      selfApprovalGranted,
      commandsAvailable,
      recoveryAbandonmentGranted,
      storedProposalAvailableByRevision?.[revision.revisionId],
      callerIdentifiable,
    ))
    .sort(
      (left, right) =>
        ORDER.indexOf(left.state) - ORDER.indexOf(right.state) ||
        right.revisionNumber - left.revisionNumber,
    );

  const active = records.find((record) => record.state === 'active') ?? null;
  const publishing = records.find((record) => record.state === 'publishing') ?? null;
  const attention = records.filter((record) => record.state === 'failed' || record.state === 'publishing');

  const readModel = {
    readModelVersion: 'lifecycle.v1',
    generatedAt: selection.generatedAt,
    readModelId: `lifecycle-${selection.scope}-${selection.teamKey ?? 'none'}`,
    quality: {
      // Nothing serving is a fact an operator must be told, not an empty screen.
      state: active === null ? 'no-active-revision' : 'complete',
      // Two revisions publishing at once would mean the single-publisher rule was not
      // holding, so the count is reported rather than assumed to be at most one.
      concurrentPublishes: records.filter((record) => record.state === 'publishing').length,
    },
    summary: {
      activeRevisionCode: active?.revisionCode ?? null,
      publishingRevisionCode: publishing?.revisionCode ?? null,
      needsAttention: attention.length,
      total: records.length,
    },
    records,
    // Offered rather than remembered: recording a failure means choosing from what the
    // product defines, not typing a code an operator would have to already know.
    failureReasonCodes: [...OPERATOR_FAILURE_REASONS],
    selection: {
      scope: selection.scope,
      teamKey: selection.scope === 'team' ? selection.teamKey : null,
    },
  };

  assertBodyFreeReadModel(readModel, SAFE_READ_MODEL_KEYS);
  return readModel;
}
