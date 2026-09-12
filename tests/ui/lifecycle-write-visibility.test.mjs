import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createLocalAdminServer } from '../../app/control-api/local-admin-server.mjs';
import { LOCAL_LIFECYCLE_ACTORS } from '../../app/local-adapters/deterministic-configuration-revisions.mjs';
import { createLocalGovernanceSource } from '../../app/control-api/local-governance-source.mjs';

async function withServer(run, options = {}) {
  const server = createLocalAdminServer(options);
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

test('the default local administrator is offered self-approval and records its own actor', async () => {
  await withServer(async (base) => {
    const held = await (
      await fetch(`${base}/api/local/lifecycle/revision?revisionId=revision-0010&viewer=${LOCAL_LIFECYCLE_ACTORS.author}`)
    ).json();
    assert.equal(held.availableCommands.includes('approve'), true);

    const approved = await save(base, 'revision-0010', held, { actor: LOCAL_LIFECYCLE_ACTORS.author });
    assert.equal(approved.status, 200);
    const record = (await listRevisions(base)).find((entry) => entry.revisionCode === 'revision-0010');
    assert.equal(record.approvedByCode, LOCAL_LIFECYCLE_ACTORS.author);
    assert.equal(record.history.at(-1).reasonCode, 'self-approval-granted');
  });
});

test('a reader cannot grant itself self-approval by claiming an administrator actor in the request', async () => {
  // The authority is decided from what the deployment configured for that actor. A
  // caller that could assert it about itself would make the rule advisory.
  await withServer(async (base) => {
    const held = await (
      await fetch(`${base}/api/local/lifecycle/revision?revisionId=revision-0010`)
    ).json();

    const refused = await fetch(`${base}/api/local/lifecycle/save?persona=auditor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revisionId: 'revision-0010',
        etag: held.etag,
        command: 'approve',
        actor: LOCAL_LIFECYCLE_ACTORS.author,
        selfApprovalGranted: true,
      }),
    });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).reasonCode, 'not-a-governance-author');
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

test('local ordinary save stays draft until the same admin explicitly approves and publishes', async () => {
  const source = createLocalGovernanceSource({ evaluationTime: '2026-07-24T10:00:00.000Z' });
  await withServer(async (base) => {
    const post = (route, body) => fetch(`${base}/api/local/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const budgets = async () => (await (await fetch(`${base}/api/local/budgets?scope=global`)).json()).records;
    const before = await budgets();
    const created = await post('budgets/propose', {
      actor: 'local-admin', command: 'edit', budgetId: 'budget-organization-monthly',
      changes: { amount: 30_000_000 },
    });
    assert.equal(created.status, 201);
    const draft = await created.json();
    assert.equal(draft.state, 'draft');
    assert.deepEqual(await budgets(), before);
    const listing = await listRevisions(base);
    assert.ok(listing[0].availableCommands.includes('approve'));
    assert.ok(listing[0].availableCommands.includes('withdraw'));
    assert.deepEqual(listing[0].selfApproval, { available: true });
    const reader = await (await fetch(`${base}/api/local/lifecycle?scope=global&persona=auditor`)).json();
    assert.deepEqual(reader.records.flatMap((record) => record.availableCommands), []);
    const body = { revisionId: draft.revisionId, actor: 'local-admin', etag: draft.etag };
    assert.equal((await post('lifecycle/publish?persona=auditor', body)).status, 403);
    assert.equal((await post('lifecycle/publish?persona=unknown-role', body)).status, 400);
    assert.equal((await post('lifecycle/publish', { ...body, content: {} })).status, 400);
    assert.equal((await post('lifecycle/publish', { ...body, etag: '"stale"' })).status, 409);
    assert.equal((await post('lifecycle/save', {
      revisionId: draft.revisionId, command: 'withdraw', actor: 'local-auditor',
    })).status, 409);
    assert.equal(stateOf(await listRevisions(base), draft.revisionId), 'draft');
    const approved = await post('lifecycle/publish', body);
    assert.equal(approved.status, 200);
    const active = await approved.json();
    assert.equal(active.state, 'active');
    assert.ok(active.targets.every((target) => target.outcome === 'verified'));
    const record = (await listRevisions(base))[0];
    assert.equal(record.approvedByCode, 'local-admin');
    assert.equal(record.publishedByCode, 'local-admin');
    assert.equal(record.history.find((entry) => entry.command === 'approve').reasonCode, 'self-approval-granted');
    assert.notDeepEqual(await budgets(), before);
  }, { source: { ...source, readConfigurationRevisions: async () => [] } });
});
