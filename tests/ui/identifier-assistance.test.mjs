import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createLatestLoad } from '../../app/admin-ui/public/latest-load.mjs';

const publicRoot = new URL('../../app/admin-ui/public/', import.meta.url);

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.hidden = true;
    this.textContent = '';
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }
}

function createHarness(clipboard) {
  const elements = {
    identifierHelp: new FakeElement('section'),
    identifierCaller: new FakeElement('div'),
    identifierOptions: new FakeElement('ul'),
    identifierStatus: new FakeElement('p'),
  };
  const context = {
    elements,
    navigator: { clipboard },
    document: {
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (value) => ({ textContent: String(value) }),
    },
    createElement: (tag, _className, content) => {
      const element = new FakeElement(tag);
      if (content !== undefined) element.textContent = String(content);
      return element;
    },
    t: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key,
    translateCode: (_namespace, code) => code,
    QUOTA_PERIODS: ['daily', 'monthly'],
  };
  return { elements, context };
}

async function loadRenderer(context) {
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');
  const start = script.indexOf('function renderIdentifierEvidence');
  const end = script.indexOf('function fillBindingModels', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(
    `let identifierCopyGeneration = 0; ${script.slice(start, end)}; renderIdentifierEvidence`,
    context,
  );
}

async function loadRendererController(context) {
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');
  const start = script.indexOf('function renderIdentifierEvidence');
  const end = script.indexOf('function fillBindingModels', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(
    `let identifierCopyGeneration = 0; ${script.slice(start, end)}; ({
      render: renderIdentifierEvidence,
      invalidate: () => { identifierCopyGeneration += 1; },
    })`,
    context,
  );
}

async function loadAuthorityHarness(fetchImpl) {
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');
  const start = script.indexOf('function accessOptionsContextIsCurrent');
  const end = script.indexOf('function fillOptions', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    api: { baseUrl: '', accessOptionsPath: '/access-options' },
    fetch: fetchImpl,
    locale: 'en',
    currentScreen: 'users-groups',
    session: {
      mode: 'local',
      getAuthorizationHeader: async () => ({}),
    },
    elements: { persona: { value: 'alice' } },
    accessOptionsLoads: createLatestLoad(),
  };
  const result = vm.runInNewContext(`
    let accessOptions = null;
    let authoringAvailable = false;
    let authoringOptionsFailure = null;
    ${script.slice(start, end)}
    ({
      refreshAuthoringAuthority,
      state: () => ({ accessOptions, authoringAvailable, authoringOptionsFailure }),
    })
  `, context);
  return { context, ...result };
}

async function loadSubjectAuthoringHarness() {
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');
  const start = script.indexOf('function fillOptions');
  const end = script.indexOf('function fillAssignmentAuthoring', start);
  assert.ok(start >= 0 && end > start);
  const field = () => {
    const input = new FakeElement('input');
    input.previousElementSibling = new FakeElement('label');
    return input;
  };
  const elements = {
    subjectAddError: new FakeElement('p'),
    subjectAddKind: field(),
    subjectAddId: field(),
    subjectAddKeyLabel: new FakeElement('label'),
    subjectAddKey: field(),
    subjectAddKeyOptions: new FakeElement('datalist'),
    subjectAddKeyHelp: new FakeElement('p'),
    subjectAddTeam: field(),
    subjectAddModels: field(),
    subjectAddReason: field(),
    subjectAddRpm: field(),
    subjectAddTpm: field(),
    subjectAddQuota: field(),
    subjectAddPeriod: field(),
    subjectAddActions: new FakeElement('div'),
    subjectAdd: new FakeElement('section'),
  };
  elements.subjectAddKind.value = 'subject';
  const context = {
    elements,
    accessOptions: {
      teams: [],
      models: [],
      grantReasonCodes: [],
      identifierEvidence: {
        knownAuthorizedValues: [
          { identifierKind: 'gateway-subject', value: 'subject-1' },
          { identifierKind: 'application-client-id', value: 'client-1' },
          { identifierKind: 'entra-group-id', value: 'group-1' },
        ],
      },
    },
    document: {
      createElement: (tag) => new FakeElement(tag),
    },
    t: (key) => key,
    authoringText: (key) => key,
    translateCode: (_namespace, code) => code,
    QUOTA_PERIODS: ['daily', 'monthly'],
    createElement: (tag, _className, content) => {
      const element = new FakeElement(tag);
      if (content !== undefined) element.textContent = String(content);
      return element;
    },
    fillLimitInputs: () => {},
    buildEntitlementAddPayload: () => ({ ok: true, payload: {} }),
    proposeAccessChange: () => {},
  };
  vm.runInNewContext(`
    ${script.slice(start, end)}
    fillSubjectAuthoring()
  `, context);
  return elements;
}

const evidence = {
  version: 'identifier-evidence.v1',
  currentCaller: { state: 'unavailable', reasonCode: 'derivation-unavailable' },
  knownAuthorizedValues: [{
    sourceKind: 'entitlement-target',
    identifierKind: 'gateway-subject',
    value: 'known-subject',
  }],
};

test('identifier copy reports success only after navigator clipboard resolves', async () => {
  let copied = null;
  const { elements, context } = createHarness({
    writeText: async (value) => { copied = value; },
  });
  const render = await loadRenderer(context);
  render(evidence);
  const button = elements.identifierOptions.children[0].children.at(-1);
  await button.listeners.click();
  assert.equal(copied, 'known-subject');
  assert.equal(elements.identifierStatus.textContent, 'identifier.copied');
});

test('identifier copy reports unavailable when navigator clipboard rejects', async () => {
  const { elements, context } = createHarness({
    writeText: async () => { throw new Error('denied'); },
  });
  const render = await loadRenderer(context);
  render(evidence);
  const button = elements.identifierOptions.children[0].children.at(-1);
  await button.listeners.click();
  assert.equal(elements.identifierStatus.textContent, 'identifier.copyUnavailable');
});

test('stale clipboard success is not reported after identifier assistance resets', async () => {
  let resolveCopy;
  const { elements, context } = createHarness({
    writeText: () => new Promise((resolve) => { resolveCopy = resolve; }),
  });
  const controller = await loadRendererController(context);
  controller.render(evidence);
  const button = elements.identifierOptions.children[0].children.at(-1);
  const pending = button.listeners.click();
  controller.invalidate();
  resolveCopy();
  await pending;
  assert.notEqual(elements.identifierStatus.textContent, 'identifier.copied');
});

test('stale clipboard rejection is not reported after identifier assistance resets', async () => {
  let rejectCopy;
  const { elements, context } = createHarness({
    writeText: () => new Promise((_resolve, reject) => { rejectCopy = reject; }),
  });
  const controller = await loadRendererController(context);
  controller.render(evidence);
  const button = elements.identifierOptions.children[0].children.at(-1);
  const pending = button.listeners.click();
  controller.invalidate();
  rejectCopy(new Error('denied'));
  await pending;
  assert.notEqual(elements.identifierStatus.textContent, 'identifier.copyUnavailable');
});

test('identifier caller keeps unknown scope explicit and preserves the inference boundary', async () => {
  const { elements, context } = createHarness({ writeText: async () => {} });
  const render = await loadRenderer(context);
  render({
    ...evidence,
    currentCaller: {
      state: 'available',
      scope: 'unexpected-scope',
      subjectKey: 'sk1-value',
      applicationKey: 'ak1-value',
    },
  });
  const callerText = elements.identifierCaller.children.map((entry) => entry.textContent).join(' ');
  assert.match(callerText, /identifier\.unknownScope/);
  assert.match(callerText, /identifier\.currentCallerBoundary/);
});

test('authoring controls filter authorized identifiers by target namespace', async () => {
  const elements = await loadSubjectAuthoringHarness();
  elements.subjectAddKind.value = 'application';
  elements.subjectAddKind.onchange();
  assert.equal(elements.subjectAddKeyLabel.textContent, 'subjectAdd.keyLabel.application');
  assert.equal(elements.subjectAddKeyHelp.textContent, 'subjectAdd.keyHelp.application');
  assert.equal(
    [...elements.subjectAddKeyOptions.children].map((option) => option.value).join(','),
    'client-1',
  );
  elements.subjectAddKind.value = 'subject';
  elements.subjectAddKind.onchange();
  assert.equal(
    [...elements.subjectAddKeyOptions.children].map((option) => option.value).join(','),
    'subject-1',
  );
});

test('non-access screens keep their authority load current until it resolves', async () => {
  const payload = {
    teams: [], models: [], bindings: [], assignmentGrantRules: [],
    grantReasonCodes: [], teamRemovalReasonCodes: [],
  };
  for (const screen of ['models', 'budgets', 'fallback']) {
    for (const mode of ['local', 'entra']) {
      const { context, refreshAuthoringAuthority, state } = await loadAuthorityHarness(
        async () => ({ ok: true, json: async () => payload }),
      );
      context.currentScreen = screen;
      context.session.mode = mode;
      const result = await refreshAuthoringAuthority();
      assert.equal(result.current, true, `${screen}/${mode}`);
      assert.equal(result.available, true, `${screen}/${mode}`);
      assert.equal(state().authoringAvailable, true);
      assert.equal(state().accessOptions, payload);
    }
  }
});

test('non-access authority ignores superseded responses without clearing the newer load', async () => {
  let resolveOld;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
  const payload = {
    teams: [], models: [], bindings: [], assignmentGrantRules: [],
    grantReasonCodes: [], teamRemovalReasonCodes: [],
  };
  let calls = 0;
  const { context, refreshAuthoringAuthority, state } = await loadAuthorityHarness(async () => {
    calls += 1;
    if (calls === 1) {
      markStarted();
      return oldResponse;
    }
    return { ok: true, json: async () => payload };
  });
  context.currentScreen = 'models';
  const old = refreshAuthoringAuthority();
  await started;
  context.currentScreen = 'budgets';
  const current = await refreshAuthoringAuthority();
  resolveOld({ ok: false, status: 403 });
  const stale = await old;
  assert.equal(current.available, true);
  assert.equal(stale.current, false);
  assert.equal(state().accessOptions, payload);
  assert.equal(state().authoringAvailable, true);
});

test('stale access-options fetch completion cannot mutate authority state', async () => {
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
  const { context, refreshAuthoringAuthority, state } = await loadAuthorityHarness(
    () => fetchPromise,
  );
  const load = { signal: {}, isCurrent: () => load.current };
  load.current = true;
  const requestContext = {
    screen: 'users-groups',
    locale: 'en',
    mode: 'local',
    persona: 'alice',
  };
  const pending = refreshAuthoringAuthority(load, requestContext);
  context.currentScreen = 'overview';
  load.current = false;
  resolveFetch({ ok: true, json: async () => ({ marker: 'old' }) });
  const result = await pending;
  assert.equal(result.current, false);
  assert.equal(result.reason, 'stale');
  assert.equal(state().accessOptions, null);
  assert.equal(state().authoringAvailable, false);
  assert.equal(state().authoringOptionsFailure, null);
});

test('stale access-options JSON completion cannot repopulate newer caller state', async () => {
  let resolveJson;
  let jsonStartedResolve;
  const jsonStarted = new Promise((resolve) => { jsonStartedResolve = resolve; });
  const { context, refreshAuthoringAuthority, state } = await loadAuthorityHarness(
    async () => ({
      ok: true,
      json: () => {
        jsonStartedResolve();
        return new Promise((resolve) => { resolveJson = resolve; });
      },
    }),
  );
  const load = { signal: {}, isCurrent: () => load.current };
  load.current = true;
  const requestContext = {
    screen: 'users-groups',
    locale: 'en',
    mode: 'local',
    persona: 'alice',
  };
  const pending = refreshAuthoringAuthority(load, requestContext);
  await jsonStarted;
  context.elements.persona.value = 'bob';
  load.current = false;
  resolveJson({ marker: 'old' });
  const result = await pending;
  assert.equal(result.current, false);
  assert.equal(result.reason, 'stale');
  assert.equal(state().accessOptions, null);
  assert.equal(state().authoringAvailable, false);
  assert.equal(state().authoringOptionsFailure, null);
});
