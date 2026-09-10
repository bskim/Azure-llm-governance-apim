/**
 * What a screen needs, separated from where it comes from.
 *
 * The read models are pure functions over their inputs, so the only thing binding a
 * screen to development data is whoever gathers those inputs. That job lives here, in
 * one interface with more than one implementation, rather than inline in the request
 * routing where every screen's migration would collide with every other's.
 *
 * A source also declares what it can offer. Some of the selections a screen accepts
 * exist only to make a state readable during development - an empty period, a widened
 * entitlement - and a source that cannot produce one must say so rather than quietly
 * answer with something else. The routing validates against the declaration, so a
 * narrower source narrows the screen instead of failing inside it.
 */

const REQUIRED_METHODS = Object.freeze([
  'describe',
  'readGovernanceSnapshots',
  'readOverview',
  'readUsersGroups',
  'readRollups',
  'readUsageRecords',
  'readProviderQuota',
  'readConfigurationRevisions',
  'readNotificationSeed',
]);

const REQUIRED_CAPABILITIES = Object.freeze([
  'overviewFixtures',
  'usersGroupsFixtures',
  'usageFixtures',
  'modelsFixtures',
  'budgetsFixtures',
  'fallbackFixtures',
  'lifecycleFixtures',
  'notificationsFixtures',
  'auditFixtures',
  'overviewSources',
  'entitlementViews',
  'defaultLifecycleViewer',
]);

const SOURCE_KINDS = Object.freeze(['development', 'stored']);

export class ReadSourceUnavailableError extends Error {
  constructor(reasonCode) {
    super(`The read source cannot answer: ${reasonCode}.`);
    this.name = 'ReadSourceUnavailableError';
    this.code = reasonCode;
  }
}

export function assertGovernanceReadSource(source) {
  if (source === null || typeof source !== 'object') {
    throw new TypeError('A governance read source is required.');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof source[method] !== 'function') {
      throw new TypeError(`A governance read source must implement ${method}.`);
    }
  }

  const described = source.describe();
  if (!SOURCE_KINDS.includes(described?.sourceKind)) {
    throw new TypeError(`describe() must name one of: ${SOURCE_KINDS.join(', ')}.`);
  }
  if (!['ephemeral', 'durable'].includes(described?.durability)) {
    throw new TypeError('describe() must state whether the source is ephemeral or durable.');
  }

  const capabilities = source.capabilities;
  if (capabilities === null || typeof capabilities !== 'object') {
    throw new TypeError('A governance read source must declare its capabilities.');
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!Object.hasOwn(capabilities, capability)) {
      throw new TypeError(`Capabilities must declare ${capability}.`);
    }
  }
  for (const capability of REQUIRED_CAPABILITIES.filter((name) => name !== 'defaultLifecycleViewer')) {
    const declared = capabilities[capability];
    if (!Array.isArray(declared) || declared.length === 0) {
      throw new TypeError(`${capability} must be a non-empty list of what the source can offer.`);
    }
  }
  if (typeof capabilities.defaultLifecycleViewer !== 'string' || capabilities.defaultLifecycleViewer.length === 0) {
    throw new TypeError('defaultLifecycleViewer must name the actor a screen defaults to.');
  }
  // Which actors may approve their own change. Empty is a valid answer and the stricter
  // one, so this is the one declaration that is not required to offer something.
  if (!Array.isArray(capabilities.selfApprovalActors)) {
    throw new TypeError('selfApprovalActors must list the actors holding approve-own-configuration, or be empty.');
  }

  return source;
}

export const GOVERNANCE_READ_SOURCE_METHODS = REQUIRED_METHODS;
export const GOVERNANCE_READ_SOURCE_CAPABILITIES = REQUIRED_CAPABILITIES;
