import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { buildFallbackAddPayload, buildFallbackEditPayload, MAX_FALLBACK_EDGES } from '../../app/admin-ui/public/governance-authoring.mjs';
import { translate } from '../../app/admin-ui/public/i18n.mjs';
import { createLocalAdminServer } from '../../app/control-api/local-admin-server.mjs';
import { createLocalGovernanceSource } from '../../app/control-api/local-governance-source.mjs';

class Element {
  children = [];
  dataset = {};
  listeners = {};
  value = '';
  hidden = false;
  disabled = false;
  textContent = '';
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
  focus() {}
}

async function ui({ locale = 'en', mode = 'deployed', available = true } = {}) {
  const script = await readFile(new URL('../../app/admin-ui/public/app.mjs', import.meta.url), 'utf8');
  const authoring = script.slice(script.indexOf('\nfunction renderFallbackAuthoring('), script.indexOf('\nfunction renderLifecycleQuality('));
  const submission = script.slice(script.indexOf('\nasync function proposeAccessChange('), script.indexOf('\nfunction removalErrorMessage('));
  const identifiers = script.slice(script.indexOf('\nfunction identifierValues('), script.indexOf('\n/** Bringing a person,'));
  const elements = Object.fromEntries([
    'fallbackEdit', 'fallbackEditTitle', 'fallbackEditHelp', 'fallbackEditMode', 'fallbackAddFields',
    'fallbackAddId', 'fallbackAddKind', 'fallbackAddKey', 'fallbackAddKeyLabel', 'fallbackAddKeyOptions',
    'fallbackEditEnabled', 'fallbackEditIntent', 'fallbackEditNotice', 'fallbackEditEdgeList',
    'fallbackEditAddEdge', 'fallbackEditError', 'fallbackEditActions', 'persona',
  ].map((name) => [name, new Element()]));
  elements.persona.value = 'governance-admin';
  const calls = [];
  const context = {
    elements, buildFallbackAddPayload, buildFallbackEditPayload, MAX_FALLBACK_EDGES,
    accessOptions: {
      models: ['coding-primary', 'coding-secondary'], teams: [{ teamCode: 'team-one' }],
      identifierEvidence: { knownAuthorizedValues: [{ identifierKind: 'application-client-id', value: 'client-one' }] },
    },
    refreshAuthoringAuthority: async () => ({ current: true, available }),
    createElement: (_tag, _class, textContent) => Object.assign(new Element(), { textContent }),
    document: { createElement: () => new Element() },
    fillOptions: (element, options, selected = []) => {
      element.options = options;
      element.value = selected[0] ?? options[0]?.[0] ?? '';
    },
    t: (key, values) => translate(locale, key, values),
    authoringText: (key) => translate(locale, key),
    showGovernanceValidation: (result, target) => { target.textContent = translate(locale, `governanceValidation.${result.error}`); },
    session: { mode, getAuthorizationHeader: async () => ({}) },
    api: { baseUrl: '', fallbackWritePath: '/fallback' },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 201, json: async () => ({ state: 'draft', revisionId: 'revision-0005' }) };
    },
  };
  runInNewContext(`${identifiers}\n${authoring}\n${submission}\nglobalThis.render = renderFallbackAuthoring;`, context);
  return { elements, calls, context };
}

test('the actual empty-plan form creates a pinned/header draft with the returned revision ID in EN/KO and both modes', async () => {
  for (const mode of ['local', 'deployed']) {
    for (const locale of ['en', 'ko']) {
      const { elements, calls, context } = await ui({ mode, locale });
      context.render({ authored: null, selection: { scope: 'global' } });
      await Promise.resolve();
      assert.equal(elements.fallbackEdit.hidden, false);
      assert.equal(elements.fallbackAddFields.hidden, false);
      assert.equal(elements.fallbackEditEnabled.value, 'false');
      assert.equal(elements.fallbackEditIntent.value, 'pinned');
      assert.equal(elements.fallbackEditNotice.value, 'header');
      assert.equal(elements.fallbackAddKey.hidden, true);
      elements.fallbackAddId.value = 'plan-global-new';
      elements.fallbackEditAddEdge.onclick();
      const row = elements.fallbackEditEdgeList.children[0];
      const from = row.children[0].children[1];
      const to = row.children[1].children[1];
      from.value = 'coding-secondary';
      from.listeners.change();
      to.value = 'coding-primary';
      to.listeners.change();
      elements.fallbackEditActions.children[0].listeners.click();
      await new Promise(setImmediate);
      assert.deepEqual(calls, [{
        url: mode === 'local' ? '/fallback?persona=governance-admin' : '/fallback',
        body: {
          command: 'add',
          plan: {
            planId: 'plan-global-new', target: { kind: 'global', key: null },
            enabled: false, modelSelectionIntent: 'pinned', substitutionNotice: 'header',
            edges: [{ from: 'coding-secondary', to: 'coding-primary' }],
          },
          ...(mode === 'local' ? { actor: 'local-admin' } : {}),
        },
      }]);
      assert.equal(elements.fallbackEditError.textContent, translate(locale, 'accessEdit.proposed', { revision: 'revision-0005' }));
    }
  }
});

test('existing plan editing preserves its settings and creation uses the existing identifier assistance', async () => {
  const { elements, context } = await ui();
  const authored = {
    planCode: 'plan-existing', optedIn: true, modelSelectionIntent: 'preferred',
    substitutionNotice: 'inline', edges: [{ from: 'coding-secondary', to: 'coding-primary' }],
  };
  context.render({ authored, selection: { scope: 'team', teamKey: 'team-one' } });
  await Promise.resolve();
  assert.equal(elements.fallbackAddFields.hidden, true);
  assert.equal(elements.fallbackEditEnabled.value, 'true');
  assert.equal(elements.fallbackEditIntent.value, 'preferred');
  assert.equal(elements.fallbackEditNotice.value, 'inline');
  elements.fallbackEditMode.value = 'add';
  elements.fallbackEditMode.onchange();
  assert.equal(elements.fallbackAddKind.value, 'team');
  assert.equal(elements.fallbackAddKey.value, 'team-one');
  assert.equal(elements.fallbackAddKeyOptions.children[0].value, 'team-one');
  elements.fallbackAddKind.value = 'application';
  elements.fallbackAddKind.onchange();
  assert.equal(elements.fallbackAddKeyOptions.children[0].value, 'client-one');
  elements.fallbackEditMode.value = 'edit';
  elements.fallbackEditMode.onchange();
  assert.equal(elements.fallbackEditNotice.value, 'inline');
});

test('the no-plan screen does not offer creation to a reader', async () => {
  const { elements, calls, context } = await ui({ available: false });
  context.render({ authored: null, selection: { scope: 'global' } });
  await Promise.resolve();
  assert.equal(elements.fallbackEdit.hidden, true);
  assert.deepEqual(calls, []);
});

test('local API creation from an empty fallback snapshot stays inactive until explicit self-publication', async () => {
  const base = createLocalGovernanceSource({ evaluationTime: '2026-07-24T10:00:00.000Z' });
  const snapshots = structuredClone(await base.readGovernanceSnapshots());
  snapshots.fallbackPolicySnapshot.plans = [];
  const server = createLocalAdminServer({ source: {
    ...base, readGovernanceSnapshots: async () => snapshots, readConfigurationRevisions: async () => [],
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body) => fetch(`${origin}/api/local/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const screen = async () => (await (await fetch(`${origin}/api/local/fallback?scope=global`)).json());
    assert.equal((await screen()).authored, null);
    const body = {
      actor: 'local-admin', command: 'add',
      plan: { planId: 'new-global', target: { kind: 'global', key: null }, edges: [{ from: 'coding-fast', to: 'coding-primary' }] },
    };
    assert.equal((await post('fallback/propose?persona=auditor', body)).status, 403);
    for (const invalid of [
      { ...body, plan: undefined }, { ...body, plan: null }, { ...body, plan: [] },
      { ...body, command: 'unsupported' },
    ]) {
      const refused = await post('fallback/propose', invalid);
      assert.equal(refused.status, 400);
      assert.equal((await refused.json()).reasonCode,
        invalid.command === 'unsupported' ? 'fallback_command_unsupported' : 'plan_required');
    }
    const response = await post('fallback/propose', body);
    assert.equal(response.status, 201);
    const proposed = await response.json();
    assert.equal(proposed.state, 'draft');
    assert.equal((await screen()).authored, null);
    const published = await post('lifecycle/publish', { revisionId: proposed.revisionId, actor: 'local-admin' });
    assert.equal(published.status, 200);
    assert.ok((await published.json()).targets.every((target) => target.outcome === 'verified'));
    assert.equal((await screen()).authored.planCode, 'new-global');
    assert.equal((await screen()).authored.optedIn, false);
    const duplicate = await post('fallback/propose', body);
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).reasonCode, 'fallback-add-plan-exists');
    const conflicting = await post('fallback/propose', { ...body, plan: { ...body.plan, planId: 'another-global' } });
    assert.equal(conflicting.status, 409);
    assert.equal((await conflicting.json()).reasonCode, 'fallback-add-target-already-governed');
    assert.equal((await screen()).authored.planCode, 'new-global');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
