import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  resolveModeTranslationKey,
  translate,
} from '../../app/admin-ui/public/i18n.mjs';

const publicRoot = new URL('../../app/admin-ui/public/', import.meta.url);

test('model identities show the registered deployment directly below the logical alias in both languages', async () => {
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');
  const start = script.indexOf('function renderModelRecords(');
  const end = script.indexOf('\nfunction renderModelCatalogue(', start);
  assert.ok(start >= 0 && end > start);
  function createElement(tag, className, textContent = '') {
    return {
      tag, className, textContent, dataset: {}, children: [],
      append(...children) { this.children.push(...children); },
    };
  }
  for (const locale of ['en', 'ko']) {
    let rows;
    const render = vm.runInNewContext(`(${script.slice(start, end)})`, {
      document: { createElement },
      createElement,
      t: (key, values) => translate(locale, key, values),
      elements: { modelsBody: { replaceChildren(...children) { rows = children; } } },
      createCapabilityCell: () => createElement('td'),
      createInternalLimitsCell: () => createElement('td'),
      createProviderQuotaCell: () => createElement('td'),
      createConsumptionCell: () => createElement('td'),
    });
    render({
      quality: { countsMeasured: false },
      records: ['deployed-primary', 'deployed-secondary', null, undefined].map((providerDeploymentName, index) => ({
        modelKey: `logical-${index}`,
        providerDeploymentName,
        providerCode: 'azure-openai',
        registrationState: 'registered',
        lifecycle: 'generally-available',
      })),
    });
    for (const [index, row] of rows.entries()) {
      const identity = row.children[0];
      assert.equal(identity.children[0].textContent, `logical-${index}`);
      assert.equal(identity.children[1].tag, 'p');
      assert.equal(identity.children[1].className, 'policy-meta');
      assert.equal(identity.children[1].textContent, translate(locale, 'models.deploymentName', {
        value: ['deployed-primary', 'deployed-secondary'][index] ?? translate(locale, 'state.unknown'),
      }));
    }
  }
});

test('authoring language identifies draft proposals in both modes', () => {
  const keys = [
    'accessEdit.eyebrow',
    'accessEdit.help',
    'accessEdit.proposeEntitlement',
    'accessEdit.proposeRetirement',
    'accessEdit.proposeRestoration',
    'accessEdit.proposeRevocation',
    'subjectAdd.eyebrow',
    'subjectAdd.help',
    'subjectAdd.propose',
    'assignmentAdd.eyebrow',
    'assignmentAdd.help',
    'assignmentAdd.propose',
    'teamEdit.eyebrow',
    'teamEdit.proposeAdd',
    'teamEdit.proposeRemove',
    'budgetEdit.eyebrow',
    'budgetEdit.help',
    'budgetEdit.confirm',
    'budgetAdd.eyebrow',
    'budgetAdd.help',
    'budgetAdd.propose',
    'budgetAdd.proposeRemoval',
    'fallbackEdit.eyebrow',
    'fallbackEdit.help',
    'fallbackEdit.propose',
  ];

  for (const key of keys) {
    assert.equal(resolveModeTranslationKey(key, 'local'), key);
    assert.equal(resolveModeTranslationKey(key, 'entra'), `${key}.deployed`);
    for (const locale of ['en', 'ko']) {
      const local = translate(locale, resolveModeTranslationKey(key, 'local'));
      const deployed = translate(locale, resolveModeTranslationKey(key, 'entra'));
      assert.doesNotMatch(local, /^\[missing:/, `${locale} local ${key}`);
      assert.doesNotMatch(deployed, /^\[missing:/, `${locale} deployed ${key}`);
      assert.match(deployed, /draft|propos|초안|제안/i, `${locale} deployed ${key}`);
    }
  }
});

test('assignment authoring distinguishes policy roles from deployed Entra access', () => {
  for (const locale of ['en', 'ko']) {
    for (const mode of ['local', 'entra']) {
      const help = translate(locale, resolveModeTranslationKey('assignmentAdd.help', mode));
      assert.match(help, /Microsoft Entra/);
      assert.match(help, /console|콘솔/);
      assert.match(help, /API/);
      assert.match(help, /does not|부여하지 않습니다/);
    }
  }
});

test('stored proposal actions send the deployed session authorization header', async () => {
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');
  const start = script.indexOf('async function sendStoredProposalAction');
  const end = script.indexOf('\nfunction hideConflict', start);
  assert.ok(start >= 0 && end > start);
  const observed = {};
  const action = vm.runInNewContext(`(${script.slice(start, end)})`, {
    api: { baseUrl: 'https://gateway.example', governancePublishPath: '/api/v1/admin/governance/publish' },
    session: { getAuthorizationHeader: async () => ({ authorization: 'Bearer test-token' }) },
    fetch: async (url, options) => {
      observed.url = url;
      observed.options = options;
      return { ok: true, json: async () => ({}) };
    },
    hideConflict() {},
    loadCurrentScreen: async () => {},
    renderRefusal() {},
    elements: { lifecycleConflictDetail: { replaceChildren() {} }, lifecycleConflict: { hidden: true } },
    createElement() {},
    t() { return ''; },
  });

  await action({ resume: true, revisionId: 'revision-0002' });
  assert.equal(observed.url, 'https://gateway.example/api/v1/admin/governance/publish');
  assert.equal(observed.options.headers.authorization, 'Bearer test-token');
  assert.equal(observed.options.headers['content-type'], 'application/json');
});

test('directory failure leaves manual access authoring available', async () => {
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');
  const start = script.indexOf('async function showUsersGroupsAuthoringAlongsideState');
  const end = script.indexOf('function identifierValues', start);
  assert.ok(start >= 0 && end > start);
  const panels = [{ hidden: false }, { hidden: false }];
  const usersGroupsContent = { hidden: true };
  let optionsLoaded = 0;
  const showAuthoring = vm.runInNewContext(`(${script.slice(start, end)})`, {
    elements: { usersGroupsContent, directoryReadingPanels: panels },
    loadAccessOptions: async () => { optionsLoaded += 1; },
  });

  await showAuthoring();

  assert.equal(usersGroupsContent.hidden, false);
  assert.deepEqual(panels.map(({ hidden }) => hidden), [true, true]);
  assert.equal(optionsLoaded, 1);
});

test('HTML shell exposes semantic landmarks, labels, tables, and live status', async () => {
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');

  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.match(html, /<nav[^>]+aria-label="Primary"/);
  assert.match(html, /<a[^>]+class="skip-link"[^>]+href="#main-content"/);
  assert.match(html, /id="screen-state"[^>]+aria-live="polite"/);
  assert.match(html, /id="config-summary"[^>]*\shidden/);
  assert.ok((html.match(/<caption\b/g) ?? []).length >= 4);
  assert.match(html, /id="refresh-button"/);
  assert.match(html, /<select id="language-select"/);
  assert.match(html, /data-i18n="locale\.ko"/);
  assert.match(html, /<label[^>]*>[\s\S]*Scope[\s\S]*<select id="scope-select"/);
  assert.match(html, /<details>/);
  assert.match(html, /data-screen="users-groups"/);
  assert.match(html, /<select id="directory-view-select"/);
  assert.match(html, /id="ambiguous-fixture-option"[^>]+hidden/);
  assert.match(html, /id="directory-table-caption"/);
  assert.match(html, /data-screen="budgets"/);
  assert.match(html, /id="budgets-content"[^>]+hidden/);
  assert.match(html, /id="budgets-table-caption"/);
  assert.match(html, /<section[^>]+aria-labelledby="model-selection-title"/);
});

test('CSS includes the complete Clawpilot theme, focus, responsive, and reduced-motion contracts', async () => {
  const css = await readFile(new URL('styles.css', publicRoot), 'utf8');
  const requiredVariables = [
    '--cp-bg', '--cp-bg-elevated', '--cp-surface', '--cp-surface-soft', '--cp-border',
    '--cp-border-strong', '--cp-text', '--cp-text-muted', '--cp-text-soft', '--cp-accent',
    '--cp-accent-hover', '--cp-accent-soft', '--cp-accent-fg', '--cp-success', '--cp-danger',
    '--cp-warning', '--cp-link', '--cp-shadow', '--cp-overlay', '--cp-panel',
    '--cp-panel-strong', '--cp-sheen', '--cp-highlight',
  ];
  for (const variable of requiredVariables) assert.ok(css.includes(variable));
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /focus-visible/);
  assert.match(css, /@media \(max-width: 860px\)/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /"Segoe UI", Aptos, Calibri/);
  assert.match(css, /\.directory-summary-grid/);
  assert.match(css, /\.policy-source-list/);
});

test('UI code renders text without HTML injection or client-side authorization calculations', async () => {
  const script = await readFile(new URL('app.mjs', publicRoot), 'utf8');

  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(script, /accessToken|authorizationHeader|clientSecret|backendUrl/);
  assert.match(script, /resolveLocale/);
  assert.match(script, /document\.documentElement\.lang = locale/);
  assert.match(script, /element\.textContent = authoringText\(element\.dataset\.i18n\)/);
  assert.match(script, /session = await loadSession\(sessionConfig\);\s*applyStaticTranslations\(\);/);
  assert.doesNotMatch(script, /model\.permissions|model\.viewer/);
  assert.match(script, /response\.status === 403/);
  assert.doesNotMatch(script, /params\.set\(['"]lang|lang:\s*locale/);
  assert.match(script, /users-groups\.v1/);
  assert.match(script, /policyInspection\.effective/);
  assert.match(script, /ambiguousFixtureOption\.hidden = !offersFixture\('ambiguous'\)/);
  assert.match(script, /degradedFixtureOption\.hidden = !offersFixture\('degraded'\)/);
  assert.match(script, /emptyFixtureOption\.hidden = !offersFixture\('empty'\)/);
  // The state selector is sent to the screens that declare they can produce a state,
  // named positively. A list of the screens to skip means the next screen added
  // silently receives a selection its route never validated.
  assert.match(script, /if \(FIXTURE_SCREENS\.has\(currentScreen\)\) params\.set\('fixture'/);
  assert.doesNotMatch(script, /!\['budgets'[^\n]*includes\(currentScreen\)\) params\.set\('fixture'/);
  // A state only some screens can produce is cleared when leaving them, so the next
  // screen is not asked for something it would have to refuse.
  assert.match(script, /elements\.fixture\.value in SCREEN_ONLY_FIXTURES[\s\S]{0,200}elements\.fixture\.value = 'complete'/);
  // One function decides which container is visible, so a new screen cannot leave an
  // old one on the page beneath it.
  assert.equal((script.match(/\.hidden = name !== /g) ?? []).length, 9);
  assert.equal((script.match(/showScreenContainer\('/g) ?? []).length, 9);
  // The header configuration chip is written only through the helper that also hides
  // it, and is reset by the same function that switches screens. A direct assignment
  // would let a screen with no configuration version keep showing the previous one's.
  assert.equal((script.match(/elements\.config\.textContent\s*=/g) ?? []).length, 1);
  assert.match(script, /function setConfigurationSummary\(text\) \{\s*elements\.config\.textContent\s*=/);
  assert.equal((script.match(/setConfigurationSummary\(/g) ?? []).length, 4);
  assert.match(script, /showScreenContainer\(name\)[\s\S]{0,400}?setConfigurationSummary\(null\)/);
  assert.match(script, /budgets\.v1/);
  assert.match(
    script,
    /record\.modelScope === 'per-model'\s*\? t\('budgets\.modelCoverage', \{ model: record\.modelKey \}\)\s*: t\('budgetModelScope\.all-models'\)/,
  );
  assert.match(
    script,
    /record\.action === 'THROTTLE' && record\.state === 'enforceable'\s*\? t\('budgets\.noHardTokenQuota'\)/,
  );
  assert.match(script, /function createDerivationCell\(record\) \{[\s\S]{0,120}record\.state === 'unenforceable'/);
  assert.match(script, /usage\.v1/);
  assert.match(script, /models\.v1/);
  assert.match(script, /fallback\.v1/);
  assert.match(script, /lifecycle\.v1/);
  assert.match(script, /change-log\.v1/);
  // A dispatcher of `else if` over version strings fails by doing nothing: renaming a
  // read model leaves the screen on its loading placeholder with no console error and
  // no failing test. So the last branch throws, and the versions are taken from the
  // projectors rather than restated here.
  assert.match(script, /function renderReadModel\(model\)[\s\S]{0,1400}?else throw new Error\(`no renderer for read model/);
  const projectorRoot = new URL('../../app/control-api/', import.meta.url);
  const projectors = (await readdir(projectorRoot)).filter((name) => name.endsWith('-read-model-projector.mjs'));
  assert.ok(projectors.length >= 8);
  for (const projector of projectors) {
    const source = await readFile(new URL(projector, projectorRoot), 'utf8');
    for (const [, version] of source.matchAll(/readModelVersion: '([^']+)'/g)) {
      assert.ok(script.includes(`'${version}'`), `${projector} emits ${version} with no renderer`);
    }
  }
  assert.match(script, /countsMeasured/);
  // The console must not claim a deployment serves a route it does not register. The
  // path table is keyed by screen and filtered by what the session config declares, so
  // an unserved screen has no path at all rather than one that 404s.
  const deployedPaths = script.match(/const DEPLOYED_SCREEN_PATHS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(deployedPaths, 'the deployed path table is missing');
  const pathScreens = [...deployedPaths[1].matchAll(/^\s+'?([A-Za-z-]+)'?:/gm)].map(([, key]) => key);
  const screenNames = [...script.matchAll(/^\s{2}'?([a-z-]+)'?: Object\.freeze\(\{\s*[\r\n]\s+hash:/gm)].map(([, key]) => key);
  assert.deepEqual(pathScreens.slice().sort(), screenNames.slice().sort());
  assert.match(
    script,
    /DEPLOYED_SCREEN_PATHS\)\.filter\(\(\[screen\]\) => servedScreens\.has\(screen\)\)/,
  );
  // Authoring routes live in their own table, named the same way, so a write path is
  // never a literal URL typed at the call site either.
  const deployedWritePaths = script.match(/const DEPLOYED_WRITE_PATHS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(deployedWritePaths, 'the deployed write-path table is missing');
  const writePathCount = [...deployedWritePaths[1].matchAll(/'\/api\/v1\/admin\//g)].length;
  assert.ok(writePathCount > 0);
  assert.match(script, /\.\.\.DEPLOYED_WRITE_PATHS,/);
  // The three deployed routes that belong to no screen and to no write table: the two
  // notification actions and the published meters, which are read on request.
  assert.equal((script.match(/'\/api\/v1\/admin\//g) ?? []).length, pathScreens.length + 3 + writePathCount);
  // The nav hiding an unserved screen is not enough: a hash can be typed. Navigation
  // is refused by the same set that decides which paths exist.
  assert.match(
    script,
    /hashchange[\s\S]{0,240}?if \(!servedScreens\.has\(nextScreen\)\) \{\s*location\.hash = SCREENS\[currentScreen\]\.hash;\s*return;/,
  );
  // The authority behind a change is the acting persona only in local development; a
  // deployment authenticates the request with the signed-in principal's own token.
  assert.match(
    script,
    /const params = session\.mode === 'local' \? `\?persona=\$\{elements\.persona\.value\}` : '';/,
  );
  assert.equal((script.match(/persona=\$\{elements\.persona\.value\}/g) ?? []).length, 3);
  // A panel that would be refused is not offered. The authority is asked for once and
  // every authoring panel follows it in both modes, so a new panel cannot forget to ask.
  assert.match(script, /async function refreshAuthoringAuthorityForContext\(load, context\)[\s\S]{0,1400}authoringAvailable = usable/);
  assert.match(
    script,
    /async function showUsersGroupsAuthoringAlongsideState\(\) \{[\s\S]{0,220}elements\.usersGroupsContent\.hidden = false;[\s\S]{0,220}await loadAccessOptions\(\);/,
  );
  assert.match(
    script,
    /currentScreen === 'users-groups' && response\.status >= 500[\s\S]{0,100}await showUsersGroupsAuthoringAlongsideState\(\)/,
  );
  assert.match(script, /if \(!runtimeCapabilities\.modelAuthoring\) \{\s*elements\.modelAdd\.hidden = true;/);
  assert.match(script, /elements\.modelPrices\.hidden = !runtimeCapabilities\.modelPrices;/);
  assert.match(script, /const registryModels = \[\.\.\.\(accessOptions\?\.models \?\? \[\]\)\]\.sort\(\);/);
  assert.match(script, /edges,\s*modelCodes: registryModels,/);
  assert.doesNotMatch(script, /if \(session\.mode !== 'local'\) \{\s*authoringAvailable = false;/);
  assert.equal((script.match(/refreshAuthoringAuthority\(\)/g) ?? []).length, 3);
  for (const panel of ['accessEdit', 'budgetAdd', 'fallbackEdit', 'modelAdd']) {
    assert.match(script, new RegExp(`elements\\.${panel}\\.hidden = true`));
  }

  // The refusal has to land on the screen that offered the change. Every write names
  // its path through the api table the screens already use for reads, not a literal
  // URL, so the same call resolves to a local or a deployed route; and each states
  // where its answer is written, so a panel that omitted it would report into an
  // element the reader cannot see.
  assert.match(
    script,
    /async function proposeAccessChange\(pathKey, body, target = elements\.accessEditError, onSuccess\)/,
  );
  assert.doesNotMatch(script, /proposeAccessChange\('\/api\/local\//);
  assert.match(
    script,
    /proposeAccessChange\(\s*'budgetsWritePath',\s*payload,\s*elements\.budgetEditError,/,
  );
  assert.match(
    script,
    /function openBudgetEdit\(record\) \{\s*elements\.budgetEditAmount\.disabled = false;/,
  );
  assert.doesNotMatch(script, /record\.warnThresholdPercent \* 100/);
  assert.doesNotMatch(script, /record\.enforcedTokenQuota \/ record\.configuredLimit\.amount/);
  assert.match(
    script,
    /Math\.min\(4, Math\.max\(tierCodes\.length, initial\.tiers\?\.length \?\? 0\)\)/,
  );
  for (const call of [
    "proposeAccessChange('entitlementsWritePath', result.payload, elements.accessEditError)",
    "proposeAccessChange('entitlementsWritePath', result.payload, elements.subjectAddError)",
    "proposeAccessChange('assignmentsWritePath', result.payload, elements.assignmentAddError)",
    "proposeAccessChange('teamsWritePath', {",
    "proposeAccessChange('fallbackWritePath', result.payload, elements.fallbackEditError)",
  ]) {
    assert.ok(script.includes(call), `${call} must remain wired`);
  }
  assert.match(
    script,
    /proposeAccessChange\('assignmentsWritePath', \{\s*command: 'revoke',[\s\S]{0,180}elements\.accessEditError/,
  );
  // Local mode exposes the lifecycle reducer; deployed mode exposes only the durable
  // proposal actions served by the publish endpoint, never generic reducer commands.
  assert.match(
    script,
    /function offersLifecycleCommands\(\) \{\s*return session\.mode === 'local' \|\| typeof api\.governancePublishPath === 'string';/,
  );
  assert.match(script, /held\.clear\(\);\s*if \(session\.mode !== 'local'\) return;/);
  assert.match(script, /async function resumeStoredProposal\(revisionCode, initialOnly\)/);
  assert.match(script, /await session\.getAuthorizationHeader\(\)/);
  assert.match(script, /result\.state === 'active'[\s\S]{0,180}accessEdit\.applied/);
  assert.match(script, /result\.state === 'active'[\s\S]{0,180}budgetEdit\.applied/);
  assert.match(
    script,
    /sendStoredProposalAction\(\{\s*resume: true,\s*revisionId: revisionCode,\s*\.\.\.\(initialOnly \? \{ initialOnly: true \} : \{\}\),\s*\}\)/,
  );
  assert.match(script, /async function withdrawStoredProposal\(revisionCode\)/);
  assert.match(script, /sendStoredProposalAction\(\{ command: 'withdraw', revisionId: revisionCode \}\)/);
  assert.match(script, /record\.availableCommands\.includes\('fail'\)/);
  assert.match(script, /record\.availableCommands\.includes\('abandon'\)/);
  assert.match(script, /async function abandonStoredProposal\(revisionCode\)/);
  assert.match(script, /sendStoredProposalAction\(\{ command: 'abandon', revisionId: revisionCode \}\)/);
  assert.doesNotMatch(script, /resumeStoredProposal[\s\S]{0,500}\bcontent:/);
  assert.doesNotMatch(script, /resumeStoredProposal[\s\S]{0,500}\bactor:/);
  // Both local-only lifecycle URLs must be unreachable once that predicate is false,
  // and there must be no third one that grew without a gate.
  assert.equal((script.match(/'\/api\/local\/lifecycle\//g) ?? []).length, 1);
  assert.equal((script.match(/`\/api\/local\/lifecycle\//g) ?? []).length, 1);
  // Budget edits reuse the same write path and refusal rendering as every other
  // authoring panel, with success handling for the payload it just sent.
  assert.match(
    script,
    /proposeAccessChange\(\s*'budgetsWritePath',\s*payload,\s*elements\.budgetEditError,/,
  );
  // The change history states how much of the picture this scope may see, and does
  // not put a verdict on the screen that nothing behind it backs.
  assert.match(script, /model\.quality\.state === 'complete'/);
  assert.doesNotMatch(script, /chainState|previousHash|brokenAtSequence/);
  // A view that would always be refused is withheld rather than offered and denied.
  assert.match(script, /directoryViewGroupsOption\.hidden = !groupsAvailable/);
  assert.match(script, /downgradeSuppressedBy/);
  assert.match(script, /currentReadModel = null;[\s\S]*currentScreenState/);
  assert.match(script, /else if \(currentScreenState\) renderScreenState\(\)/);
  assert.match(script, /activeLoadController\?\.abort\(\)/);
  // A render fault is reported as one. Sharing the network branch told the reader the
  // adapter was unreachable when the answer had in fact arrived.
  assert.match(script, /renderReadModel\(payload\);\s*\} catch \{[\s\S]{0,120}state\.error\.render/);
  assert.match(script, /signal: controller\.signal/);
  assert.match(script, /generation !== loadGeneration/);
  assert.doesNotMatch(script, /resolveRole|ROLE_SCOPES|ROLE_ASSIGNMENTS/);
  // A save is written against the version the screen is showing. Re-reading at click
  // time would make every save look current, and the warning would never appear.
  assert.doesNotMatch(script, /lifecycle\/revision[\s\S]{0,400}method: 'POST'/);
  assert.match(script, /expectedRevisionNumber: reading\.revisionNumber/);
  // A refused save is shown, not swallowed by a silent reload.
  assert.match(script, /result\.outcome !== 'saved'[\s\S]{0,80}renderRefusal/);
  // Recording a failure needs a reason a person typed. A stock one would put a
  // fabricated explanation into the audit record.
  assert.doesNotMatch(script, /COMMAND_REASONS = Object\.freeze\(\{[^}]*\bfail:/);
});

test('accepted UI assets contain no prompt, completion, credential, or raw authority fields', async () => {
  const files = ['index.html', 'styles.css', 'app.mjs', 'i18n.mjs'];
  const forbidden = [
    'accessToken', 'refreshToken', 'idToken', 'clientSecret', 'providerKey',
    'managedIdentityToken', 'requestBody', 'responseBody', 'backendUrl',
  ];
  for (const file of files) {
    const content = await readFile(new URL(file, publicRoot), 'utf8');
    for (const field of forbidden) assert.equal(content.includes(field), false, `${file} contains ${field}`);
  }
});