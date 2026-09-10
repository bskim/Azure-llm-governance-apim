import { AUTHORED_POLICY_RETENTION_SECONDS } from '../lifecycle/authored-policy-retention.mjs';
import { captureModel } from '../registry/model-capture.mjs';
import { REGISTRY_CAPTURE_RETENTION_SECONDS } from '../registry/registry-capture-retention.mjs';
import {
  assembleGovernanceSnapshots,
  assertGovernanceSnapshotDocument,
  governanceSnapshotDocument,
} from './governance-snapshot-document.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ISSUER = Object.freeze({ kind: 'system', key: 'system-initial-bootstrap' });
const REASON_CODE = 'initial-governance-set';

export const INITIAL_SET_REASONS = Object.freeze({
  groupIdNotGuid: 'initial-set-group-id-not-guid',
  tenantIdNotGuid: 'initial-set-tenant-id-not-guid',
  deploymentUnknown: 'initial-set-deployment-unknown',
  modelOutsideOrganization: 'initial-set-model-outside-organization',
  duplicateModel: 'initial-set-duplicate-model',
  duplicateTeam: 'initial-set-duplicate-team',
  snapshotInvalid: 'initial-set-snapshot-invalid',
});

export class InitialGovernanceSetRefusedError extends Error {
  constructor(code, detail = null) {
    super(`The initial governance set was refused: ${code}.`);
    this.name = 'InitialGovernanceSetRefusedError';
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code, detail) {
  throw new InitialGovernanceSetRefusedError(code, detail);
}

function assertRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
}

function assertExactKeys(value, required, optional, path) {
  assertRecord(value, path);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${path}.${key} is not allowed.`);
  }
}

function assertSafeId(value, path) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${path} must be a bounded safe identifier.`);
  }
}

function assertGuid(value, path, reason = INITIAL_SET_REASONS.groupIdNotGuid) {
  if (typeof value !== 'string' || !GUID.test(value)) {
    refuse(reason, path);
  }
}

function sortedUnique(values, reason, path) {
  if (new Set(values).size !== values.length) refuse(reason, path);
  return [...values].sort((left, right) => left.localeCompare(right));
}

function envelope({ kind, tenantId, at, retentionSeconds, collection }) {
  return {
    contractVersion: 'v1',
    snapshotId: `initial-${kind}-001`,
    tenantId,
    version: 1,
    status: 'complete',
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + retentionSeconds * 1000).toISOString(),
    sourceRevision: 'initial-governance-set',
    ...collection,
  };
}

function captureModels(input, deployments) {
  const byName = new Map(deployments.map((entry) => [entry.deploymentName, entry]));
  const models = input.models.map((requested, index) => {
    assertExactKeys(requested, ['deploymentName'], ['modelKey'], `input.models[${index}]`);
    const deployment = byName.get(requested.deploymentName);
    if (deployment === undefined) refuse(INITIAL_SET_REASONS.deploymentUnknown, requested.deploymentName);
    return captureModel({ deployment, modelKey: requested.modelKey });
  });
  sortedUnique(models.map((model) => model.modelKey), INITIAL_SET_REASONS.duplicateModel, 'input.models');
  return models.sort((left, right) => left.modelKey.localeCompare(right.modelKey));
}

function assertAllowlist(values, { captured, organization, path }) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${path} must allow at least one model.`);
  }
  for (const [index, modelKey] of values.entries()) {
    assertSafeId(modelKey, `${path}[${index}]`);
    if (!captured.has(modelKey)) refuse(INITIAL_SET_REASONS.deploymentUnknown, modelKey);
    if (organization !== null && !organization.has(modelKey)) {
      refuse(INITIAL_SET_REASONS.modelOutsideOrganization, modelKey);
    }
  }
  return sortedUnique(values, INITIAL_SET_REASONS.duplicateModel, path);
}

function buildEntitlement(input, registryModels, at) {
  const captured = new Set(registryModels.map((model) => model.modelKey));
  const organizationModels = assertAllowlist(input.organization.models, {
    captured,
    organization: null,
    path: 'input.organization.models',
  });
  const organization = new Set(organizationModels);
  const teamCatalog = [];
  const bindings = [{
    bindingId: 'binding-organization-001',
    bindingVersion: 1,
    state: 'active',
    target: { kind: 'global', key: null },
    modelAllowlist: organizationModels,
    limits: input.organization.limits,
    validFrom: at,
    validUntil: null,
    issuedBy: ISSUER,
    reasonCode: REASON_CODE,
  }];

  for (const [index, team] of input.teams.entries()) {
    const path = `input.teams[${index}]`;
    assertExactKeys(team, ['teamKey', 'membershipGroupId'], ['models', 'limits'], path);
    assertSafeId(team.teamKey, `${path}.teamKey`);
    assertGuid(team.membershipGroupId, `${path}.membershipGroupId`);
    teamCatalog.push({ teamKey: team.teamKey, membershipGroupId: team.membershipGroupId });
    if (team.models === undefined && team.limits === undefined) continue;
    if (team.models === undefined || team.limits === undefined) {
      throw new TypeError(`${path} must state models and limits together, or neither.`);
    }
    bindings.push({
      bindingId: `binding-team-${team.teamKey}-001`,
      bindingVersion: 1,
      state: 'active',
      target: { kind: 'team', key: team.teamKey },
      modelAllowlist: assertAllowlist(team.models, { captured, organization, path: `${path}.models` }),
      limits: team.limits,
      validFrom: at,
      validUntil: null,
      issuedBy: ISSUER,
      reasonCode: REASON_CODE,
    });
  }

  sortedUnique(teamCatalog.map((entry) => entry.teamKey), INITIAL_SET_REASONS.duplicateTeam, 'input.teams');
  sortedUnique(
    teamCatalog.map((entry) => entry.membershipGroupId),
    INITIAL_SET_REASONS.duplicateTeam,
    'input.teams membershipGroupId',
  );
  return {
    organizationModels,
    teamCatalog: teamCatalog.sort((left, right) => left.teamKey.localeCompare(right.teamKey)),
    bindings: bindings.sort((left, right) => left.bindingId.localeCompare(right.bindingId)),
  };
}

function buildFallback(input, organizationModels, at) {
  if (input.fallback === undefined || input.fallback === null) return [];
  assertExactKeys(
    input.fallback,
    ['enabled', 'edges'],
    ['modelSelectionIntent', 'substitutionNotice', 'onExhausted'],
    'input.fallback',
  );
  if (!Array.isArray(input.fallback.edges)) throw new TypeError('input.fallback.edges must be an array.');
  const allowed = new Set(organizationModels);
  for (const edge of input.fallback.edges) {
    if (!allowed.has(edge?.from) || !allowed.has(edge?.to)) {
      refuse(INITIAL_SET_REASONS.modelOutsideOrganization, 'input.fallback.edges');
    }
  }
  const optional = {};
  for (const key of ['modelSelectionIntent', 'substitutionNotice', 'onExhausted']) {
    if (Object.hasOwn(input.fallback, key)) optional[key] = input.fallback[key];
  }
  return [{
    planId: 'plan-organization-001',
    planVersion: 1,
    state: 'active',
    target: { kind: 'global', key: null },
    enabled: input.fallback.enabled,
    ...optional,
    edges: input.fallback.edges,
    validFrom: at,
    validUntil: null,
    issuedBy: ISSUER,
    reasonCode: REASON_CODE,
  }];
}

export function buildInitialGovernanceSet({ input, deployments, at } = {}) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (!Array.isArray(deployments)) throw new TypeError('deployments must be an array.');
  assertExactKeys(
    input,
    ['tenantId', 'scopeGroupId', 'organization', 'teams', 'models'],
    ['applications', 'budgets', 'fallback'],
    'input',
  );
  assertGuid(input.tenantId, 'input.tenantId', INITIAL_SET_REASONS.tenantIdNotGuid);
  assertSafeId(input.scopeGroupId, 'input.scopeGroupId');
  assertExactKeys(input.organization, ['models', 'limits'], [], 'input.organization');
  if (!Array.isArray(input.teams)) throw new TypeError('input.teams must be an array.');
  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new TypeError('input.models must name at least one provider deployment.');
  }

  const registryModels = captureModels(input, deployments);
  const { organizationModels, teamCatalog, bindings } = buildEntitlement(input, registryModels, at);
  const applications = [...(input.applications ?? [])]
    .sort((left, right) => String(left?.applicationId).localeCompare(String(right?.applicationId)));
  const budgets = [...(input.budgets ?? [])]
    .sort((left, right) => String(left?.budgetId).localeCompare(String(right?.budgetId)));
  const authored = { tenantId: input.tenantId, at, retentionSeconds: AUTHORED_POLICY_RETENTION_SECONDS };
  const snapshotsByKind = {
    assignment: envelope({ ...authored, kind: 'assignment', collection: { assignments: [] } }),
    entitlement: {
      ...envelope({ ...authored, kind: 'entitlement', collection: { bindings } }),
      teamCatalog,
    },
    modelRegistry: envelope({
      tenantId: input.tenantId,
      at,
      retentionSeconds: REGISTRY_CAPTURE_RETENTION_SECONDS,
      kind: 'modelRegistry',
      collection: { models: registryModels, applications },
    }),
    fallbackPolicy: envelope({
      ...authored,
      kind: 'fallbackPolicy',
      collection: { plans: buildFallback(input, organizationModels, at) },
    }),
    budget: envelope({ ...authored, kind: 'budget', collection: { budgets } }),
  };

  const documents = Object.entries(snapshotsByKind).map(([kind, snapshot]) => {
    try {
      return assertGovernanceSnapshotDocument(
        governanceSnapshotDocument({ scopeGroupId: input.scopeGroupId, kind, snapshot }),
        { evaluationTime: at },
      );
    } catch (error) {
      refuse(INITIAL_SET_REASONS.snapshotInvalid, `${kind}: ${error.message}`);
    }
  });
  const snapshots = assembleGovernanceSnapshots(documents);
  return Object.freeze({
    scopeGroupId: input.scopeGroupId,
    content: Object.freeze({ snapshots }),
    summary: Object.freeze({
      scopeGroupId: input.scopeGroupId,
      teamKeys: Object.freeze(teamCatalog.map((entry) => entry.teamKey)),
      modelKeys: Object.freeze(registryModels.map((model) => model.modelKey)),
      organizationModelKeys: Object.freeze(organizationModels),
      counts: Object.freeze({
        assignments: 0,
        bindings: bindings.length,
        models: registryModels.length,
        applications: applications.length,
        budgets: budgets.length,
        fallbackEdges: snapshotsByKind.fallbackPolicy.plans[0]?.edges.length ?? 0,
      }),
      expiresAt: Object.freeze({
        authored: snapshotsByKind.assignment.expiresAt,
        registry: snapshotsByKind.modelRegistry.expiresAt,
      }),
    }),
  });
}