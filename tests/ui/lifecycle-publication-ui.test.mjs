import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { translate } from '../../app/admin-ui/public/i18n.mjs';

const script = await readFile(new URL('../../app/admin-ui/public/app.mjs', import.meta.url), 'utf8');

test('the budget edit success message uses the saved revision ID, not the requested token amount', async () => {
  const budgetStart = script.indexOf('\nasync function proposeBudgetChange(');
  const budgetCode = script.slice(budgetStart, script.indexOf('\n/**', budgetStart));
  const accessCode = script.slice(script.indexOf('\nasync function proposeAccessChange('), script.indexOf('\nfunction removalErrorMessage('));
  for (const mode of ['local', 'deployed']) {
    for (const locale of ['en', 'ko']) {
      const calls = [];
      let actionsCleared = 0;
      const elements = {
        persona: { value: 'governance-admin' },
        budgetEditError: { textContent: '' },
        budgetEditSubject: { textContent: '' },
        budgetEditActions: { replaceChildren: () => { actionsCleared += 1; } },
        budgetEditAmount: { disabled: false },
      };
      const context = {
        elements,
        api: { baseUrl: '', budgetsWritePath: '/budgets' },
        session: { mode, getAuthorizationHeader: async () => ({}) },
        t: (key, args) => translate(locale, key, args),
        formatNumber: (value) => new Intl.NumberFormat(locale).format(value),
        fetch: async (url, options) => {
          calls.push({ url, body: JSON.parse(options.body) });
          return { ok: true, status: 201, json: async () => ({ state: 'draft', revisionId: 'revision-0005' }) };
        },
      };
      runInNewContext(`${budgetCode}\n${accessCode}\nglobalThis.saveBudget = proposeBudgetChange;`, context);
      const payload = { command: 'edit', budgetId: 'budget-organization-monthly', changes: { amount: 1 } };
      await context.saveBudget(payload);
      assert.deepEqual(calls, [{
        url: mode === 'local' ? '/budgets?persona=governance-admin' : '/budgets',
        body: mode === 'local' ? { ...payload, actor: 'local-admin' } : payload,
      }]);
      assert.match(elements.budgetEditSubject.textContent, /revision-0005/);
      assert.doesNotMatch(elements.budgetEditSubject.textContent, /(?:Draft|초안) 1\b/);
      assert.equal(elements.budgetEditSubject.textContent, translate(locale, 'budgetEdit.proposed', { revision: 'revision-0005' }));
      assert.equal(elements.budgetEditError.textContent, '');
      assert.equal(elements.budgetEditAmount.disabled, true);
      assert.equal(actionsCleared, 1);
    }
  }
});

test('ordinary UI saves accept 201 drafts without sending an approval or publication request', async () => {
  const code = script.slice(script.indexOf('\nasync function proposeAccessChange('), script.indexOf('\nfunction removalErrorMessage('));
  for (const mode of ['local', 'deployed']) {
    for (const locale of ['en', 'ko']) {
      const calls = [];
      const target = { textContent: '' };
      const context = {
        elements: { accessEditError: target, persona: { value: 'governance-admin' } },
        api: { baseUrl: '', budgetsWritePath: '/budgets' },
        session: { mode, getAuthorizationHeader: async () => ({}) },
        t: (key, args) => translate(locale, key, args),
        fetch: async (url, options) => {
          calls.push({ url, body: JSON.parse(options.body) });
          return { ok: true, status: 201, json: async () => ({ state: 'draft', revisionId: 'revision-0002' }) };
        },
      };
      runInNewContext(`${code}\nglobalThis.save = proposeAccessChange;`, context);
      const body = { command: 'edit', budgetId: 'budget-organization-monthly', changes: { amount: 30_000_000 } };
      await context.save('budgetsWritePath', body);
      assert.deepEqual(calls, [{
        url: mode === 'local' ? '/budgets?persona=governance-admin' : '/budgets',
        body: mode === 'local' ? { ...body, actor: 'local-admin' } : body,
      }]);
      assert.equal(target.textContent, translate(locale, 'accessEdit.proposed', { revision: 'revision-0002' }));
    }
  }
});

test('the explicit deployed approval action sends only the immutable stored-proposal resume', async () => {
  const code = script.slice(script.indexOf('\nasync function resumeStoredProposal('), script.indexOf('\nfunction hideConflict('));
  const calls = [];
  let reloads = 0;
  const context = {
    api: { baseUrl: '', governancePublishPath: '/v1/admin/governance/publish' },
    session: { getAuthorizationHeader: async () => ({ authorization: 'test-token' }) },
    hideConflict: () => {},
    loadCurrentScreen: async () => { reloads += 1; },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: { ...options.headers } });
      return { ok: true, json: async () => ({ state: 'active' }) };
    },
  };
  runInNewContext(`${code}\nglobalThis.approve = resumeStoredProposal;`, context);
  assert.deepEqual(calls, []);
  await context.approve('revision-0002', false);
  assert.deepEqual(calls[0], {
    url: '/v1/admin/governance/publish',
    body: { resume: true, revisionId: 'revision-0002' },
    headers: { 'content-type': 'application/json', authorization: 'test-token' },
  });
  assert.equal(reloads, 1);
});

test('the local approval button publishes the held proposal using its displayed ETag and admin actor', async () => {
  const code = script.slice(script.indexOf('\nasync function saveRevision('), script.indexOf('\nfunction renderLifecycle('));
  const calls = [];
  let reloads = 0;
  const context = {
    held: new Map([['revision-0002', { etag: '"2"', revisionNumber: 2 }]]),
    elements: { persona: { value: 'governance-admin' } },
    COMMAND_REASONS: { approve: 'change-reviewed' },
    hideConflict: () => {},
    loadCurrentScreen: async () => { reloads += 1; },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ outcome: 'published', state: 'active' }) };
    },
  };
  runInNewContext(`${code}\nglobalThis.approve = saveRevision;`, context);
  await context.approve({ revisionCode: 'revision-0002', command: 'approve' });
  assert.deepEqual(calls, [{
    url: '/api/local/lifecycle/publish?persona=governance-admin',
    body: { revisionId: 'revision-0002', etag: '"2"', expectedRevisionNumber: 2, actor: 'local-admin' },
  }]);
  assert.equal(reloads, 1);
});
