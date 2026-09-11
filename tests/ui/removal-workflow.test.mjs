import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { createLatestLoad } from '../../app/admin-ui/public/latest-load.mjs';
import {
  buildRemovalPlanPayload,
  buildRemovalProposalPayload,
  validateRemovalPlan,
} from '../../app/admin-ui/public/removal-workflow.mjs';

const request = buildRemovalPlanPayload({ kind: 'team', key: 'platform-engineering', reasonCode: 'team-merged' });
const plan = Object.freeze({
  readModelVersion: 'removal-plan.v1', target: request.target, reasonCode: request.reasonCode, planDigest: 'digest-001',
  references: [{ referenceId: 'ref-001', kind: 'entitlement-binding', code: 'team-access', state: 'active', action: 'remove-binding' }],
  blockers: [], canPropose: true,
});

test('builds exact plan and proposal payloads only after every reference is acknowledged', () => {
  assert.deepEqual(request, { target: { kind: 'team', key: 'platform-engineering' }, reasonCode: 'team-merged' });
  assert.throws(() => buildRemovalProposalPayload(plan, request, []), /Every removal-plan reference/);
  assert.deepEqual(buildRemovalProposalPayload(plan, request, ['ref-001']), {
    target: { kind: 'team', key: 'platform-engineering' }, reasonCode: 'team-merged', planDigest: 'digest-001', selectedReferenceIds: ['ref-001'],
  });
});

test('rejects stale selection, invalid targets, and incomplete server plans', () => {
  assert.throws(() => buildRemovalPlanPayload({ kind: 'application', key: 'x', reasonCode: 'x' }), /team or model/);
  assert.throws(() => validateRemovalPlan({ ...plan, reasonCode: 'different' }, request), /does not match/);
  assert.throws(() => validateRemovalPlan({ ...plan, planDigest: '' }, request), /incomplete/);
  assert.throws(() => validateRemovalPlan({ ...plan, references: [{ ...plan.references[0], state: 'unknown' }] }, request), /invalid reference/);
  assert.throws(() => buildRemovalProposalPayload(plan, request, ['ref-001', 'ref-001']), /exactly once/);
  const blocked = { ...plan, blockers: [{ reasonCode: 'active-reference-remains' }] };
  assert.throws(() => buildRemovalProposalPayload(blocked, request, ['ref-001']), /blockers remain/);
  assert.throws(() => buildRemovalProposalPayload({ ...plan, canPropose: false }, request, ['ref-001']), /blockers remain/);
  assert.throws(() => validateRemovalPlan({ ...plan, references: [plan.references[0], plan.references[0]] }, request), /invalid reference/);
  assert.deepEqual(validateRemovalPlan({ ...plan, references: [{ ...plan.references[0], state: 'expired' }] }, request).references[0].state, 'expired');
});

class Element {
  children = [];
  dataset = {};
  listeners = {};
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  textContent = '';
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(event, handler) { this.listeners[event] = handler; }
  scrollIntoView() {}
  emit(event) { return this.listeners[event]?.(); }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('[data-removal-reference]')]);
    return descendants.filter((child) => child.dataset.removalReference && (!selector.endsWith(':checked') || child.checked));
  }
}

async function workflow(fetch) {
  const script = await readFile(new URL('../../app/admin-ui/public/app.mjs', import.meta.url), 'utf8');
  const functions = script.slice(script.indexOf('\nfunction removalErrorMessage'), script.indexOf('\nfunction renderUsageQuality'));
  assert.ok(functions.length > 0, 'removal functions must be top-level declarations');
  const elements = Object.fromEntries([
    'removalWorkflow', 'removalTitle', 'removalDetails', 'removalReferences', 'removalActions', 'removalError',
    'teamEditExisting', 'teamEditReason', 'modelAddTarget', 'modelAddReason', 'persona',
  ].map((name) => [name, new Element()]));
  elements.teamEditExisting.value = request.target.key;
  elements.teamEditReason.value = request.reasonCode;
  elements.modelAddTarget.value = 'coding';
  elements.modelAddReason.value = 'model-retired';
  elements.persona.value = 'governance-admin';
  const context = {
    elements, fetch, buildRemovalPlanPayload, buildRemovalProposalPayload, validateRemovalPlan,
    removalLoads: createLatestLoad(), removalProposalPending: false, removalReview: null,
    document: { createElement: () => new Element() },
    createElement: (_tag, _class, text) => Object.assign(new Element(), { textContent: text }),
    t: (key) => key, translateCode: (namespace, key) => `${namespace}.${key}`,
    session: { mode: 'local', getAuthorizationHeader: async () => ({}) },
    api: { baseUrl: '', removalPlanPath: '/plan', removalProposalsPath: '/proposals' },
    location: {}, SCREENS: { lifecycle: { hash: '#lifecycle' } },
  };
  runInNewContext(`${functions}\nglobalThis.workflow = { openRemovalWorkflow, closeRemovalWorkflow, renderRemovalPlan };`, context);
  return { ...context.workflow, elements, context };
}

const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const saved = { outcome: 'proposed', revisionId: 'revision-0012', revisionNumber: 12, state: 'draft' };

test('executes both team and model plan entry paths with exact requests and unchecked references', async () => {
  const calls = [];
  const ui = await workflow(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return response({ ...plan, ...body, references: [{ ...plan.references[0], state: 'expired' }] });
  });
  for (const kind of ['team', 'model']) {
    const key = kind === 'team' ? request.target.key : 'coding';
    const reasonCode = kind === 'team' ? request.reasonCode : 'model-retired';
    await ui.openRemovalWorkflow(kind, key, reasonCode);
    assert.deepEqual(calls.at(-1), { url: '/plan?persona=governance-admin', body: { target: { kind, key }, reasonCode } });
    const [checkbox] = ui.elements.removalReferences.querySelectorAll('[data-removal-reference]');
    assert.equal(checkbox.checked, false);
    assert.equal(ui.elements.removalActions.children[0].disabled, true);
    checkbox.checked = true;
    checkbox.emit('change');
    assert.equal(ui.elements.removalActions.children[0].disabled, false);
  }
});

test('submits at most once, even when clicking again or changing acknowledgements while POST is pending or done', async () => {
  const calls = [];
  let complete;
  const ui = await workflow((url, options) => {
    calls.push({ url, options });
    return new Promise((resolve) => { complete = resolve; });
  });
  ui.renderRemovalPlan(plan, request);
  const [checkbox] = ui.elements.removalReferences.querySelectorAll('[data-removal-reference]');
  const propose = ui.elements.removalActions.children[0];
  checkbox.checked = true;
  checkbox.emit('change');
  const submitting = propose.emit('click');
  await Promise.resolve();
  assert.equal(propose.disabled, true);
  assert.equal(checkbox.disabled, true);
  checkbox.emit('change');
  await propose.emit('click');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal, undefined, 'navigation must not abort a mutation');
  assert.deepEqual(JSON.parse(calls[0].options.body), { ...request, planDigest: plan.planDigest, selectedReferenceIds: ['ref-001'] });
  complete(response(saved, 201));
  await submitting;
  assert.equal(ui.elements.removalError.textContent, 'removal.proposed');
  checkbox.emit('change');
  await propose.emit('click');
  assert.equal(calls.length, 1);
  assert.equal(propose.disabled, true);
  assert.equal(ui.context.removalProposalPending, false);
});

test('changed target, reason, or discarded review refuses a retained submit handler without claiming a pending mutation', async () => {
  for (const changed of ['target', 'reason', 'view']) {
    let calls = 0;
    const ui = await workflow(async () => { calls += 1; return response(saved, 201); });
    ui.renderRemovalPlan(plan, request);
    const [checkbox] = ui.elements.removalReferences.querySelectorAll('[data-removal-reference]');
    checkbox.checked = true;
    const propose = ui.elements.removalActions.children[0];
    if (changed === 'target') ui.elements.teamEditExisting.value = 'different-team';
    if (changed === 'reason') ui.elements.teamEditReason.value = 'different-reason';
    if (changed === 'view') ui.closeRemovalWorkflow();
    await propose.emit('click');
    assert.equal(calls, 0, changed);
    assert.equal(ui.context.removalProposalPending, false, changed);
    assert.equal(ui.elements.removalError.textContent, 'removal.stale', changed);
  }
});

test('pending submission blocks another review and survives navigation without displaying a stale result', async () => {
  let complete;
  let calls = 0;
  const ui = await workflow(() => {
    calls += 1;
    return new Promise((resolve) => { complete = resolve; });
  });
  ui.renderRemovalPlan(plan, request);
  ui.elements.removalReferences.querySelectorAll('[data-removal-reference]')[0].checked = true;
  const submitting = ui.elements.removalActions.children[0].emit('click');
  await Promise.resolve();
  await ui.openRemovalWorkflow('model', 'coding', 'model-retired');
  assert.equal(calls, 1);
  assert.equal(ui.elements.removalError.textContent, 'removal.pending');
  assert.equal(ui.elements.removalActions.children[0].textContent, 'removal.openPublishing');
  complete(response(saved, 201));
  await submitting;
  assert.equal(ui.elements.removalError.textContent, 'removal.pending');
  assert.equal(ui.context.removalProposalPending, false);
});

test('failed or ambiguous submission clears pending state and requires a fresh review instead of a blind retry', async () => {
  for (const failure of ['stale', 'network', 'invalid-response']) {
    const ui = await workflow(async () => {
      if (failure === 'network') throw new Error('Connection lost after sending.');
      return failure === 'stale' ? response({ outcome: 'refused', reasonCode: 'removal-plan-stale' }, 409) : response({}, 201);
    });
    ui.renderRemovalPlan(plan, request);
    ui.elements.removalReferences.querySelectorAll('[data-removal-reference]')[0].checked = true;
    await ui.elements.removalActions.children[0].emit('click');
    assert.equal(ui.context.removalProposalPending, false, failure);
    assert.equal(ui.context.removalReview, null, failure);
    assert.equal(ui.elements.removalError.textContent, failure === 'stale' ? 'removal.stale' : 'removal.pending', failure);
    assert.equal(ui.elements.removalActions.children[0].textContent, 'removal.openPublishing');
  }
});

test('actual local and deployed authorization envelopes display the permission failure without offering a proposal', async () => {
  for (const body of [
    { error: { code: 'governance_access_denied' } },
    { error: { code: 'caller_not_authenticated' } },
    { outcome: 'refused', reasonCode: 'not-a-governance-author' },
    { outcome: 'refused', reasonCode: 'scope-denied' },
    { outcome: 'refused', reasonCode: 'membership-not-authoritative' },
  ]) {
    const ui = await workflow(async () => response(body, 403));
    await ui.openRemovalWorkflow('team', request.target.key, request.reasonCode);
    assert.equal(ui.elements.removalError.textContent, 'removal.forbidden', JSON.stringify(body));
    assert.equal(ui.elements.removalActions.children.length, 0);
  }
});

test('out-of-order plan responses, blocked plans, invalid responses and invalid input never enable submission', async () => {
  let finishOld;
  const ui = await workflow((_url, options) => {
    const body = JSON.parse(options.body);
    if (body.target.kind === 'team') return new Promise((resolve) => { finishOld = resolve; });
    return Promise.resolve(response({ ...plan, ...body, blockers: [{ reasonCode: 'last-model' }], canPropose: false }));
  });
  const old = ui.openRemovalWorkflow('team', request.target.key, request.reasonCode);
  await Promise.resolve();
  await ui.openRemovalWorkflow('model', 'coding', 'model-retired');
  finishOld(response(plan));
  await old;
  assert.equal(ui.context.removalReview.request.target.kind, 'model');
  assert.equal(ui.elements.removalActions.children[0].disabled, true);
  await ui.openRemovalWorkflow('unknown', '', '');
  assert.equal(ui.elements.removalError.textContent, 'removal.invalid');
  assert.equal(ui.elements.removalActions.children.length, 0);
  const invalid = await workflow(async () => response({ ...plan, references: [{ ...plan.references[0], state: 'unknown' }] }));
  await invalid.openRemovalWorkflow('team', request.target.key, request.reasonCode);
  assert.equal(invalid.elements.removalError.textContent, 'removal.unavailable');
  assert.equal(invalid.elements.removalActions.children.length, 0);
});

test('latest-load race guards discard stale removal results after target, persona, screen, or language changes', () => {
  const loads = createLatestLoad();
  for (const changed of ['target', 'persona', 'screen', 'language']) {
    const pending = loads.begin();
    loads.invalidate();
    assert.equal(pending.isCurrent(), false, changed);
    assert.equal(pending.signal.aborted, true, changed);
  }
});

test('UI exposes review actions and capability-gated model authoring without raw JSON rendering', async () => {
  const [script, markup, messages] = await Promise.all([
    readFile(new URL('../../app/admin-ui/public/app.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../app/admin-ui/public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../app/admin-ui/public/i18n.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(script, /removalPlanPath: '\/api\/local\/removal-plan'/);
  assert.match(script, /removalProposalsPath: '\/api\/v1\/admin\/removal-proposals'/);
  assert.match(script, /openRemovalWorkflow\('team'/);
  assert.match(script, /openRemovalWorkflow\('model'/);
  assert.match(script, /\n}\r?\n\r?\nfunction removalErrorMessage/);
  assert.match(script, /removalProposalPending = true/);
  assert.match(script, /t\('removal\.pending'\)/);
  assert.match(script, /if \(!runtimeCapabilities\.modelAuthoring\)/);
  assert.match(script, /removalLoads\.invalidate\(\)/);
  assert.doesNotMatch(script.slice(script.indexOf('function renderRemovalPlan'), script.indexOf('async function openRemovalWorkflow')), /innerHTML/);
  assert.match(markup, /id="removal-workflow"/);
  assert.match(markup, /provider deployments and Entra groups are not deleted/);
  assert.match(messages, /'removal\.propose': 'Propose acknowledged removal'/);
  assert.match(messages, /'removal\.propose': '확인한 삭제 제안'/);
});
