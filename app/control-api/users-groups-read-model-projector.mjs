import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';
import { assertBodyFreeReadModel } from './admin-read-model-projector.mjs';
import { evaluateEffectiveEntitlementBindings } from '../governance-domain/authorization/governance-authorization-evaluator.mjs';

const SAFE_READ_MODEL_KEYS = new Set([
  'readModelVersion',
  'generatedAt',
  'readModelId',
  'configurationVersion',
  'quality',
  'summary',
  'records',
  'selection',
]);

const VIEWS = Object.freeze(['users', 'groups', 'applications']);

// An application is not in the directory, because nobody is a member of one. The
// applications governance knows about are the ones its own policy names, and their
// membership question is which caller may act as them, not who belongs to them.
const APPLICATION_VIEW_SCOPES = Object.freeze(['team', 'global']);

function refuse(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function assertSelection(selection) {
  if (!VIEWS.includes(selection.view)) refuse('view-not-supported');
  // A self-scoped reader has no applications of their own to list, and an empty table
  // would read as an organization with no applications at all.
  if (selection.view === 'applications' && !APPLICATION_VIEW_SCOPES.includes(selection.scope)) {
    refuse('view-not-permitted-for-scope');
  }
}

/**
 * Self scope asks "which of these records is me", which only has an answer when the
 * reading identifies people the same way the caller's credential does.
 *
 * A directory reading does not. It comes from Microsoft Graph, which knows a person by
 * their directory object identifier, while the gateway forwards the token's subject,
 * which is pairwise per application. The two pseudonyms are computed from different
 * identifiers and can never be equal, so filtering by the caller would match nothing
 * and present it as belonging to no group.
 */
function assertSelfScopeAnswerable(fixture, selection) {
  if (selection.scope !== 'self') return;
  if (fixture.subjectsMatchCaller === undefined) {
    throw new TypeError('fixture must state whether its subjects identify the caller.');
  }
  if (fixture.subjectsMatchCaller !== true) refuse('self-scope-not-identifiable');

  // A reading written before groups carried their membership can say how many people
  // are in a group but not who. Filtering it would answer "you are in none of them"
  // from data that never addressed the question.
  if (selection.view === 'groups' &&
      fixture.groups.some((record) => !Array.isArray(record.memberSubjectIds))) {
    refuse('self-scope-membership-absent');
  }
}

/**
 * The applications policy names, as records the same projection can read.
 *
 * They carry no relation counts, because an application has no members: what it has
 * is the policy addressed to it, which is what the screen is for.
 */
function projectApplicationRecords(entitlementSnapshot, assignmentSnapshot) {
  const applications = new Map();
  for (const binding of entitlementSnapshot.bindings) {
    if (binding.target.kind !== 'application') continue;
    applications.set(binding.target.key, binding.state);
  }
  for (const assignment of assignmentSnapshot?.assignments ?? []) {
    if (assignment.assignee.kind !== 'application') continue;
    if (!applications.has(assignment.assignee.key)) applications.set(assignment.assignee.key, assignment.state);
  }

  return [...applications.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([applicationKey, state]) => ({
      recordKey: `directory-application-${applicationKey}`,
      applicationKey,
      displayCode: applicationKey,
      entityKind: 'application',
      teamCode: null,
      lifecycleState: state === 'active' ? 'active' : 'suspended',
      // Nothing was resolved from a directory, so the record says so rather than
      // claiming a completeness no observation supports.
      resolutionState: 'incomplete',
      directRelationCount: 0,
      inheritedRelationCount: 0,
    }));
}

function filterVisibleRecords(fixture, context, scope, teamKey) {
  if (scope === 'global') {
    return { users: fixture.users, groups: fixture.groups };
  }
  if (scope === 'team') {
    return {
      users: fixture.users.filter((record) => record.teamCode === teamKey),
      groups: fixture.groups.filter((record) => record.teamCode === teamKey),
    };
  }
  return {
    users: fixture.users.filter((record) => record.subjectId === context.subject.subjectId),
    groups: fixture.groups.filter((record) =>
      record.memberSubjectIds.includes(context.subject.subjectId)),
  };
}

function selectPolicyBindings(record, entitlementSnapshot) {
  return entitlementSnapshot.bindings.filter((binding) => {
    if (binding.state !== 'active') return false;
    if (binding.target.kind === 'global') return true;
    if (binding.target.kind === 'team') return binding.target.key === record.teamCode;
    if (binding.target.kind === 'subject') return binding.target.key === record.subjectId;
    if (binding.target.kind === 'application') return binding.target.key === record.applicationKey;
    return false;
  });
}

function projectPolicySource(binding, record, qualityState, configurationVersion) {
  const direct =
    binding.target.kind === 'subject' ||
    binding.target.kind === 'application' ||
    (record.entityKind === 'group' && binding.target.kind === 'team');
  const sourceKind =
    binding.target.kind === 'global'
      ? 'organization'
      : binding.target.kind === 'team'
        ? 'team'
        : binding.target.kind === 'application'
          ? 'application'
          : 'user';
  const sourceCode =
    binding.target.kind === 'global'
      ? 'organization-default'
      : binding.target.kind === 'team'
        ? binding.target.key
        : record.displayCode;
  return {
    originCode: direct ? 'direct' : 'inherited',
    sourceKind,
    sourceCode,
    decisionCode: qualityState === 'partial' ? 'unavailable' : 'allow',
    modelCodes: qualityState === 'partial' ? [] : structuredClone(binding.modelAllowlist),
    limits: qualityState === 'partial'
      ? {
          requestsPerMinute: null,
          tokensPerMinute: null,
          tokenQuota: null,
          quotaPeriod: null,
        }
      : {
          requestsPerMinute: binding.limits.requestsPerMinute ?? null,
          tokensPerMinute: binding.limits.tokensPerMinute ?? null,
          tokenQuota: binding.limits.tokenQuota ?? null,
          quotaPeriod: binding.limits.quotaPeriod ?? null,
        },
    configurationVersion,
    freshness: qualityState === 'fresh' ? 'fresh' : qualityState,
  };
}

function projectEffectivePolicy(bindings, fixture) {
  if (fixture.quality.state === 'stale') {
    return {
      decisionCode: 'unavailable',
      reasonCode: 'directory-evidence-stale',
      modelCodes: [],
      limits: { requestsPerMinute: null, tokensPerMinute: null },
      configurationVersion: fixture.configurationVersion,
    };
  }
  if (fixture.quality.state === 'partial') {
    return {
      decisionCode: 'unavailable',
      reasonCode: 'required-policy-unavailable',
      modelCodes: [],
      limits: { requestsPerMinute: null, tokensPerMinute: null },
      configurationVersion: fixture.configurationVersion,
    };
  }

  if (!bindings.some((binding) => binding.target.kind !== 'global')) {
    return {
      decisionCode: 'deny',
      reasonCode: 'principal-not-entitled',
      modelCodes: [],
      limits: { requestsPerMinute: null, tokensPerMinute: null },
      configurationVersion: fixture.configurationVersion,
    };
  }

  const effective = evaluateEffectiveEntitlementBindings(bindings);
  return {
    decisionCode: effective.decision,
    reasonCode: effective.reasonCode,
    modelCodes: structuredClone(effective.modelAllowlist),
    limits: structuredClone(effective.limits),
    configurationVersion: fixture.configurationVersion,
  };
}

function projectRecord(record, fixture, entitlementSnapshot) {
  const bindings = selectPolicyBindings(record, entitlementSnapshot);
  const sources = bindings.map((binding) =>
    projectPolicySource(
      binding,
      record,
      fixture.quality.state,
      fixture.configurationVersion,
    ));
  const direct = sources.filter((source) => source.originCode === 'direct');
  const inherited = sources.filter((source) => source.originCode === 'inherited');
  return {
    displayCode: record.displayCode,
    entityKind: record.entityKind,
    lifecycleState: record.lifecycleState,
    resolutionState: record.resolutionState,
    directRelationCount: record.directRelationCount,
    inheritedRelationCount: record.inheritedRelationCount,
    policyInspection: {
      direct,
      inherited,
      effective: projectEffectivePolicy(bindings, fixture),
    },
  };
}

export function projectUsersGroupsReadModel({
  context,
  authorization,
  entitlementSnapshot,
  assignmentSnapshot = null,
  fixture,
  selection,
}) {
  assertAuthorizedReadScope({
    authorization,
    scope: selection.scope,
    teamKey: selection.teamKey,
  });
  assertSelection(selection);
  assertSelfScopeAnswerable(fixture, selection);

  const visible = filterVisibleRecords(fixture, context, selection.scope, selection.teamKey);
  const applications = projectApplicationRecords(entitlementSnapshot, assignmentSnapshot);
  const inView = selection.view === 'applications' ? applications : visible[selection.view];
  const records = inView.map((record) => projectRecord(record, fixture, entitlementSnapshot));
  const allVisible = [...visible.users, ...visible.groups];
  const projectedVisible = allVisible.map((record) =>
    projectRecord(record, fixture, entitlementSnapshot));
  const readModel = {
    readModelVersion: 'users-groups.v1',
    generatedAt: fixture.generatedAt,
    readModelId: `users-groups-${fixture.name}-${selection.scope}-${selection.view}`,
    configurationVersion: fixture.configurationVersion,
    quality: structuredClone(fixture.quality),
    summary: {
      visibleUsers: visible.users.length,
      visibleGroups: visible.groups.length,
      visibleApplications: applications.length,
      directMemberships: visible.users.reduce(
        (sum, record) => sum + record.directRelationCount,
        0,
      ),
      inheritedMemberships: visible.users.reduce(
        (sum, record) => sum + record.inheritedRelationCount,
        0,
      ),
      unavailableOutcomes: projectedVisible.filter(
        (record) => record.policyInspection.effective.decisionCode === 'unavailable',
      ).length,
    },
    records,
    selection: {
      fixture: fixture.name,
      scope: selection.scope,
      view: selection.view,
      teamKey: selection.scope === 'team' ? selection.teamKey : null,
    },
  };
  assertBodyFreeReadModel(readModel, SAFE_READ_MODEL_KEYS);
  return readModel;
}