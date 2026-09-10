import { localeTag, resolveLocale, resolveModeTranslationKey, translate } from './i18n.mjs';
import { createLocalSession, loadSession, readSessionConfig } from './session.mjs';
import {
  BUDGET_ACTIONS,
  BUDGET_MODEL_SCOPES,
  BUDGET_PERIODS,
  BUDGET_SCOPES,
  buildBudgetAddPayload,
  buildBudgetEditPayload,
} from './budget-authoring.mjs';
import {
  MAX_FALLBACK_EDGES,
  QUOTA_PERIODS,
  buildAssignmentGrantPayload,
  buildEntitlementAddPayload,
  buildEntitlementEditPayload,
  buildEntitlementStatePayload,
  buildFallbackEditPayload,
} from './governance-authoring.mjs';

const elements = {
  state: document.querySelector('#screen-state'),
  overviewContent: document.querySelector('#overview-content'),
  usersGroupsContent: document.querySelector('#users-groups-content'),
  navigationLinks: [...document.querySelectorAll('[data-screen]')],
  pageEyebrow: document.querySelector('#page-eyebrow'),
  pageTitle: document.querySelector('#page-title'),
  pageDescription: document.querySelector('#page-description'),
  toolbar: document.querySelector('#screen-toolbar'),
  rangeControl: document.querySelector('#range-control'),
  teamControl: document.querySelector('#team-control'),
  team: document.querySelector('#team-select'),
  directoryViewControl: document.querySelector('#directory-view-control'),
  directoryView: document.querySelector('#directory-view-select'),
  config: document.querySelector('#config-summary'),
  viewerRole: document.querySelector('#viewer-role'),
  membership: document.querySelector('#membership-state'),
  qualityBanner: document.querySelector('#quality-banner'),
  qualityTitle: document.querySelector('#quality-title'),
  qualityDetails: document.querySelector('#quality-details'),
  operatingState: document.querySelector('#operating-state'),
  updatedAt: document.querySelector('#updated-at'),
  metrics: document.querySelector('#metric-grid'),
  models: document.querySelector('#model-usage-body'),
  attention: document.querySelector('#attention-list'),
  activity: document.querySelector('#activity-body'),
  refresh: document.querySelector('#refresh-button'),
  fixture: document.querySelector('#fixture-select'),
  source: document.querySelector('#source-select'),
  sourceControl: document.querySelector('#source-control'),
  ambiguousFixtureOption: document.querySelector('#ambiguous-fixture-option'),
  degradedFixtureOption: document.querySelector('#degraded-fixture-option'),
  emptyFixtureOption: document.querySelector('#empty-fixture-option'),
  staleFixtureOption: document.querySelector('#stale-fixture-option'),
  partialFixtureOption: document.querySelector('#partial-fixture-option'),
  persona: document.querySelector('#persona-select'),
  scope: document.querySelector('#scope-select'),
  range: document.querySelector('#range-select'),
  language: document.querySelector('#language-select'),
  directoryQualityBanner: document.querySelector('#directory-quality-banner'),
  directoryQualityTitle: document.querySelector('#directory-quality-title'),
  directoryQualityDetails: document.querySelector('#directory-quality-details'),
  directorySummary: document.querySelector('#directory-summary-grid'),
  directoryUpdatedAt: document.querySelector('#directory-updated-at'),
  directoryCaption: document.querySelector('#directory-table-caption'),
  directoryBody: document.querySelector('#directory-table-body'),
  directoryReadingPanels: [...document.querySelectorAll('.directory-reading-panel')],
  environment: document.querySelector('.environment-chip'),
  viewerLabel: document.querySelector('.sidebar-foot-label'),
  budgetsContent: document.querySelector('#budgets-content'),
  budgetsQualityBanner: document.querySelector('#budgets-quality-banner'),
  budgetsQualityTitle: document.querySelector('#budgets-quality-title'),
  budgetsQualityDetails: document.querySelector('#budgets-quality-details'),
  modelSelection: document.querySelector('#model-selection-grid'),
  budgetsUpdatedAt: document.querySelector('#budgets-updated-at'),
  budgetsBody: document.querySelector('#budgets-table-body'),
  budgetEdit: document.querySelector('#budget-edit'),
  budgetEditSubject: document.querySelector('#budget-edit-subject'),
  budgetEditAmount: document.querySelector('#budget-edit-amount'),
  budgetEditScope: document.querySelector('#budget-edit-scope'),
  budgetEditModelScope: document.querySelector('#budget-edit-model-scope'),
  budgetEditModelKey: document.querySelector('#budget-edit-model-key'),
  budgetEditPeriod: document.querySelector('#budget-edit-period'),
  budgetEditAction: document.querySelector('#budget-edit-action'),
  budgetEditThresholds: document.querySelector('#budget-edit-thresholds'),
  budgetEditError: document.querySelector('#budget-edit-error'),
  budgetEditActions: document.querySelector('#budget-edit-actions'),
  budgetAdd: document.querySelector('#budget-add'),
  budgetAddScope: document.querySelector('#budget-add-scope'),
  budgetAddModelScope: document.querySelector('#budget-add-model-scope'),
  budgetAddModelKey: document.querySelector('#budget-add-model-key'),
  budgetAddPeriod: document.querySelector('#budget-add-period'),
  budgetAddAction: document.querySelector('#budget-add-action'),
  budgetAddAmount: document.querySelector('#budget-add-amount'),
  budgetAddThresholds: document.querySelector('#budget-add-thresholds'),
  budgetAddTarget: document.querySelector('#budget-add-target'),
  budgetAddReason: document.querySelector('#budget-add-reason'),
  budgetAddError: document.querySelector('#budget-add-error'),
  budgetAddActions: document.querySelector('#budget-add-actions'),
  channelEdit: document.querySelector('#channel-edit'),
  channelEditCurrent: document.querySelector('#channel-edit-current'),
  channelEditKind: document.querySelector('#channel-edit-kind'),
  channelEditEndpoint: document.querySelector('#channel-edit-endpoint'),
  channelEditError: document.querySelector('#channel-edit-error'),
  channelEditActions: document.querySelector('#channel-edit-actions'),
  fallbackEdit: document.querySelector('#fallback-edit'),
  fallbackEditEnabled: document.querySelector('#fallback-edit-enabled'),
  fallbackEditIntent: document.querySelector('#fallback-edit-intent'),
  fallbackEditNotice: document.querySelector('#fallback-edit-notice'),
  fallbackEditEdgeList: document.querySelector('#fallback-edit-edge-list'),
  fallbackEditAddEdge: document.querySelector('#fallback-edit-add-edge'),
  fallbackEditError: document.querySelector('#fallback-edit-error'),
  fallbackEditActions: document.querySelector('#fallback-edit-actions'),
  accessEdit: document.querySelector('#access-edit'),
  accessEditBinding: document.querySelector('#access-edit-binding'),
  accessEditState: document.querySelector('#access-edit-state'),
  accessEditModels: document.querySelector('#access-edit-models'),
  accessEditRpm: document.querySelector('#access-edit-rpm'),
  accessEditTpm: document.querySelector('#access-edit-tpm'),
  accessEditQuota: document.querySelector('#access-edit-quota'),
  accessEditPeriod: document.querySelector('#access-edit-period'),
  accessEditAssignment: document.querySelector('#access-edit-assignment'),
  accessEditReason: document.querySelector('#access-edit-reason'),
  accessEditError: document.querySelector('#access-edit-error'),
  accessEditActions: document.querySelector('#access-edit-actions'),
  subjectAdd: document.querySelector('#subject-add'),
  subjectAddKind: document.querySelector('#subject-add-kind'),
  subjectAddId: document.querySelector('#subject-add-id'),
  subjectAddKey: document.querySelector('#subject-add-key'),
  subjectAddTeam: document.querySelector('#subject-add-team'),
  subjectAddModels: document.querySelector('#subject-add-models'),
  subjectAddRpm: document.querySelector('#subject-add-rpm'),
  subjectAddTpm: document.querySelector('#subject-add-tpm'),
  subjectAddQuota: document.querySelector('#subject-add-quota'),
  subjectAddPeriod: document.querySelector('#subject-add-period'),
  subjectAddReason: document.querySelector('#subject-add-reason'),
  subjectAddError: document.querySelector('#subject-add-error'),
  subjectAddActions: document.querySelector('#subject-add-actions'),
  assignmentAdd: document.querySelector('#assignment-add'),
  assignmentAddId: document.querySelector('#assignment-add-id'),
  assignmentAddRole: document.querySelector('#assignment-add-role'),
  assignmentAddAssigneeKind: document.querySelector('#assignment-add-assignee-kind'),
  assignmentAddAssigneeKey: document.querySelector('#assignment-add-assignee-key'),
  assignmentAddScopeKind: document.querySelector('#assignment-add-scope-kind'),
  assignmentAddScopeKey: document.querySelector('#assignment-add-scope-key'),
  assignmentAddReason: document.querySelector('#assignment-add-reason'),
  assignmentAddError: document.querySelector('#assignment-add-error'),
  assignmentAddActions: document.querySelector('#assignment-add-actions'),
  teamEdit: document.querySelector('#team-edit'),
  teamEditKey: document.querySelector('#team-edit-key'),
  teamEditGroup: document.querySelector('#team-edit-group'),
  teamEditExisting: document.querySelector('#team-edit-existing'),
  teamEditReason: document.querySelector('#team-edit-reason'),
  teamEditError: document.querySelector('#team-edit-error'),
  teamEditActions: document.querySelector('#team-edit-actions'),
  directoryViewApplicationsOption: document.querySelector('#directory-view-applications-option'),
  usageContent: document.querySelector('#usage-content'),
  usageQualityBanner: document.querySelector('#usage-quality-banner'),
  usageQualityTitle: document.querySelector('#usage-quality-title'),
  usageQualityDetails: document.querySelector('#usage-quality-details'),
  usageSummary: document.querySelector('#usage-summary-grid'),
  usageUpdatedAt: document.querySelector('#usage-updated-at'),
  usageBody: document.querySelector('#usage-table-body'),
  directoryViewGroupsOption: document.querySelector('#directory-view-groups-option'),
  modelsContent: document.querySelector('#models-content'),
  modelsQualityBanner: document.querySelector('#models-quality-banner'),
  modelsQualityTitle: document.querySelector('#models-quality-title'),
  modelsQualityDetails: document.querySelector('#models-quality-details'),
  modelsUpdatedAt: document.querySelector('#models-updated-at'),
  modelsBody: document.querySelector('#models-table-body'),
  modelAdd: document.querySelector('#model-add'),
  modelAddDeployment: document.querySelector('#model-add-deployment'),
  modelAddTarget: document.querySelector('#model-add-target'),
  modelAddReason: document.querySelector('#model-add-reason'),
  modelAddError: document.querySelector('#model-add-error'),
  modelAddActions: document.querySelector('#model-add-actions'),
  modelPrices: document.querySelector('#model-prices'),
  modelPricesActions: document.querySelector('#model-prices-actions'),
  modelPricesBody: document.querySelector('#model-prices-body'),
  fallbackContent: document.querySelector('#fallback-content'),
  fallbackCandidates: document.querySelector('#fallback-candidates'),
  fallbackQualityBanner: document.querySelector('#fallback-quality-banner'),
  fallbackQualityTitle: document.querySelector('#fallback-quality-title'),
  fallbackQualityDetails: document.querySelector('#fallback-quality-details'),
  fallbackDecision: document.querySelector('#fallback-decision-grid'),
  fallbackUpdatedAt: document.querySelector('#fallback-updated-at'),
  fallbackBody: document.querySelector('#fallback-table-body'),
  lifecycleContent: document.querySelector('#lifecycle-content'),
  lifecycleQualityBanner: document.querySelector('#lifecycle-quality-banner'),
  lifecycleQualityTitle: document.querySelector('#lifecycle-quality-title'),
  lifecycleQualityDetails: document.querySelector('#lifecycle-quality-details'),
  lifecycleUpdatedAt: document.querySelector('#lifecycle-updated-at'),
  lifecycleBody: document.querySelector('#lifecycle-table-body'),
  lifecycleConflict: document.querySelector('#lifecycle-conflict'),
  lifecycleConflictEyebrow: document.querySelector('#lifecycle-conflict-eyebrow'),
  lifecycleConflictTitle: document.querySelector('#lifecycle-conflict-title'),
  lifecycleConflictDetail: document.querySelector('#lifecycle-conflict-detail'),
  lifecycleConflictActions: document.querySelector('#lifecycle-conflict-actions'),
  lifecycleReason: document.querySelector('#lifecycle-reason'),
  lifecycleReasonInput: document.querySelector('#lifecycle-reason-input'),
  lifecycleReasonError: document.querySelector('#lifecycle-reason-error'),
  lifecycleReasonActions: document.querySelector('#lifecycle-reason-actions'),
  notificationsContent: document.querySelector('#notifications-content'),
  notificationsQualityDetails: document.querySelector('#notifications-quality-details'),
  notificationsUpdatedAt: document.querySelector('#notifications-updated-at'),
  notificationsBody: document.querySelector('#notifications-table-body'),
  auditContent: document.querySelector('#audit-content'),
  auditQualityBanner: document.querySelector('#audit-quality-banner'),
  auditQualityTitle: document.querySelector('#audit-quality-title'),
  auditQualityDetails: document.querySelector('#audit-quality-details'),
  auditExport: document.querySelector('#audit-export-grid'),
  auditUpdatedAt: document.querySelector('#audit-updated-at'),
  auditBody: document.querySelector('#audit-table-body'),
};

// One row per screen, so adding a screen is a row rather than another branch in every
// function that has to know which one is showing.
const SCREENS = Object.freeze({
  overview: Object.freeze({
    hash: '#overview',
    prefix: 'overview',
    descriptionKey: 'app.description',
    refreshKey: 'app.refreshOverview',
    loadingTitleKey: 'state.loading.title',
    loadingDetailKey: 'state.loading.detail',
    errorTitleKey: 'state.error.title',
    path: 'overviewPath',
  }),
  'users-groups': Object.freeze({
    hash: '#users-groups',
    prefix: 'usersGroups',
    descriptionKey: 'usersGroups.description',
    refreshKey: 'app.refreshUsersGroups',
    loadingTitleKey: 'usersGroups.loadingTitle',
    loadingDetailKey: 'usersGroups.loadingDetail',
    errorTitleKey: 'usersGroups.unavailableTitle',
    path: 'usersGroupsPath',
  }),
  budgets: Object.freeze({
    hash: '#budgets',
    prefix: 'budgets',
    descriptionKey: 'budgets.description',
    refreshKey: 'app.refreshBudgets',
    loadingTitleKey: 'budgets.loadingTitle',
    loadingDetailKey: 'budgets.loadingDetail',
    errorTitleKey: 'budgets.unavailableTitle',
    path: 'budgetsPath',
  }),
  usage: Object.freeze({
    hash: '#usage',
    prefix: 'usage',
    descriptionKey: 'usage.description',
    refreshKey: 'app.refreshUsage',
    loadingTitleKey: 'usage.loadingTitle',
    loadingDetailKey: 'usage.loadingDetail',
    errorTitleKey: 'usage.unavailableTitle',
    path: 'usagePath',
  }),
  models: Object.freeze({
    hash: '#models',
    prefix: 'models',
    descriptionKey: 'models.description',
    refreshKey: 'app.refreshModels',
    loadingTitleKey: 'models.loadingTitle',
    loadingDetailKey: 'models.loadingDetail',
    errorTitleKey: 'models.unavailableTitle',
    path: 'modelsPath',
  }),
  fallback: Object.freeze({
    hash: '#fallback',
    prefix: 'fallback',
    descriptionKey: 'fallback.description',
    refreshKey: 'app.refreshFallback',
    loadingTitleKey: 'fallback.loadingTitle',
    loadingDetailKey: 'fallback.loadingDetail',
    errorTitleKey: 'fallback.unavailableTitle',
    path: 'fallbackPath',
  }),
  lifecycle: Object.freeze({
    hash: '#lifecycle',
    prefix: 'lifecycle',
    descriptionKey: 'lifecycle.description',
    refreshKey: 'app.refreshLifecycle',
    loadingTitleKey: 'lifecycle.loadingTitle',
    loadingDetailKey: 'lifecycle.loadingDetail',
    errorTitleKey: 'lifecycle.unavailableTitle',
    path: 'lifecyclePath',
  }),
  notifications: Object.freeze({
    hash: '#notifications',
    prefix: 'notifications',
    descriptionKey: 'notifications.description',
    refreshKey: 'app.refreshNotifications',
    loadingTitleKey: 'notifications.loadingTitle',
    loadingDetailKey: 'notifications.loadingDetail',
    errorTitleKey: 'notifications.unavailableTitle',
    path: 'notificationsPath',
  }),
  audit: Object.freeze({
    hash: '#audit',
    prefix: 'audit',
    descriptionKey: 'audit.description',
    refreshKey: 'app.refreshAudit',
    loadingTitleKey: 'audit.loadingTitle',
    loadingDetailKey: 'audit.loadingDetail',
    errorTitleKey: 'audit.unavailableTitle',
    path: 'auditPath',
  }),
});

function screenForHash(hash) {
  const match = Object.entries(SCREENS).find(([, screen]) => screen.hash === hash);
  return match ? match[0] : 'overview';
}

let locale = resolveLocale(new URLSearchParams(location.search).get('lang'));
let currentReadModel = null;
let currentScreen = screenForHash(location.hash);
let currentScreenState = null;
let activeLoadController = null;
let loadGeneration = 0;
// A deployment has no server-side fixtures and no persona switch, and it must not
// present affordances that imply the data on screen is simulated.
let developmentControlsAvailable = true;
let runtimeCapabilities = Object.freeze({
  modelAuthoring: true,
  modelPrices: true,
});

// Local development answers with the persona routes on the same origin; a deployment
// answers with the governance API. The screens do not know which they are talking to.
const LOCAL_API = Object.freeze({
  baseUrl: '',
  overviewPath: '/api/local/overview',
  usersGroupsPath: '/api/local/users-groups',
  budgetsPath: '/api/local/budgets',
  usagePath: '/api/local/usage',
  modelsPath: '/api/local/models',
  fallbackPath: '/api/local/fallback',
  lifecyclePath: '/api/local/lifecycle',
  notificationsPath: '/api/local/notifications',
  acknowledgePath: '/api/local/notifications/acknowledge',
  channelPath: '/api/local/notifications/channel',
  auditPath: '/api/local/audit',
  modelPricesPath: '/api/local/model-prices',
  accessOptionsPath: '/api/local/access-options',
  entitlementsWritePath: '/api/local/entitlements/propose',
  teamsWritePath: '/api/local/teams/propose',
  budgetsWritePath: '/api/local/budgets/propose',
  fallbackWritePath: '/api/local/fallback/propose',
  assignmentsWritePath: '/api/local/assignments/propose',
  modelsWritePath: '/api/local/models/propose',
});

// The route a deployment would serve for each screen. Which of these it actually
// registers is the deployment's own answer, read from the session config, so this
// table is a naming convention rather than a claim that all of them exist.
const DEPLOYED_SCREEN_PATHS = Object.freeze({
  overview: '/api/v1/admin/overview',
  'users-groups': '/api/v1/admin/users-groups',
  budgets: '/api/v1/admin/budgets',
  usage: '/api/v1/admin/usage',
  models: '/api/v1/admin/models',
  fallback: '/api/v1/admin/fallback',
  lifecycle: '/api/v1/admin/lifecycle',
  notifications: '/api/v1/admin/notifications',
  audit: '/api/v1/admin/audit',
});

// Authoring routes a deployment may register. Access options and the entitlement or
// assignment changes have no GET screen of their own; a budget or fallback change
// shares its screen's own path, using POST instead of GET. Whether a deployment
// actually answers on these is not stated here, it is asked of the server by
// refreshAuthoringAuthority, the same way DEPLOYED_SCREEN_PATHS is a naming
// convention rather than a claim that every route exists.
const DEPLOYED_WRITE_PATHS = Object.freeze({
  accessOptionsPath: '/api/v1/admin/access-options',
  entitlementsWritePath: '/api/v1/admin/entitlements',
  teamsWritePath: '/api/v1/admin/teams',
  budgetsWritePath: '/api/v1/admin/budgets',
  fallbackWritePath: '/api/v1/admin/fallback',
  assignmentsWritePath: '/api/v1/admin/assignments',
  modelsWritePath: '/api/v1/admin/models',
  governancePublishPath: '/api/v1/admin/governance/publish',
});
let session = createLocalSession();
let api = LOCAL_API;

function t(key, params) {
  return translate(locale, key, params);
}

function authoringText(key, params) {
  return t(resolveModeTranslationKey(key, session.mode), params);
}

function text(value) {
  return document.createTextNode(String(value));
}

function createElement(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.append(text(content));
  return element;
}

function formatNumber(value) {
  return new Intl.NumberFormat(localeTag(locale)).format(value);
}

// A measure nobody collected must not render as a confident zero.
function formatCount(value) {
  return value === null ? t('state.unknown') : formatNumber(value);
}

function formatMetric(metric) {
  if (metric.value === null) return t('state.unknown');
  if (metric.unit === 'ratio') return `${(metric.value * 100).toFixed(1)}%`;
  if (metric.unit === 'milliseconds') return t('unit.milliseconds', { value: formatNumber(metric.value) });
  return formatNumber(metric.value);
}

function formatTime(value) {
  return new Intl.DateTimeFormat(localeTag(locale), {
    hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(value));
}

function applyStaticTranslations() {
  document.documentElement.lang = locale;
  document.title = t('app.title');
  elements.language.value = locale;
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = authoringText(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  }
  for (const element of document.querySelectorAll('[data-i18n-title]')) {
    element.setAttribute('title', t(element.dataset.i18nTitle));
  }
  for (const element of document.querySelectorAll('[data-i18n-content]')) {
    element.setAttribute('content', t(element.dataset.i18nContent));
  }
}

// The viewer block states where authority comes from. In a deployment that is the
// signed-in principal and the roles Entra issued; claiming a local fixture identity
// while showing real governance data would misrepresent what the reader is seeing.
function renderViewer() {
  const described = session.describe();
  if (described.mode === 'local') {
    elements.viewerRole.textContent = t(`persona.${elements.persona.value}`);
    elements.membership.textContent = t('viewer.localFixture');
    return;
  }
  elements.viewerRole.textContent = described.name ?? t('viewer.signedIn');
  elements.membership.textContent = t('viewer.directoryIdentity');
  elements.viewerLabel.textContent = t('viewer.deployedLabel');
  elements.viewerLabel.removeAttribute('data-i18n');
}

// Which screens each control belongs to, stated positively. Listing the screens that
// must hide it instead means every new screen silently inherits a control that does
// nothing on it, and nothing fails until somebody reads the page.
const RANGE_SCREENS = new Set(['overview']);
const SOURCE_SCREENS = new Set(['overview']);
const DIRECTORY_VIEW_SCREENS = new Set(['users-groups', 'usage']);
const FIXTURE_SCREENS = new Set(Object.keys(SCREENS));
// A state one screen can produce and another cannot. Offering it everywhere would
// mean a selection that silently answers with something else.
const SCREEN_ONLY_FIXTURES = Object.freeze({
  ambiguous: new Set(['users-groups']),
  degraded: new Set(['usage', 'models', 'notifications']),
  empty: new Set(['overview', 'users-groups', 'usage', 'budgets', 'fallback', 'lifecycle', 'notifications', 'audit']),
  stale: new Set(['overview', 'users-groups', 'usage', 'models', 'budgets']),
  partial: new Set(['overview', 'users-groups', 'usage', 'models', 'budgets']),
});

function offersFixture(name) {
  const screens = SCREEN_ONLY_FIXTURES[name];
  if (screens === undefined) return FIXTURE_SCREENS.has(currentScreen);
  return screens.has(currentScreen);
}

/**
 * Local mode exposes the lifecycle reducer. A deployment exposes only the stored
 * proposal publish endpoint, which accepts approval/retry intent rather than edits.
 */
function offersLifecycleCommands() {
  return session.mode === 'local' || typeof api.governancePublishPath === 'string';
}

function applyScreenChrome() {
  const screen = SCREENS[currentScreen];
  const usersGroups = currentScreen === 'users-groups';
  const usage = currentScreen === 'usage';
  elements.pageEyebrow.textContent = t(`${screen.prefix}.eyebrow`);
  elements.pageTitle.textContent = t(`${screen.prefix}.title`);
  elements.pageDescription.textContent = t(screen.descriptionKey);
  elements.toolbar.setAttribute('aria-label', t(`${screen.prefix}.filters`));
  elements.rangeControl.hidden = !RANGE_SCREENS.has(currentScreen);
  elements.teamControl.hidden = elements.scope.value !== 'team';
  elements.directoryViewControl.hidden = !DIRECTORY_VIEW_SCREENS.has(currentScreen);
  // A usage group total is other people's traffic, so at self scope it is not an
  // option that fails on selection; it is not offered.
  const groupsAvailable = !(usage && elements.scope.value === 'self');
  elements.directoryViewGroupsOption.hidden = !groupsAvailable;
  elements.directoryViewGroupsOption.disabled = !groupsAvailable;
  if (!groupsAvailable) elements.directoryView.value = 'users';
  // Nobody has applications of their own, so at self scope the view is not offered
  // rather than offered and refused.
  const applicationsAvailable = usersGroups && elements.scope.value !== 'self';
  elements.directoryViewApplicationsOption.hidden = !applicationsAvailable;
  elements.directoryViewApplicationsOption.disabled = !applicationsAvailable;
  if (!applicationsAvailable && elements.directoryView.value === 'applications') {
    elements.directoryView.value = 'users';
  }
  elements.ambiguousFixtureOption.hidden = !offersFixture('ambiguous');
  elements.degradedFixtureOption.hidden = !offersFixture('degraded');
  elements.emptyFixtureOption.hidden = !offersFixture('empty');
  elements.staleFixtureOption.hidden = !offersFixture('stale');
  elements.partialFixtureOption.hidden = !offersFixture('partial');
  // A state that belongs to the screen being left would be sent to one that cannot
  // produce it, and the request would be refused for a selection nobody made.
  if (elements.fixture.value in SCREEN_ONLY_FIXTURES && !offersFixture(elements.fixture.value)) {
    elements.fixture.value = 'complete';
  }
  // A deployment has no server-side fixtures at all, so the choice is not offered
  // there however the screen changes.
  elements.sourceControl.hidden = !SOURCE_SCREENS.has(currentScreen) || !developmentControlsAvailable;
  if (usersGroups) elements.source.value = 'fixture';
  // The rollup source produces one window rather than the state set, so on the one
  // screen that offers it the two controls cannot both be live.
  elements.fixture.disabled =
    !FIXTURE_SCREENS.has(currentScreen)
    || (SOURCE_SCREENS.has(currentScreen) && elements.source.value === 'rollup');
  elements.refresh.title = t(screen.refreshKey);
  elements.refresh.setAttribute('aria-label', t(screen.refreshKey));
  for (const link of elements.navigationLinks) {
    const selected = link.dataset.screen === currentScreen;
    link.classList.toggle('is-current', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function setLocale(nextLocale) {
  locale = resolveLocale(nextLocale);
  const url = new URL(location.href);
  url.searchParams.set('lang', locale);
  history.replaceState(null, '', url);
  applyStaticTranslations();
  applyScreenChrome();
  if (currentReadModel) renderReadModel(currentReadModel);
  else if (currentScreenState) renderScreenState();
}

function renderScreenState() {
  const { kind, titleKey, detailKey, reasonCode, requestId } = currentScreenState;
  const detail = reasonCode
    ? [translateErrorCode(reasonCode), requestId].filter(Boolean).join(' · ')
    : t(detailKey);
  elements.overviewContent.hidden = true;
  elements.usersGroupsContent.hidden = true;
  elements.budgetsContent.hidden = true;
  elements.usageContent.hidden = true;
  elements.modelsContent.hidden = true;
  elements.fallbackContent.hidden = true;
  elements.lifecycleContent.hidden = true;
  elements.notificationsContent.hidden = true;
  elements.auditContent.hidden = true;
  elements.state.hidden = false;
  elements.state.className = `screen-state ${kind ? `is-${kind}` : ''}`;
  elements.state.replaceChildren(
    createElement('strong', null, t(titleKey)),
    createElement('p', null, detail),
  );
}

function showState(kind, titleKey, { detailKey, reasonCode, requestId } = {}) {
  currentReadModel = null;
  currentScreenState = { kind, titleKey, detailKey, reasonCode, requestId };
  renderScreenState();
}

function renderQuality(model) {
  const state = model.freshness.state;
  const aggregation = model.freshness.aggregation;
  elements.qualityBanner.classList.toggle('is-fresh', state === 'fresh' && aggregation === 'complete');
  elements.qualityTitle.textContent =
    state === 'fresh' && aggregation === 'complete'
      ? t('quality.currentComplete')
      : t(state === 'stale' ? 'quality.staleAggregation' : 'quality.currentAggregation', {
          aggregation: t(`aggregation.${aggregation}`),
        });
  const pairs = [
    [t('quality.reportedAt'), formatTime(model.freshness.reportedAt)],
    [t('quality.ingestionLag'), t('quality.seconds', { value: formatNumber(model.freshness.lagSeconds) })],
    [t('quality.reconciliation'), t(`reconciliation.${model.freshness.reconciliation}`)],
    [t('quality.quotaSource'), t(`source.${model.freshness.quotaSource}`)],
  ];
  elements.qualityDetails.replaceChildren(...pairs.flatMap(([label, value]) => [
    createElement('dt', null, label),
    createElement('dd', null, value),
  ]));
}

function renderOperatingState(items) {
  elements.operatingState.replaceChildren(...items.map((item) => {
    const wrapper = document.createElement('div');
    wrapper.append(
      createElement('dt', null, t(`operating.${item.id}`)),
      createElement('dd', `tone-${item.tone}`, t(`status.${item.valueCode}`)),
    );
    return wrapper;
  }));
}

function renderMetrics(metrics) {
  elements.metrics.replaceChildren(...metrics.map((metric) => {
    const item = createElement('article', 'metric-item');
    item.append(
      createElement('div', 'metric-label', metric.label),
      createElement('div', 'metric-value', formatMetric(metric)),
    );
    const meta = createElement('div', 'metric-meta');
    item.querySelector('.metric-label').textContent = t(`metric.${metric.id}`);
    const quality = createElement('span', 'status-label', t(`quality.${metric.quality}`));
    quality.dataset.tone = metric.quality === 'reported' ? 'success' : 'warning';
    const freshness = createElement('span', 'status-label', t(`freshness.${metric.freshness}`));
    freshness.dataset.tone = metric.freshness === 'fresh' ? 'success' : 'warning';
    meta.append(quality, freshness, createElement('span', null, t(`source.${metric.source}`)));
    item.append(meta);
    return item;
  }));
}

function renderModels(models) {
  if (models.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement('td', 'empty-message', t('state.noModelUsage'));
    cell.colSpan = 7;
    row.append(cell);
    elements.models.replaceChildren(row);
    return;
  }
  elements.models.replaceChildren(...models.map((model) => {
    const row = document.createElement('tr');
    const modelCell = document.createElement('td');
    modelCell.append(createElement('strong', null, model.model), document.createElement('br'), createElement('small', null, model.version ?? t('state.unknown')));
    row.append(
      modelCell,
      createElement('td', null, formatCount(model.requests)),
      createElement('td', null, formatCount(model.totalTokens)),
      createElement('td', null, model.quotaPercent === null ? t('state.unknown') : `${model.quotaPercent}%`),
      createElement('td', null, formatCount(model.errors)),
      createElement('td', null, `${t(`quality.${model.quality}`)} · ${t(`freshness.${model.freshness}`)}`),
    );
    return row;
  }));
}

function renderAttention(items) {
  if (items.length === 0) {
    elements.attention.replaceChildren(createElement('p', 'empty-message', t('state.noAttention')));
    return;
  }
  elements.attention.replaceChildren(...items.map((item) => {
    const details = createElement('details', 'attention-item');
    details.dataset.severity = item.severity;
    const summary = document.createElement('summary');
    summary.append(
      text(t(`attention.${item.titleCode}`)),
      createElement('span', 'status-label', t(`severity.${item.severity}`)),
    );
    const body = createElement('div', 'attention-body');
    body.append(
      createElement('p', null, t(`attention.${item.reasonCode}`, item.reasonParams)),
      createElement('code', null, item.correlationId),
      createElement('p', null, formatTime(item.occurredAt)),
    );
    details.append(summary, body);
    return details;
  }));
}

function renderActivity(items) {
  if (items.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement('td', 'empty-message', t('state.noActivity'));
    cell.colSpan = 4;
    row.append(cell);
    elements.activity.replaceChildren(row);
    return;
  }
  elements.activity.replaceChildren(...items.map((item) => {
    const row = document.createElement('tr');
    const request = document.createElement('td');
    request.append(createElement('code', null, item.requestId), document.createElement('br'), createElement('small', null, formatTime(item.occurredAt)));
    row.append(
      request,
      createElement('td', null, t(`activity.scope.${item.scopeCode}`)),
      createElement('td', null, item.effectiveModel ?? t('state.deniedBeforeModel')),
      createElement('td', null, `${t(`activity.outcome.${item.outcome}`)} · ${t(`quality.${item.tokenQuality}`)}`),
    );
    return row;
  }));
}

/**
 * Only the policy-derived screens know which published configuration produced what is
 * on screen. Usage, notifications, and audit are historical records, so a version
 * beside them would imply a relationship that does not exist.
 */
function setConfigurationSummary(text) {
  elements.config.textContent = text ?? '';
  elements.config.hidden = text === null;
}

function showScreenContainer(name) {
  currentScreenState = null;
  elements.state.hidden = true;
  // Cleared here rather than per screen, so a screen that never sets it cannot keep
  // showing the previous screen's version as though something had refreshed it.
  setConfigurationSummary(null);
  elements.overviewContent.hidden = name !== 'overview';
  elements.usersGroupsContent.hidden = name !== 'users-groups';
  elements.budgetsContent.hidden = name !== 'budgets';
  elements.usageContent.hidden = name !== 'usage';
  elements.modelsContent.hidden = name !== 'models';
  elements.fallbackContent.hidden = name !== 'fallback';
  elements.lifecycleContent.hidden = name !== 'lifecycle';
  elements.notificationsContent.hidden = name !== 'notifications';
  elements.auditContent.hidden = name !== 'audit';
}

function renderOverview(model) {
  showScreenContainer('overview');
  setConfigurationSummary(`${model.configuration.activeVersion} · ${t(`status.${model.configuration.state}`)}`);
  renderViewer();
  elements.updatedAt.textContent = t('updatedAt', { value: formatTime(model.generatedAt) });
  renderQuality(model);
  renderOperatingState(model.operatingState);
  renderMetrics(model.metrics);
  renderModels(model.modelUsage);
  renderAttention(model.attention);
  renderActivity(model.recentActivity);
}

function renderDirectoryQuality(model) {
  const state = model.quality.state;
  const aggregation = model.quality.aggregation;
  elements.directoryQualityBanner.classList.toggle(
    'is-fresh',
    state === 'fresh' && aggregation === 'complete',
  );
  elements.directoryQualityTitle.textContent =
    state === 'fresh' && aggregation === 'complete'
      ? t('quality.currentComplete')
      : t(state === 'stale' ? 'quality.staleAggregation' : 'quality.currentAggregation', {
          aggregation: t(`aggregation.${aggregation}`),
        });
  const pairs = [
    [t('quality.reportedAt'), formatTime(model.quality.reportedAt)],
    [t('quality.ingestionLag'), t('quality.seconds', { value: formatNumber(model.quality.lagSeconds) })],
    [t('quality.aggregation'), t(`aggregation.${aggregation}`)],
    [t('quality.configurationVersion'), model.configurationVersion],
  ];
  elements.directoryQualityDetails.replaceChildren(...pairs.flatMap(([label, value]) => [
    createElement('dt', null, label),
    createElement('dd', null, value),
  ]));
}

function renderDirectorySummary(summary) {
  const items = [
    ['visibleUsers', summary.visibleUsers],
    ['visibleGroups', summary.visibleGroups],
    ['directMemberships', summary.directMemberships],
    ['inheritedMemberships', summary.inheritedMemberships],
    ['unavailableOutcomes', summary.unavailableOutcomes],
  ];
  elements.directorySummary.replaceChildren(...items.map(([id, value]) => {
    const item = createElement('article', 'directory-summary-item');
    item.append(
      createElement('span', null, t(`usersGroups.${id}`)),
      createElement('strong', null, formatNumber(value)),
    );
    return item;
  }));
}

function renderPolicySource(source) {
  const item = document.createElement('li');
  const heading = createElement('strong', null, t('usersGroups.policySource', {
    origin: t(`origin.${source.originCode}`),
    source: t(`sourceKind.${source.sourceKind}`),
  }));
  const sourceLabel = createElement('span', null, translateCode('directory', source.sourceCode));
  const decision = createElement('span', 'status-label', t(`decision.${source.decisionCode}`));
  decision.dataset.tone = source.decisionCode === 'allow' ? 'success' : 'warning';
  const models = source.decisionCode === 'unavailable'
    ? t('state.unknown')
    : source.modelCodes.length > 0
      ? source.modelCodes.join(', ')
      : t('usersGroups.noModels');
  const limits = source.decisionCode === 'unavailable'
    ? t('state.unknown')
    : [
        source.limits.requestsPerMinute === null
          ? null
          : t('usersGroups.rpm', { value: formatNumber(source.limits.requestsPerMinute) }),
        source.limits.tokensPerMinute === null
          ? null
          : t('usersGroups.tpm', { value: formatNumber(source.limits.tokensPerMinute) }),
        source.limits.tokenQuota === null
          ? null
          : t('usersGroups.quota', {
              value: formatNumber(source.limits.tokenQuota),
              period: t(`period.${source.limits.quotaPeriod}`),
            }),
      ].filter(Boolean).join(' · ') || t('usersGroups.noLimits');
  item.append(
    heading,
    sourceLabel,
    decision,
    createElement('span', null, t('usersGroups.models', { value: models })),
    createElement('span', null, limits),
  );
  return item;
}

function createEffectiveCell(effective) {
  const cell = document.createElement('td');
  const decision = createElement('span', 'status-label', t(`decision.${effective.decisionCode}`));
  decision.dataset.tone =
    effective.decisionCode === 'allow'
      ? 'success'
      : effective.decisionCode === 'deny'
        ? 'danger'
        : 'warning';
  const models = effective.decisionCode === 'unavailable'
    ? t('state.unknown')
    : effective.modelCodes.length > 0
      ? effective.modelCodes.join(', ')
      : t('usersGroups.noModels');
  const limits = effective.limits.requestsPerMinute === null
    ? t('state.unknown')
    : `${t('usersGroups.rpm', { value: formatNumber(effective.limits.requestsPerMinute) })} · ${t('usersGroups.tpm', { value: formatNumber(effective.limits.tokensPerMinute) })}`;
  cell.append(
    decision,
    createElement('p', 'policy-reason', t(`reason.${effective.reasonCode}`)),
    createElement('p', 'policy-meta', t('usersGroups.models', { value: models })),
    createElement('p', 'policy-meta', limits),
  );
  return cell;
}

function createPolicyDetails(record) {
  const details = createElement('details', 'policy-disclosure');
  const summary = createElement('summary', null, t('usersGroups.inspectPolicy'));
  const list = createElement('ul', 'policy-source-list');
  const sources = [
    ...record.policyInspection.direct,
    ...record.policyInspection.inherited,
  ];
  list.append(...sources.map(renderPolicySource));
  details.append(summary, list);
  return details;
}

function renderDirectoryRecords(model) {
  elements.directoryCaption.textContent = t(`usersGroups.${model.selection.view}Caption`);
  if (model.records.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement('td', 'empty-message', t('state.noDirectoryRecords', {
      view: t(`usersGroups.${model.selection.view}`).toLowerCase(),
    }));
    cell.colSpan = 5;
    row.append(cell);
    elements.directoryBody.replaceChildren(row);
    return;
  }

  elements.directoryBody.replaceChildren(...model.records.map((record) => {
    const row = document.createElement('tr');
    const identity = document.createElement('td');
    identity.append(
      // An application is named by its own key rather than by a translated label: it is
      // an identifier the operator configured, not a word this product chose.
      createElement('strong', null, translateCode('directory', record.displayCode)),
      document.createElement('br'),
      createElement('small', null, t(`entity.${record.entityKind}`)),
    );
    const state = document.createElement('td');
    const lifecycle = createElement('span', 'status-label', t(`lifecycle.${record.lifecycleState}`));
    lifecycle.dataset.tone = record.lifecycleState === 'active' ? 'success' : 'warning';
    const resolution = createElement('span', 'status-label', t(`resolution.${record.resolutionState}`));
    resolution.dataset.tone = record.resolutionState === 'complete' ? 'success' : 'warning';
    state.append(lifecycle, resolution);
    const relations = document.createElement('td');
    relations.append(
      createElement('span', null, t('usersGroups.directCount', { value: formatNumber(record.directRelationCount) })),
      document.createElement('br'),
      createElement('span', null, t('usersGroups.inheritedCount', { value: formatNumber(record.inheritedRelationCount) })),
    );
    const detailCell = document.createElement('td');
    detailCell.append(createPolicyDetails(record));
    row.append(
      identity,
      state,
      relations,
      createEffectiveCell(record.policyInspection.effective),
      detailCell,
    );
    return row;
  }));
}

function renderUsersGroups(model) {
  showScreenContainer('users-groups');
  for (const panel of elements.directoryReadingPanels) panel.hidden = false;
  setConfigurationSummary(`${model.configurationVersion} · ${t('status.active')}`);
  renderViewer();
  elements.directoryUpdatedAt.textContent = t('updatedAt', { value: formatTime(model.generatedAt) });
  renderDirectoryQuality(model);
  renderDirectorySummary(model.summary);
  renderDirectoryRecords(model);
  loadAccessOptions();
}

function renderBudgetQuality(model) {
  const complete = model.quality.state === 'complete';
  // Late is not unavailable, so it dims the banner without changing what it says.
  elements.budgetsQualityBanner.classList.toggle(
    'is-fresh',
    complete && model.quality.freshnessState === 'fresh',
  );
  elements.budgetsQualityTitle.textContent = complete
    ? t('budgets.qualityComplete')
    : t('budgets.qualityUnavailable');
  const pairs = [
    [t('budgets.publicationState'), translateCode('budgetState', model.quality.reasonCode)],
    [t('usage.reportedAt'), formatTime(model.freshness.reportedAt)],
    [t('usage.ingestionLag'), t('usage.lagMinutes', {
      value: formatNumber(Math.round(model.freshness.lagSeconds / 60)),
    })],
    [t('budgets.budgetCount'), formatNumber(model.records.length)],
  ];
  elements.budgetsQualityDetails.replaceChildren(...pairs.flatMap(([label, value]) => [
    createElement('dt', null, label),
    createElement('dd', null, value),
  ]));
}

/**
 * The model decision belongs beside the budgets because a downgrade that a pin
 * suppresses otherwise reads as a budget that is denying traffic.
 */
function describeDowngrade(selection) {
  if (selection.downgradeSuppressedBy) return t('budgets.downgradeSuppressed');
  const contracts = selection.downgradeContracts ?? [];
  if (contracts.length === 0) return t('budgets.downgradeNone');
  // Named rather than counted: a chain that compiles on one contract and not another
  // is a fact about which callers get it, and a bare "yes" hides that.
  const named = contracts.map((contract) => translateCode('apiFamily', contract)).join(', ');
  return t('budgets.downgradeOnContracts', { value: named });
}

function renderModelSelection(selection) {
  if (selection === null) {
    elements.modelSelection.replaceChildren(
      createElement('p', 'empty-message', t('budgets.noModelSelection')),
    );
    return;
  }
  const cards = [
    [t('budgets.intent'), t(`intent.${selection.intent}`)],
    [t('budgets.notice'), t(`notice.${selection.substitutionNotice}`)],
    [t('budgets.downgrade'), describeDowngrade(selection)],
  ];
  elements.modelSelection.replaceChildren(...cards.map(([label, value]) => {
    const card = createElement('article', 'directory-summary-item');
    card.append(createElement('span', null, label), createElement('strong', null, value));
    return card;
  }));
}

/**
 * How much of the budget the period has used.
 *
 * The coverage is shown beside the total whenever the period has a gap, because the
 * measured number is lower than the truth and would otherwise read as room.
 */
function createBudgetConsumptionCell(consumption) {
  const cell = createElement('td');
  if (consumption.state === 'unmeasured') {
    cell.append(createElement('p', 'empty-message', translateCode('consumptionReason', consumption.reasonCode)));
    return cell;
  }

  const percent = createElement(
    'span',
    'status-label',
    t('budgets.consumedPercent', { value: formatNumber(consumption.consumedBasisPoints / 100) }),
  );
  percent.dataset.tone = consumption.overCap ? 'danger' : consumption.state === 'partial' ? 'warning' : 'success';
  cell.append(
    percent,
    createElement('p', 'policy-meta', t('budgets.consumedTokens', {
      value: formatNumber(consumption.consumedTokens),
    })),
  );

  // How far past the cap this period actually went. Stated as a floor on an incomplete
  // period: a gap lowers a total, so what is already over is over.
  if (consumption.overCap) {
    cell.append(
      createElement('p', 'policy-meta', t(
        consumption.state === 'partial' ? 'budgets.exceededByAtLeast' : 'budgets.exceededBy',
        { value: formatNumber(consumption.exceededByTokens) },
      )),
      createElement('p', 'policy-meta', t('budgets.exceededWhy')),
    );
  }

  if (consumption.state === 'partial') {
    cell.append(
      createElement('p', 'policy-meta', translateCode('consumptionReason', consumption.reasonCode)),
      createElement('p', 'policy-meta', t('budgets.windowsMissing', {
        value: formatNumber(consumption.windowsMissing),
      })),
    );
    return cell;
  }

  cell.append(
    createElement('p', 'policy-meta', t('budgets.remainingTokens', {
      value: formatNumber(consumption.remainingTokens),
    })),
  );
  return cell;
}

function createDerivationCell(record) {
  const cell = createElement('td');
  if (record.state === 'unenforceable') {
    const unenforceable = createElement(
      'span',
      'status-label',
      translateCode('budgetState', record.reasonCode),
    );
    unenforceable.dataset.tone = 'warning';
    cell.append(unenforceable);
    return cell;
  }
  cell.append(
    createElement('p', 'policy-meta', t('budgets.derivedAt', { value: formatTime(record.derivedAt) })),
  );
  return cell;
}

function renderBudgetRecords(model) {
  if (model.records.length === 0) {
    const row = createElement('tr');
    const cell = createElement('td', 'empty-message', t('budgets.none'));
    cell.colSpan = 8;
    row.append(cell);
    elements.budgetsBody.replaceChildren(row);
    return;
  }
  elements.budgetsBody.replaceChildren(...model.records.map((record) => {
    const row = createElement('tr');
    const identity = createElement('td');
    identity.append(
      createElement('strong', null, record.budgetCode),
      createElement('p', 'policy-meta', t(`budgetScope.${record.scopeKind}`)),
      createElement(
        'p',
        'policy-meta',
        record.modelScope === 'per-model'
          ? t('budgets.modelCoverage', { model: record.modelKey })
          : t('budgetModelScope.all-models'),
      ),
    );

    const action = createElement('td');
    action.append(createElement('span', 'status-label', t(`budgetAction.${record.action}`)));
    for (const tier of record.throttleTiers) {
      action.append(
        createElement('p', 'policy-meta', t('budgets.tierAt', {
          tier: tier.tierCode,
          value: formatNumber(tier.atBasisPoints / 100),
        })),
      );
    }

    const configured = createElement('td');
    configured.append(
      createElement(
        'strong',
        null,
        t('budgets.tokens', { value: formatNumber(record.configuredLimit.amount) }),
      ),
      createElement('p', 'policy-meta', t(`period.${record.period}`)),
    );

    const enforced = createElement('td');
    enforced.append(
      createElement(
        'strong',
        null,
        record.enforcedTokenQuota === null
          ? record.action === 'THROTTLE' && record.state === 'enforceable'
            ? t('budgets.noHardTokenQuota')
            : t('budgets.notEnforceable')
          : t('budgets.tokens', { value: formatNumber(record.enforcedTokenQuota) }),
      ),
    );
    if (record.warnThresholdPercent !== null) {
      enforced.append(
        createElement('p', 'policy-meta', t('budgets.warnAt', {
          value: formatNumber(record.warnThresholdPercent),
        })),
      );
    }

    const change = createElement('td');
    const edit = createElement('button', 'row-command', t('budgetEdit.open'));
    edit.type = 'button';
    // Hidden until renderBudgetAuthoring learns whether the server allows changing
    // this row at all; whether it does is answered after this row is already drawn.
    edit.hidden = true;
    edit.addEventListener('click', () => {
      openBudgetEdit(record);
    });
    change.append(edit);

    row.append(
      identity,
      action,
      configured,
      enforced,
      createBudgetConsumptionCell(record.consumption),
      createDerivationCell(record),
      change,
    );
    return row;
  }));
}

function renderBudgets(model) {
  showScreenContainer('budgets');
  renderViewer();
  elements.budgetsUpdatedAt.textContent = t('updatedAt', { value: formatTime(model.generatedAt) });
  renderBudgetQuality(model);
  renderModelSelection(model.modelSelection);
  renderBudgetRecords(model);
  hideBudgetEdit();
  renderBudgetAuthoring(model);
}

const BUDGET_REMOVAL_REASONS = Object.freeze([
  'replaced-by-team-caps',
  'no-longer-funded',
  'created-in-error',
  'moved-to-another-scope',
]);

/**
 * Adding and removing a cap, from the screen that shows the caps.
 *
 * Neither changes what the table says: a proposal is not in force, and a screen that
 * showed it would be describing a cap the gateway is not enforcing.
 */
function renderBudgetAuthoring(model) {
  refreshAuthoringAuthority().then((allowed) => {
    toggleBudgetRowEditButtons(allowed);
    if (!allowed) {
      elements.budgetAdd.hidden = true;
      return;
    }
    fillBudgetAuthoring(model);
  });
}

// The per-row edit button is created hidden by renderBudgetRecords, because whether
// it may be used is an answer the server gives asynchronously, after the row is drawn.
function toggleBudgetRowEditButtons(allowed) {
  for (const button of elements.budgetsBody.querySelectorAll('.row-command')) {
    button.hidden = !allowed;
  }
}

function budgetInput(id, field, value = '') {
  const input = document.createElement('input');
  input.id = id;
  input.dataset.budgetField = field;
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 63;
  input.value = value;
  return input;
}

function labelledBudgetInput(container, id, field, labelKey, value = '', labelValues = {}) {
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = t(labelKey, labelValues);
  const input = budgetInput(id, field, value);
  container.append(label, input);
  return input;
}

function labelledBudgetSelect(container, id, field, labelKey, entries, selected = '', labelValues = {}) {
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = t(labelKey, labelValues);
  const select = document.createElement('select');
  select.id = id;
  select.dataset.budgetField = field;
  fillOptions(select, entries, [selected]);
  container.append(label, select);
}

function renderBudgetThresholds(container, prefix, action, initial = {}) {
  container.replaceChildren();
  if (action === 'HARD_BLOCK') {
    labelledBudgetInput(
      container, `${prefix}-warning`, 'warnAtBasisPoints',
      'budgetAuthoring.warningLabel', initial.warnAtBasisPoints ?? '',
    );
    return;
  }
  if (action === 'SOFT_WARNING') {
    labelledBudgetInput(
      container, `${prefix}-grace`, 'graceBasisPoints',
      'budgetAdd.graceLabel', initial.graceBasisPoints ?? '',
    );
    return;
  }
  const tierCodes = accessOptions?.budgetOptions?.throttleTierCodes;
  if (!Array.isArray(tierCodes) || tierCodes.length === 0) {
    container.append(createElement('p', 'policy-meta', t('budgetAuthoring.throttleUnavailable')));
    return;
  }
  const help = createElement('p', 'policy-meta', t('budgetAuthoring.throttleHelp'));
  container.append(help);
  const rowCount = Math.min(4, Math.max(tierCodes.length, initial.tiers?.length ?? 0));
  for (let index = 0; index < rowCount; index += 1) {
    const tier = initial.tiers?.[index] ?? {};
    labelledBudgetInput(
      container, `${prefix}-tier-${index + 1}-at`, `tier-${index}-at`,
      'budgetAuthoring.tierAtLabel', tier.atBasisPoints ?? '', { value: index + 1 },
    );
    labelledBudgetSelect(
      container, `${prefix}-tier-${index + 1}-code`, `tier-${index}-code`,
      'budgetAuthoring.tierCodeLabel',
      [['', t('budgetAuthoring.tierCodePlaceholder')], ...tierCodes.map((code) => [code, code])],
      tier.tierCode ?? '',
      { value: index + 1 },
    );
  }
}

function readBudgetForm(prefix, source) {
  const edit = prefix === 'budget-edit';
  const thresholds = edit ? source.budgetEditThresholds : source.budgetAddThresholds;
  const value = (field) => thresholds.querySelector(`[data-budget-field="${field}"]`)?.value ?? '';
  return {
    scope: edit ? undefined : source.budgetAddScope.value,
    amount: edit ? source.budgetEditAmount.value : source.budgetAddAmount.value,
    action: edit ? source.budgetEditAction.value : source.budgetAddAction.value,
    modelScope: edit ? source.budgetEditModelScope.value : source.budgetAddModelScope.value,
    modelKey: edit ? source.budgetEditModelKey.value : source.budgetAddModelKey.value,
    period: edit ? source.budgetEditPeriod.value : source.budgetAddPeriod.value,
    warnAtBasisPoints: value('warnAtBasisPoints'),
    graceBasisPoints: value('graceBasisPoints'),
    tiers: Array.from({ length: 4 }, (_, index) => ({
      atBasisPoints: value(`tier-${index}-at`),
      tierCode: value(`tier-${index}-code`),
    })),
  };
}

function showBudgetValidation(result, errorElement) {
  errorElement.textContent = t(`budgetValidation.${result.error}`);
  const panel = errorElement.closest('.authoring-panel');
  const field = result.field === 'tiers'
    ? panel.querySelector('[data-budget-field^="tier-"]')
    : panel.querySelector(`[data-budget-field="${result.field}"], [id$="-${result.field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}"]`);
  field?.focus();
}

function fillBudgetAuthoring(model) {
  elements.budgetAddError.textContent = '';
  fillOptions(elements.budgetAddScope, BUDGET_SCOPES.map((scope) => [scope, t(`budgetScope.${scope}`)]));
  fillOptions(elements.budgetAddAction, BUDGET_ACTIONS.map((action) => [action, t(`budgetAction.${action}`)]));
  elements.budgetAddAction.querySelector('[value="THROTTLE"]').disabled =
    !(accessOptions?.budgetOptions?.throttleTierCodes?.length > 0);
  fillOptions(elements.budgetAddModelScope, BUDGET_MODEL_SCOPES.map((scope) => [scope, t(`budgetModelScope.${scope}`)]));
  fillOptions(elements.budgetAddModelKey, (accessOptions?.models ?? []).map((key) => [key, key]));
  fillOptions(elements.budgetAddPeriod, BUDGET_PERIODS.map((period) => [period, t(`period.${period}`)]), ['Monthly']);
  const updateAddModel = () => {
    const perModel = elements.budgetAddModelScope.value === 'per-model';
    elements.budgetAddModelKey.hidden = !perModel;
    elements.budgetAddModelKey.previousElementSibling.hidden = !perModel;
  };
  const updateAddThresholds = () => renderBudgetThresholds(
    elements.budgetAddThresholds,
    'budget-add',
    elements.budgetAddAction.value,
  );
  elements.budgetAddModelScope.onchange = updateAddModel;
  elements.budgetAddAction.onchange = updateAddThresholds;
  updateAddModel();
  updateAddThresholds();
  fillOptions(
    elements.budgetAddTarget,
    model.records.map((record) => [record.budgetCode, record.budgetCode]),
  );
  fillOptions(
    elements.budgetAddReason,
    BUDGET_REMOVAL_REASONS.map((code) => [code, `${translateCode('budgetRemovalReason', code)} (${code})`]),
  );

  const add = createElement('button', 'row-command', authoringText('budgetAdd.propose'));
  add.type = 'button';
  add.addEventListener('click', () => {
    const scope = elements.budgetAddScope.value;
    const result = buildBudgetAddPayload(
      readBudgetForm('budget-add', elements),
      {
        models: accessOptions?.models ?? [],
        throttleTierCodes: accessOptions?.budgetOptions?.throttleTierCodes,
      },
      `budget-${scope}-${Date.now().toString(36)}`,
    );
    if (!result.ok) {
      showBudgetValidation(result, elements.budgetAddError);
      return;
    }
    proposeAccessChange('budgetsWritePath', result.payload, elements.budgetAddError);
  });

  const remove = createElement('button', 'row-command', authoringText('budgetAdd.proposeRemoval'));
  remove.type = 'button';
  remove.dataset.tone = 'danger';
  remove.disabled = model.records.length === 0;
  remove.addEventListener('click', () => {
    proposeAccessChange('budgetsWritePath', {
      command: 'remove',
      budgetId: elements.budgetAddTarget.value,
      reasonCode: elements.budgetAddReason.value,
    }, elements.budgetAddError);
  });

  elements.budgetAddActions.replaceChildren(add, remove);
  elements.budgetAdd.hidden = false;
}

function hideBudgetEdit() {
  elements.budgetEdit.hidden = true;
  elements.budgetEditAmount.value = '';
  elements.budgetEditError.textContent = '';
  elements.budgetEditSubject.textContent = '';
  elements.budgetEditActions.replaceChildren();
  elements.budgetEditThresholds.replaceChildren();
}

function formatBudgetLimit(limit) {
  return t('budgets.tokens', { value: formatNumber(limit.amount) });
}

/**
 * A change to a budget is a proposal, not an edit that takes effect.
 *
 * The screen says so before the click and again after it, because a limit that reads
 * as changed while the gateway still enforces the old one is worse than no screen.
 */
function openBudgetEdit(record) {
  elements.budgetEditAmount.disabled = false;
  elements.budgetEditError.textContent = '';
  elements.budgetEditSubject.textContent = t('budgetEdit.subject', {
    budget: record.budgetCode,
    value: formatBudgetLimit(record.configuredLimit),
  });
  elements.budgetEditAmount.value = String(record.configuredLimit.amount);
  elements.budgetEditScope.value = t(`budgetScope.${record.scopeKind}`);
  fillOptions(elements.budgetEditModelScope, BUDGET_MODEL_SCOPES.map((scope) => [scope, t(`budgetModelScope.${scope}`)]), [record.modelScope]);
  fillOptions(elements.budgetEditModelKey, (accessOptions?.models ?? []).map((key) => [key, key]), [record.modelKey]);
  elements.budgetEditModelKey.value = record.modelKey ?? '';
  fillOptions(elements.budgetEditPeriod, BUDGET_PERIODS.map((period) => [period, t(`period.${period}`)]), [record.period]);
  fillOptions(elements.budgetEditAction, BUDGET_ACTIONS.map((action) => [action, t(`budgetAction.${action}`)]), [record.action]);
  elements.budgetEditAction.querySelector('[value="THROTTLE"]').disabled =
    !(accessOptions?.budgetOptions?.throttleTierCodes?.length > 0);
  const thresholdInitial = {
    warnAtBasisPoints: record.action === 'HARD_BLOCK'
      ? record.thresholds.warnAtBasisPoints ?? ''
      : '',
    graceBasisPoints: record.action === 'SOFT_WARNING'
      ? record.thresholds.graceBasisPoints
      : '',
    tiers: record.action === 'THROTTLE' ? record.thresholds.tiers : [],
  };
  const updateEditModel = () => {
    const perModel = elements.budgetEditModelScope.value === 'per-model';
    elements.budgetEditModelKey.hidden = !perModel;
    elements.budgetEditModelKey.previousElementSibling.hidden = !perModel;
  };
  const updateEditThresholds = () => renderBudgetThresholds(
    elements.budgetEditThresholds,
    'budget-edit',
    elements.budgetEditAction.value,
    elements.budgetEditAction.value === record.action ? thresholdInitial : {},
  );
  elements.budgetEditModelScope.onchange = updateEditModel;
  elements.budgetEditAction.onchange = updateEditThresholds;
  updateEditModel();
  updateEditThresholds();

  const confirm = createElement('button', 'row-command', authoringText('budgetEdit.confirm'));
  confirm.type = 'button';
  confirm.addEventListener('click', () => {
    const result = buildBudgetEditPayload(
      record,
      readBudgetForm('budget-edit', elements),
      {
        models: accessOptions?.models ?? [],
        throttleTierCodes: accessOptions?.budgetOptions?.throttleTierCodes,
      },
    );
    if (!result.ok) {
      showBudgetValidation(result, elements.budgetEditError);
      return;
    }
    proposeBudgetChange(result.payload);
  });

  const cancel = createElement('button', 'row-command', t('budgetEdit.cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', hideBudgetEdit);

  elements.budgetEditActions.replaceChildren(confirm, cancel);
  elements.budgetEdit.hidden = false;
  elements.budgetEditAmount.focus();
}

async function proposeBudgetChange(payload) {
  await proposeAccessChange(
    'budgetsWritePath',
    payload,
    elements.budgetEditError,
    (result) => {
      // The table is deliberately not refreshed to show the new number: a draft is
      // not in force, and an applied change is better read back from a reload.
      elements.budgetEditSubject.textContent = result.state === 'active'
        ? t('budgetEdit.applied', { value: formatNumber(payload.changes.amount) })
        : t('budgetEdit.proposed', { value: formatNumber(payload.changes.amount) });
      elements.budgetEditActions.replaceChildren();
      elements.budgetEditAmount.disabled = true;
    },
  );
}

/**
 * Proposing an access change from the screen that shows access.
 *
 * The options come from their own endpoint rather than from the directory read model,
 * because an edit needs the identifiers the projection deliberately does not carry.
 * Nothing here changes what the table shows: a proposal is not in force, and a screen
 * that displayed it would be describing policy the gateway is not enforcing.
 */
let accessOptions = null;
// Whether the acting principal may change governance at all. Reading it globally is
// not authority to change it, so the server decides and the panels follow.
let authoringAvailable = false;

async function refreshAuthoringAuthority() {
  try {
    const params = session.mode === 'local' ? `?persona=${elements.persona.value}` : '';
    const response = await fetch(`${api.baseUrl}${api.accessOptionsPath}${params}`, {
      headers: { Accept: 'application/json', ...(await session.getAuthorizationHeader()) },
    });
    authoringAvailable = response.ok;
    if (response.ok) accessOptions = await response.json();
  } catch {
    authoringAvailable = false;
  }
  return authoringAvailable;
}

function fillOptions(select, entries, selected = []) {
  select.replaceChildren(...entries.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = selected.includes(value);
    return option;
  }));
}

function describeBinding(binding) {
  return t('accessEdit.bindingOption', {
    target: binding.targetCode ?? t(`accessEdit.target.${binding.targetKind}`),
    kind: t(`accessEdit.target.${binding.targetKind}`),
    state: t(`entitlementState.${binding.state}`),
  });
}

function fillBindingModels() {
  const binding = accessOptions?.bindings.find(
    (entry) => entry.bindingCode === elements.accessEditBinding.value,
  );
  fillOptions(
    elements.accessEditModels,
    (accessOptions?.models ?? []).map((modelKey) => [modelKey, modelKey]),
    binding?.modelCodes ?? [],
  );
  fillLimitInputs({
    rpm: elements.accessEditRpm,
    tpm: elements.accessEditTpm,
    quota: elements.accessEditQuota,
    period: elements.accessEditPeriod,
  }, binding?.limits ?? {});
  const editable = binding?.state === 'active';
  elements.accessEditModels.disabled = !editable;
  elements.accessEditRpm.disabled = !editable;
  elements.accessEditTpm.disabled = !editable;
  elements.accessEditQuota.disabled = !editable;
  elements.accessEditPeriod.disabled = !editable;
  elements.accessEditState.textContent = binding === undefined
    ? ''
    : t('accessEdit.bindingState', { state: t(`entitlementState.${binding.state}`) });
  return binding;
}

function fillLimitInputs(controls, limits = {}) {
  controls.rpm.value = limits.requestsPerMinute ?? '';
  controls.tpm.value = limits.tokensPerMinute ?? '';
  controls.quota.value = limits.tokenQuota ?? '';
  fillOptions(controls.period, [
    ['', t('entitlementLimits.noQuotaPeriod')],
    ...QUOTA_PERIODS.map((period) => [period, t(`period.${period}`)]),
  ], [limits.quotaPeriod ?? '']);
}

function readLimitInputs(controls) {
  return {
    requestsPerMinute: controls.rpm.value,
    tokensPerMinute: controls.tpm.value,
    tokenQuota: controls.quota.value,
    quotaPeriod: controls.period.value,
  };
}

function showGovernanceValidation(result, target, focus) {
  target.textContent = t(`governanceValidation.${result.error}`);
  focus?.focus();
}

async function loadAccessOptions() {
  if (currentScreen !== 'users-groups') {
    elements.accessEdit.hidden = true;
    elements.subjectAdd.hidden = true;
    elements.assignmentAdd.hidden = true;
    elements.teamEdit.hidden = true;
    return;
  }
  if (!(await refreshAuthoringAuthority())) {
    // A reader who may not change access is not shown a panel that would refuse.
    elements.accessEdit.hidden = true;
    elements.subjectAdd.hidden = true;
    elements.assignmentAdd.hidden = true;
    elements.teamEdit.hidden = true;
    return;
  }
  if (currentScreen !== 'users-groups') return;

  elements.accessEditError.textContent = '';
  fillOptions(
    elements.accessEditBinding,
    accessOptions.bindings.map((binding) => [binding.bindingCode, describeBinding(binding)]),
  );
  fillOptions(
    elements.accessEditAssignment,
    accessOptions.assignments.map((assignment) => [
      assignment.assignmentCode,
      t('accessEdit.assignmentOption', {
        role: assignment.roleCode,
        assignee: assignment.assigneeCode,
      }),
    ]),
  );
  fillOptions(
    elements.accessEditReason,
    accessOptions.revocationReasonCodes.map((code) => [
      code,
      `${translateCode('revocationReason', code)} (${code})`,
    ]),
  );

  const entitlement = createElement('button', 'row-command', authoringText('accessEdit.proposeEntitlement'));
  entitlement.type = 'button';
  entitlement.addEventListener('click', () => {
    const binding = accessOptions.bindings.find(
      (entry) => entry.bindingCode === elements.accessEditBinding.value,
    );
    const result = buildEntitlementEditPayload(binding, {
      modelCodes: [...elements.accessEditModels.selectedOptions].map((option) => option.value),
      ...readLimitInputs({
        rpm: elements.accessEditRpm,
        tpm: elements.accessEditTpm,
        quota: elements.accessEditQuota,
        period: elements.accessEditPeriod,
      }),
    });
    if (!result.ok) {
      showGovernanceValidation(result, elements.accessEditError, elements.accessEditModels);
      return;
    }
    proposeAccessChange('entitlementsWritePath', result.payload, elements.accessEditError);
  });

  const revoke = createElement('button', 'row-command', authoringText('accessEdit.proposeRevocation'));
  revoke.type = 'button';
  revoke.dataset.tone = 'danger';
  revoke.disabled = accessOptions.assignments.length === 0;
  revoke.addEventListener('click', () => {
    proposeAccessChange('assignmentsWritePath', {
      command: 'revoke',
      assignmentId: elements.accessEditAssignment.value,
      reasonCode: elements.accessEditReason.value,
    }, elements.accessEditError);
  });

  const retire = createElement('button', 'row-command', authoringText('accessEdit.proposeRetirement'));
  retire.type = 'button';
  retire.dataset.tone = 'danger';
  retire.addEventListener('click', () => {
    const binding = accessOptions.bindings.find(
      (entry) => entry.bindingCode === elements.accessEditBinding.value,
    );
    const result = buildEntitlementStatePayload(binding, 'revoked');
    if (!result.ok) {
      showGovernanceValidation(result, elements.accessEditError, elements.accessEditBinding);
      return;
    }
    proposeAccessChange('entitlementsWritePath', result.payload, elements.accessEditError);
  });

  const restore = createElement('button', 'row-command', authoringText('accessEdit.proposeRestoration'));
  restore.type = 'button';
  restore.addEventListener('click', () => {
    const binding = accessOptions.bindings.find(
      (entry) => entry.bindingCode === elements.accessEditBinding.value,
    );
    const result = buildEntitlementStatePayload(binding, 'active');
    if (!result.ok) {
      showGovernanceValidation(result, elements.accessEditError, elements.accessEditBinding);
      return;
    }
    proposeAccessChange('entitlementsWritePath', result.payload, elements.accessEditError);
  });

  function refreshBindingEditor() {
    const binding = fillBindingModels();
    entitlement.hidden = binding?.state !== 'active';
    retire.hidden = binding?.state !== 'active' || binding.targetKind === 'global';
    restore.hidden = binding?.state !== 'revoked' || binding.canRestore !== true;
  }

  elements.accessEditBinding.onchange = refreshBindingEditor;
  elements.accessEditActions.replaceChildren(entitlement, retire, restore, revoke);
  refreshBindingEditor();
  elements.accessEdit.hidden = false;
  fillSubjectAuthoring();
  fillAssignmentAuthoring();
  fillTeamAuthoring();
}

async function showUsersGroupsAuthoringAlongsideState() {
  elements.usersGroupsContent.hidden = false;
  for (const panel of elements.directoryReadingPanels) panel.hidden = true;
  await loadAccessOptions();
}

/** Bringing a person, application, or existing team under governance. */
function fillSubjectAuthoring() {
  elements.subjectAddError.textContent = '';
  fillOptions(elements.subjectAddKind, [
    ['subject', t('accessEdit.target.subject')],
    ['team', t('accessEdit.target.team')],
    ['application', t('accessEdit.target.application')],
  ]);
  fillOptions(
    elements.subjectAddTeam,
    accessOptions.teams.map((team) => [team.teamCode, team.teamCode]),
  );
  fillOptions(
    elements.subjectAddModels,
    accessOptions.models.map((modelCode) => [modelCode, modelCode]),
  );
  fillOptions(
    elements.subjectAddReason,
    accessOptions.grantReasonCodes.map((code) => [code, `${translateCode('grantReason', code)} (${code})`]),
  );
  fillLimitInputs({
    rpm: elements.subjectAddRpm,
    tpm: elements.subjectAddTpm,
    quota: elements.subjectAddQuota,
    period: elements.subjectAddPeriod,
  });

  const updateTargetInput = () => {
    const team = elements.subjectAddKind.value === 'team';
    elements.subjectAddKey.hidden = team;
    elements.subjectAddKey.previousElementSibling.hidden = team;
    elements.subjectAddTeam.hidden = !team;
    elements.subjectAddTeam.previousElementSibling.hidden = !team;
  };
  elements.subjectAddKind.onchange = updateTargetInput;
  updateTargetInput();

  const add = createElement('button', 'row-command', authoringText('subjectAdd.propose'));
  add.type = 'button';
  add.addEventListener('click', () => {
    const result = buildEntitlementAddPayload({
      bindingId: elements.subjectAddId.value,
      targetKind: elements.subjectAddKind.value,
      targetKey: elements.subjectAddKind.value === 'team'
        ? elements.subjectAddTeam.value
        : elements.subjectAddKey.value,
      modelCodes: [...elements.subjectAddModels.selectedOptions].map((option) => option.value),
      reasonCode: elements.subjectAddReason.value,
      ...readLimitInputs({
        rpm: elements.subjectAddRpm,
        tpm: elements.subjectAddTpm,
        quota: elements.subjectAddQuota,
        period: elements.subjectAddPeriod,
      }),
    });
    if (!result.ok) {
      showGovernanceValidation(result, elements.subjectAddError, elements.subjectAddKey);
      return;
    }
    proposeAccessChange('entitlementsWritePath', result.payload, elements.subjectAddError);
  });
  elements.subjectAddActions.replaceChildren(add);
  elements.subjectAdd.hidden = false;
}

function fillAssignmentAuthoring() {
  elements.assignmentAddError.textContent = '';
  fillOptions(
    elements.assignmentAddRole,
    accessOptions.assignmentGrantRules.map((rule) => [
      rule.roleCode,
      t(`assignmentAdd.role.${rule.roleCode}`),
    ]),
  );
  fillOptions(
    elements.assignmentAddScopeKey,
    accessOptions.teams.map((team) => [team.teamCode, team.teamCode]),
  );
  const updateScopeVisibility = () => {
    const teamScoped = elements.assignmentAddScopeKind.value === 'team';
    elements.assignmentAddScopeKey.hidden = !teamScoped;
    elements.assignmentAddScopeKey.previousElementSibling.hidden = !teamScoped;
  };
  const updateRule = () => {
    const rule = accessOptions.assignmentGrantRules.find(
      (entry) => entry.roleCode === elements.assignmentAddRole.value,
    );
    fillOptions(
      elements.assignmentAddAssigneeKind,
      rule.assigneeKinds.map((kind) => [kind, t(`assignmentAdd.assignee.${kind}`)]),
    );
    fillOptions(
      elements.assignmentAddScopeKind,
      rule.scopeKinds.map((kind) => [kind, t(`assignmentAdd.scope.${kind}`)]),
    );
    updateScopeVisibility();
  };
  elements.assignmentAddRole.onchange = updateRule;
  elements.assignmentAddScopeKind.onchange = updateScopeVisibility;
  updateRule();

  const grant = createElement('button', 'row-command', authoringText('assignmentAdd.propose'));
  grant.type = 'button';
  grant.addEventListener('click', () => {
    const rule = accessOptions.assignmentGrantRules.find(
      (entry) => entry.roleCode === elements.assignmentAddRole.value,
    );
    const result = buildAssignmentGrantPayload({
      assignmentId: elements.assignmentAddId.value,
      roleCode: elements.assignmentAddRole.value,
      assigneeKind: elements.assignmentAddAssigneeKind.value,
      assigneeKey: elements.assignmentAddAssigneeKey.value,
      scopeKind: elements.assignmentAddScopeKind.value,
      scopeKey: elements.assignmentAddScopeKey.value,
      reasonCode: elements.assignmentAddReason.value,
    }, rule);
    if (!result.ok) {
      showGovernanceValidation(result, elements.assignmentAddError, elements.assignmentAddId);
      return;
    }
    proposeAccessChange('assignmentsWritePath', result.payload, elements.assignmentAddError);
  });
  elements.assignmentAddActions.replaceChildren(grant);
  elements.assignmentAdd.hidden = false;
}

/**
 * A team is offered for removal with the bindings that target it, because removal is
 * refused while any remain and an administrator should see that before pressing.
 */
function fillTeamAuthoring() {
  elements.teamEditError.textContent = '';
  fillOptions(
    elements.teamEditExisting,
    accessOptions.teams.map((team) => [
      team.teamCode,
      t('teamEdit.existingOption', { team: team.teamCode, count: team.bindingCodes.length }),
    ]),
  );
  fillOptions(
    elements.teamEditReason,
    accessOptions.teamRemovalReasonCodes.map((code) => [
      code,
      `${translateCode('teamRemovalReason', code)} (${code})`,
    ]),
  );

  const add = createElement('button', 'row-command', authoringText('teamEdit.proposeAdd'));
  add.type = 'button';
  add.addEventListener('click', () => {
    const teamKey = elements.teamEditKey.value.trim();
    const membershipGroupId = elements.teamEditGroup.value.trim();
    if (teamKey.length === 0 || membershipGroupId.length === 0) {
      elements.teamEditError.textContent = t('teamEdit.bothRequired');
      (teamKey.length === 0 ? elements.teamEditKey : elements.teamEditGroup).focus();
      return;
    }
    proposeAccessChange('teamsWritePath', {
      command: 'add',
      teamKey,
      membershipGroupId,
    }, elements.teamEditError);
  });

  const remove = createElement('button', 'row-command', authoringText('teamEdit.proposeRemove'));
  remove.type = 'button';
  remove.dataset.tone = 'danger';
  remove.addEventListener('click', () => {
    proposeAccessChange('teamsWritePath', {
      command: 'remove',
      teamKey: elements.teamEditExisting.value,
      reasonCode: elements.teamEditReason.value,
    }, elements.teamEditError);
  });

  elements.teamEditActions.replaceChildren(add, remove);
  elements.teamEdit.hidden = false;
}

async function proposeAccessChange(pathKey, body, target = elements.accessEditError, onSuccess) {
  try {
    const params = session.mode === 'local' ? `?persona=${elements.persona.value}` : '';
    const response = await fetch(`${api.baseUrl}${api[pathKey]}${params}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await session.getAuthorizationHeader()),
      },
      // A deployment derives the actor from the validated token, so sending one
      // would let the screen sign a name it has no standing to claim.
      body: JSON.stringify(session.mode === 'local' ? { ...body, actor: 'local-auditor' } : body),
    });
    const result = await response.json();
    if (!response.ok) {
      target.textContent = translateCode(
        'accessEditRefusal',
        result.reasonCode ?? result.error?.code ?? 'propose_failed',
      );
      return;
    }
    if (onSuccess) {
      onSuccess(result);
      return;
    }
    target.textContent = result.state === 'active'
      ? t('accessEdit.applied', { revision: result.revisionId })
      : t('accessEdit.proposed', { revision: result.revisionId });
  } catch {
    target.textContent = t('accessEdit.unavailable');
  }
}

function renderUsageQuality(model) {
  const complete = model.quality.state === 'complete' && model.quality.freshnessState === 'fresh';
  elements.usageQualityBanner.classList.toggle('is-fresh', complete);
  elements.usageQualityTitle.textContent = complete
    ? t('usage.windowComplete')
    : model.quality.state === 'complete'
      ? t('usage.window.stale')
      : t(`usage.window.${model.quality.state}`);
  const pairs = [
    [t('usage.windowStart'), formatTime(model.window.windowStart)],
    [t('usage.windowEnd'), formatTime(model.window.windowEnd)],
    [t('usage.asOf'), formatTime(model.window.asOf)],
    [t('usage.reportedAt'), formatTime(model.window.reportedAt)],
    [t('usage.ingestionLag'), t('usage.lagMinutes', {
      value: formatNumber(Math.round(model.window.lagSeconds / 60)),
    })],
    [t('usage.completeness'), translateCode('usageReason', model.window.completenessReason ?? 'none')],
  ];
  elements.usageQualityDetails.replaceChildren(...pairs.flatMap(([label, value]) => [
    createElement('dt', null, label),
    createElement('dd', null, value),
  ]));
}

function renderUsageSummary(model) {
  if (!model.quality.countsMeasured) {
    elements.usageSummary.replaceChildren(
      createElement('p', 'empty-message', t('usage.notMeasured', {
        reason: translateCode('usageReason', model.quality.reasonCode),
      })),
    );
    return;
  }
  const totals = model.totals;
  const items = [
    [t('usage.requests'), formatNumber(totals.requests)],
    [t('usage.totalTokens'), formatNumber(totals.totalTokens)],
    [t('usage.promptTokens'), formatNumber(totals.promptTokens)],
    [t('usage.completionTokens'), formatNumber(totals.completionTokens)],
    [t('usage.refused'), formatNumber(totals.outcomes.refused)],
  ];
  elements.usageSummary.replaceChildren(...items.map(([label, value]) => {
    const item = createElement('article', 'directory-summary-item');
    item.append(createElement('span', null, label), createElement('strong', null, value));
    return item;
  }));
}

function renderUsageRecords(model) {
  if (model.records.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement(
      'td',
      'empty-message',
      model.quality.countsMeasured
        ? t('usage.noUsage')
        : t('usage.notMeasured', { reason: translateCode('usageReason', model.quality.reasonCode) }),
    );
    cell.colSpan = 6;
    row.append(cell);
    elements.usageBody.replaceChildren(row);
    return;
  }
  elements.usageBody.replaceChildren(...model.records.map((record) => {
    const row = document.createElement('tr');

    const identity = createElement('td');
    identity.append(
      createElement('strong', null, record.entityKey),
      createElement('p', 'policy-meta', t(`usage.entityKind.${record.entityKind}`)),
    );

    const requests = createElement('td');
    requests.append(createElement('strong', null, formatNumber(record.requests)));
    for (const outcome of ['served', 'refused', 'failed']) {
      if (record.outcomes[outcome] === 0) continue;
      requests.append(
        createElement('p', 'policy-meta', t('usage.outcomeCount', {
          outcome: t(`usage.outcome.${outcome}`),
          value: formatNumber(record.outcomes[outcome]),
        })),
      );
    }

    const tokens = createElement('td');
    tokens.append(
      createElement('strong', null, formatNumber(record.totalTokens)),
      createElement('p', 'policy-meta', t('usage.tokenSplit', {
        prompt: formatNumber(record.promptTokens),
        completion: formatNumber(record.completionTokens),
      })),
    );

    const models = createElement('td');
    for (const entry of record.byModel) {
      models.append(
        createElement('p', 'policy-meta', t('usage.modelShare', {
          model: entry.modelKey,
          requests: formatNumber(entry.requests),
          tokens: formatNumber(entry.totalTokens),
        })),
      );
      // What was asked for and what served it are different facts, and a row that showed
      // only the second would make a downgrade invisible to the person paying for it.
      if (entry.substitutedRequests > 0) {
        models.append(
          createElement('p', 'policy-meta', t('usage.modelSubstituted', {
            value: formatNumber(entry.substitutedRequests),
            requested: entry.requestedModelKeys.filter((key) => key !== entry.modelKey).join(', '),
          })),
        );
      }
    }

    const quality = createElement('td');
    const label = createElement('span', 'status-label', t(`quality.${record.tokenQuality}`));
    label.dataset.tone = record.tokenQuality === 'reported' ? 'success' : 'warning';
    quality.append(label, createAttributionNote(record.attribution));

    row.append(identity, requests, tokens, models, quality);
    return row;
  }));
}

/**
 * How well the calling application is known.
 *
 * Naming a specific agent for a request that arrived through a shared developer tool
 * would attribute work to something nobody established, so the aggregate says which
 * requests it can and cannot speak for rather than presenting one number.
 */
function createAttributionNote(attribution) {
  const note = createElement('p', 'policy-meta', t(`usage.attribution.${attribution.state}`));
  if (attribution.state !== 'mixed') return note;
  note.textContent = t('usage.attributionMixed', {
    strong: formatNumber(attribution.strongRequests),
    generic: formatNumber(attribution.genericRequests),
    unavailable: formatNumber(attribution.unavailableRequests),
  });
  return note;
}

function renderUsage(model) {
  showScreenContainer('usage');
  renderViewer();
  elements.usageUpdatedAt.textContent = t('updatedAt', { value: formatTime(model.generatedAt) });
  renderUsageQuality(model);
  renderUsageSummary(model);
  renderUsageRecords(model);
}

function renderModelQuality(model) {
  const healthy = model.registry.state === 'complete'
    && model.quality.countsMeasured
    && model.quality.freshnessState === 'fresh';
  elements.modelsQualityBanner.classList.toggle('is-fresh', healthy);
  elements.modelsQualityTitle.textContent = t(`models.catalogue.${model.registry.state}`);
  const pairs = [
    [t('models.catalogueVersion'), model.registry.version === null ? t('state.unknown') : String(model.registry.version)],
    [t('models.capturedAt'), model.registry.capturedAt === null ? t('state.unknown') : formatTime(model.registry.capturedAt)],
    [t('models.expiresAt'), model.registry.expiresAt === null ? t('state.unknown') : formatTime(model.registry.expiresAt)],
    [t('usage.reportedAt'), formatTime(model.window.reportedAt)],
    [t('usage.ingestionLag'), t('usage.lagMinutes', {
      value: formatNumber(Math.round(model.window.lagSeconds / 60)),
    })],
    [t('usage.completeness'), translateCode('usageReason', model.window.completenessReason ?? 'none')],
    [t('models.providerQuotaSource'), t(`models.quotaState.${model.quality.providerQuotaState}`)],
    [
      t('models.quotaCapturedAt'),
      model.quality.providerQuotaCapturedAt === null
        ? t('state.unknown')
        : formatTime(model.quality.providerQuotaCapturedAt),
    ],
  ];
  elements.modelsQualityDetails.replaceChildren(...pairs.flatMap(([label, value]) => [
    createElement('dt', null, label),
    createElement('dd', null, value),
  ]));
}

function createCapabilityCell(record) {
  const cell = createElement('td');
  if (record.registrationState !== 'registered') {
    cell.append(createElement('p', 'policy-meta', t('models.unregisteredDetail')));
    return cell;
  }
  cell.append(
    createElement(
      'p',
      'policy-meta',
      record.apiFamilies.map((family) => t(`apiFamily.${family}`)).join(' · '),
    ),
    // Shown rather than enforced: the operator chose this policy when deploying the
    // model, so a downgrade between two of their deployments is between two of their
    // own choices.
    createElement(
      'p',
      'policy-meta',
      record.safetyPolicy === null
        ? t('models.noSafetyPolicy')
        : t('models.safetyPolicy', { value: record.safetyPolicy }),
    ),
  );
  const agreement = createElement(
    'span',
    'status-label',
    t(`models.providerAgreement.${record.providerAgreement.state}`),
  );
  agreement.dataset.tone = record.providerAgreement.state === 'agrees'
    ? 'success'
    : record.providerAgreement.state === 'unverified' ? 'warning' : 'danger';
  cell.append(agreement);
  if (record.providerAgreement.changedFields.length > 0) {
    cell.append(createElement('p', 'policy-meta', t('models.providerAgreement.changedFields', {
      fields: record.providerAgreement.changedFields
        .map((field) => t(`models.providerField.${field}`))
        .join(' · '),
    })));
  }
  return cell;
}

function createInternalLimitsCell(limits) {
  const cell = createElement('td');
  if (limits === null) {
    cell.append(createElement('p', 'empty-message', t('models.noEntitlement')));
    return cell;
  }
  cell.append(
    createElement('strong', null, t('models.rateRange', {
      min: formatNumber(limits.requestsPerMinute.min),
      max: formatNumber(limits.requestsPerMinute.max),
    })),
    createElement('p', 'policy-meta', t('models.tokenRateRange', {
      min: formatNumber(limits.tokensPerMinute.min),
      max: formatNumber(limits.tokensPerMinute.max),
    })),
    // The range exists because the limit belongs to an entitlement, not to the model.
    createElement('p', 'policy-meta', t('models.grantingBindings', {
      value: formatNumber(limits.grantingBindings),
    })),
  );
  return cell;
}

function createConsumptionCell(record, countsMeasured) {
  const cell = createElement('td');
  if (!countsMeasured || record.consumption === null) {
    cell.append(
      createElement('p', 'empty-message', countsMeasured ? t('models.noTraffic') : t('models.notMeasured')),
    );
    return cell;
  }
  const { consumption } = record;
  cell.append(
    createElement('strong', null, t('models.requestsAndTokens', {
      requests: formatNumber(consumption.requests),
      tokens: formatNumber(consumption.totalTokens),
    })),
    createElement('p', 'policy-meta', t('models.failedAndRefused', {
      failed: formatNumber(consumption.outcomes.failed),
      refused: formatNumber(consumption.outcomes.refused),
    })),
  );
  const quality = createElement('span', 'status-label', t(`quality.${consumption.tokenQuality}`));
  quality.dataset.tone = consumption.tokenQuality === 'reported' ? 'success' : 'warning';
  cell.append(quality);
  return cell;
}

// Allocation, not consumption. A quota nobody could read says why; rendering it as
// 0% would read as free capacity, and calling it "used" would read as spent tokens.
function createProviderQuotaCell(quota) {
  const cell = createElement('td');
  if (quota.source !== 'provider-deployment') {
    cell.append(
      createElement('strong', null, t('state.unknown')),
      createElement('p', 'policy-meta', translateCode('quotaReason', quota.reasonCode)),
    );
    return cell;
  }
  if (quota.pool === null) {
    cell.append(
      createElement('strong', null, t('models.deploymentRate', {
        requests: quota.requestsPerMinute === null ? t('state.unknown') : formatNumber(quota.requestsPerMinute),
        tokens: quota.tokensPerMinute === null ? t('state.unknown') : formatNumber(quota.tokensPerMinute),
      })),
      createElement('p', 'policy-meta', translateCode('quotaReason', quota.reasonCode)),
    );
    return cell;
  }
  cell.append(
    createElement('strong', null, t('models.poolAllocation', {
      allocated: formatNumber(quota.pool.allocated),
      limit: formatNumber(quota.pool.limit),
    })),
  );
  const state = createElement(
    'span',
    'status-label',
    quota.pool.fullyAllocated
      ? t('models.poolFullyAllocated')
      : t('models.poolAllocatable', { value: formatNumber(quota.pool.allocatable) }),
  );
  state.dataset.tone = quota.pool.fullyAllocated ? 'warning' : 'success';
  cell.append(
    state,
    createElement('p', 'policy-meta', t('models.deploymentRate', {
      requests: quota.requestsPerMinute === null ? t('state.unknown') : formatNumber(quota.requestsPerMinute),
      tokens: quota.tokensPerMinute === null ? t('state.unknown') : formatNumber(quota.tokensPerMinute),
    })),
    createElement('p', 'policy-meta', quota.deploymentName),
    createElement('p', 'policy-meta', t('models.allocationNotUsage')),
  );
  if (quota.pool.matchQuality === 'normalized') {
    cell.append(createElement('p', 'policy-meta', t('models.poolNormalised')));
  }
  return cell;
}

function renderModelRecords(model) {
  if (model.records.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement('td', 'empty-message', t('models.none'));
    cell.colSpan = 6;
    row.append(cell);
    elements.modelsBody.replaceChildren(row);
    return;
  }
  elements.modelsBody.replaceChildren(...model.records.map((record) => {
    const row = document.createElement('tr');

    const identity = createElement('td');
    identity.append(createElement('strong', null, record.modelKey));
    const state = createElement(
      'span',
      'status-label',
      record.registrationState === 'registered'
        ? t(`lifecycle.${record.lifecycle}`)
        : t('models.unregistered'),
    );
    state.dataset.tone = record.registrationState !== 'registered'
      ? 'danger'
      : record.lifecycle === 'generally-available' ? 'success' : 'warning';
    identity.append(state);
    identity.append(
      createElement('p', 'policy-meta', record.providerCode ?? t('state.unknown')),
    );

    row.append(
      identity,
      createCapabilityCell(record),
      createInternalLimitsCell(record.internalLimits),
      createProviderQuotaCell(record.providerQuota),
      createConsumptionCell(record, model.quality.countsMeasured),
    );
    return row;
  }));
}

function renderModelCatalogue(model) {
  showScreenContainer('models');
  renderViewer();
  elements.modelsUpdatedAt.textContent = t('updatedAt', { value: formatTime(model.generatedAt) });
  renderModelQuality(model);
  renderModelRecords(model);
  renderModelAuthoring(model);
  renderModelPrices();
}

const MODEL_REMOVAL_REASONS = Object.freeze([
  'retired-by-provider',
  'replaced-by-newer-model',
  'no-longer-approved',
  'added-in-error',
]);

/**
 * Bringing a deployment the provider already serves under governance, and taking one
 * back out.
 *
 * Nothing about the model is typed. The administrator names a deployment and everything
 * the catalogue keeps is read from the provider's own answer about it, which is why the
 * panel has no fields for what a model can do or what it costs.
 */
function renderModelAuthoring(model) {
  if (!runtimeCapabilities.modelAuthoring) {
    elements.modelAdd.hidden = true;
    return;
  }
  refreshAuthoringAuthority().then((allowed) => {
    if (!allowed) {
      elements.modelAdd.hidden = true;
      return;
    }
    fillModelAuthoring(model);
  });
}

function fillModelAuthoring(model) {
  elements.modelAddError.textContent = '';
  const governed = model.records.filter((record) => record.registrationState === 'registered');
  fillOptions(
    elements.modelAddDeployment,
    model.available.map((deployment) => [
      deployment.deploymentName,
      t('modelAdd.deploymentOption', {
        deployment: deployment.deploymentName,
        model: deployment.modelName,
      }),
    ]),
  );
  fillOptions(elements.modelAddTarget, governed.map((record) => [record.modelKey, record.modelKey]));
  fillOptions(
    elements.modelAddReason,
    MODEL_REMOVAL_REASONS.map((code) => [code, `${translateCode('modelRemovalReason', code)} (${code})`]),
  );

  const add = createElement('button', 'row-command', t('modelAdd.add'));
  add.type = 'button';
  // A deployment already in the catalogue is not offered, so an empty list means the
  // provider is serving nothing this catalogue does not already carry.
  add.disabled = model.available.length === 0;
  add.addEventListener('click', () => {
    proposeAccessChange('modelsWritePath', {
      command: 'add',
      deploymentName: elements.modelAddDeployment.value,
    }, elements.modelAddError);
  });

  const remove = createElement('button', 'row-command', t('modelAdd.remove'));
  remove.type = 'button';
  remove.dataset.tone = 'danger';
  remove.disabled = governed.length === 0;
  remove.addEventListener('click', () => {
    proposeAccessChange('modelsWritePath', {
      command: 'remove',
      modelKey: elements.modelAddTarget.value,
      reasonCode: elements.modelAddReason.value,
    }, elements.modelAddError);
  });

  const recapture = createElement('button', 'row-command', t('modelAdd.recapture'));
  recapture.type = 'button';
  recapture.disabled = governed.length === 0;
  recapture.addEventListener('click', () => {
    proposeAccessChange('modelsWritePath', {
      command: 'recapture',
    }, elements.modelAddError);
  });

  elements.modelAddActions.replaceChildren(add, remove, recapture);
  elements.modelAdd.hidden = false;
}

/**
 * The published meters, on request.
 *
 * Collapsed and fetched only when a reader opens it, because the price list is a paged
 * source of well over a thousand meters and no decision on this screen depends on it.
 */
function renderModelPrices() {
  elements.modelPrices.hidden = !runtimeCapabilities.modelPrices;
  if (!runtimeCapabilities.modelPrices) return;
  elements.modelPricesBody.hidden = true;
  elements.modelPricesBody.replaceChildren();

  const toggle = createElement('button', 'row-command', t('modelPrices.show'));
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'model-prices-body');
  toggle.addEventListener('click', async () => {
    if (!elements.modelPricesBody.hidden) {
      elements.modelPricesBody.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = t('modelPrices.show');
      return;
    }
    toggle.disabled = true;
    await loadModelPrices();
    toggle.disabled = false;
    elements.modelPricesBody.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    toggle.textContent = t('modelPrices.hide');
  });
  elements.modelPricesActions.replaceChildren(toggle);
}

async function loadModelPrices() {
  try {
    const response = await fetch(`${api.baseUrl}${api.modelPricesPath}`, {
      headers: { Accept: 'application/json', ...(await session.getAuthorizationHeader()) },
    });
    const payload = await response.json();
    if (!response.ok) {
      elements.modelPricesBody.replaceChildren(
        createElement(
          'p',
          'empty-message',
          translateCode('modelPriceReason', payload.error?.code ?? 'model_prices_failed'),
        ),
      );
      return;
    }
    renderModelPriceTable(payload);
  } catch {
    elements.modelPricesBody.replaceChildren(
      createElement('p', 'empty-message', t('modelPrices.unavailable')),
    );
  }
}

function renderModelPriceTable(prices) {
  const table = createElement('table', 'directory-table');
  table.append(
    createElement('caption', null, t('modelPrices.caption', {
      region: prices.region ?? t('state.unknown'),
    })),
  );

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const key of ['modelPrices.deployment', 'modelPrices.meter', 'modelPrices.price']) {
    const heading = createElement('th', null, t(key));
    heading.scope = 'col';
    headRow.append(heading);
  }
  head.append(headRow);

  const body = document.createElement('tbody');
  for (const deployment of prices.deployments) {
    // A deployment the price list says nothing about still gets a row. An absent one
    // would read as a model with no meters, which is not the same as a model with no
    // price published for it.
    const meters = deployment.rows.length === 0 ? [null] : deployment.rows;
    meters.forEach((meter, index) => {
      const row = document.createElement('tr');
      const identity = createElement('td');
      if (index === 0) {
        identity.append(createElement('strong', null, deployment.deploymentName));
        const state = createElement('span', 'status-label', t(`modelPrices.match.${deployment.match}`));
        state.dataset.tone = deployment.match === 'exact'
          ? 'success'
          : deployment.match === 'closest' ? 'warning' : 'danger';
        identity.append(state, createElement('p', 'policy-meta', deployment.modelName));
      }
      row.append(identity);
      if (meter === null) {
        const empty = createElement('td', 'empty-message', t('modelPrices.noMeter'));
        empty.colSpan = 2;
        row.append(empty);
      } else {
        row.append(
          createElement('td', null, meter.meterName),
          // Rendered as the list publishes it, price and unit together and neither
          // converted, because a converted rate would be this product asserting one.
          createElement('td', null, t('modelPrices.perUnit', {
            price: `${meter.retailPrice} ${meter.currencyCode}`,
            unit: meter.unitOfMeasure,
          })),
        );
      }
      body.append(row);
    });
  }

  table.append(head, body);
  const wrap = createElement('div', 'table-wrap directory-table-wrap');
  wrap.append(table);
  elements.modelPricesBody.replaceChildren(wrap);
}

function renderFallbackQuality(model) {
  const accepted = model.quality.state === 'complete';
  elements.fallbackQualityBanner.classList.toggle('is-fresh', accepted);
  elements.fallbackQualityTitle.textContent = t(`fallback.plan.${model.quality.state}`);
  const authored = model.authored;
  const pairs = authored === null
    ? [[t('fallback.planState'), translateCode('fallbackReason', model.quality.reasonCode)]]
    : [
        [t('fallback.planCode'), `${authored.planCode} · v${authored.planVersion}`],
        [t('fallback.planTarget'), `${t(`fallbackTarget.${authored.targetKind}`)}${authored.targetCode === null ? '' : `: ${authored.targetCode}`}`],
        [t('fallback.optIn'), authored.optedIn ? t('fallback.optedIn') : t('fallback.notOptedIn')],
        [t('fallback.planState'), t(`recordState.${authored.state}`)],
        [t('fallback.validity'), `${formatTime(authored.validFrom)} — ${authored.validUntil === null ? t('fallback.openEnded') : formatTime(authored.validUntil)}`],
        [t('fallback.authoringVerdict'), translateCode('fallbackReason', authored.authoringReasonCode)],
      ];
  elements.fallbackQualityDetails.replaceChildren(...pairs.flatMap(([label, value]) => [
    createElement('dt', null, label),
    createElement('dd', null, value),
  ]));
}

function renderFallbackDecision(model) {
  const decision = model.decision;
  if (decision === null) {
    elements.fallbackDecision.replaceChildren(
      createElement('p', 'empty-message', t('fallback.noDecision')),
    );
    return;
  }
  const items = [
    [t('fallback.requested'), decision.requested.modelKey],
    [
      t('fallback.effective'),
      decision.effective === null ? t('fallback.deniedNoModel') : decision.effective.modelKey,
    ],
    [t('fallback.hops'), formatNumber(decision.hops)],
    [t('fallback.intent'), t(`intent.${decision.modelSelectionIntent}`)],
    [t('fallback.trigger'), t(`fallback.trigger.${decision.triggerKind}`)],
    [t('fallback.configVersion'), String(decision.configVersion ?? t('state.unknown'))],
  ];
  elements.fallbackDecision.replaceChildren(...items.map(([label, value]) => {
    const item = createElement('article', 'directory-summary-item');
    item.append(createElement('span', null, label), createElement('strong', null, value));
    return item;
  }));

  const outcome = createElement('article', 'directory-summary-item');
  const label = createElement('span', 'status-label', translateCode('fallbackReason', decision.reasonCode));
  label.dataset.tone = decision.decision === 'denied' ? 'danger' : decision.hops > 0 ? 'warning' : 'success';
  outcome.append(createElement('span', null, t('fallback.outcome')), label);
  elements.fallbackDecision.append(outcome);

  if (decision.exhausted !== null) {
    const blocked = createElement('article', 'directory-summary-item');
    blocked.append(
      createElement('span', null, t('fallback.blockedBy')),
      createElement('strong', null, translateCode('fallbackReason', decision.exhausted.blockedBy)),
    );
    elements.fallbackDecision.append(blocked);
    // A denial that was configured and could not be applied is the finding an auditor
    // came for; presenting the plan as if it were in force would hide it.
    if (decision.exhausted.unenforcedPolicy !== null) {
      const unenforced = createElement('article', 'directory-summary-item');
      const tone = createElement('span', 'status-label', t('fallback.unenforcedDeny'));
      tone.dataset.tone = 'danger';
      unenforced.append(createElement('span', null, t('fallback.unenforced')), tone);
      elements.fallbackDecision.append(unenforced);
    }
  }
}

function renderFallbackHops(model) {
  const authored = model.authored;
  if (authored === null || authored.edges.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement('td', 'empty-message', t('fallback.noHops'));
    cell.colSpan = 3;
    row.append(cell);
    elements.fallbackBody.replaceChildren(row);
    return;
  }
  const contracts = model.compiled ?? [];
  const outcomeFor = (contract, key) => {
    if (contract.permittedHops.some((hop) => `${hop.from}>${hop.to}` === key)) {
      return { state: 'permitted', blockedBy: null };
    }
    const refused = contract.refusedHops.find((hop) => `${hop.from}>${hop.to}` === key);
    return refused
      ? { state: 'refused', blockedBy: refused.blockedBy }
      : { state: 'not-compiled', blockedBy: null };
  };

  elements.fallbackBody.replaceChildren(...authored.edges.map((edge) => {
    const key = `${edge.from}>${edge.to}`;
    const row = document.createElement('tr');

    const hop = createElement('td');
    hop.append(
      createElement('strong', null, t('fallback.hop', { from: edge.from, to: edge.to })),
      createElement('p', 'policy-meta', t('fallback.singleHop')),
    );

    const outcome = createElement('td');
    const rule = createElement('td');
    for (const contract of contracts) {
      const { state, blockedBy } = outcomeFor(contract, key);
      const badge = createElement(
        'span',
        'status-label',
        `${t(`apiFamily.${contract.apiFamily}`)}: ${t(`fallback.hopState.${state}`)}`,
      );
      badge.dataset.tone = state === 'permitted' ? 'success' : state === 'refused' ? 'warning' : 'danger';
      outcome.append(badge);
      rule.append(
        createElement(
          'p',
          'policy-meta',
          state === 'permitted'
            ? t('fallback.hopPermittedDetail')
            : translateCode('fallbackReason', blockedBy ?? contract.reasonCode ?? 'fallback-no-plan-for-scope'),
        ),
      );
    }

    row.append(hop, outcome, rule);
    return row;
  }));
}

/**
 * The targets an administrator could author next. A source model that can reach
 * nothing is the answer to "why can I not add a hop here", so it is listed with its
 * refusals rather than omitted.
 */
function renderFallbackCandidates(model) {
  const contracts = model.candidates ?? [];
  if (contracts.length === 0) {
    elements.fallbackCandidates.replaceChildren(
      createElement('p', 'empty-message', t('fallback.noCandidates')),
    );
    return;
  }
  const nodes = [];
  for (const contract of contracts) {
    for (const entry of contract.bySource) {
      nodes.push(
        createElement(
          'dt',
          null,
          t('fallback.candidateSource', {
            contract: translateCode('apiFamily', contract.apiFamily),
            source: entry.source,
          }),
        ),
      );
      const detail = createElement('dd');
      if (entry.permitted.length > 0) {
        const permitted = createElement('span', 'status-label', t('fallback.candidatePermitted', { value: entry.permitted.join(', ') }));
        permitted.dataset.tone = 'success';
        detail.append(permitted);
      }
      else {
        const none = createElement('span', 'status-label', t('fallback.candidateNonePermitted'));
        none.dataset.tone = 'warning';
        detail.append(none);
      }
      for (const refused of entry.refused) {
        detail.append(
          createElement(
            'p',
            'policy-meta',
            t('fallback.candidateRefused', {
              model: refused.modelKey,
              reason: translateCode('fallbackReason', refused.blockedBy),
            }),
          ),
        );
      }
      nodes.push(detail);
    }
  }
  elements.fallbackCandidates.replaceChildren(...nodes);
}

function renderFallback(model) {
  showScreenContainer('fallback');
  renderViewer();
  elements.fallbackUpdatedAt.textContent = t('updatedAt', { value: formatTime(model.generatedAt) });
  renderFallbackQuality(model);
  renderFallbackDecision(model);
  renderFallbackHops(model);
  renderFallbackCandidates(model);
  renderFallbackAuthoring(model);
}

/** Turning the ladder on, and opting callers into it, are separate choices. */
function renderFallbackAuthoring(model) {
  const planCode = model.authored?.planCode ?? null;
  if (planCode === null) {
    elements.fallbackEdit.hidden = true;
    return;
  }
  refreshAuthoringAuthority().then((allowed) => {
    if (!allowed) {
      elements.fallbackEdit.hidden = true;
      return;
    }
    fillFallbackAuthoring(model.authored);
  });
}

function fillFallbackAuthoring(authored) {
  elements.fallbackEditError.textContent = '';
  fillOptions(elements.fallbackEditEnabled, [
    ['true', t('fallbackEdit.enabled')],
    ['false', t('fallbackEdit.disabled')],
  ], [String(authored.optedIn)]);
  fillOptions(elements.fallbackEditIntent, [
    ['pinned', t('intent.pinned')],
    ['preferred', t('intent.preferred')],
  ], [authored.modelSelectionIntent]);
  fillOptions(elements.fallbackEditNotice, [
    ['header', t('notice.header')],
    ['inline', t('notice.inline')],
  ], [authored.substitutionNotice]);
  const registryModels = [...(accessOptions?.models ?? [])].sort();
  const edges = (authored.edges ?? []).map(({ from, to }) => ({ from, to }));

  function renderEdgeEditor() {
    elements.fallbackEditEdgeList.replaceChildren(...edges.map((edge, index) => {
      const row = createElement('div', 'fallback-edge-row');
      const fromGroup = createElement('div');
      const from = document.createElement('select');
      const fromId = `fallback-edit-edge-from-${index}`;
      from.id = fromId;
      from.setAttribute('aria-describedby', 'fallback-edit-edges-help fallback-edit-error');
      const fromModels = [...new Set([...registryModels, edge.from])].sort();
      fillOptions(from, fromModels.map((modelCode) => [modelCode, modelCode]), [edge.from]);
      from.addEventListener('change', () => { edge.from = from.value; });
      const fromLabel = createElement('label', null, t('fallbackEdit.edgeFrom'));
      fromLabel.htmlFor = fromId;
      fromGroup.append(fromLabel, from);

      const toGroup = createElement('div');
      const to = document.createElement('select');
      const toId = `fallback-edit-edge-to-${index}`;
      to.id = toId;
      to.setAttribute('aria-describedby', 'fallback-edit-edges-help fallback-edit-error');
      const toModels = [...new Set([...registryModels, edge.to])].sort();
      fillOptions(to, toModels.map((modelCode) => [modelCode, modelCode]), [edge.to]);
      to.addEventListener('change', () => { edge.to = to.value; });
      const toLabel = createElement('label', null, t('fallbackEdit.edgeTo'));
      toLabel.htmlFor = toId;
      toGroup.append(toLabel, to);

      const remove = createElement('button', 'row-command', t('fallbackEdit.removeEdge'));
      remove.type = 'button';
      remove.dataset.tone = 'danger';
      remove.addEventListener('click', () => {
        edges.splice(index, 1);
        renderEdgeEditor();
      });
      row.append(fromGroup, toGroup, remove);
      return row;
    }));
    elements.fallbackEditAddEdge.disabled =
      registryModels.length < 2 || edges.length >= MAX_FALLBACK_EDGES;
  }

  elements.fallbackEditAddEdge.onclick = () => {
    const usedSources = new Set(edges.map((edge) => edge.from));
    const from = registryModels.find((modelCode) => !usedSources.has(modelCode))
      ?? registryModels[0];
    const to = registryModels.find((modelCode) => modelCode !== from);
    if (from === undefined || to === undefined) {
      elements.fallbackEditError.textContent = t('governanceValidation.fallbackModelsRequired');
      return;
    }
    edges.push({ from, to });
    renderEdgeEditor();
  };
  renderEdgeEditor();

  const propose = createElement('button', 'row-command', authoringText('fallbackEdit.propose'));
  propose.type = 'button';
  propose.addEventListener('click', () => {
    const result = buildFallbackEditPayload(authored, {
      enabled: elements.fallbackEditEnabled.value === 'true',
      modelSelectionIntent: elements.fallbackEditIntent.value,
      substitutionNotice: elements.fallbackEditNotice.value,
      edges,
      modelCodes: registryModels,
    });
    if (!result.ok) {
      showGovernanceValidation(result, elements.fallbackEditError, elements.fallbackEditEnabled);
      return;
    }
    proposeAccessChange('fallbackWritePath', result.payload, elements.fallbackEditError);
  });
  elements.fallbackEditActions.replaceChildren(propose);
  elements.fallbackEdit.hidden = false;
}

function renderLifecycleQuality(model) {
  const healthy = model.quality.state === 'complete';
  elements.lifecycleQualityBanner.classList.toggle('is-fresh', healthy);
  elements.lifecycleQualityTitle.textContent = healthy
    ? t('lifecycle.activeServing', { value: model.summary.activeRevisionCode })
    : t('lifecycle.nothingServing');
  const pairs = [
    [t('lifecycle.activeRevision'), model.summary.activeRevisionCode ?? t('lifecycle.none')],
    [t('lifecycle.publishingRevision'), model.summary.publishingRevisionCode ?? t('lifecycle.none')],
    [t('lifecycle.needsAttention'), formatNumber(model.summary.needsAttention)],
    [t('lifecycle.revisionCount'), formatNumber(model.summary.total)],
    // More than one at once would mean the single-publisher rule stopped holding.
    [t('lifecycle.concurrentPublishes'), formatNumber(model.quality.concurrentPublishes)],
  ];
  elements.lifecycleQualityDetails.replaceChildren(...pairs.flatMap(([label, value]) => [
    createElement('dt', null, label),
    createElement('dd', null, value),
  ]));
}

const LIFECYCLE_TONES = Object.freeze({
  active: 'success',
  publishing: 'warning',
  approved: 'success',
  draft: 'warning',
  failed: 'danger',
  superseded: 'danger',
});

const TARGET_TONES = Object.freeze({
  verified: 'success',
  written: 'warning',
  pending: 'warning',
  failed: 'danger',
});

function renderLifecycleRecords(model) {
  if (model.records.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement('td', 'empty-message', t('lifecycle.noRevisions'));
    cell.colSpan = 5;
    row.append(cell);
    elements.lifecycleBody.replaceChildren(row);
    return;
  }
  elements.lifecycleBody.replaceChildren(...model.records.map((record) => {
    const row = document.createElement('tr');
    row.dataset.revisionCode = record.revisionCode;

    const identity = createElement('td');
    identity.append(
      createElement('strong', null, record.revisionCode),
      createElement('p', 'policy-meta', t('lifecycle.revisionNumber', { value: formatNumber(record.revisionNumber) })),
    );
    if (record.supersededInFavourOf !== null) {
      identity.append(
        createElement('p', 'policy-meta', t('lifecycle.returnedTo', { value: record.supersededInFavourOf })),
      );
    }

    const state = createElement('td');
    const badge = createElement('span', 'status-label', t(`lifecycleState.${record.state}`));
    badge.dataset.tone = LIFECYCLE_TONES[record.state];
    state.append(badge);
    if (record.failure !== null) {
      state.append(
        createElement('p', 'policy-meta', translateCode('lifecycleReason', record.failure.reasonCode)),
      );
    }
    if (record.targetSummary.partial) {
      // Some targets took the change and some did not; either end alone looks fine.
      state.append(createElement('p', 'policy-meta', t('lifecycle.partialWrite')));
    }

    const approval = createElement('td');
    approval.append(
      createElement('p', 'policy-meta', t('lifecycle.authoredBy', {
        actor: record.authoredByCode,
        at: formatTime(record.authoredAt),
      })),
    );
    approval.append(
      createElement(
        'p',
        'policy-meta',
        record.approvedByCode === null
          ? t('lifecycle.notApproved')
          : t('lifecycle.approvedBy', { actor: record.approvedByCode, at: formatTime(record.approvedAt) }),
      ),
    );
    if (record.publishedByCode !== null) {
      approval.append(
        createElement('p', 'policy-meta', t('lifecycle.publishedBy', {
          actor: record.publishedByCode,
          at: formatTime(record.publishStartedAt),
        })),
      );
    }

    const targets = createElement('td');
    targets.append(
      createElement('strong', null, t('lifecycle.verifiedOf', {
        verified: formatNumber(record.targetSummary.verified),
        total: formatNumber(record.targetSummary.total),
      })),
    );
    for (const target of record.targets) {
      const line = createElement('p', 'policy-meta');
      const outcome = createElement('span', 'status-label', t(`targetOutcome.${target.outcome}`));
      outcome.dataset.tone = TARGET_TONES[target.outcome];
      line.append(text(`${target.targetCode} `), outcome);
      if (target.reasonCode !== null) {
        line.append(text(` ${translateCode('lifecycleReason', target.reasonCode)}`));
      }
      targets.append(line);
    }

    const actions = createElement('td');
    if (!offersLifecycleCommands()) {
      actions.append(createElement('p', 'empty-message', t('lifecycle.commandsNotServed')));
    } else if (session.mode !== 'local') {
      const action = record.availableCommands.includes('approve')
        ? { command: 'resume', label: 'approve' }
        : record.availableCommands.includes('publish')
          ? { command: 'resume', label: 'publish' }
          : record.availableCommands.includes('retry') || record.availableCommands.includes('fail')
            ? { command: 'resume', label: 'retry' }
            : record.availableCommands.includes('abandon')
              ? { command: 'abandon', label: 'abandon' }
              : record.availableCommands.includes('withdraw')
                ? { command: 'withdraw', label: 'withdrawDraft' }
                : null;
      if (action === null) {
        actions.append(createElement('p', 'empty-message', t('lifecycle.noActions')));
      } else {
        const addAction = (current) => {
          const button = createElement('button', 'row-command', t(`lifecycleCommand.${current.label}`));
          button.type = 'button';
          button.addEventListener('click', () => {
            if (current.command === 'withdraw') withdrawStoredProposal(record.revisionCode);
            else if (current.command === 'abandon') abandonStoredProposal(record.revisionCode);
            else resumeStoredProposal(record.revisionCode, record.resumeInitialOnly);
          });
          actions.append(button);
        };
        addAction(action);
        if (action.command !== 'abandon' && record.availableCommands.includes('abandon')) {
          addAction({ command: 'abandon', label: 'abandon' });
        }
      }
    } else if (record.availableCommands.length === 0) {
      actions.append(createElement('p', 'empty-message', t('lifecycle.noActions')));
    } else {
      for (const command of record.availableCommands) {
        const commandKey = command === 'withdraw' && record.state === 'draft'
          ? 'lifecycleCommand.withdrawDraft'
          : `lifecycleCommand.${command}`;
        const button = createElement('button', 'row-command', t(commandKey));
        button.type = 'button';
        button.addEventListener('click', () => {
          if (command === 'fail') {
            askForFailureReason(record.revisionCode);
            return;
          }
          saveRevision({ revisionCode: record.revisionCode, command });
        });
        actions.append(button);
        if (command === 'supersede') {
          actions.append(createElement('p', 'policy-meta', t('lifecycle.supersedeHelp')));
        }
      }
    }

    row.append(identity, state, approval, targets, actions);
    return row;
  }));
}

/**
 * The version of each revision that the screen is currently showing.
 *
 * A save is written against this, not against a fresh read taken at the moment of
 * the click. Re-reading first would make every save look current and the warning
 * would almost never appear: the change this is meant to catch arrives while the
 * screen sits open, not in the milliseconds around the click.
 */
const held = new Map();

/**
 * Why each command is being issued, and what else it has to state.
 *
 * `fail` is absent because its reason cannot be stock. Recording a failure requires
 * saying what failed, so the screen asks for it and sends what was typed; a fixed
 * string here would put a fabricated explanation into the audit record.
 */
const COMMAND_REASONS = Object.freeze({
  edit: 'change-revised',
  approve: 'change-reviewed',
  withdraw: 'approval-withdrawn',
  publish: 'publish-approved',
  complete: 'publish-confirmed',
  retry: 'publish-retried',
  supersede: 'supersede-requested',
});

function commandArguments(command, summary) {
  if (command === 'publish') return { publishingRevisionId: summary.publishingRevisionCode ?? null };
  if (command === 'supersede') return { previousActiveRevisionId: summary.activeRevisionCode ?? null };
  return {};
}

async function holdLifecycleRevisions(model) {
  held.clear();
  if (session.mode !== 'local') return;
  await Promise.all(
    model.records
      .filter((record) => record.availableCommands.length > 0)
      .map(async (record) => {
        const response = await fetch(
          `/api/local/lifecycle/revision?revisionId=${encodeURIComponent(record.revisionCode)}`,
        );
        if (!response.ok) return;
        held.set(record.revisionCode, { ...(await response.json()), summary: model.summary });
      }),
  );
}

async function resumeStoredProposal(revisionCode, initialOnly) {
  await sendStoredProposalAction({
    resume: true,
    revisionId: revisionCode,
    ...(initialOnly ? { initialOnly: true } : {}),
  });
}

async function withdrawStoredProposal(revisionCode) {
  await sendStoredProposalAction({ command: 'withdraw', revisionId: revisionCode });
}

async function abandonStoredProposal(revisionCode) {
  await sendStoredProposalAction({ command: 'abandon', revisionId: revisionCode });
}

async function sendStoredProposalAction(body) {
  hideConflict();
  try {
    const response = await fetch(`${api.baseUrl}${api.governancePublishPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await session.getAuthorizationHeader()),
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      renderRefusal(result);
      return;
    }
    await loadCurrentScreen();
  } catch {
    elements.lifecycleConflictDetail.replaceChildren(
      createElement('p', 'policy-meta', t('conflict.unavailable')),
    );
    elements.lifecycleConflict.hidden = false;
  }
}

function hideConflict() {
  elements.lifecycleConflict.hidden = true;
  elements.lifecycleConflictDetail.replaceChildren();
  elements.lifecycleConflictActions.replaceChildren();
}

// The reasons the product defines, as the read model offered them. Held rather than
// listed here so the screen cannot offer a reason the product does not know.
let failureReasonCodes = [];

function hideFailureReason() {
  elements.lifecycleReason.hidden = true;
  elements.lifecycleReasonError.textContent = '';
  elements.lifecycleReasonActions.replaceChildren();
}

/**
 * Recording a failure needs a reason, and an operator should not have to already know
 * the vocabulary to give one, so the reasons are offered with what each one means.
 */
function askForFailureReason(revisionCode) {
  hideConflict();
  elements.lifecycleReasonError.textContent = '';

  elements.lifecycleReasonInput.replaceChildren(
    ...failureReasonCodes.map((code) => {
      const option = createElement(
        'option',
        null,
        t('reason.option', { description: translateCode('lifecycleReason', code), code }),
      );
      option.value = code;
      return option;
    }),
  );

  const confirm = createElement('button', 'row-command', t('reason.confirm'));
  confirm.type = 'button';
  confirm.addEventListener('click', () => {
    const reasonCode = elements.lifecycleReasonInput.value;
    if (!failureReasonCodes.includes(reasonCode)) {
      elements.lifecycleReasonError.textContent = t('reason.invalid');
      elements.lifecycleReasonInput.focus();
      return;
    }
    hideFailureReason();
    saveRevision({ revisionCode, command: 'fail', reasonCode });
  });

  const cancel = createElement('button', 'row-command', t('reason.cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', hideFailureReason);

  elements.lifecycleReasonActions.replaceChildren(confirm, cancel);
  elements.lifecycleReason.hidden = false;
  elements.lifecycleReasonInput.focus();
}

/**
 * What changed since this screen was loaded, listed by who did it.
 *
 * The list is the point. "Somebody else saved first" tells a person nothing they can
 * weigh. The command itself is applied to the stored revision, so their history is
 * not erased; what is at stake is that this decision was made without seeing it.
 */
function renderConflict(conflict, retry) {
  headline('conflict.eyebrow', 'conflict.title');
  const detail = elements.lifecycleConflictDetail;
  detail.replaceChildren();

  if (conflict.reasonCode === 'history-diverged') {
    detail.append(createElement('p', 'policy-meta', t('conflict.diverged')));
  } else {
    detail.append(
      createElement('p', 'policy-meta', t('conflict.lost', {
        value: formatNumber(conflict.comparison.discarded.length),
      })),
    );
    for (const entry of conflict.comparison.discarded) {
      detail.append(
        createElement('p', 'policy-meta', t('conflict.entry', {
          actor: entry.actor,
          command: t(`lifecycleCommand.${entry.command}`),
          at: formatTime(entry.at),
        })),
      );
    }
  }

  elements.lifecycleConflictActions.replaceChildren();
  // A diverged history is not a difference a person can weigh, so overwriting it is
  // not offered at all.
  if (conflict.reasonCode !== 'history-diverged') {
    const overwrite = createElement('button', 'row-command', t('conflict.overwrite'));
    overwrite.type = 'button';
    overwrite.dataset.tone = 'danger';
    overwrite.addEventListener('click', () => retry(conflict.currentEtag));
    elements.lifecycleConflictActions.append(overwrite);
  }
  elements.lifecycleConflictActions.append(reloadButton('conflict.keepTheirs'));
  elements.lifecycleConflict.hidden = false;
}

/**
 * A refusal is not a conflict, and cannot be resolved by forcing.
 *
 * It is still shown here, because the alternative is a click that appears to do
 * nothing: the screen would quietly reload and leave the person to work out for
 * themselves that their action never happened.
 */
function renderRefusal(result) {
  headline('conflict.refusedEyebrow', 'conflict.refusedTitle');
  const detail = elements.lifecycleConflictDetail;
  detail.replaceChildren(
    createElement(
      'p',
      'policy-meta',
      translateCode('lifecycleRefusal', result.reasonCode ?? result.error?.code ?? 'save-refused'),
    ),
  );

  const blocking = result.detail?.publishingRevisionId ?? null;
  const unverified = result.detail?.targetCodes ?? null;
  if (blocking !== null) {
    detail.append(createElement('p', 'policy-meta', t('lifecycle.blockedBy', { value: blocking })));
  }
  if (Array.isArray(unverified)) {
    for (const targetCode of unverified) {
      detail.append(createElement('p', 'policy-meta', t('lifecycle.targetUnverified', { value: targetCode })));
    }
  }

  elements.lifecycleConflictActions.replaceChildren();
  // Naming the publish that is in the way is only half an answer; the operator has
  // to be able to get to it and finish or abandon it.
  if (blocking !== null) {
    const goTo = createElement('button', 'row-command', t('lifecycle.goToBlocking'));
    goTo.type = 'button';
    goTo.addEventListener('click', () => {
      hideConflict();
      highlightRevision(blocking);
    });
    elements.lifecycleConflictActions.append(goTo);
  }
  elements.lifecycleConflictActions.append(reloadButton('conflict.reload'));
  elements.lifecycleConflict.hidden = false;
}

function highlightRevision(revisionCode) {
  const row = [...elements.lifecycleBody.querySelectorAll('tr')].find(
    (candidate) => candidate.dataset.revisionCode === revisionCode,
  );
  if (row === undefined) {
    showState('error', 'notifications.actionRefusedTitle', {
      reasonCode: 'blocking-revision-not-visible',
      requestId: '',
    });
    return;
  }
  for (const candidate of elements.lifecycleBody.querySelectorAll('tr')) {
    candidate.removeAttribute('data-highlighted');
  }
  row.dataset.highlighted = 'true';
  row.scrollIntoView({ block: 'center' });
  row.querySelector('button.row-command')?.focus();
}

function headline(eyebrowKey, titleKey) {
  elements.lifecycleConflictEyebrow.dataset.i18n = eyebrowKey;
  elements.lifecycleConflictEyebrow.textContent = t(eyebrowKey);
  elements.lifecycleConflictTitle.dataset.i18n = titleKey;
  elements.lifecycleConflictTitle.textContent = t(titleKey);
}

function reloadButton(labelKey) {
  const button = createElement('button', 'row-command', t(labelKey));
  button.type = 'button';
  button.addEventListener('click', () => {
    hideConflict();
    loadCurrentScreen();
  });
  return button;
}

async function saveRevision({ revisionCode, command, acknowledgedEtag = null, reasonCode = null }) {
  hideConflict();
  const reading = held.get(revisionCode);
  if (reading === undefined) {
    await loadCurrentScreen();
    return;
  }
  try {
    // What a person typed wins over the stock reason for the command, because the one
    // command that needs a typed reason has no stock reason to fall back to.
    const reason = reasonCode ?? COMMAND_REASONS[command];
    const response = await fetch('/api/local/lifecycle/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revisionId: revisionCode,
        etag: reading.etag,
        expectedRevisionNumber: reading.revisionNumber,
        loaded: reading.revision,
        command,
        actor: 'local-auditor',
        ...(reason === undefined ? {} : { reasonCode: reason }),
        ...commandArguments(command, reading.summary),
        force: acknowledgedEtag !== null,
        // The version the warning described. A change arriving while it was on
        // screen is refused again rather than carried away by a confirmation that
        // never mentioned it.
        acknowledgedEtag,
      }),
    });
    const result = await response.json();
    if (result.outcome === 'conflict') {
      renderConflict(result, (currentEtag) =>
        saveRevision({ revisionCode, command, acknowledgedEtag: currentEtag, reasonCode }),
      );
      return;
    }
    if (result.outcome !== 'saved') {
      renderRefusal(result);
      return;
    }
    await loadCurrentScreen();
  } catch {
    elements.lifecycleConflictDetail.replaceChildren(
      createElement('p', 'policy-meta', t('conflict.unavailable')),
    );
    elements.lifecycleConflict.hidden = false;
  }
}

function renderLifecycle(model) {
  showScreenContainer('lifecycle');
  renderViewer();
  failureReasonCodes = model.failureReasonCodes ?? [];
  elements.lifecycleUpdatedAt.textContent = t('updatedAt', { value: formatTime(model.generatedAt) });
  renderLifecycleQuality(model);
  renderLifecycleRecords(model);
  hideConflict();
  hideFailureReason();
  holdLifecycleRevisions(model);
}

const NOTIFICATION_SOURCED_CATEGORIES = new Set(['notification', 'drift']);

function renderAuditQuality(model) {
  const complete = model.quality.state === 'complete';
  elements.auditQualityBanner.classList.toggle('is-fresh', complete);
  elements.auditQualityTitle.textContent = complete
    ? t('audit.completeTitle')
    : t('audit.partialTitle');
  const pairs = [
    [t('audit.completeness'), translateCode('auditReason', model.quality.reasonCode)],
    [t('audit.recordsChecked'), formatNumber(model.summary.total)],
    [t('audit.firstRecord'), model.summary.firstAt === null ? t('state.unknown') : formatTime(model.summary.firstAt)],
    [t('audit.lastRecord'), model.summary.lastAt === null ? t('state.unknown') : formatTime(model.summary.lastAt)],
    [
      t('audit.sources'),
      model.summary.byCategory.map((entry) => `${t(`auditCategory.${entry.category}`)} ${entry.count}`).join(' · '),
    ],
  ];
  elements.auditQualityDetails.replaceChildren(...pairs.flatMap(([label, value]) => [
    createElement('dt', null, label),
    createElement('dd', null, value),
  ]));
}

function renderAuditExport(model) {
  const offer = model.export;
  if (!offer.permitted) {
    // Saying why the export is unavailable stops a reader guessing whether the
    // permission is missing or the feature is.
    elements.auditExport.replaceChildren(
      createElement('p', 'empty-message', translateCode('auditReason', offer.reasonCode)),
    );
    return;
  }
  const manifest = offer.manifest;
  const items = [
    [t('audit.exportRows'), formatNumber(manifest.rowCount)],
    [t('audit.exportScope'), t(`scope.${manifest.scope}`)],
    [
      t('audit.exportCategories'),
      manifest.categories === 'all'
        ? t('audit.allCategories')
        : manifest.categories.map((category) => t(`auditCategory.${category}`)).join(' · '),
    ],
    [t('audit.exportExcluded'), manifest.excluded.map((code) => t(`auditExcluded.${code}`)).join(' · ')],
  ];
  elements.auditExport.replaceChildren(...items.map(([label, value]) => {
    const item = createElement('article', 'directory-summary-item');
    item.append(createElement('span', null, label), createElement('strong', null, value));
    return item;
  }));
}

function renderAuditRecords(model) {
  if (model.records.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement('td', 'empty-message', t('audit.noRecords'));
    cell.colSpan = 4;
    row.append(cell);
    elements.auditBody.replaceChildren(row);
    return;
  }
  elements.auditBody.replaceChildren(...model.records.map((record) => {
    const row = document.createElement('tr');

    const identity = createElement('td');
    // A notification is named once, by the vocabulary the notifications screen uses.
    // A second wording here would drift from it.
    const label = NOTIFICATION_SOURCED_CATEGORIES.has(record.category)
      ? t(`notificationKind.${record.action}`)
      : t(`auditAction.${record.action}`);
    identity.append(createElement('strong', null, label));
    const category = createElement('span', 'status-label', t(`auditCategory.${record.category}`));
    category.dataset.tone = 'success';
    identity.append(
      category,
      createElement('p', 'policy-meta', formatTime(record.occurredAt)),
    );

    const actor = createElement('td');
    actor.append(
      createElement('strong', null, record.actorCode),
      createElement('p', 'policy-meta', t(`auditActor.${record.actorKind}`)),
      createElement('p', 'policy-meta', record.targetCode),
    );

    const reason = createElement('td');
    reason.append(
      createElement(
        'p',
        'policy-meta',
        translateCode(
          NOTIFICATION_SOURCED_CATEGORIES.has(record.category) ? 'notificationReason' : 'auditReason',
          record.reasonCode,
        ),
      ),
      createElement(
        'p',
        'policy-meta',
        record.version === null
          ? t('audit.noVersion')
          : t('audit.version', { value: formatNumber(record.version) }),
      ),
    );

    const evidence = createElement('td');
    if (record.evidence === null) {
      evidence.append(createElement('p', 'empty-message', t('audit.noEvidence')));
    } else {
      for (const [key, value] of Object.entries(record.evidence)) {
        // Quality and freshness are enumerations the product already names elsewhere;
        // versions and model keys are identifiers and stay verbatim.
        const rendered =
          key === 'quality' || key === 'freshness' ? translateCode(key, value) : value;
        evidence.append(createElement('p', 'policy-meta', `${t(`auditEvidence.${key}`)}: ${rendered}`));
      }
    }

    row.append(identity, actor, reason, evidence);
    return row;
  }));
}

const NOTIFICATION_TONES = Object.freeze({
  pending: 'warning',
  delivered: 'success',
  failed: 'danger',
  acknowledged: 'success',
});

function renderNotificationsQuality(model) {
  const pairs =
    model.summary === null
      ? [[t('notifications.summary'), t('notifications.unmeasured')]]
      : [
          [t('notifications.total'), formatNumber(model.summary.total)],
          [t('notifications.pending'), formatNumber(model.summary.pending)],
          [t('notifications.delivered'), formatNumber(model.summary.delivered)],
          [t('notifications.failed'), formatNumber(model.summary.failed)],
          [t('notifications.acknowledged'), formatNumber(model.summary.acknowledged)],
        ];
  pairs.push([t('notifications.source'), translateCode('notificationQuality', model.quality.reasonCode)]);
  elements.notificationsQualityDetails.replaceChildren(...pairs.flatMap(([label, value]) => [
    createElement('dt', null, label),
    createElement('dd', null, String(value)),
  ]));
}

function renderNotificationRecords(model) {
  if (model.records.length === 0) {
    const row = document.createElement('tr');
    const cell = createElement(
      'td',
      'empty-message',
      // Nothing to show and nothing measurable are different answers, and only one of
      // them means there is nothing to do.
      model.summary === null ? t('notifications.unmeasured') : t('notifications.none'),
    );
    cell.colSpan = 4;
    row.append(cell);
    elements.notificationsBody.replaceChildren(row);
    return;
  }

  elements.notificationsBody.replaceChildren(...model.records.map((record) => {
    const row = document.createElement('tr');

    const event = createElement('td');
    event.append(createElement('strong', null, t(`notificationKind.${record.kind}`)));
    const severity = createElement('span', 'status-label', t(`severity.${record.severity}`));
    severity.dataset.tone = record.severity === 'critical' ? 'danger' : 'warning';
    event.append(
      severity,
      createElement('p', 'policy-meta', t('notifications.raisedAt', { value: formatTime(record.raisedAt) })),
      createElement('p', 'policy-meta', t('notifications.period', { value: formatTime(record.periodStart) })),
    );

    const scope = createElement('td');
    scope.append(
      createElement('strong', null, t(`scopeKind.${record.scopeKind}`)),
      createElement(
        'p',
        'policy-meta',
        record.scopeCode === null ? t('notifications.everyCaller') : record.scopeCode,
      ),
    );

    const delivery = createElement('td');
    const state = createElement('span', 'status-label', t(`notificationState.${record.deliveryState}`));
    state.dataset.tone = NOTIFICATION_TONES[record.deliveryState];
    delivery.append(
      state,
      createElement('p', 'policy-meta', t('notifications.attempts', { value: formatNumber(record.attemptCount) })),
    );
    if (record.lastAttemptAt !== null) {
      delivery.append(
        createElement('p', 'policy-meta', t('notifications.lastAttempt', {
          channel: record.lastChannelCode,
          at: formatTime(record.lastAttemptAt),
        })),
      );
    }
    if (record.lastReasonCode !== null) {
      delivery.append(
        createElement('p', 'policy-meta', translateCode('notificationReason', record.lastReasonCode)),
      );
    }
    delivery.append(
      createElement(
        'p',
        'policy-meta',
        record.nextAttemptAt === null
          ? t('notifications.noRetry')
          : t('notifications.nextAttempt', { value: formatTime(record.nextAttemptAt) }),
      ),
    );

    const acknowledgement = createElement('td');
    if (record.acknowledgedByCode === null) {
      acknowledgement.append(createElement('p', 'empty-message', t('notifications.notAcknowledged')));
      const button = createElement('button', 'row-command', t('notifications.acknowledge'));
      button.type = 'button';
      button.addEventListener('click', () => acknowledgeNotification(record.notificationCode));
      acknowledgement.append(button);
    } else {
      acknowledgement.append(
        createElement('strong', null, record.acknowledgedByCode),
        createElement('p', 'policy-meta', formatTime(record.acknowledgedAt)),
      );
    }

    row.append(event, scope, delivery, acknowledgement);
    return row;
  }));
}

async function acknowledgeNotification(key) {
  try {
    const response = await fetch(`${api.baseUrl}${api.acknowledgePath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(await session.getAuthorizationHeader()),
      },
      // A deployment takes the actor from the validated token. Sending one would let
      // the screen sign a name it has no standing to claim.
      body: JSON.stringify(session.mode === 'local' ? { key, actorCode: 'local-auditor' } : { key }),
    });
    const result = await response.json();
    // A refusal is shown rather than swallowed by a reload that looks like nothing
    // happened.
    if (result.ok !== true) {
      showState('error', 'notifications.actionRefusedTitle', {
        reasonCode: result.reasonCode ?? result.error?.code ?? 'acknowledge-refused',
        requestId: '',
      });
      return;
    }
    await loadCurrentScreen();
  } catch {
    showState('error', 'notifications.actionRefusedTitle', {
      reasonCode: 'acknowledge-refused',
      requestId: '',
    });
  }
}

/**
 * The address is written and never read back, so the panel reports the host it was
 * told and leaves the field empty. A field pre-filled with a masked value would
 * invite an operator to submit the mask.
 */
async function renderChannel() {
  elements.channelEdit.hidden = true;
  elements.channelEditError.textContent = '';
  let described;
  try {
    const response = await fetch(`${api.baseUrl}${api.channelPath}`, {
      headers: { Accept: 'application/json', ...(await session.getAuthorizationHeader()) },
    });
    if (!response.ok) return;
    described = await response.json();
  } catch {
    return;
  }

  elements.channelEditKind.replaceChildren(
    ...(described.supportedKinds ?? []).map((kind) => {
      const option = createElement('option', null, t(`channelKind.${kind}`));
      option.value = kind;
      return option;
    }),
  );
  if (described.configured) elements.channelEditKind.value = described.channelKind;
  elements.channelEditCurrent.textContent = described.configured
    ? t('channelEdit.current', { host: described.endpointHost, updatedAt: formatTime(described.updatedAt) })
    : t('channelEdit.unset');

  const save = createElement('button', 'row-command', t('channelEdit.save'));
  save.type = 'button';
  save.addEventListener('click', saveChannel);
  elements.channelEditActions.replaceChildren(save);
  elements.channelEdit.hidden = false;
}

async function saveChannel() {
  const endpoint = elements.channelEditEndpoint.value.trim();
  if (endpoint.length === 0) {
    elements.channelEditError.textContent = t('channelEdit.endpointRequired');
    return;
  }
  try {
    const response = await fetch(`${api.baseUrl}${api.channelPath}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(await session.getAuthorizationHeader()) },
      body: JSON.stringify({ channelKind: elements.channelEditKind.value, endpoint }),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      elements.channelEditError.textContent = translateCode(
        'channelEditRefusal',
        result.reasonCode ?? result.error?.reasonCode ?? result.error?.code ?? 'channel-refused',
      );
      return;
    }
    // Cleared rather than left showing what was sent, because it is a credential.
    elements.channelEditEndpoint.value = '';
    await renderChannel();
  } catch {
    elements.channelEditError.textContent = translateCode('channelEditRefusal', 'channel-unavailable');
  }
}

function renderNotifications(model) {
  showScreenContainer('notifications');
  renderViewer();
  elements.notificationsUpdatedAt.textContent = t('updatedAt', { value: formatTime(model.generatedAt) });
  renderNotificationsQuality(model);
  renderNotificationRecords(model);
  void renderChannel();
}

function renderAudit(model) {
  showScreenContainer('audit');
  renderViewer();
  elements.auditUpdatedAt.textContent = t('updatedAt', { value: formatTime(model.generatedAt) });
  renderAuditQuality(model);
  renderAuditExport(model);
  renderAuditRecords(model);
}

function renderReadModel(model) {
  currentReadModel = model;
  applyScreenChrome();
  if (model.readModelVersion === 'overview.v2') renderOverview(model);
  else if (model.readModelVersion === 'users-groups.v1') renderUsersGroups(model);
  else if (model.readModelVersion === 'budgets.v1') renderBudgets(model);
  else if (model.readModelVersion === 'usage.v1') renderUsage(model);
  else if (model.readModelVersion === 'models.v1') renderModelCatalogue(model);
  else if (model.readModelVersion === 'fallback.v1') renderFallback(model);
  else if (model.readModelVersion === 'lifecycle.v1') renderLifecycle(model);
  else if (model.readModelVersion === 'notifications.v1') renderNotifications(model);
  else if (model.readModelVersion === 'change-log.v1') renderAudit(model);
  else throw new Error(`no renderer for read model ${model.readModelVersion}`);
}

function translateCode(namespace, code) {
  const translated = t(`${namespace}.${code}`);
  return translated.startsWith('[missing:') ? code : translated;
}

function translateErrorCode(code) {
  return translateCode('error', code);
}

async function loadCurrentScreen() {
  const generation = ++loadGeneration;
  activeLoadController?.abort();
  const controller = new AbortController();
  activeLoadController = controller;
  elements.refresh.disabled = true;
  const screen = SCREENS[currentScreen];
  showState('', screen.loadingTitleKey, { detailKey: screen.loadingDetailKey });
  const params = new URLSearchParams({ scope: elements.scope.value });
  // Fixture, persona, and source select server-side development state. A deployment
  // decides all three from the caller's token, so they are never sent.
  if (session.mode === 'local') {
    params.set('persona', elements.persona.value);
    if (FIXTURE_SCREENS.has(currentScreen)) params.set('fixture', elements.fixture.value);
    if (SOURCE_SCREENS.has(currentScreen)) params.set('source', elements.source.value);
  }
  if (elements.scope.value === 'team') params.set('team', elements.team.value);
  if (currentScreen === 'users-groups' || currentScreen === 'usage') params.set('view', elements.directoryView.value);
  if (currentScreen === 'overview') params.set('range', elements.range.value);
  try {
    const response = await fetch(`${api.baseUrl}${api[screen.path]}?${params}`, {
      headers: { Accept: 'application/json', ...(await session.getAuthorizationHeader()) },
      signal: controller.signal,
    });
    const payload = await response.json();
    if (generation !== loadGeneration) return;
    if (!response.ok) {
      const code = payload.error?.code ?? 'overview_failed';
      const reasonCode = payload.error?.reasonCode ?? code;
      const requestId = payload.error?.requestId ?? 'request-unavailable';
      showState(
        response.status === 403 ? 'denied' : 'error',
        response.status === 403 ? 'state.denied.title' : screen.errorTitleKey,
        { reasonCode, requestId },
      );
      // The directory roster and governance snapshots are independent sources.
      // Missing Graph permission must not turn manual entitlement or assignment
      // authoring into a directory feature.
      if (currentScreen === 'users-groups' && response.status >= 500) {
        await showUsersGroupsAuthoringAlongsideState();
      }
      return;
    }
    // Drawing the answer is a separate failure from not getting one. Leaving them
    // together reported a render fault as an unreachable adapter, which sends the
    // reader to check the wrong thing.
    try {
      renderReadModel(payload);
    } catch {
      showState('error', screen.errorTitleKey, { detailKey: 'state.error.render' });
    }
  } catch (error) {
    if (error.name === 'AbortError' || generation !== loadGeneration) return;
    showState('error', screen.errorTitleKey, { detailKey: 'state.error.network' });
  } finally {
    if (generation === loadGeneration) {
      elements.refresh.disabled = false;
      if (activeLoadController === controller) activeLoadController = null;
    }
  }
}

  for (const control of [elements.fixture, elements.source, elements.persona, elements.range, elements.team]) {
  control.addEventListener('change', loadCurrentScreen);
}
// Chrome settles first, because it can narrow the selection the request is built from.
elements.scope.addEventListener('change', () => {
  applyScreenChrome();
  loadCurrentScreen();
});
elements.source.addEventListener('change', applyScreenChrome);
elements.directoryView.addEventListener('change', loadCurrentScreen);
elements.refresh.addEventListener('click', loadCurrentScreen);
elements.language.addEventListener('change', () => setLocale(elements.language.value));
// Which screens this session may show. A deployment narrows it to what it registers;
// locally every screen is served. It gates navigation as well as the nav list, because
// a hash can be typed and a screen with no route would otherwise request one.
let servedScreens = new Set(Object.keys(SCREENS));

window.addEventListener('hashchange', () => {
  const nextScreen = screenForHash(location.hash);
  if (nextScreen === currentScreen) return;
  if (!servedScreens.has(nextScreen)) {
    location.hash = SCREENS[currentScreen].hash;
    return;
  }
  currentScreen = nextScreen;
  currentReadModel = null;
  applyScreenChrome();
  loadCurrentScreen();
});
applyStaticTranslations();
applyScreenChrome();

// A deployment names its identity provider and API origin; anything else stays local.
const sessionConfig = await readSessionConfig();
if (sessionConfig.mode === 'entra') {
  session = await loadSession(sessionConfig);
  applyStaticTranslations();
  // A screen the deployment cannot serve is not offered. Showing it and failing the
  // request would look like an outage rather than a capability that is not there yet.
  servedScreens = new Set(sessionConfig.screens ?? ['overview']);
  runtimeCapabilities = Object.freeze({
    modelAuthoring: sessionConfig.capabilities?.modelAuthoring === true,
    modelPrices: sessionConfig.capabilities?.modelPrices === true,
  });
  // The map carries a path only for a screen the deployment declared. Listing all of
  // them stated that a deployment could serve routes it does not register, and the
  // claim survived only because the nav happened to hide them.
  api = {
    baseUrl: sessionConfig.apiBaseUrl ?? '',
    acknowledgePath: '/api/v1/admin/notifications/acknowledge',
    channelPath: '/api/v1/admin/notifications/channel',
    modelPricesPath: '/api/v1/admin/model-prices',
    ...DEPLOYED_WRITE_PATHS,
    ...Object.fromEntries(
      Object.entries(DEPLOYED_SCREEN_PATHS).filter(([screen]) => servedScreens.has(screen)).map(
        ([screen, path]) => [SCREENS[screen].path, path],
      ),
    ),
  };
  // Development controls select server-side fixtures, which a deployment does not have.
  developmentControlsAvailable = false;
  for (const control of [elements.fixture, elements.source, elements.persona]) {
    control.closest('.development-control').hidden = true;
  }
  // The badge names what the reader is looking at. Leaving it on the local label
  // would present real governance data as deterministic test output.
  elements.environment.textContent = t('app.environmentDeployed');
  elements.environment.removeAttribute('data-i18n');
  for (const link of elements.navigationLinks) {
    if (!servedScreens.has(link.dataset.screen)) link.closest('li').hidden = true;
  }
  if (!servedScreens.has(currentScreen)) {
    currentScreen = 'overview';
    location.hash = '#overview';
  }
  applyScreenChrome();
  await session.signIn();
}

loadCurrentScreen();
