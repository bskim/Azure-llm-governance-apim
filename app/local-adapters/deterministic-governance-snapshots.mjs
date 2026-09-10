import {
  assertEntitlementPolicySnapshotV1,
  assertGovernanceAssignmentSnapshotV1,
} from '../governance-domain/authorization/governance-authorization-validator.mjs';
import { assertBudgetSnapshotV1 } from '../governance-domain/policy/budget-publication.mjs';
import { assertFallbackPolicySnapshotV1 } from '../governance-domain/policy/fallback-plan-compiler.mjs';
import { assertModelRegistrySnapshotV1 } from '../governance-domain/registry/model-registry-validator.mjs';
import { REGISTRY_CAPTURE_RETENTION_SECONDS } from '../governance-domain/registry/registry-capture-retention.mjs';

const evaluationTime = '2026-07-24T10:00:00.000Z';

const ASSIGNMENT_SNAPSHOT = Object.freeze({
  contractVersion: 'v1',
  snapshotId: 'assignment-snapshot-local-001',
  tenantId: 'tenant-local-demo',
  version: 1,
  status: 'complete',
  capturedAt: '2026-07-24T09:55:00.000Z',
  expiresAt: '2026-07-24T10:30:00.000Z',
  sourceRevision: 'assignment-source-local-001',
  assignments: [
    {
      assignmentId: 'assignment-auditor-local-001',
      assignmentVersion: 1,
      state: 'active',
      roleCode: 'auditor',
      assignee: { kind: 'group', key: 'group-auditor' },
      scope: { kind: 'global', key: null },
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-access',
    },
    {
      assignmentId: 'assignment-governance-admin-local-001',
      assignmentVersion: 1,
      state: 'active',
      roleCode: 'governance-admin',
      assignee: { kind: 'group', key: 'group-governance-admin' },
      scope: { kind: 'global', key: null },
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-access',
    },
  ],
});

const ENTITLEMENT_SNAPSHOT = Object.freeze({
  contractVersion: 'v1',
  snapshotId: 'entitlement-snapshot-local-001',
  tenantId: 'tenant-local-demo',
  version: 1,
  status: 'complete',
  capturedAt: '2026-07-24T09:55:00.000Z',
  expiresAt: '2026-07-24T10:30:00.000Z',
  sourceRevision: 'entitlement-source-local-001',
  teamCatalog: [
    { teamKey: 'developer-experience', membershipGroupId: 'group-end-user' },
    { teamKey: 'platform-engineering', membershipGroupId: 'group-governance-admin' },
  ],
  bindings: [
    // A coding agent entitled in its own right, so the applications view has something
    // that is not also a person. It is not the console, whose callers are the personas.
    {
      bindingId: 'binding-application-local-agent-001',
      bindingVersion: 1,
      state: 'active',
      target: { kind: 'application', key: 'app-local-agent' },
      modelAllowlist: ['coding-primary'],
      limits: { requestsPerMinute: 30, tokensPerMinute: 30_000, tokenQuota: 3_000_000, quotaPeriod: 'Monthly' },
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-policy',
    },
    {
      bindingId: 'binding-global-local-001',
      bindingVersion: 1,
      state: 'active',
      target: { kind: 'global', key: null },
      modelAllowlist: ['coding-primary'],
      limits: { requestsPerMinute: 80, tokensPerMinute: 80_000, tokenQuota: 40_000_000, quotaPeriod: 'Monthly' },
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-policy',
    },
    {
      bindingId: 'binding-subject-local-admin-001',
      bindingVersion: 1,
      state: 'active',
      target: { kind: 'subject', key: 'user-local-admin' },
      modelAllowlist: ['coding-fast', 'coding-primary'],
      limits: { requestsPerMinute: 120, tokensPerMinute: 120_000, tokenQuota: 6_000_000, quotaPeriod: 'Monthly' },
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-policy',
    },
    {
      bindingId: 'binding-subject-local-auditor-001',
      bindingVersion: 1,
      state: 'active',
      target: { kind: 'subject', key: 'user-local-auditor' },
      modelAllowlist: ['coding-primary'],
      limits: { requestsPerMinute: 60, tokensPerMinute: 60_000, tokenQuota: 2_000_000, quotaPeriod: 'Monthly' },
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-policy',
    },
    {
      bindingId: 'binding-subject-local-end-user-001',
      bindingVersion: 1,
      state: 'active',
      target: { kind: 'subject', key: 'user-local-end-user' },
      modelAllowlist: ['coding-fast', 'coding-primary'],
      limits: { requestsPerMinute: 50, tokensPerMinute: 50_000, tokenQuota: 1_500_000, quotaPeriod: 'Monthly' },
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-policy',
    },
    {
      bindingId: 'binding-team-developer-experience-001',
      bindingVersion: 1,
      state: 'active',
      target: { kind: 'team', key: 'developer-experience' },
      modelAllowlist: ['coding-fast'],
      limits: { requestsPerMinute: 40, tokensPerMinute: 40_000, tokenQuota: 8_000_000, quotaPeriod: 'Monthly' },
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-policy',
    },
    {
      bindingId: 'binding-team-platform-engineering-001',
      bindingVersion: 1,
      state: 'active',
      target: { kind: 'team', key: 'platform-engineering' },
      modelAllowlist: ['coding-fast', 'coding-primary'],
      limits: { requestsPerMinute: 100, tokensPerMinute: 100_000, tokenQuota: 12_000_000, quotaPeriod: 'Monthly' },
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-policy',
    },
  ],
});

const MODEL_REGISTRY_SNAPSHOT = Object.freeze({
  contractVersion: 'v1',
  snapshotId: 'model-registry-local-001',
  tenantId: 'tenant-local-demo',
  version: 1,
  status: 'complete',
  capturedAt: '2026-07-24T09:55:00.000Z',
  expiresAt: new Date(
    Date.parse('2026-07-24T09:55:00.000Z') + REGISTRY_CAPTURE_RETENTION_SECONDS * 1000,
  ).toISOString(),
  sourceRevision: 'model-registry-source-local-001',
  models: [
    {
      // The cheaper alternative. It matches the primary on everything a downgrade
      // may not lose, so price is the only axis that differs.
      modelKey: 'coding-fast',
      providerKey: 'azure-openai',
      providerDeploymentName: 'deploy-coding-fast',
      apiFamilies: ['openai-chat-completions', 'openai-responses'],
      lifecycle: 'generally-available',
      safetyPolicy: 'local-default-policy',
    },
    {
      modelKey: 'coding-primary',
      providerKey: 'azure-openai',
      providerDeploymentName: 'deploy-coding-primary',
      apiFamilies: ['openai-chat-completions', 'openai-responses'],
      lifecycle: 'generally-available',
      safetyPolicy: 'local-default-policy',
    },
  ],
  applications: [
    // A shared developer tool authenticates as itself, so a request through it names the
    // tool rather than the agent that used it. Recorded as `generic` for that reason.
    { applicationId: 'app-local-agent', attributionQuality: 'generic', displayCode: 'application.local-agent' },
    { applicationId: 'app-local-console', attributionQuality: 'strong', displayCode: 'application.local-console' },
  ],
});

const FALLBACK_POLICY_SNAPSHOT = Object.freeze({
  contractVersion: 'v1',
  snapshotId: 'fallback-policy-local-001',
  tenantId: 'tenant-local-demo',
  version: 1,
  status: 'complete',
  capturedAt: '2026-07-24T09:55:00.000Z',
  expiresAt: '2026-07-24T10:30:00.000Z',
  sourceRevision: 'fallback-source-local-001',
  plans: [
    {
      planId: 'plan-global-cheaper-alternative-001',
      planVersion: 1,
      state: 'active',
      target: { kind: 'global', key: null },
      enabled: true,
      // Stated rather than omitted, because omitting it pins: authoring a ladder and
      // opting callers into it are deliberately separate steps.
      modelSelectionIntent: 'preferred',
      edges: [{ from: 'coding-primary', to: 'coding-fast' }],
      validFrom: '2026-07-24T00:00:00.000Z',
      validUntil: null,
      issuedBy: { kind: 'system', key: 'system-local-bootstrap' },
      reasonCode: 'local-fixture-fallback',
    },
  ],
});

const BUDGET_SNAPSHOT = Object.freeze({
  contractVersion: 'v1',
  snapshotId: 'budget-snapshot-local-001',
  tenantId: 'tenant-local-demo',
  version: 1,
  status: 'complete',
  capturedAt: '2026-07-24T09:55:00.000Z',
  expiresAt: '2026-07-24T10:30:00.000Z',
  sourceRevision: 'budget-source-local-001',
  budgets: [
    {
      // Tighter than the entitlement cap, so the merge is observable locally.
      budgetId: 'budget-organization-monthly',
      budgetVersion: 1,
      scope: 'organization',
      action: 'SOFT_WARNING',
      modelScope: 'all-models',
      accountingBasis: 'apim-estimated-total-tokens',
      limit: { unit: 'tokens', currency: null, amount: 20_000_000 },
      period: 'Monthly',
      thresholds: { graceBasisPoints: 1_000 },
    },
  ],
});

export function getDeterministicGovernanceSnapshots() {
  const snapshots = {
    assignmentSnapshot: structuredClone(ASSIGNMENT_SNAPSHOT),
    entitlementSnapshot: structuredClone(ENTITLEMENT_SNAPSHOT),
    modelRegistrySnapshot: structuredClone(MODEL_REGISTRY_SNAPSHOT),
    fallbackPolicySnapshot: structuredClone(FALLBACK_POLICY_SNAPSHOT),
    budgetSnapshot: structuredClone(BUDGET_SNAPSHOT),
  };
  assertGovernanceAssignmentSnapshotV1(snapshots.assignmentSnapshot, { evaluationTime });
  assertEntitlementPolicySnapshotV1(snapshots.entitlementSnapshot, { evaluationTime });
  snapshots.modelRegistrySnapshot = assertModelRegistrySnapshotV1(snapshots.modelRegistrySnapshot, {
    evaluationTime,
    principalTenantId: snapshots.entitlementSnapshot.tenantId,
  });
  snapshots.fallbackPolicySnapshot = assertFallbackPolicySnapshotV1(snapshots.fallbackPolicySnapshot, {
    evaluationTime,
    principalTenantId: snapshots.entitlementSnapshot.tenantId,
  });
  snapshots.budgetSnapshot = assertBudgetSnapshotV1(snapshots.budgetSnapshot, {
    evaluationTime,
    principalTenantId: snapshots.entitlementSnapshot.tenantId,
  });
  return snapshots;
}
