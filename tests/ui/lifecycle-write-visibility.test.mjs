import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createLocalAdminServer } from '../../app/control-api/local-admin-server.mjs';
import { LOCAL_LIFECYCLE_ACTORS } from '../../app/local-adapters/deterministic-configuration-revisions.mjs';

async function withServer(run) {
  const server = createLocalAdminServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const listRevisions = async (base) =>
  (await (await fetch(`${base}/api/local/lifecycle?scope=global&revisions=all`)).json()).records;

const stateOf = (records, revisionCode) =>
  records.find((record) => record.revisionCode === revisionCode)?.state ?? null;

test('a saved revision is visible on the screen that lists revisions', async () => {
  // The write path was durable and the list was a fixture, so a save succeeded and
  // then disappeared. That is worse than a save that fails, because nothing reports it.
  await withServer(async (base) => {
    const before = await listRevisions(base);
    assert.equal(stateOf(before, 'revision-0010'), 'draft');

    const held = await (
      await fetch(`${base}/api/local/lifecycle/revision?revisionId=revision-0010`)
    ).json();
    assert.ok(held.availableCommands.includes('approve'));

    const saved = await fetch(`${base}/api/local/lifecycle/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: 'revision-0010',
        etag: held.etag,
        expectedRevisionNumber: held.revisionNumber,
        command: 'approve',
        actor: LOCAL_LIFECYCLE_ACTORS.approver,
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).outcome, 'saved');

    const after = await listRevisions(base);
    assert.equal(stateOf(after, 'revision-0010'), 'approved');
    assert.equal(after.length, before.length, 'approving a revision must not add or drop one');
  });
});

const save = async (base, revisionId, held, body) =>
  fetch(`${base}/api/local/lifecycle/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revisionId,
      etag: held.etag,
      expectedRevisionNumber: held.revisionNumber,
      command: 'approve',
      ...body,
    }),
  });

test('an author without the authority is not offered self-approval and cannot take it', async () => {
  await withServer(async (base) => {
    const held = await (
      await fetch(`${base}/api/local/lifecycle/revision?revisionId=revision-0010&viewer=${LOCAL_LIFECYCLE_ACTORS.author}`)
    ).json();
    assert.equal(held.availableCommands.includes('approve'), false);

    const refused = await save(base, 'revision-0010', held, { actor: LOCAL_LIFECYCLE_ACTORS.author });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).reasonCode, 'separation-of-duties');
  });
});

test('a caller cannot grant itself the authority by claiming it in the request', async () => {
  // The authority is decided from what the deployment configured for that actor. A
  // caller that could assert it about itself would make the rule advisory.
  await withServer(async (base) => {
    const held = await (
      await fetch(`${base}/api/local/lifecycle/revision?revisionId=revision-0010`)
    ).json();

    const refused = await save(base, 'revision-0010', held, {
      actor: LOCAL_LIFECYCLE_ACTORS.author,
      selfApprovalGranted: true,
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).reasonCode, 'separation-of-duties');
    assert.equal(stateOf(await listRevisions(base), 'revision-0010'), 'draft');
  });
});

test('an owner may approve their own change, and it is recorded as their own', async () => {
  await withServer(async (base) => {
    const viewer = LOCAL_LIFECYCLE_ACTORS.owner;
    const held = await (
      await fetch(`${base}/api/local/lifecycle/revision?revisionId=revision-0011&viewer=${viewer}`)
    ).json();
    assert.equal(held.availableCommands.includes('approve'), true);

    const saved = await save(base, 'revision-0011', held, { actor: viewer });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).outcome, 'saved');

    const records = await listRevisions(base);
    assert.equal(stateOf(records, 'revision-0011'), 'approved');
    const record = records.find((entry) => entry.revisionCode === 'revision-0011');
    assert.equal(record.selfApproval, null, 'a viewer who did not author it is not offered the exception');
    assert.equal(
      record.history.at(-1).reasonCode,
      'self-approval-granted',
      'the audit record must not present this as a second person reviewing the change',
    );

    const asOwner = await (
      await fetch(`${base}/api/local/lifecycle?scope=global&revisions=all&viewer=${viewer}`)
    ).json();
    assert.deepEqual(
      asOwner.records.find((entry) => entry.revisionCode === 'revision-0011').selfApproval,
      { available: true },
    );
  });
});

test('a save refused by the reducer leaves the listed state alone', async () => {
  await withServer(async (base) => {
    const held = await (
      await fetch(`${base}/api/local/lifecycle/revision?revisionId=revision-0007`)
    ).json();
    assert.equal(held.state, 'active');

    const refused = await fetch(`${base}/api/local/lifecycle/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: 'revision-0007',
        etag: held.etag,
        expectedRevisionNumber: held.revisionNumber,
        command: 'approve',
        actor: LOCAL_LIFECYCLE_ACTORS.approver,
      }),
    });
    assert.notEqual(refused.status, 200);

    assert.equal(stateOf(await listRevisions(base), 'revision-0007'), 'active');
  });
});

test('each server starts from the seed, so one test cannot decide another', async () => {
  await withServer(async (base) => {
    assert.equal(stateOf(await listRevisions(base), 'revision-0010'), 'draft');
  });
});
