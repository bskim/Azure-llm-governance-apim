import assert from 'node:assert/strict';
import test from 'node:test';

import { projectLifecycle } from '../../app/control-api/lifecycle-read-model-projector.mjs';
import { OPERATOR_FAILURE_REASONS } from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';
import {
  getDeterministicConfigurationRevisions,
  LOCAL_LIFECYCLE_ACTORS,
} from '../../app/local-adapters/deterministic-configuration-revisions.mjs';

const generatedAt = '2026-07-24T10:00:00.000Z';

function authorization(permittedReadScopes = ['self', 'team', 'global']) {
  return {
    contractVersion: 'v1',
    readAuthority: 'authoritative',
    permittedReadScopes,
    permittedTeamKeys: ['platform-engineering'],
    reasonCode: 'authorized',
  };
}

function project(overrides = {}) {
  const revisions = overrides.revisions ?? getDeterministicConfigurationRevisions();
  return projectLifecycle({
    authorization: authorization(overrides.scopes),
    revisions,
    selection: {
      scope: overrides.scope ?? 'global',
      teamKey: overrides.teamKey ?? null,
      generatedAt,
    },
    viewerCode: overrides.viewerCode ?? null,
    selfApprovalGranted: overrides.selfApprovalGranted ?? false,
    recoveryAbandonmentGranted: overrides.recoveryAbandonmentGranted ?? false,
    storedProposalAvailableByRevision: overrides.storedProposalAvailableByRevision
      ?? Object.fromEntries(revisions.map((entry) => [entry.revisionId, true])),
    callerIdentifiable: overrides.callerIdentifiable ?? true,
  });
}

function record(readModel, state) {
  return readModel.records.find((entry) => entry.state === state);
}

function revision(readModel, revisionCode) {
  return readModel.records.find((entry) => entry.revisionCode === revisionCode);
}

test('the states that need an operator are listed before the ones that do not', () => {
  const readModel = project();
  assert.equal(readModel.readModelVersion, 'lifecycle.v1');
  assert.deepEqual(readModel.records.map((entry) => entry.state), [
    'publishing',
    'failed',
    'approved',
    'draft',
    'draft',
    'active',
    'superseded',
  ]);
  assert.equal(readModel.summary.needsAttention, 2);
});

test('what is serving now and what is mid-publish are named separately', () => {
  const readModel = project();
  assert.equal(readModel.summary.activeRevisionCode, 'revision-0007');
  assert.equal(readModel.summary.publishingRevisionCode, 'revision-0008');
  assert.equal(readModel.quality.state, 'complete');
  assert.equal(readModel.quality.concurrentPublishes, 1);
});

test('nothing serving is reported rather than shown as an empty screen', () => {
  const revisions = getDeterministicConfigurationRevisions().filter(
    (revision) => revision.state !== 'active',
  );
  const readModel = project({ revisions });
  assert.equal(readModel.quality.state, 'no-active-revision');
  assert.equal(readModel.summary.activeRevisionCode, null);
});

test('a publish in flight shows which target is confirmed and which is only written', () => {
  const publishing = record(project(), 'publishing');
  assert.deepEqual(
    publishing.targets.map((target) => [target.targetCode, target.outcome]),
    [
      ['gateway-backend', 'pending'],
      ['gateway-named-values', 'verified'],
      ['gateway-policy', 'written'],
    ],
  );
  assert.equal(publishing.targetSummary.verified, 1);
  assert.equal(publishing.targetSummary.total, 3);
  // Written is not finished, so completing is not offered.
  assert.equal(publishing.availableCommands.includes('complete'), false);
  assert.equal(publishing.availableCommands.includes('fail'), true);
});

test('a failed publish reports the partial write and offers retry and supersede', () => {
  const failed = record(project(), 'failed');
  assert.equal(failed.failure.reasonCode, 'readback-mismatch');
  assert.equal(failed.targetSummary.partial, true);
  assert.equal(
    failed.targets.find((target) => target.targetCode === 'gateway-policy').reasonCode,
    'readback-mismatch',
  );
  assert.deepEqual(failed.availableCommands, ['retry', 'supersede']);
});

test('recovery abandonment is server-gated and unavailable after publication activity', () => {
  const base = record(project(), 'failed');
  const zeroVerified = {
    ...base,
    authoredByCode: 'bootstrap-import',
    targets: base.targets.map((target) => ({ ...target, outcome: 'failed' })),
  };
  // Feed the domain-shaped record rather than the display projection back as a fixture.
  const [first, ...rest] = getDeterministicConfigurationRevisions();
  const fixtureRevision = {
    ...first,
    state: 'failed',
    authoredBy: zeroVerified.authoredByCode,
    targets: first.targets.map((target) => ({ ...target, outcome: 'failed', reasonCode: 'gateway-unreachable' })),
  };
  assert.equal(
    revision(project({ revisions: [fixtureRevision, ...rest] }), fixtureRevision.revisionId).availableCommands.includes('abandon'),
    false,
  );
  assert.equal(
    revision(project({
      revisions: [fixtureRevision, ...rest],
      recoveryAbandonmentGranted: true,
    }), fixtureRevision.revisionId).availableCommands.includes('abandon'),
    false,
  );
  assert.equal(base.availableCommands.includes('abandon'), false);
});

test('a publishing bootstrap proposal never offers abandonment while target writes can be in flight', () => {
  const [first, ...rest] = getDeterministicConfigurationRevisions();
  const publishingBootstrap = {
    ...first,
    state: 'publishing',
    authoredBy: 'bootstrap-import',
    publishedBy: null,
    publishStartedAt: null,
    publishCompletedAt: null,
    targets: first.targets.map((target) => ({ ...target, outcome: 'pending', reasonCode: null })),
  };

  const projected = revision(project({
    revisions: [publishingBootstrap, ...rest],
    recoveryAbandonmentGranted: true,
    storedProposalAvailableByRevision: { [publishingBootstrap.revisionId]: true },
  }), publishingBootstrap.revisionId);

  assert.equal(projected.availableCommands.includes('abandon'), false);
});

test('legacy draft and approved recovery actions only expose high-trust abandonment', () => {
  const [first, ...rest] = getDeterministicConfigurationRevisions();
  for (const state of ['draft', 'approved']) {
    const legacy = {
      ...first,
      revisionId: `revision-legacy-${state}`,
      state,
      authoredBy: 'bootstrap-import',
      approvedBy: state === 'approved' ? LOCAL_LIFECYCLE_ACTORS.approver : null,
      approvedAt: state === 'approved' ? generatedAt : null,
      targets: first.targets.map((target) => ({ ...target, outcome: 'pending', reasonCode: null })),
    };
    const unavailable = revision(project({
      revisions: [legacy, ...rest],
      storedProposalAvailableByRevision: { [legacy.revisionId]: false },
    }), legacy.revisionId);
    assert.equal(unavailable.availableCommands.includes('abandon'), false);
    assert.equal(unavailable.availableCommands.includes('withdraw'), false);
    assert.equal(unavailable.availableCommands.includes('approve'), false);
    assert.equal(unavailable.availableCommands.includes('publish'), false);

    const available = revision(project({
      revisions: [legacy, ...rest],
      recoveryAbandonmentGranted: true,
      storedProposalAvailableByRevision: { [legacy.revisionId]: false },
    }), legacy.revisionId);
    assert.equal(available.availableCommands.includes('abandon'), true);
    assert.equal(available.availableCommands.includes('withdraw'), false);
    assert.equal(available.availableCommands.includes('approve'), false);
    assert.equal(available.availableCommands.includes('publish'), false);
  }
});

test('a revision without its durable proposal offers no resume action the handler will reject', () => {
  const [first, ...rest] = getDeterministicConfigurationRevisions();
  const missingDraft = {
    ...first,
    state: 'failed',
    authoredBy: 'actor1-0123456789abcdef0123456789abcdef',
    targets: first.targets.map((target) => ({
      ...target,
      outcome: 'failed',
      reasonCode: 'gateway-unreachable',
    })),
  };

  const projected = revision(project({
    revisions: [missingDraft, ...rest],
    storedProposalAvailableByRevision: { [missingDraft.revisionId]: false },
  }), missingDraft.revisionId);

  assert.equal(projected.availableCommands.includes('retry'), false);
  assert.equal(projected.availableCommands.includes('abandon'), false);
});

test('a lifecycle reader without an attributable actor is offered no handler-rejected action', () => {
  const [first, ...rest] = getDeterministicConfigurationRevisions();
  const recoverable = {
    ...first,
    state: 'failed',
    authoredBy: 'actor1-0123456789abcdef0123456789abcdef',
    targets: first.targets.map((target) => ({
      ...target,
      outcome: 'failed',
      reasonCode: 'gateway-unreachable',
    })),
  };

  const projected = revision(project({
    revisions: [recoverable, ...rest],
    viewerCode: null,
    callerIdentifiable: false,
    storedProposalAvailableByRevision: { [recoverable.revisionId]: true },
  }), recoverable.revisionId);

  assert.deepEqual(projected.availableCommands, []);
});

test('a bootstrap recovery is marked for the handler-required initial-only resume', () => {
  const [first, ...rest] = getDeterministicConfigurationRevisions();
  const bootstrapRecovery = {
    ...first,
    state: 'failed',
    authoredBy: 'bootstrap-import',
    targets: first.targets.map((target) => ({
      ...target,
      outcome: 'failed',
      reasonCode: 'gateway-unreachable',
    })),
  };

  const projected = revision(project({
    revisions: [bootstrapRecovery, ...rest],
    storedProposalAvailableByRevision: { [bootstrapRecovery.revisionId]: true },
  }), bootstrapRecovery.revisionId);

  assert.equal(projected.availableCommands.includes('retry'), true);
  assert.equal(projected.resumeInitialOnly, true);
});

test('a superseded revision names what it returned to', () => {
  const superseded = record(project(), 'superseded');
  assert.equal(superseded.supersededInFavourOf, 'revision-0004');
  assert.deepEqual(superseded.availableCommands, []);
});

test('approving your own change is not offered, so the rule is visible before the click', () => {
  const asApprover = revision(project({ viewerCode: LOCAL_LIFECYCLE_ACTORS.approver }), 'revision-0010');
  assert.equal(asApprover.availableCommands.includes('approve'), true);
  assert.equal(asApprover.selfApproval, null);

  const asAuthor = revision(project({ viewerCode: LOCAL_LIFECYCLE_ACTORS.author }), 'revision-0010');
  assert.equal(asAuthor.availableCommands.includes('approve'), false);
  assert.deepEqual(asAuthor.availableCommands, ['withdraw'], 'immutable proposals must be withdrawn, not edited');
  assert.deepEqual(asAuthor.selfApproval, { available: false });
});

test('the reasons an operator may record are offered by the read model', () => {
  // Offered rather than remembered: a free-text code would require an operator to
  // already know the vocabulary, and a list held by the screen would drift from the
  // one the product defines.
  const readModel = project();
  assert.deepEqual(readModel.failureReasonCodes, [...OPERATOR_FAILURE_REASONS]);
  assert.ok(readModel.failureReasonCodes.length > 0);
});

test('every offered reason is one the reducer accepts', () => {
  const draft = revision(project(), 'revision-0010');
  assert.ok(draft !== undefined);
  for (const reasonCode of OPERATOR_FAILURE_REASONS) {
    // The reducer refuses a malformed reason, so an offered one that it rejected would
    // be an action the screen could never complete.
    assert.match(reasonCode, /^[a-z][a-z0-9-]{2,63}$/, `${reasonCode} is not a reason the reducer accepts`);
  }
});

test('an author holding the authority is offered it, and told that is what it is', () => {
  const withoutAuthority = revision(
    project({ viewerCode: LOCAL_LIFECYCLE_ACTORS.owner }),
    'revision-0011',
  );
  assert.equal(withoutAuthority.availableCommands.includes('approve'), false);
  assert.deepEqual(withoutAuthority.selfApproval, { available: false });

  const withAuthority = revision(
    project({ viewerCode: LOCAL_LIFECYCLE_ACTORS.owner, selfApprovalGranted: true }),
    'revision-0011',
  );
  assert.equal(withAuthority.availableCommands.includes('approve'), true);
  assert.deepEqual(withAuthority.selfApproval, { available: true });
});

test('history is projected with the actor and reason of every transition', () => {
  const active = record(project(), 'active');
  assert.equal(active.history[0].command, 'create');
  assert.equal(active.history.at(-1).command, 'complete');
  assert.equal(active.history.at(-1).to, 'active');
  assert.ok(active.history.every((entry) => typeof entry.reasonCode === 'string'));
});

test('author and approver pseudonyms are projected without their raw authenticated identifiers', () => {
  const author = 'actor1-0123456789abcdef0123456789abcdef';
  const approver = 'actor1-fedcba9876543210fedcba9876543210';
  const [first, ...rest] = getDeterministicConfigurationRevisions();
  const readModel = project({
    revisions: [{
      ...first,
      authoredBy: author,
      approvedBy: approver,
      history: first.history.map((entry) => ({ ...entry, actor: author })),
    }, ...rest],
  });
  const projected = revision(readModel, first.revisionId);

  assert.equal(projected.authoredByCode, author);
  assert.equal(projected.approvedByCode, approver);
  assert.ok(!JSON.stringify(readModel).includes('object-admin-0002'));
  assert.ok(!JSON.stringify(readModel).includes('tenant-admin-0001'));
});

test('an unpermitted scope is denied before anything is projected', () => {
  assert.throws(
    () => project({ scopes: ['self'] }),
    (error) => error.code === 'scope-denied',
  );
});

test('a raw directory identifier is refused rather than printed on an admin screen', () => {
  // The body-free assertion checks key names; an actor arrives as a value, so it
  // needs its own check or a caller could put a principal object id on the screen.
  const [first, ...rest] = getDeterministicConfigurationRevisions();
  const leaky = { ...first, authoredBy: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' };
  assert.throws(
    () => project({ revisions: [leaky, ...rest] }),
    (error) => error.code === 'actor-not-pseudonymous',
  );
});

test('the read model carries no request body and no raw principal identifier', () => {
  const serialized = JSON.stringify(project());
  for (const forbidden of ['prompt', 'completion', 'subjectId', 'applicationId', 'accessToken', 'roles']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `read model must not carry ${forbidden}`);
  }
});
