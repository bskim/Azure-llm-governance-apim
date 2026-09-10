import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalAdminServer } from '../../app/control-api/local-admin-server.mjs';
import { createLocalGovernanceSource } from '../../app/control-api/local-governance-source.mjs';

async function withServer(action, source = undefined) {
  const server = source === undefined ? createLocalAdminServer() : createLocalAdminServer({ source });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await action(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('serves the visible Admin UI and body-free overview read model', async () => {
  await withServer(async (origin) => {
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await page.text(), /Governance Control/);

    const budgetAuthoring = await fetch(`${origin}/budget-authoring.mjs`);
    assert.equal(budgetAuthoring.status, 200);
    assert.match(budgetAuthoring.headers.get('content-type'), /javascript/);
    assert.match(await budgetAuthoring.text(), /export function buildBudgetAddPayload/);

    const response = await fetch(`${origin}/api/local/overview?fixture=complete&persona=governance-admin&scope=global&range=24h`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-local-demo'), 'true');
    const readModel = await response.json();
    assert.equal(readModel.readModelVersion, 'overview.v2');
    assert.equal('viewer' in readModel, false);
    assert.equal('permissions' in readModel, false);

    const serialized = JSON.stringify(readModel);
    for (const forbidden of [
      'accessToken', 'authorization', 'prompt', 'completion', 'subjectId', 'groupId',
      'backendUrl', 'role', 'roles', 'membership', 'memberships', 'permissions',
    ]) {
      assert.equal(serialized.includes(`"${forbidden}"`), false);
    }
  });
});

test('server enforces scope from server-side persona permissions', async () => {
  await withServer(async (origin) => {
    // A gateway caller holds no governance role, so every governance scope is closed
    // to them, including their own usage.
    for (const scope of ['global', 'team', 'self']) {
      const denied = await fetch(`${origin}/api/local/overview?persona=end-user&scope=${scope}`);
      assert.equal(denied.status, 403, scope);
      assert.equal((await denied.json()).error.code, 'scope-denied');
    }

    const auditor = await fetch(`${origin}/api/local/overview?persona=auditor&scope=self`);
    assert.equal(auditor.status, 200);
    const readModel = await auditor.json();
    assert.equal(readModel.recentActivity[0].scopeCode, 'my-usage');
    assert.equal(
      readModel.recentActivity.some((item) => item.scopeCode === 'platform-engineering'),
      false,
    );
  });
});

test('permitted scopes return different, scope-filtered payloads', async () => {
  await withServer(async (origin) => {
    const selfModel = await (
      await fetch(`${origin}/api/local/overview?persona=governance-admin&scope=self`)
    ).json();
    const teamModel = await (
      await fetch(`${origin}/api/local/overview?persona=governance-admin&scope=team`)
    ).json();
    const globalModel = await (
      await fetch(`${origin}/api/local/overview?persona=governance-admin&scope=global`)
    ).json();

    const requests = (model) => model.metrics.find((metric) => metric.id === 'requests').value;
    assert.ok(requests(selfModel) < requests(teamModel));
    assert.ok(requests(teamModel) < requests(globalModel));
    assert.deepEqual(selfModel.recentActivity.map((item) => item.scopeCode), ['my-usage']);
    assert.ok(teamModel.recentActivity.every((item) => item.scopeCode === 'platform-engineering'));
  });
});

test('locale input does not change server payload or authorization result', async () => {
  await withServer(async (origin) => {
    const english = await (
      await fetch(`${origin}/api/local/overview?fixture=complete&persona=governance-admin&scope=global&range=24h&lang=en`)
    ).json();
    const korean = await (
      await fetch(`${origin}/api/local/overview?fixture=complete&persona=governance-admin&scope=global&range=24h&lang=ko`)
    ).json();

    assert.deepEqual(korean, english);
    assert.equal(JSON.stringify(english).includes('Governance Admin'), false);
    assert.equal(JSON.stringify(english).includes('Platform engineering'), false);
  });
});

test('server exposes deterministic state fixtures without mutation routes', async () => {
  await withServer(async (origin) => {
    for (const fixture of ['complete', 'stale', 'partial', 'empty']) {
      const response = await fetch(`${origin}/api/local/overview?fixture=${fixture}`);
      assert.equal(response.status, 200);
      const readModel = await response.json();
      assert.equal(readModel.selection.fixture, fixture);
    }

    assert.equal((await fetch(`${origin}/api/local/overview?fixture=denied`)).status, 403);
    assert.equal((await fetch(`${origin}/api/local/overview?fixture=error`)).status, 503);
    assert.equal((await fetch(`${origin}/api/v1/internal/principal-context`)).status, 404);
    assert.equal((await fetch(`${origin}/api/local/overview`, { method: 'POST' })).status, 405);
  });
});

test('serves a scope-filtered locale-neutral Users & Groups read model', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/users-groups?fixture=complete&persona=governance-admin&scope=team&view=users`;
    const english = await (await fetch(`${base}&lang=en`)).json();
    const korean = await (await fetch(`${base}&lang=ko`)).json();

    assert.deepEqual(korean, english);
    assert.equal(english.readModelVersion, 'users-groups.v1');
    assert.deepEqual(english.records.map((record) => record.displayCode), [
      'local-admin',
      'local-auditor',
    ]);
    assert.equal(english.summary.visibleUsers, 2);
    assert.equal(english.summary.visibleGroups, 1);

    const developerExperience = await (
      await fetch(`${origin}/api/local/users-groups?fixture=complete&persona=governance-admin&scope=team&team=developer-experience&view=users`)
    ).json();
    assert.deepEqual(
      developerExperience.records.map((record) => record.displayCode),
      ['local-end-user'],
    );

    const serialized = JSON.stringify(english);
    for (const forbidden of [
      'subjectId', 'groupId', 'memberSubjectIds', 'recordKey', 'role', 'roles', 'membership',
      'memberships', 'permissions', 'accessToken', 'prompt', 'completion', 'backendUrl',
    ]) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
    }
  });
});

test('Users & Groups authorization ignores caller-shaped authority parameters', async () => {
  await withServer(async (origin) => {
    const authorityInput = new URLSearchParams({
      fixture: 'complete',
      persona: 'end-user',
      scope: 'global',
      view: 'users',
      role: 'governance-admin',
      groupId: 'group-governance-admin',
      membership: 'complete',
      permissions: 'global',
    });
    const denied = await fetch(`${origin}/api/local/users-groups?${authorityInput}`);
    assert.equal(denied.status, 403);
    const deniedPayload = await denied.json();
    assert.deepEqual(Object.keys(deniedPayload.error).sort(), ['code', 'requestId']);
    assert.equal(deniedPayload.error.code, 'scope-denied');

    // Self scope is closed to a gateway caller too, so the injected authority
    // parameters have nothing left to widen.
    const self = await fetch(
      `${origin}/api/local/users-groups?fixture=complete&persona=end-user&scope=self&view=users`,
    );
    assert.equal(self.status, 403);
    assert.equal((await self.json()).error.code, 'scope-denied');

    const auditor = await (
      await fetch(`${origin}/api/local/users-groups?fixture=complete&persona=auditor&scope=self&view=users`)
    ).json();
    assert.deepEqual(auditor.records.map((record) => record.displayCode), ['local-auditor']);
  });
});

test('unauthorized canonical team selection returns 403 on both read endpoints', async () => {
  await withServer(async (origin) => {
    for (const path of [
      '/api/local/overview?fixture=complete&persona=governance-admin&scope=team&team=not-authorized&range=24h',
      '/api/local/users-groups?fixture=complete&persona=governance-admin&scope=team&team=not-authorized&view=users',
      '/api/local/budgets?persona=governance-admin&scope=team&team=not-authorized',
    ]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 403);
      const payload = await response.json();
      assert.equal(payload.error.code, 'team-scope-denied');
      assert.deepEqual(Object.keys(payload.error).sort(), ['code', 'requestId']);
      assert.equal('records' in payload, false);
      assert.equal('summary' in payload, false);
    }
  });
});

test('serves a budget read model that separates what was configured from what is enforced', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/local/budgets?persona=governance-admin&scope=global`);
    assert.equal(response.status, 200);
    const readModel = await response.json();

    assert.equal(readModel.readModelVersion, 'budgets.v1');
    const [record] = readModel.records;
    // The fixture budget is deliberately tighter than the entitlement, and its grace
    // band is what makes the enforced quota differ from the configured one.
    assert.equal(record.configuredLimit.amount, 20_000_000);
    assert.equal(record.enforcedTokenQuota, 22_000_000);
    assert.equal(record.warnThresholdPercent, 90);

    const serialized = JSON.stringify(readModel);
    for (const forbidden of ['subjectId', 'groupId', 'prompt', 'completion', 'roles']) {
      assert.equal(serialized.includes(`"${forbidden}"`), false);
    }
  });
});

test('the budget screen reports how the model decision will be made, not only the cap', async () => {
  await withServer(async (origin) => {
    for (const intent of ['preferred', 'pinned']) {
      const response = await fetch(
        `${origin}/api/local/budgets?persona=governance-admin&scope=global&intent=${intent}`,
      );
      assert.equal(response.status, 200);
      const { modelSelection } = await response.json();
      assert.equal(modelSelection.intent, intent);
      assert.equal(modelSelection.substitutionNotice, 'header');
    }

    const refused = await fetch(
      `${origin}/api/local/budgets?persona=governance-admin&scope=global&intent=cheapest`,
    );
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, 'selection_not_supported');
  });
});

test('a reader without global scope cannot read global budgets', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/local/budgets?persona=end-user&scope=global`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'scope-denied');
  });
});

test('serves a body-free usage read model for both the user and the group axis', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/usage?persona=governance-admin&scope=global`;
    const users = await (await fetch(`${base}&view=users`)).json();
    assert.equal(users.readModelVersion, 'usage.v1');
    assert.equal(users.quality.state, 'complete');
    assert.equal(users.quality.countsMeasured, true);
    assert.ok(users.records.every((record) => record.entityKind === 'user'));
    assert.ok(users.totals.requests > 0);

    const groups = await (await fetch(`${base}&view=groups`)).json();
    assert.deepEqual(
      groups.records.map((record) => record.entityKey),
      ['developer-experience', 'platform-engineering'],
    );
    // The two axes partition the same traffic, so their totals cannot disagree.
    assert.equal(groups.totals.requests, users.totals.requests);
    assert.equal(groups.totals.totalTokens, users.totals.totalTokens);

    const serialized = JSON.stringify(users);
    for (const forbidden of ['subjectId', 'groupId', 'applicationId', 'prompt', 'completion', 'roles']) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
    }
  });
});

test('usage scope filtering is decided server-side, not by the caller', async () => {
  await withServer(async (origin) => {
    const team = await (
      await fetch(`${origin}/api/local/usage?persona=governance-admin&scope=team&team=platform-engineering&view=users`)
    ).json();
    assert.ok(team.records.every((record) => record.entityKey.includes('platform-engineering')));

    const denied = await fetch(`${origin}/api/local/usage?persona=end-user&scope=global&view=users`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'scope-denied');

    const wrongTeam = await fetch(
      `${origin}/api/local/usage?persona=governance-admin&scope=team&team=not-authorized&view=users`,
    );
    assert.equal(wrongTeam.status, 403);
    assert.equal((await wrongTeam.json()).error.code, 'team-scope-denied');

    // A group total is other people's traffic, so a self-scoped reader is refused
    // rather than shown an empty table.
    const selfGroups = await fetch(
      `${origin}/api/local/usage?persona=auditor&scope=self&view=groups`,
    );
    assert.equal(selfGroups.status, 403);
    assert.equal((await selfGroups.json()).error.code, 'view-not-permitted-for-scope');
  });
});

test('an unobserved usage window publishes no counts rather than a quiet one', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/usage?persona=governance-admin&scope=global&view=users`;
    const degraded = await (await fetch(`${base}&fixture=degraded`)).json();
    assert.equal(degraded.quality.state, 'degraded');
    assert.equal(degraded.quality.countsMeasured, false);
    assert.equal(degraded.totals, null);
    assert.deepEqual(degraded.records, []);

    const partial = await (await fetch(`${base}&fixture=partial`)).json();
    assert.equal(partial.quality.state, 'partial');
    assert.equal(partial.quality.countsMeasured, true);
    assert.ok(partial.totals.requests > 0);

    const refused = await fetch(`${base}&fixture=whenever`);
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, 'selection_not_supported');
  });
});

test('the usage screen exposes every state it can be read in, and tells them apart', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/usage?persona=governance-admin&scope=global&view=users`;

    const complete = await (await fetch(`${base}&fixture=complete`)).json();
    assert.equal(complete.quality.freshnessState, 'fresh');
    assert.ok(complete.records.length > 0);

    // Read late, but read. Counts stay published and the lag is what changes.
    const stale = await (await fetch(`${base}&fixture=stale`)).json();
    assert.equal(stale.quality.freshnessState, 'stale');
    assert.equal(stale.quality.countsMeasured, true);
    assert.ok(stale.window.lagSeconds > complete.window.lagSeconds);
    assert.notEqual(stale.window.reportedAt, null);

    // Observed and quiet is not the same answer as never observed, and the pair
    // that proves it is this one: same counts measured, opposite conclusions.
    const empty = await (await fetch(`${base}&fixture=empty`)).json();
    assert.equal(empty.quality.countsMeasured, true);
    assert.deepEqual(empty.records, []);
    assert.equal(empty.totals.requests, 0);
    const degraded = await (await fetch(`${base}&fixture=degraded`)).json();
    assert.equal(degraded.quality.countsMeasured, false);
    assert.equal(degraded.totals, null);

    assert.equal((await fetch(`${base}&fixture=denied`)).status, 403);
    assert.equal((await fetch(`${base}&fixture=error`)).status, 503);
    // A state another screen offers is not answered with something else.
    assert.equal((await fetch(`${base}&fixture=ambiguous`)).status, 400);
  });
});

test('the change history covers every governance source and says what an export would contain', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/audit?persona=auditor&scope=global`;
    const model = await (await fetch(base)).json();

    assert.equal(model.readModelVersion, 'change-log.v1');
    assert.equal(model.quality.state, 'complete');
    assert.equal(model.summary.total, model.records.length);
    // One history, derived from every governance source that keeps a record.
    const categories = model.summary.byCategory.map((entry) => entry.category);
    for (const expected of ['publish', 'notification']) {
      assert.ok(categories.includes(expected), expected);
    }

    assert.equal(model.export.permitted, true);
    assert.deepEqual(model.export.manifest.excluded, ['message-bodies', 'token-counts', 'credentials']);

    const serialized = JSON.stringify(model.records);
    for (const forbidden of ['prompt', 'completion', 'promptTokens', 'totalTokens', 'subjectId', 'accessToken']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });
});

test('the change history is closed to a caller with no governance scope', async () => {
  await withServer(async (origin) => {
    const denied = await fetch(`${origin}/api/local/audit?persona=end-user&scope=global`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'scope-denied');

    const refused = await fetch(`${origin}/api/local/audit?persona=auditor&fixture=rewritten`);
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, 'selection_not_supported');
  });
});

test('a revision loads with the version a save must be written against', async () => {
  await withServer(async (origin) => {
    const held = await (
      await fetch(`${origin}/api/local/lifecycle/revision?revisionId=revision-0010`)
    ).json();

    assert.equal(held.revisionId, 'revision-0010');
    assert.ok(held.etag, 'the edit form cannot save safely without the version it read');
    assert.ok(Array.isArray(held.availableCommands));

    const absent = await fetch(`${origin}/api/local/lifecycle/revision?revisionId=revision-9999`);
    assert.equal(absent.status, 404);
  });
});

test('the second administrator to save is refused and told whose work is at stake', async () => {
  await withServer(async (origin) => {
    const held = await (
      await fetch(`${origin}/api/local/lifecycle/revision?revisionId=revision-0010`)
    ).json();

    const save = (body) =>
      fetch(`${origin}/api/local/lifecycle/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revisionId: held.revisionId,
          etag: held.etag,
          expectedRevisionNumber: held.revisionNumber,
          loaded: held.revision,
          ...body,
        }),
      });

    const first = await save({ command: 'edit', actor: 'admin-b', reasonCode: 'change-revised' });
    assert.equal(first.status, 200);

    // The second still holds the version it read before the first save landed.
    const second = await save({ command: 'edit', actor: 'admin-a', reasonCode: 'change-revised' });
    assert.equal(second.status, 409);
    const conflict = await second.json();
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.comparison.discarded[0].actor, 'admin-b');
    assert.ok(conflict.currentEtag);

    const forced = await save({
      command: 'edit',
      actor: 'admin-a',
      reasonCode: 'change-revised',
      force: true,
      acknowledgedEtag: conflict.currentEtag,
    });
    assert.equal(forced.status, 200);
    assert.deepEqual((await forced.json()).overwrote.discardedActors, ['admin-b']);

    // Confirming without naming the version that was shown destroys whatever happens
    // to be stored now, which is not what anybody agreed to.
    const blind = await save({
      command: 'edit',
      actor: 'admin-a',
      reasonCode: 'change-revised',
      force: true,
    });
    assert.equal(blind.status, 409);
  });
});

test('a save is refused without the fields that make it attributable', async () => {
  await withServer(async (origin) => {
    const bad = await fetch(`${origin}/api/local/lifecycle/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revisionId: 'revision-0010' }),
    });
    assert.equal(bad.status, 400);

    const wrongMethod = await fetch(`${origin}/api/local/lifecycle/save`);
    assert.equal(wrongMethod.status, 405);
  });
});

test('the publishing screen reports what is serving, what is stuck, and what is recoverable', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/lifecycle?persona=governance-admin&scope=global`;
    const readModel = await (await fetch(base)).json();

    assert.equal(readModel.readModelVersion, 'lifecycle.v1');
    assert.equal(readModel.summary.activeRevisionCode, 'revision-0007');
    assert.equal(readModel.summary.publishingRevisionCode, 'revision-0008');
    assert.equal(readModel.quality.concurrentPublishes, 1);

    const failed = readModel.records.find((record) => record.state === 'failed');
    assert.equal(failed.failure.reasonCode, 'readback-mismatch');
    assert.equal(failed.targetSummary.partial, true);
    // Local fixture revisions have no durable proposals, so the deployed publish
    // handler would refuse recovery even though the revision history is readable.
    assert.deepEqual(failed.availableCommands, ['supersede']);

    // Written is not confirmed, so finishing the publish is not offered.
    const publishing = readModel.records.find((record) => record.state === 'publishing');
    assert.equal(publishing.availableCommands.includes('complete'), false);

    const nothingServing = await (await fetch(`${base}&revisions=none-active`)).json();
    assert.equal(nothingServing.quality.state, 'no-active-revision');
    assert.equal(nothingServing.summary.activeRevisionCode, null);

    const serialized = JSON.stringify(readModel);
    for (const forbidden of ['subjectId', 'applicationId', 'prompt', 'completion', 'accessToken']) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
    }
  });
});

test('the publishing screen does not offer approval without a durable proposal', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/lifecycle?persona=governance-admin&scope=global`;
    const asApprover = await (await fetch(`${base}&viewer=local-auditor`)).json();
    const asAuthor = await (await fetch(`${base}&viewer=local-admin`)).json();

    const draftOf = (model) => model.records.find((record) => record.revisionCode === 'revision-0010');
    assert.equal(draftOf(asApprover).availableCommands.includes('approve'), false);
    assert.equal(draftOf(asAuthor).availableCommands.includes('approve'), false);

    // Self-approval cannot bypass the durable-proposal requirement.
    const asOwner = await (await fetch(`${base}&viewer=local-owner`)).json();
    const ownDraft = asOwner.records.find((record) => record.revisionCode === 'revision-0011');
    assert.equal(ownDraft.availableCommands.includes('approve'), false);
    assert.deepEqual(ownDraft.selfApproval, { available: true });

    const denied = await fetch(`${origin}/api/local/lifecycle?persona=end-user&scope=global`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'scope-denied');

    const refused = await fetch(`${base}&revisions=whatever`);
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, 'selection_not_supported');
  });
});

test('the fallback screen separates what was authored from what this caller may take', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/fallback?persona=governance-admin&scope=global`;

    // The fixture entitlement withholds the cheaper model, so the authored hop exists
    // and is refused. That is the case the screen is for.
    const refused = await (await fetch(`${base}&pressure=breach`)).json();
    assert.equal(refused.readModelVersion, 'fallback.v1');
    assert.equal(refused.quality.state, 'complete');
    assert.equal(refused.authored.optedIn, true);
    assert.deepEqual(refused.authored.edges, [{ from: 'coding-primary', to: 'coding-fast' }]);
    // Both fixture models serve both contracts, so every contract must report the
    // same refusal; a contract missing from the answer would hide a route entirely.
    assert.deepEqual(
      refused.compiled.map((entry) => entry.apiFamily).sort(),
      ['anthropic-messages', 'openai-chat-completions', 'openai-responses'],
    );
    for (const entry of refused.compiled) {
      assert.deepEqual(entry.permittedHops, [], entry.apiFamily);
    }
    assert.deepEqual(
      refused.compiled.find((entry) => entry.apiFamily === 'openai-responses').refusedHops,
      [{ from: 'coding-primary', to: 'coding-fast', blockedBy: 'fallback-target-not-entitled' }],
    );
    assert.equal(refused.decision.effective.modelKey, 'coding-primary');
    assert.equal(refused.decision.hops, 0);
    assert.equal(refused.decision.exhausted.blockedBy, 'fallback-target-not-entitled');

    const permitted = await (await fetch(`${base}&pressure=breach&entitlement=both-models`)).json();
    assert.deepEqual(
      permitted.compiled.find((entry) => entry.apiFamily === 'openai-responses').permittedHops,
      [{ from: 'coding-primary', to: 'coding-fast' }],
    );
    // Neither fixture model answers Anthropic Messages, so that route offers no hop
    // rather than borrowing one compiled for a contract it does not speak.
    assert.deepEqual(
      permitted.compiled.find((entry) => entry.apiFamily === 'anthropic-messages').permittedHops,
      [],
    );
    assert.equal(permitted.decision.requested.modelKey, 'coding-primary');
    assert.equal(permitted.decision.effective.modelKey, 'coding-fast');
    assert.equal(permitted.decision.hops, 1);
    assert.equal(permitted.decision.exhausted, null);

    // Below the threshold the same permitted hop is simply not taken.
    const calm = await (await fetch(`${base}&pressure=none&entitlement=both-models`)).json();
    assert.equal(calm.decision.hops, 0);
    assert.equal(calm.decision.triggerKind, 'none');
    assert.equal(calm.decision.effective.modelKey, 'coding-primary');

    // What could be authored next, judged per contract by the rules that will judge
    // it at runtime. The authored hop above is refused for entitlement, so the same
    // target must not be offered as a candidate from that source either.
    const chat = calm.candidates.find((entry) => entry.apiFamily === 'openai-chat-completions');
    assert.ok(chat, 'chat candidates');
    const fromPrimary = chat.bySource.find((entry) => entry.source === 'coding-primary');
    assert.ok(fromPrimary, 'candidates from coding-primary');
    assert.deepEqual(fromPrimary.permitted, ['coding-fast']);
    assert.equal(fromPrimary.permitted.includes('coding-primary'), false);
    for (const entry of fromPrimary.refused) {
      assert.equal(typeof entry.blockedBy, 'string', entry.modelKey);
    }

    const serialized = JSON.stringify(refused);
    for (const forbidden of ['subjectId', 'applicationId', 'prompt', 'completion', 'providerKey']) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
    }
  });
});

test('fallback visibility is authorized server-side and refuses an unsupported selection', async () => {
  await withServer(async (origin) => {
    const denied = await fetch(`${origin}/api/local/fallback?persona=end-user&scope=global`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'scope-denied');

    const wrongTeam = await fetch(
      `${origin}/api/local/fallback?persona=governance-admin&scope=team&team=not-authorized`,
    );
    assert.equal(wrongTeam.status, 403);
    assert.equal((await wrongTeam.json()).error.code, 'team-scope-denied');

    const refused = await fetch(`${origin}/api/local/fallback?persona=governance-admin&pressure=sometimes`);
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error.code, 'selection_not_supported');
  });
});

test('serves a model catalogue joined to the traffic the reader may see', async () => {
  await withServer(async (origin) => {
    const readModel = await (
      await fetch(`${origin}/api/local/models?persona=governance-admin&scope=global`)
    ).json();

    assert.equal(readModel.readModelVersion, 'models.v1');
    assert.equal(readModel.registry.state, 'complete');
    assert.deepEqual(readModel.records.map((row) => row.modelKey), ['coding-fast', 'coding-primary']);

    const primary = readModel.records.find((row) => row.modelKey === 'coding-primary');
    assert.equal(primary.registrationState, 'registered');
    assert.equal(primary.lifecycle, 'generally-available');
    assert.ok(primary.consumption.requests > 0);
    // Internal limits differ by entitlement, so the row states a range and its span.
    assert.ok(primary.internalLimits.grantingBindings > 1);
    assert.ok(primary.internalLimits.requestsPerMinute.max > primary.internalLimits.requestsPerMinute.min);
    // The provider allocation is read, not assumed. This one is fully deployed,
    // which means no room for another deployment, not that tokens ran out.
    assert.equal(readModel.quality.providerQuotaState, 'complete');
    assert.equal(primary.providerQuota.source, 'provider-deployment');
    assert.equal(primary.providerQuota.deploymentName, 'deploy-coding-primary');
    assert.equal(primary.providerQuota.tokensPerMinute, 1_000_000);
    assert.equal(primary.providerQuota.pool.fullyAllocated, true);
    assert.equal(primary.providerQuota.pool.allocatable, 0);
    // Allocation and usage are separate numbers on the same row.
    assert.ok(primary.consumption.totalTokens < primary.providerQuota.pool.allocated * 1_000);

    const fast = readModel.records.find((row) => row.modelKey === 'coding-fast');
    assert.equal(fast.providerQuota.pool.allocatable, 2_950);

    const unread = await (
      await fetch(`${origin}/api/local/models?persona=governance-admin&scope=global&quota=unavailable`)
    ).json();
    assert.equal(unread.quality.providerQuotaState, 'unavailable');
    for (const row of unread.records) {
      assert.equal(row.providerQuota.pool, null);
      assert.equal(row.providerQuota.reasonCode, 'quota-snapshot-unavailable');
    }

    const serialized = JSON.stringify(readModel);
    for (const forbidden of ['subjectId', 'applicationId', 'prompt', 'completion', 'backendUrl']) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
    }
  });
});

test('the model catalogue is scope-filtered and refuses an unpermitted reader', async () => {
  await withServer(async (origin) => {
    const global = await (
      await fetch(`${origin}/api/local/models?persona=governance-admin&scope=global`)
    ).json();
    const team = await (
      await fetch(`${origin}/api/local/models?persona=governance-admin&scope=team&team=developer-experience`)
    ).json();

    const requestsFor = (model, key) =>
      model.records.find((row) => row.modelKey === key)?.consumption?.requests ?? 0;
    assert.ok(requestsFor(team, 'coding-fast') < requestsFor(global, 'coding-fast'));
    // A model nobody on that team used is still catalogued, with absent consumption.
    assert.equal(team.records.find((row) => row.modelKey === 'coding-primary').consumption, null);

    const denied = await fetch(`${origin}/api/local/models?persona=end-user&scope=global`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'scope-denied');

    const degraded = await (
      await fetch(`${origin}/api/local/models?persona=governance-admin&scope=global&fixture=degraded`)
    ).json();
    assert.equal(degraded.quality.countsMeasured, false);
    assert.ok(degraded.records.every((row) => row.consumption === null));
  });
});

test('every screen can be read in each state it declares, and refuses the ones it does not', async () => {
  await withServer(async (origin) => {
    // What each screen says it can be. A records screen has no partly observed window
    // to be in, and a screen that reads a ledger can fail to reach it, which is not
    // the same answer as the ledger being empty.
    const declared = {
      budgets: ['complete', 'stale', 'partial', 'empty'],
      fallback: ['complete', 'empty'],
      lifecycle: ['complete', 'empty'],
      notifications: ['complete', 'empty', 'degraded'],
      audit: ['complete', 'empty'],
    };
    const undeclared = {
      budgets: ['degraded', 'ambiguous'],
      fallback: ['stale', 'partial', 'degraded'],
      lifecycle: ['stale', 'partial', 'degraded'],
      notifications: ['stale', 'partial'],
      audit: ['stale', 'partial', 'degraded'],
    };

    for (const [screen, states] of Object.entries(declared)) {
      for (const fixture of states) {
        const response = await fetch(`${origin}/api/local/${screen}?fixture=${fixture}`);
        assert.equal(response.status, 200, `${screen} ${fixture}`);
      }
      assert.equal((await fetch(`${origin}/api/local/${screen}?fixture=denied`)).status, 403, screen);
      assert.equal((await fetch(`${origin}/api/local/${screen}?fixture=error`)).status, 503, screen);
      for (const fixture of undeclared[screen]) {
        const refused = await fetch(`${origin}/api/local/${screen}?fixture=${fixture}`);
        assert.equal(refused.status, 400, `${screen} ${fixture}`);
        assert.equal((await refused.json()).error.code, 'selection_not_supported');
      }
    }
  });
});

test('outstanding work is closed to a caller with no governance scope', async () => {
  await withServer(async (origin) => {
    const denied = await fetch(`${origin}/api/local/notifications?persona=end-user&scope=global`);
    assert.equal(denied.status, 403);
    const payload = await denied.json();
    assert.equal('records' in payload, false);
    assert.equal('summary' in payload, false);
  });
});

test('an empty screen says nothing is there, and never says it by publishing nothing', async () => {
  await withServer(async (origin) => {
    const budgets = await (await fetch(`${origin}/api/local/budgets?fixture=empty`)).json();
    assert.deepEqual(budgets.records, []);
    // No budget configured is not the same as the publication being unreadable.
    assert.equal(budgets.quality.state, 'complete');

    const fallback = await (await fetch(`${origin}/api/local/fallback?fixture=empty`)).json();
    assert.equal(fallback.authored, null);
    assert.equal(fallback.quality.state, 'no-plan');

    const lifecycle = await (await fetch(`${origin}/api/local/lifecycle?fixture=empty`)).json();
    assert.deepEqual(lifecycle.records, []);

    const audit = await (await fetch(`${origin}/api/local/audit?fixture=empty`)).json();
    assert.deepEqual(audit.records, []);
    // Nothing recorded is a complete reading of nothing, not a narrowed one.
    assert.equal(audit.quality.state, 'complete');

    // A ledger with nothing outstanding still answers; one that cannot be read does
    // not, and a zero in its place would read as nothing outstanding.
    const quiet = await (await fetch(`${origin}/api/local/notifications?fixture=empty`)).json();
    assert.notEqual(quiet.summary, null);
    const unreadable = await (await fetch(`${origin}/api/local/notifications?fixture=degraded`)).json();
    assert.equal(unreadable.summary, null);
  });
});

test('a budget period states how late it is, and withholds what a gap would falsify', async () => {
  await withServer(async (origin) => {
    const complete = await (await fetch(`${origin}/api/local/budgets?fixture=complete`)).json();
    assert.equal(complete.quality.freshnessState, 'fresh');

    const stale = await (await fetch(`${origin}/api/local/budgets?fixture=stale`)).json();
    assert.equal(stale.quality.freshnessState, 'stale');
    assert.ok(stale.freshness.lagSeconds > complete.freshness.lagSeconds);
    // Late is not incomplete: the same budgets are still reported.
    assert.equal(stale.records.length, complete.records.length);

    const partial = await (await fetch(`${origin}/api/local/budgets?fixture=partial`)).json();
    const withGap = partial.records.find((record) => record.consumption?.state === 'partial');
    assert.ok(withGap, 'a withheld window must show as a partial period');
    assert.equal(withGap.consumption.reasonCode, 'window-missing');
    // A remainder computed from a total that is lower than the truth is room the
    // organization does not have.
    assert.equal(withGap.consumption.remainingTokens, null);
  });
});

test('the applications view lists what policy names, and is not offered at self scope', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/users-groups?persona=governance-admin&view=applications`;
    const global = await fetch(`${base}&scope=global`);
    assert.equal(global.status, 200);
    const model = await global.json();
    assert.ok(model.records.length > 0, 'an application named by policy must be listed');
    for (const record of model.records) {
      assert.equal(record.entityKind, 'application');
      // An application has no members, so it claims no relation counts and no
      // directory resolution it never had.
      assert.equal(record.directRelationCount, 0);
      assert.equal(record.resolutionState, 'incomplete');
      assert.ok(record.policyInspection.effective.decisionCode.length > 0);
    }
    assert.equal(model.summary.visibleApplications, model.records.length);

    // Nobody's own applications exist, so an empty table would read as an
    // organization with none at all.
    const self = await fetch(`${base}&scope=self&persona=end-user`);
    assert.equal(self.status, 403);
    assert.equal((await self.json()).error.code, 'view-not-permitted-for-scope');
  });
});

test('a governance edit becomes a proposal, whichever part of the set it changes', async () => {
  await withServer(async (origin) => {
    const propose = async (path, body) => {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'local-admin', ...body }),
      });
      return { status: response.status, payload: await response.json() };
    };

    const entitlement = await propose('/api/local/entitlements/propose', {
      bindingId: 'binding-global-local-001',
      changes: { modelAllowlist: ['coding-fast', 'coding-primary'] },
    });
    assert.equal(entitlement.status, 201);
    assert.equal(entitlement.payload.state, 'draft');

    const retirement = await propose('/api/local/entitlements/propose', {
      bindingId: 'binding-application-local-agent-001',
      changes: { state: 'revoked' },
    });
    assert.equal(retirement.status, 201);
    assert.equal(retirement.payload.state, 'draft');

    const grant = await propose('/api/local/assignments/propose', {
      command: 'grant',
      assignmentId: 'assignment-aaa-team-admin-001',
      roleCode: 'team-admin',
      assignee: { kind: 'group', key: 'group-end-user' },
      scope: { kind: 'team', key: 'developer-experience' },
      reasonCode: 'delegated-team-administration',
    });
    assert.equal(grant.status, 201);

    const revoke = await propose('/api/local/assignments/propose', {
      command: 'revoke',
      assignmentId: 'assignment-auditor-local-001',
      reasonCode: 'left-the-organization',
    });
    assert.equal(revoke.status, 201);

    // Every proposal is a revision on the one write path, so they are numbered in the
    // same sequence a budget edit uses rather than in a series of their own.
    const numbers = [entitlement, retirement, grant, revoke].map((result) => result.payload.revisionNumber);
    assert.deepEqual(numbers, [...numbers].sort((left, right) => left - right));
    assert.equal(new Set(numbers).size, numbers.length);

    // A refused edit is the operator's answer and carries its reason, not a fault.
    const refused = await propose('/api/local/entitlements/propose', {
      bindingId: 'binding-global-local-001',
      changes: { modelAllowlist: ['coding-imaginary'] },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.payload.reasonCode, 'entitlement-edit-model-unregistered');

    const unattributed = await fetch(`${origin}/api/local/assignments/propose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'revoke', assignmentId: 'assignment-auditor-local-001', reasonCode: 'x' }),
    });
    assert.equal(unattributed.status, 400);

    // Reading governance globally is not authority to change it. An auditor sees every
    // scope and may change nothing.
    const auditor = await fetch(`${origin}/api/local/entitlements/propose?persona=auditor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'local-auditor',
        bindingId: 'binding-global-local-001',
        changes: { modelAllowlist: ['coding-primary'] },
      }),
    });
    assert.equal(auditor.status, 403);
    assert.equal((await auditor.json()).reasonCode, 'not-a-governance-author');

    // And the panel that offers the change is not offered to them either.
    assert.equal((await fetch(`${origin}/api/local/access-options?persona=auditor`)).status, 403);
    const options = await fetch(`${origin}/api/local/access-options?persona=governance-admin`);
    assert.equal(options.status, 200);
    const payload = await options.json();
    assert.ok(payload.bindings.some((binding) => binding.targetKind === 'application'));
    assert.ok(payload.bindings.every((binding) => typeof binding.limits === 'object'));
    assert.ok(payload.bindings.every((binding) => binding.state === 'active'));
    assert.ok(payload.bindings.every((binding) => binding.canRestore === false));
    assert.ok(payload.assignmentGrantRules.some((rule) => rule.roleCode === 'platform-operator'));
    assert.ok(payload.revocationReasonCodes.length > 0);
    assert.deepEqual(payload.budgetOptions, {
      throttleTierCodes: ['tier-reduced', 'tier-minimal'],
    });
  });
});

test('a cap can be added and taken away, and two caps may not cover the same traffic', async () => {
  await withServer(async (origin) => {
    const propose = async (path, body) => {
      const response = await fetch(`${origin}${path}?persona=governance-admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: 'local-admin', ...body }),
      });
      return { status: response.status, payload: await response.json() };
    };

    const budget = {
      budgetId: 'budget-added-by-test-001',
      scope: 'team',
      action: 'HARD_BLOCK',
      modelScope: 'all-models',
      accountingBasis: 'apim-estimated-total-tokens',
      limit: { unit: 'tokens', currency: null, amount: 120_000 },
      period: 'Monthly',
      thresholds: {},
    };

    const added = await propose('/api/local/budgets/propose', { command: 'add', budget });
    assert.equal(added.status, 201);
    assert.equal(added.payload.state, 'draft');

    const softWarning = await propose('/api/local/budgets/propose', {
      command: 'add',
      budget: {
        ...budget,
        budgetId: 'budget-soft-warning-by-test-001',
        scope: 'application',
        action: 'SOFT_WARNING',
        thresholds: { graceBasisPoints: 1000 },
      },
    });
    assert.equal(softWarning.status, 201);
    assert.equal(softWarning.payload.state, 'draft');

    const edited = await propose('/api/local/budgets/propose', {
      command: 'edit',
      budgetId: 'budget-organization-monthly',
      changes: {
        amount: 30_000_000,
        action: 'THROTTLE',
        thresholds: { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-reduced' }] },
        modelScope: 'per-model',
        modelKey: 'coding-primary',
        period: 'Daily',
        accountingBasis: 'apim-estimated-total-tokens',
      },
    });
    assert.equal(edited.status, 201);
    assert.equal(edited.payload.state, 'draft');
    assert.ok(edited.payload.revisionId);

    const unsupportedTier = await propose('/api/local/budgets/propose', {
      command: 'edit',
      budgetId: 'budget-organization-monthly',
      changes: {
        action: 'THROTTLE',
        thresholds: { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-not-deployed' }] },
      },
    });
    assert.equal(unsupportedTier.status, 409);
    assert.equal(unsupportedTier.payload.reasonCode, 'budget-edit-result-invalid');

    // A second cap over the same scope, model, and period would both be enforced and
    // the tighter would silently win, so it is refused rather than accepted. The
    // comparison is against what is published, because that is what a proposal branches
    // from; two drafts that collide are settled by the revision conflict at approval.
    const overlapping = await propose('/api/local/budgets/propose', {
      command: 'add',
      budget: { ...budget, budgetId: 'budget-added-by-test-002', scope: 'organization' },
    });
    assert.equal(overlapping.status, 409);
    assert.equal(overlapping.payload.reasonCode, 'budget-edit-duplicate-coverage');

    const reusedId = await propose('/api/local/budgets/propose', {
      command: 'add',
      budget: { ...budget, budgetId: 'budget-organization-monthly' },
    });
    assert.equal(reusedId.status, 409);
    assert.equal(reusedId.payload.reasonCode, 'budget-edit-duplicate-budget');

    // Taking a cap away is an act an auditor has to be able to account for later.
    const removed = await propose('/api/local/budgets/propose', {
      command: 'remove',
      budgetId: 'budget-organization-monthly',
      reasonCode: 'replaced-by-team-caps',
    });
    assert.equal(removed.status, 201);

    const unexplained = await propose('/api/local/budgets/propose', {
      command: 'remove',
      budgetId: 'budget-organization-monthly',
    });
    assert.equal(unexplained.status, 409);
    assert.equal(unexplained.payload.reasonCode, 'budget-edit-reason-required');

    // Writing the ladder and putting callers on it are separate decisions, so both are
    // on the one write path and neither takes effect before it is published.
    const plan = await propose('/api/local/fallback/propose', {
      planId: 'plan-global-cheaper-alternative-001',
      changes: { edges: [{ from: 'coding-fast', to: 'coding-primary' }] },
    });
    assert.equal(plan.status, 201);

    const invalidGraph = await propose('/api/local/fallback/propose', {
      planId: 'plan-global-cheaper-alternative-001',
      changes: {
        edges: [
          { from: 'coding-fast', to: 'coding-primary' },
          { from: 'coding-primary', to: 'coding-fast' },
        ],
      },
    });
    assert.equal(invalidGraph.status, 409);
    assert.equal(invalidGraph.payload.reasonCode, 'fallback-edit-result-invalid');

    // A notice in the answer body describes a substitution the caller was not routed
    // through unless the ladder is the one that serves them.
    const inconsistent = await propose('/api/local/fallback/propose', {
      planId: 'plan-global-cheaper-alternative-001',
      changes: { modelSelectionIntent: 'pinned', substitutionNotice: 'inline' },
    });
    assert.equal(inconsistent.status, 409);
    assert.equal(inconsistent.payload.reasonCode, 'fallback-edit-notice-requires-preferred');

    const auditor = await fetch(`${origin}/api/local/fallback/propose?persona=auditor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'local-auditor',
        planId: 'plan-global-cheaper-alternative-001',
        changes: { enabled: false },
      }),
    });
    assert.equal(auditor.status, 403);
  });
});

test('a published per-model soft warning reads back its authored non-round grace', async () => {
  const baseSource = createLocalGovernanceSource({ evaluationTime: '2026-07-24T10:00:00.000Z' });
  await withServer(async (origin) => {
    const proposed = await fetch(`${origin}/api/local/budgets/propose?persona=governance-admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'local-admin',
        command: 'edit',
        budgetId: 'budget-organization-monthly',
        changes: {
          modelScope: 'per-model',
          modelKey: 'coding-primary',
          thresholds: { graceBasisPoints: 333 },
        },
      }),
    });
    assert.equal(proposed.status, 201);
    const proposal = await proposed.json();

    const held = await (
      await fetch(`${origin}/api/local/lifecycle/revision?revisionId=${proposal.revisionId}`)
    ).json();
    const approved = await fetch(`${origin}/api/local/lifecycle/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revisionId: held.revisionId,
        etag: held.etag,
        expectedRevisionNumber: held.revisionNumber,
        loaded: held.revision,
        command: 'approve',
        actor: 'local-auditor',
      }),
    });
    assert.equal(approved.status, 200);

    const published = await fetch(`${origin}/api/local/lifecycle/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revisionId: proposal.revisionId, actor: 'local-auditor' }),
    });
    assert.equal(published.status, 200, JSON.stringify(await published.json()));

    const readBack = await (
      await fetch(`${origin}/api/local/budgets?persona=governance-admin&scope=global`)
    ).json();
    const record = readBack.records.find((entry) => entry.budgetCode === 'budget-organization-monthly');
    assert.equal(record.modelScope, 'per-model');
    assert.equal(record.modelKey, 'coding-primary');
    assert.deepEqual(record.thresholds, { graceBasisPoints: 333 });
    assert.equal(record.consumption.state, 'partial');
    assert.ok(record.consumption.consumedTokens > 0);
  }, { ...baseSource, readConfigurationRevisions: async () => [] });
});

test('the model catalogue offers only the states it can actually be read in', async () => {
  await withServer(async (origin) => {
    const base = `${origin}/api/local/models?persona=governance-admin&scope=global`;

    const complete = await (await fetch(`${base}&fixture=complete`)).json();
    assert.equal(complete.quality.freshnessState, 'fresh');
    assert.ok(complete.records.length > 0);

    const stale = await (await fetch(`${base}&fixture=stale`)).json();
    assert.equal(stale.quality.freshnessState, 'stale');
    assert.ok(stale.window.lagSeconds > complete.window.lagSeconds);
    // The catalogue is what is published, not what was used, so a late reading still
    // lists every model.
    assert.equal(stale.records.length, complete.records.length);

    const degraded = await (await fetch(`${base}&fixture=degraded`)).json();
    assert.equal(degraded.quality.countsMeasured, false);
    assert.ok(degraded.records.every((record) => record.consumption === null));
    assert.ok(degraded.records.length > 0);

    assert.equal((await fetch(`${base}&fixture=denied`)).status, 403);
    assert.equal((await fetch(`${base}&fixture=error`)).status, 503);
    // An empty catalogue is not a state this screen has: emptiness here would be the
    // catalogue being unavailable, which it reports separately. A source that cannot
    // produce a state says so rather than answering with a different one.
    assert.equal((await fetch(`${base}&fixture=empty`)).status, 400);
  });
});

test('Users & Groups exposes complete degraded states without domain-data leakage', async () => {
  await withServer(async (origin) => {
    for (const fixture of ['complete', 'stale', 'partial', 'empty']) {
      const response = await fetch(`${origin}/api/local/users-groups?fixture=${fixture}`);
      assert.equal(response.status, 200, fixture);
      const readModel = await response.json();
      assert.equal(readModel.selection.fixture, fixture);
    }

    const ambiguous = await fetch(`${origin}/api/local/users-groups?fixture=ambiguous`);
    assert.equal(ambiguous.status, 403);
    const ambiguousPayload = await ambiguous.json();
    assert.equal(ambiguousPayload.error.code, 'membership-not-authoritative');
    assert.equal(ambiguousPayload.error.reasonCode, 'membership-evidence-ambiguous');
    assert.equal('records' in ambiguousPayload, false);
    assert.equal('summary' in ambiguousPayload, false);

    assert.equal((await fetch(`${origin}/api/local/users-groups?fixture=denied`)).status, 403);
    assert.equal((await fetch(`${origin}/api/local/users-groups?fixture=error`)).status, 503);
    assert.equal((await fetch(`${origin}/api/local/users-groups?view=orchestras`)).status, 400);
    assert.equal((await fetch(`${origin}/api/local/users-groups`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${origin}/api/local/users-groups/update`, { method: 'PUT' })).status, 405);
  });
});
test('the rollup-backed overview is served over the same contract as the fixtures', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/local/overview?source=rollup&persona=governance-admin&scope=global&range=24h`);
    assert.equal(response.status, 200);

    const readModel = await response.json();
    assert.equal(readModel.readModelVersion, 'overview.v2');
    assert.equal(readModel.selection.fixture, 'gateway-usage-rollup');
    assert.ok(readModel.metrics.find((metric) => metric.id === 'requests').value > 0);
    // What the rollups cannot measure must stay absent all the way to the wire.
    assert.equal(readModel.metrics.find((metric) => metric.id === 'latency').value, null);
    // Local development is the fixture reality, so the configuration chip keeps
    // reporting the deterministic local value rather than reading a store.
    assert.deepEqual(readModel.configuration, {
      activeVersion: 'cfg-local-003',
      state: 'active',
      publishedAt: '2026-07-24T09:30:00.000Z',
    });

    const serialized = JSON.stringify(readModel);
    for (const forbidden of ['prompt', 'completion', 'subjectId', 'memberships', 'requestBody']) {
      assert.equal(serialized.includes(`"${forbidden}"`), false);
    }
  });
});

test('an unsupported overview source is refused rather than silently defaulted', async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/local/overview?source=whatever&persona=governance-admin`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'source_not_supported');
  });
});

test('rollup-backed team scope is still authorized server-side', async () => {
  await withServer(async (origin) => {
    const denied = await fetch(`${origin}/api/local/overview?source=rollup&persona=end-user&scope=global`);
    assert.equal(denied.status, 403);

    const wrongTeam = await fetch(`${origin}/api/local/overview?source=rollup&persona=auditor&scope=team&team=no-such-team`);
    assert.equal(wrongTeam.status, 403);
  });
});
