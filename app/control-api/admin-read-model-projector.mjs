import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';

const SAFE_READ_MODEL_KEYS = new Set([
  'readModelVersion',
  'generatedAt',
  'readModelId',
  'configuration',
  'freshness',
  'operatingState',
  'metrics',
  'modelUsage',
  'attention',
  'recentActivity',
  'selection',
]);

const FORBIDDEN_SERIALIZED_KEYS = [
  'trust',
  'validationId',
  'subjectId',
  'applicationId',
  'groupId',
  'role',
  'roles',
  'membership',
  'memberships',
  'permissions',
  'accessToken',
  'authorization',
  'prompt',
  'completion',
  'requestBody',
  'responseBody',
  'backendUrl',
  'resourceId',
];

function assertSelection(selection) {
  if (!['24h', '7d', '30d'].includes(selection.range)) {
    const error = new Error('range-not-supported');
    error.code = 'range-not-supported';
    throw error;
  }
}

function assertBodyFreeReadModel(readModel, safeReadModelKeys = SAFE_READ_MODEL_KEYS) {
  for (const key of Object.keys(readModel)) {
    if (!safeReadModelKeys.has(key)) {
      throw new TypeError(`Read-model field ${key} is not allowed.`);
    }
  }
  const serialized = JSON.stringify(readModel);
  for (const key of FORBIDDEN_SERIALIZED_KEYS) {
    if (serialized.includes(`"${key}"`)) {
      throw new TypeError(`Read model contains forbidden field ${key}.`);
    }
  }
}

export function projectAdminOverview({ authorization, fixture, selection }) {
  assertAuthorizedReadScope({
    authorization,
    scope: selection.scope,
    teamKey: selection.teamKey,
  });
  assertSelection(selection);

  const readModel = {
    readModelVersion: 'overview.v2',
    generatedAt: fixture.generatedAt,
    readModelId: `overview-${fixture.name}-${selection.scope}-${selection.range}`,
    configuration: structuredClone(fixture.configuration),
    freshness: structuredClone(fixture.freshness),
    operatingState: structuredClone(fixture.operatingState),
    metrics: structuredClone(fixture.metrics),
    modelUsage: structuredClone(fixture.modelUsage),
    attention: structuredClone(fixture.attention),
    recentActivity: structuredClone(fixture.recentActivity),
    selection: {
      fixture: fixture.name,
      scope: selection.scope,
      range: selection.range,
      teamKey: selection.scope === 'team' ? selection.teamKey : null,
    },
  };
  assertBodyFreeReadModel(readModel);
  return readModel;
}

export { assertBodyFreeReadModel };