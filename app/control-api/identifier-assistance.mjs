/**
 * The identifier picker is deliberately a small, server-owned projection.
 *
 * Raw token claims are never returned. The only caller-specific values are the
 * HMAC pseudonyms the policy and telemetry code already knows how to derive.
 * Authoring targets, directory identifiers, team keys, and model names remain
 * separate entries so an operator cannot mistake one identifier namespace for
 * another.
 */

export const IDENTIFIER_EVIDENCE_VERSION = 'identifier-evidence.v1';

const TARGET_IDENTIFIER_KINDS = Object.freeze({
  subject: 'gateway-subject',
  application: 'application-client-id',
  team: 'canonical-team-key',
  global: 'global-scope',
});

function currentCallerUnavailable(reasonCode, source) {
  return Object.freeze({
    state: 'unavailable',
    scope: 'control-plane-token',
    source,
    reasonCode,
    notInferenceIdentityProof: true,
    notEntitlementTarget: true,
  });
}

function identityParts(identity) {
  return {
    tenantId: identity?.subject?.tenantId ?? identity?.tenantId,
    subjectId: identity?.subject?.subjectId ?? identity?.subjectId,
    applicationId: identity?.application?.applicationId ?? identity?.applicationId,
  };
}

/**
 * Build caller diagnostics only from an already verified identity and the
 * configured production deriver. In particular, objectId is intentionally not
 * accepted as a subject fallback: directory actor codes and gateway `sub` are
 * different namespaces.
 */
export function deriveCurrentCallerDiagnostic({
  identity,
  deriver,
  scope = 'control-plane-token',
  source = 'verified-control-plane-token',
} = {}) {
  const { tenantId, subjectId, applicationId } = identityParts(identity);
  if (deriver === null || typeof deriver?.deriveSubjectKey !== 'function'
    || typeof deriver?.deriveApplicationKey !== 'function') {
    return Object.freeze({
      ...currentCallerUnavailable('derivation-unavailable', source),
      scope,
    });
  }
  if ([tenantId, subjectId, applicationId].some((value) => typeof value !== 'string' || value.length === 0)) {
    return Object.freeze({
      ...currentCallerUnavailable('caller-identifiers-unavailable', source),
      scope,
    });
  }
  try {
    return Object.freeze({
      state: 'available',
      scope,
      source,
      subjectKey: deriver.deriveSubjectKey({ tenantId, subjectId }),
      applicationKey: deriver.deriveApplicationKey({ tenantId, applicationId }),
      derivationVersion: deriver.version,
      notInferenceIdentityProof: true,
      notEntitlementTarget: true,
    });
  } catch {
    return Object.freeze({
      ...currentCallerUnavailable('derivation-failed', source),
      scope,
    });
  }
}

function value(sourceKind, identifierKind, value, sourceCode, extra = {}) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return {
    sourceKind,
    identifierKind,
    value,
    sourceCode,
    ...extra,
  };
}

/**
 * Return only identifiers already present in the published authoring snapshots.
 * This is not a directory search and does not expose a new join key.
 */
export function projectKnownAuthorizedIdentifiers(snapshots) {
  const values = [];
  for (const binding of snapshots?.entitlementSnapshot?.bindings ?? []) {
    const target = binding?.target;
    if (!target) continue;
    const identifierKind = TARGET_IDENTIFIER_KINDS[target.kind];
    if (identifierKind && target.key !== null) {
      values.push(value(
        'entitlement-target',
        identifierKind,
        target.key,
        binding.bindingId,
        { targetKind: target.kind },
      ));
    }
  }
  for (const assignment of (snapshots?.assignmentSnapshot?.assignments ?? [])
    .filter((entry) => entry?.state === 'active')) {
    const assignee = assignment?.assignee;
    if (assignee?.kind && assignee.key !== null) {
      values.push(value(
        'assignment-assignee',
        assignee.kind === 'subject'
          ? 'gateway-subject'
          : assignee.kind === 'application'
            ? 'application-client-id'
            : assignee.kind === 'group'
              ? 'entra-group-id'
              : 'assignment-assignee',
        assignee.key,
        assignment.assignmentId,
        { assigneeKind: assignee.kind },
      ));
    }
    const scope = assignment?.scope;
    if (scope?.kind === 'team' && scope.key !== null) {
      values.push(value('assignment-scope', 'canonical-team-key', scope.key, assignment.assignmentId, {
        scopeKind: scope.kind,
      }));
    }
  }
  for (const team of snapshots?.entitlementSnapshot?.teamCatalog ?? []) {
    values.push(value('team-catalog', 'canonical-team-key', team.teamKey, team.teamKey));
    values.push(value('team-membership', 'entra-group-id', team.membershipGroupId, team.teamKey));
  }
  for (const model of snapshots?.modelRegistrySnapshot?.models ?? []) {
    values.push(value('model-registry', 'logical-model-alias', model.modelKey, model.modelKey));
    values.push(value(
      'provider-deployment',
      'provider-deployment-name',
      model.providerDeploymentName,
      model.modelKey,
    ));
  }

  const seen = new Set();
  return Object.freeze(values.filter((entry) => {
    if (entry === null) return false;
    const key = `${entry.identifierKind}:${entry.value}:${entry.sourceKind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export function buildIdentifierEvidence({
  identity,
  deriver = null,
  snapshots,
  scope = 'control-plane-token',
  source = 'verified-control-plane-token',
} = {}) {
  return Object.freeze({
    version: IDENTIFIER_EVIDENCE_VERSION,
    currentCaller: deriveCurrentCallerDiagnostic({ identity, deriver, scope, source }),
    knownAuthorizedValues: projectKnownAuthorizedIdentifiers(snapshots),
  });
}
