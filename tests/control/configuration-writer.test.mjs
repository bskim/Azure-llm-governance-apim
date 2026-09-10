import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createConfigurationWriter } from '../../app/control-api/configuration-writer.mjs';
import { createRevision } from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';

const SCOPE = 'platform-engineering';

function draft(revisionId = 'revision-0007') {
  return createRevision({
    revisionId,
    scopeGroupId: SCOPE,
    revisionNumber: 7,
    authoredBy: 'admin-a',
    authoredAt: '2026-07-24T09:00:00.000Z',
    targets: ['gateway-policy'],
  });
}

async function seeded(revisionId) {
  const store = createInMemoryGovernanceStore();
  const writer = createConfigurationWriter({ store });
  const seed = draft(revisionId);
  await store.putConfigurationRevision(seed, { ifMatch: null });
  const loaded = await writer.readForEdit({ scopeGroupId: SCOPE, revisionId: seed.revisionId });
  return { store, writer, loaded };
}

test('a save against the version that was read succeeds and issues a new tag', async () => {
  const { writer, loaded } = await seeded('revision-0101');

  const result = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'approve',
    actor: 'admin-b',
    at: '2026-07-24T09:05:00.000Z',
    reasonCode: 'change-reviewed',
  });

  assert.equal(result.outcome, 'saved');
  assert.equal(result.revision.state, 'approved');
  assert.notEqual(result.etag, loaded.etag);
  assert.equal(result.overwrote, null);
});

test('a second administrator who read the same version is refused, and told what changed', async () => {
  // Both loaded revision 7. The first save wins; the second must not silently land.
  const { writer, loaded } = await seeded('revision-0102');

  await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'approve',
    actor: 'admin-b',
    at: '2026-07-24T09:05:00.000Z',
    reasonCode: 'change-reviewed',
  });

  const second = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'edit',
    actor: 'admin-a',
    at: '2026-07-24T09:06:00.000Z',
    reasonCode: 'change-revised',
  });

  assert.equal(second.outcome, 'conflict');
  assert.equal(second.reasonCode, 'changed-since-read');
  assert.deepEqual(
    second.comparison.discarded.map((entry) => `${entry.actor}:${entry.command}`),
    ['admin-b:approve'],
  );
  assert.ok(second.currentEtag, 'the caller needs the version it was just shown');
});

test('confirming an overwrite applies it and records whose work was destroyed', async () => {
  const { store, writer, loaded } = await seeded('revision-0103');

  await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'approve',
    actor: 'admin-b',
    at: '2026-07-24T09:05:00.000Z',
    reasonCode: 'change-reviewed',
  });

  const conflict = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'edit',
    actor: 'admin-a',
    at: '2026-07-24T09:06:00.000Z',
    reasonCode: 'change-revised',
  });

  const forced = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'edit',
    actor: 'admin-a',
    at: '2026-07-24T09:06:00.000Z',
    reasonCode: 'change-revised',
    force: true,
    acknowledgedEtag: conflict.currentEtag,
  });

  assert.equal(forced.outcome, 'saved');
  assert.deepEqual(forced.overwrote.discardedActors, ['admin-b']);
  assert.deepEqual(forced.overwrote.discardedCommands, ['approve']);
  assert.equal(forced.overwrote.actorCode, 'admin-a');

  const stored = await store.readConfigurationRevision({ scopeGroupId: SCOPE, revisionId: 'revision-0103' });
  assert.equal(stored.document.state, 'draft', 'the confirmed command is what landed');
});

test('confirming an overwrite destroys only the work that was shown', async () => {
  // The person agreed to discard one named change. A third save arriving while the
  // warning was on screen was never shown to them, so confirming must not carry it
  // away too: a warning that covers only part of the loss is not a warning.
  const { store, writer, loaded } = await seeded('revision-0106');

  await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'approve',
    actor: 'admin-b',
    at: '2026-07-24T09:05:00.000Z',
    reasonCode: 'change-reviewed',
  });

  const shown = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'edit',
    actor: 'admin-a',
    at: '2026-07-24T09:06:00.000Z',
    reasonCode: 'change-revised',
  });
  assert.equal(shown.outcome, 'conflict');

  // A third administrator saves after the warning was rendered.
  const fresh = await writer.readForEdit({ scopeGroupId: SCOPE, revisionId: 'revision-0106' });
  await writer.save({
    loaded: fresh.revision,
    etag: fresh.etag,
    command: 'publish',
    actor: 'admin-c',
    at: '2026-07-24T09:07:00.000Z',
    reasonCode: 'publish-approved',
    publishingRevisionId: null,
  });

  const forced = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'edit',
    actor: 'admin-a',
    at: '2026-07-24T09:08:00.000Z',
    reasonCode: 'change-revised',
    force: true,
    acknowledgedEtag: shown.currentEtag,
  });

  assert.equal(forced.outcome, 'conflict', 'the unseen change is shown before it can be destroyed');
  assert.ok(
    forced.comparison.discarded.some((entry) => entry.actor === 'admin-c'),
    'the newly arrived change is named in the second warning',
  );

  const stored = await store.readConfigurationRevision({ scopeGroupId: SCOPE, revisionId: 'revision-0106' });
  assert.equal(stored.document.state, 'publishing', "admin-c's save is still there");
});

test('forcing without stating what was seen is refused rather than overwriting blind', async () => {
  const { store, writer, loaded } = await seeded('revision-0107');

  await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'approve',
    actor: 'admin-b',
    at: '2026-07-24T09:05:00.000Z',
    reasonCode: 'change-reviewed',
  });

  const forced = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'edit',
    actor: 'admin-a',
    at: '2026-07-24T09:06:00.000Z',
    reasonCode: 'change-revised',
    force: true,
  });

  assert.equal(forced.outcome, 'conflict');
  const stored = await store.readConfigurationRevision({ scopeGroupId: SCOPE, revisionId: 'revision-0107' });
  assert.equal(stored.document.state, 'approved');
});

test('a save the reducer refuses never reaches the store', async () => {
  // A rule the state machine enforces is not a conflict, and must not be presented
  // as one or resolved by forcing.
  const { store, writer, loaded } = await seeded('revision-0104');

  const result = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'complete',
    actor: 'admin-b',
    at: '2026-07-24T09:05:00.000Z',
    reasonCode: 'publish-confirmed',
  });

  assert.equal(result.outcome, 'refused');
  const stored = await store.readConfigurationRevision({ scopeGroupId: SCOPE, revisionId: 'revision-0104' });
  assert.equal(stored.document.state, 'draft');
});

test('a refusal carries what the person needs to act on it', async () => {
  // "Another publish is in flight" without saying which one leaves the operator
  // hunting for it, and the reducer already knows the answer.
  const { writer, loaded } = await seeded('revision-0108');
  const approved = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'approve',
    actor: 'admin-b',
    at: '2026-07-24T09:05:00.000Z',
    reasonCode: 'change-reviewed',
  });

  const blocked = await writer.save({
    loaded: approved.revision,
    etag: approved.etag,
    command: 'publish',
    actor: 'admin-b',
    at: '2026-07-24T09:06:00.000Z',
    reasonCode: 'publish-approved',
    publishingRevisionId: 'revision-0099',
  });

  assert.equal(blocked.outcome, 'refused');
  assert.equal(blocked.reasonCode, 'publish-in-progress');
  assert.equal(blocked.detail.publishingRevisionId, 'revision-0099');
});

test('a refusal that names nothing extra carries no invented detail', async () => {
  const { writer, loaded } = await seeded('revision-0109');

  const refused = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'approve',
    actor: 'admin-a',
    at: '2026-07-24T09:05:00.000Z',
    reasonCode: 'change-reviewed',
    selfApprovalGranted: false,
  });

  assert.equal(refused.reasonCode, 'separation-of-duties');
  assert.equal(refused.detail, null);
});

test('a save without the version it read is refused rather than defaulted', async () => {
  const { writer, loaded } = await seeded('revision-0105');

  await assert.rejects(
    () =>
      writer.save({
        loaded: loaded.revision,
        etag: undefined,
        command: 'approve',
        actor: 'admin-b',
        at: '2026-07-24T09:05:00.000Z',
        reasonCode: 'change-reviewed',
      }),
    /state the version you read/,
  );
});

test('a third change landing during the confirmation is refused again', async () => {
  // The reason confirming carries the tag it was shown. Without it, the moment spent
  // reading the warning would be its own race.
  const { store, writer, loaded } = await seeded('revision-0106');

  await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'approve',
    actor: 'admin-b',
    at: '2026-07-24T09:05:00.000Z',
    reasonCode: 'change-reviewed',
  });

  const conflict = await writer.save({
    loaded: loaded.revision,
    etag: loaded.etag,
    command: 'edit',
    actor: 'admin-a',
    at: '2026-07-24T09:06:00.000Z',
    reasonCode: 'change-revised',
  });
  assert.equal(conflict.outcome, 'conflict');

  // Somebody else moves again while the warning is on screen.
  const current = await store.readConfigurationRevision({ scopeGroupId: SCOPE, revisionId: 'revision-0106' });
  await writer.save({
    loaded: current.document,
    etag: current.etag,
    command: 'publish',
    actor: 'admin-c',
    at: '2026-07-24T09:07:00.000Z',
    publishingRevisionId: null,
    reasonCode: 'publish-requested',
  });

  await assert.rejects(
    () => store.putConfigurationRevision(conflict.current, { ifMatch: conflict.currentEtag }),
    (error) => error.name === 'ConcurrencyConflictError',
  );
});
