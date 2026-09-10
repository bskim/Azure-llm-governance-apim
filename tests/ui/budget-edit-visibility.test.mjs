import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createLocalAdminServer } from '../../app/control-api/local-admin-server.mjs';
import { LOCAL_LIFECYCLE_ACTORS } from '../../app/local-adapters/deterministic-configuration-revisions.mjs';

const OWNER = LOCAL_LIFECYCLE_ACTORS.owner;
const TARGET = 'budget-organization-monthly';

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

const post = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const budgetsScreen = async (base) =>
  (await (await fetch(`${base}/api/local/budgets?persona=governance-admin&scope=global`)).json());

function limitOf(readModel, budgetId) {
  const record = readModel.records.find((entry) => entry.budgetCode === budgetId);
  return record?.configuredLimit?.amount ?? null;
}

async function approve(base, revisionId) {
  const held = await (
    await fetch(`${base}/api/local/lifecycle/revision?revisionId=${revisionId}&viewer=${OWNER}`)
  ).json();
  const saved = await post(base, '/api/local/lifecycle/save', {
    revisionId,
    etag: held.etag,
    expectedRevisionNumber: held.revisionNumber,
    command: 'approve',
    actor: OWNER,
  });
  assert.equal(saved.status, 200, `approve failed: ${JSON.stringify(await saved.json())}`);
}

/**
 * The seed leaves a revision mid-publish, which is the state an operator has to clear
 * before anything else can publish. Clearing it is the product's own recovery path,
 * not a shortcut around it.
 */
async function clearInFlight(base) {
  const lifecycle = await (await fetch(`${base}/api/local/lifecycle?scope=global&revisions=all`)).json();
  for (const record of lifecycle.records.filter((entry) => entry.state === 'publishing')) {
    const held = await (
      await fetch(`${base}/api/local/lifecycle/revision?revisionId=${record.revisionCode}&viewer=${OWNER}`)
    ).json();
    const saved = await post(base, '/api/local/lifecycle/save', {
      revisionId: record.revisionCode,
      etag: held.etag,
      expectedRevisionNumber: held.revisionNumber,
      command: 'fail',
      actor: OWNER,
      reasonCode: 'superseded-by-operator',
    });
    assert.equal(saved.status, 200, `clearing ${record.revisionCode} failed`);
  }
}

test('a budget edit reaches the screen only once it has been published', async () => {
  await withServer(async (base) => {
    await clearInFlight(base);
    const before = await budgetsScreen(base);
    const original = limitOf(before, TARGET);
    assert.ok(Number.isSafeInteger(original) && original > 0);

    const proposed = await post(base, '/api/local/budgets/propose', {
      budgetId: TARGET,
      changes: { amount: original + 5_000_000 },
      actor: OWNER,
    });
    assert.equal(proposed.status, 201);
    const { revisionId } = await proposed.json();

    // Proposing is not publishing. A screen that showed the new number here would be
    // showing policy the gateway is not enforcing.
    assert.equal(limitOf(await budgetsScreen(base), TARGET), original);

    await approve(base, revisionId);
    const published = await post(base, '/api/local/lifecycle/publish', { revisionId, actor: OWNER });
    assert.equal(published.status, 200);
    const result = await published.json();
    assert.equal(result.outcome, 'published');
    assert.ok(result.targets.every((entry) => entry.outcome === 'verified'));

    assert.equal(limitOf(await budgetsScreen(base), TARGET), original + 5_000_000);
  });
});

test('an edit the snapshot would refuse never becomes a revision', async () => {
  await withServer(async (base) => {
    const refused = await post(base, '/api/local/budgets/propose', {
      budgetId: TARGET,
      changes: { amount: 0 },
      actor: OWNER,
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).reasonCode, 'budget-edit-result-invalid');

    const lifecycle = await (await fetch(`${base}/api/local/lifecycle?scope=global&revisions=all`)).json();
    assert.equal(
      lifecycle.records.some((record) => record.state === 'draft' && record.authoredByCode === OWNER
        && record.revisionCode !== 'revision-0011'),
      false,
      'a refused edit must not leave a draft nobody can publish',
    );
  });
});

test('a budget nobody defined is refused rather than created by an edit', async () => {
  await withServer(async (base) => {
    const refused = await post(base, '/api/local/budgets/propose', {
      budgetId: 'budget-invented',
      changes: { amount: 1_000 },
      actor: OWNER,
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).reasonCode, 'budget-edit-target-unknown');
  });
});

test('a publish is refused while another revision is still in flight', async () => {
  // The seed leaves one mid-publish. Two publishers writing the same targets would
  // interleave and the loser would never know.
  await withServer(async (base) => {
    const proposed = await post(base, '/api/local/budgets/propose', {
      budgetId: TARGET,
      changes: { amount: 30_000_000 },
      actor: OWNER,
    });
    const { revisionId } = await proposed.json();
    await approve(base, revisionId);

    const blocked = await post(base, '/api/local/lifecycle/publish', { revisionId, actor: OWNER });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).reasonCode, 'publish-in-progress');

    await clearInFlight(base);
    const published = await post(base, '/api/local/lifecycle/publish', { revisionId, actor: OWNER });
    assert.equal(published.status, 200);
    assert.equal((await published.json()).outcome, 'published');
  });
});

test('publishing a revision that was never approved is refused', async () => {
  await withServer(async (base) => {
    const proposed = await post(base, '/api/local/budgets/propose', {
      budgetId: TARGET,
      changes: { amount: 30_000_000 },
      actor: OWNER,
    });
    const { revisionId } = await proposed.json();

    const refused = await post(base, '/api/local/lifecycle/publish', { revisionId, actor: OWNER });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).reasonCode, 'transition-not-allowed');
  });
});

test('a second edit starts from what was published, not from the seed', async () => {
  await withServer(async (base) => {
    await clearInFlight(base);
    const original = limitOf(await budgetsScreen(base), TARGET);

    for (const step of [1, 2]) {
      const proposed = await post(base, '/api/local/budgets/propose', {
        budgetId: TARGET,
        changes: { amount: original + step * 1_000_000 },
        actor: OWNER,
      });
      assert.equal(proposed.status, 201, `proposal ${step} refused`);
      const { revisionId } = await proposed.json();
      await approve(base, revisionId);
      const published = await post(base, '/api/local/lifecycle/publish', { revisionId, actor: OWNER });
      assert.equal(published.status, 200);
      assert.equal((await published.json()).outcome, 'published');
    }

    assert.equal(limitOf(await budgetsScreen(base), TARGET), original + 2_000_000);
  });
});
