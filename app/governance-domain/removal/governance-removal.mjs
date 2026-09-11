import { createHash } from 'node:crypto';

import {
  TEAM_REMOVAL_REASONS,
  removeTeam,
} from '../authorization/team-catalog-edit.mjs';
import {
  assertEntitlementPolicySnapshotV1,
  assertGovernanceAssignmentSnapshotV1,
} from '../authorization/governance-authorization-validator.mjs';
import { AUTHORED_POLICY_RETENTION_SECONDS } from '../lifecycle/authored-policy-retention.mjs';
import { removeBudget } from '../policy/budget-edit.mjs';
import { editFallbackPlan } from '../policy/fallback-plan-edit.mjs';
import {
  assertFallbackPolicySnapshotV1,
} from '../policy/fallback-plan-compiler.mjs';
import { removeModel } from '../registry/model-capture.mjs';

export const MODEL_REMOVAL_REASONS = Object.freeze([
  'retired-by-provider',
  'replaced-by-newer-model',
  'no-longer-approved',
  'added-in-error',
]);

export const REMOVAL_REFERENCE_KINDS = Object.freeze([
  'entitlement-binding',
  'assignment-scope',
  'fallback-plan',
  'model-budget',
  'fallback-edge',
]);

export const REMOVAL_REFERENCE_ACTIONS = Object.freeze([
  'remove-binding',
  'remove-assignment',
  'remove-plan',
  'remove-model-from-allowlist',
  'remove-budget',
  'remove-edge',
]);

export const REMOVAL_BLOCKERS = Object.freeze({
  targetUnknown: 'removal-target-unknown',
  reasonUnsupported: 'removal-reason-unsupported',
  lastModel: 'removal-last-model',
  emptyAllowlist: 'removal-empty-model-allowlist',
  candidateInvalid: 'removal-candidate-invalid',
});

export class GovernanceRemovalRefusedError extends Error {
  constructor(reasonCode, detail = null) {
    super(reasonCode);
    this.name = 'GovernanceRemovalRefusedError';
    this.code = reasonCode;
    this.detail = detail;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digestFor({ target, reasonCode, snapshots }) {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ target, reasonCode, snapshots })))
    .digest('hex');
}

function nextSnapshot(snapshot, property, records, at) {
  return {
    ...snapshot,
    version: snapshot.version + 1,
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + AUTHORED_POLICY_RETENTION_SECONDS * 1000).toISOString(),
    [property]: records,
  };
}

function reference(referenceId, kind, code, state, action) {
  return Object.freeze({ referenceId, kind, code, state, action });
}

function teamReferences(snapshots, teamKey) {
  const references = [];
  for (const binding of snapshots.entitlementSnapshot.bindings) {
    if (binding.target.kind === 'team' && binding.target.key === teamKey) {
      references.push(reference(
        `entitlement-binding:${binding.bindingId}`,
        'entitlement-binding',
        binding.bindingId,
        binding.state,
        'remove-binding',
      ));
    }
  }
  for (const assignment of snapshots.assignmentSnapshot.assignments) {
    if (assignment.scope.kind === 'team' && assignment.scope.key === teamKey) {
      references.push(reference(
        `assignment-scope:${assignment.assignmentId}`,
        'assignment-scope',
        assignment.assignmentId,
        assignment.state,
        'remove-assignment',
      ));
    }
  }
  for (const plan of snapshots.fallbackPolicySnapshot.plans) {
    if (plan.target.kind === 'team' && plan.target.key === teamKey) {
      references.push(reference(
        `fallback-plan:${plan.planId}`,
        'fallback-plan',
        plan.planId,
        plan.state,
        'remove-plan',
      ));
    }
  }
  return references;
}

function modelReferences(snapshots, modelKey) {
  const references = [];
  for (const binding of snapshots.entitlementSnapshot.bindings) {
    if (binding.modelAllowlist.includes(modelKey)) {
      references.push(reference(
        `entitlement-binding:${binding.bindingId}:model:${modelKey}`,
        'entitlement-binding',
        binding.bindingId,
        binding.state,
        'remove-model-from-allowlist',
      ));
    }
  }
  for (const budget of snapshots.budgetSnapshot.budgets) {
    if (budget.modelScope === 'per-model' && budget.modelKey === modelKey) {
      references.push(reference(
        `model-budget:${budget.budgetId}`,
        'model-budget',
        budget.budgetId,
        'active',
        'remove-budget',
      ));
    }
  }
  for (const plan of snapshots.fallbackPolicySnapshot.plans) {
    for (const edge of plan.edges) {
      if (edge.from === modelKey || edge.to === modelKey) {
        references.push(reference(
          `fallback-edge:${plan.planId}:${edge.from}:${edge.to}`,
          'fallback-edge',
          plan.planId,
          plan.state,
          'remove-edge',
        ));
      }
    }
  }
  return references;
}

function assertTarget(target) {
  if (
    target === null
    || typeof target !== 'object'
    || Array.isArray(target)
    || !['team', 'model'].includes(target.kind)
    || typeof target.key !== 'string'
    || target.key.length === 0
    || Object.keys(target).some((key) => !['kind', 'key'].includes(key))
  ) {
    throw new GovernanceRemovalRefusedError('removal-target-invalid');
  }
}

function blockersFor({ snapshots, target, reasonCode, references }) {
  const blockers = [];
  const reasons = target.kind === 'team' ? TEAM_REMOVAL_REASONS : MODEL_REMOVAL_REASONS;
  if (!reasons.includes(reasonCode)) blockers.push({ reasonCode: REMOVAL_BLOCKERS.reasonUnsupported });

  const exists = target.kind === 'team'
    ? snapshots.entitlementSnapshot.teamCatalog.some((team) => team.teamKey === target.key)
    : snapshots.modelRegistrySnapshot.models.some((model) => model.modelKey === target.key);
  if (!exists) blockers.push({ reasonCode: REMOVAL_BLOCKERS.targetUnknown });
  if (target.kind === 'model') {
    if (snapshots.modelRegistrySnapshot.models.length === 1 && exists) {
      blockers.push({ reasonCode: REMOVAL_BLOCKERS.lastModel });
    }
    if (references.some((entry) => {
      if (entry.action !== 'remove-model-from-allowlist') return false;
      const binding = snapshots.entitlementSnapshot.bindings.find(
        (candidate) => candidate.bindingId === entry.code,
      );
      return binding?.modelAllowlist.length === 1;
    })) {
      blockers.push({ reasonCode: REMOVAL_BLOCKERS.emptyAllowlist });
    }
  }
  return blockers;
}

export function planGovernanceRemoval({ snapshots, target, reasonCode }) {
  assertTarget(target);
  const references = (
    target.kind === 'team'
      ? teamReferences(snapshots, target.key)
      : modelReferences(snapshots, target.key)
  ).sort((left, right) => left.referenceId.localeCompare(right.referenceId));
  const blockers = blockersFor({ snapshots, target, reasonCode, references });
  return Object.freeze({
    readModelVersion: 'removal-plan.v1',
    target: Object.freeze({ ...target }),
    reasonCode,
    planDigest: digestFor({ target, reasonCode, snapshots }),
    references: Object.freeze(references),
    blockers: Object.freeze(blockers),
    canPropose: blockers.length === 0,
  });
}

function assertExactSelection(references, selectedReferenceIds) {
  if (!Array.isArray(selectedReferenceIds)) {
    throw new GovernanceRemovalRefusedError('removal-selection-required');
  }
  if (new Set(selectedReferenceIds).size !== selectedReferenceIds.length) {
    throw new GovernanceRemovalRefusedError('removal-selection-duplicate');
  }
  const expected = references.map((entry) => entry.referenceId).sort();
  const selected = [...selectedReferenceIds].sort();
  if (JSON.stringify(expected) !== JSON.stringify(selected)) {
    throw new GovernanceRemovalRefusedError('removal-selection-incomplete');
  }
}

function applyTeamRemoval({ snapshots, target, reasonCode, at }) {
  const entitlementWithoutBindings = nextSnapshot(
    snapshots.entitlementSnapshot,
    'bindings',
    snapshots.entitlementSnapshot.bindings.filter(
      (binding) => !(binding.target.kind === 'team' && binding.target.key === target.key),
    ),
    at,
  );
  assertEntitlementPolicySnapshotV1(entitlementWithoutBindings, { evaluationTime: at });
  const entitlementSnapshot = removeTeam({
    snapshot: entitlementWithoutBindings,
    teamKey: target.key,
    reasonCode,
    at,
  });

  const assignments = snapshots.assignmentSnapshot.assignments.filter(
    (assignment) => !(assignment.scope.kind === 'team' && assignment.scope.key === target.key),
  );
  const assignmentSnapshot = assignments.length === snapshots.assignmentSnapshot.assignments.length
    ? snapshots.assignmentSnapshot
    : nextSnapshot(snapshots.assignmentSnapshot, 'assignments', assignments, at);
  if (assignmentSnapshot !== snapshots.assignmentSnapshot) {
    assertGovernanceAssignmentSnapshotV1(assignmentSnapshot, { evaluationTime: at });
  }

  const plans = snapshots.fallbackPolicySnapshot.plans.filter(
    (plan) => !(plan.target.kind === 'team' && plan.target.key === target.key),
  );
  const fallbackPolicySnapshot = plans.length === snapshots.fallbackPolicySnapshot.plans.length
    ? snapshots.fallbackPolicySnapshot
    : nextSnapshot(snapshots.fallbackPolicySnapshot, 'plans', plans, at);
  if (fallbackPolicySnapshot !== snapshots.fallbackPolicySnapshot) {
    assertFallbackPolicySnapshotV1(fallbackPolicySnapshot, { evaluationTime: at });
  }
  return { ...snapshots, entitlementSnapshot, assignmentSnapshot, fallbackPolicySnapshot };
}

function applyModelRemoval({ snapshots, target, reasonCode, at }) {
  const entitlementChanged = snapshots.entitlementSnapshot.bindings.some(
    (binding) => binding.modelAllowlist.includes(target.key),
  );
  const bindings = snapshots.entitlementSnapshot.bindings.map((binding) =>
    binding.modelAllowlist.includes(target.key)
      ? {
          ...binding,
          bindingVersion: binding.bindingVersion + 1,
          modelAllowlist: binding.modelAllowlist.filter((modelKey) => modelKey !== target.key),
        }
      : binding);
  const entitlementSnapshot = entitlementChanged
    ? nextSnapshot(snapshots.entitlementSnapshot, 'bindings', bindings, at)
    : snapshots.entitlementSnapshot;
  if (entitlementSnapshot !== snapshots.entitlementSnapshot) {
    assertEntitlementPolicySnapshotV1(entitlementSnapshot, { evaluationTime: at });
  }

  let budgetSnapshot = snapshots.budgetSnapshot;
  for (const budget of snapshots.budgetSnapshot.budgets) {
    if (budget.modelScope === 'per-model' && budget.modelKey === target.key) {
      budgetSnapshot = removeBudget({
        snapshot: budgetSnapshot,
        budgetId: budget.budgetId,
        reasonCode,
        at,
      });
    }
  }

  let fallbackPolicySnapshot = snapshots.fallbackPolicySnapshot;
  for (const plan of snapshots.fallbackPolicySnapshot.plans) {
    const edges = plan.edges.filter((edge) => edge.from !== target.key && edge.to !== target.key);
    if (edges.length !== plan.edges.length) {
      fallbackPolicySnapshot = editFallbackPlan({
        snapshot: fallbackPolicySnapshot,
        planId: plan.planId,
        changes: { edges },
        at,
      });
    }
  }
  const modelRegistrySnapshot = removeModel({
    snapshot: snapshots.modelRegistrySnapshot,
    modelKey: target.key,
    reasonCode,
    entitlementSnapshot,
    at,
  });
  return {
    ...snapshots,
    entitlementSnapshot,
    budgetSnapshot,
    fallbackPolicySnapshot,
    modelRegistrySnapshot,
  };
}

export function applyGovernanceRemoval({
  snapshots,
  target,
  reasonCode,
  planDigest,
  selectedReferenceIds,
  at,
}) {
  const plan = planGovernanceRemoval({ snapshots, target, reasonCode });
  if (plan.planDigest !== planDigest) {
    throw new GovernanceRemovalRefusedError('removal-plan-stale');
  }
  if (!plan.canPropose) {
    throw new GovernanceRemovalRefusedError(plan.blockers[0].reasonCode);
  }
  assertExactSelection(plan.references, selectedReferenceIds);
  try {
    return target.kind === 'team'
      ? applyTeamRemoval({ snapshots, target, reasonCode, at })
      : applyModelRemoval({ snapshots, target, reasonCode, at });
  } catch (error) {
    if (error instanceof GovernanceRemovalRefusedError) throw error;
    throw new GovernanceRemovalRefusedError(
      error.code ?? REMOVAL_BLOCKERS.candidateInvalid,
      error.message,
    );
  }
}
