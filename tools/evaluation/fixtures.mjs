const evaluationTime = '2026-09-11T00:00:00.000Z';
const tenantId = 'evaluation-local-tenant';
const caps = Object.freeze({ maxRequests: 1, maxInputTokens: 3, maxOutputTokens: 2, maxTotalTokens: 5 });

function registry() {
  return {
    contractVersion: 'v1', snapshotId: 'evaluation-registry-001', tenantId, version: 1, status: 'complete',
    capturedAt: '2026-09-10T23:55:00.000Z', expiresAt: '2026-09-11T00:30:00.000Z', sourceRevision: 'evaluation-registry-source-001',
    models: ['fallback-model', 'primary-model'].map((modelKey) => ({
      modelKey, providerKey: 'azure-openai', apiFamilies: ['openai-responses'], lifecycle: 'generally-available', safetyPolicy: 'local-default-policy',
    })),
    applications: [],
  };
}

function budget(action, thresholds = {}) {
  return {
    budgetId: `evaluation-${action.toLowerCase()}`, budgetVersion: 1, scope: 'organization', action,
    modelScope: 'all-models', accountingBasis: 'apim-estimated-total-tokens',
    limit: { unit: 'tokens', currency: null, amount: 100 }, period: 'Daily', thresholds,
  };
}

function budgetSnapshot(action, thresholds) {
  return {
    contractVersion: 'v1', snapshotId: `evaluation-${action.toLowerCase()}-snapshot`, tenantId, version: 1, status: 'complete',
    capturedAt: '2026-09-10T23:55:00.000Z', expiresAt: '2026-09-11T00:30:00.000Z',
    sourceRevision: `evaluation-${action.toLowerCase()}-source`, budgets: [budget(action, thresholds)],
  };
}

function fixture(id, { requestedModel = 'primary-model', action = 'HARD_BLOCK', thresholds = {}, remaining = 100, expected, policy = {}, requestCaps = caps }) {
  return {
    id, requestedModel, evaluationTime, tenantId, registry: registry(), budgetSnapshot: budgetSnapshot(action, thresholds),
    policy: {
      allowedModels: ['primary-model', 'fallback-model'], modelSelectionIntent: 'preferred',
      fallback: { enabled: false, maxDepth: 1, chain: [] }, ...policy,
    },
    remainingTokensByScope: { organization: remaining }, caps: requestCaps, expected,
  };
}

export const evaluationFixtures = Object.freeze([
  fixture('allow', { expected: { decision: 'selected', effectiveModel: 'primary-model', reasonCode: 'fallback-disabled', backendRequests: 1, publication: { quota: 100, warningPercent: null, tiers: [] }, boundaries: [] } }),
  fixture('denied-model', { requestedModel: 'unapproved-model', requestCaps: { ...caps, maxRequests: 0 }, expected: { decision: 'denied', effectiveModel: null, reasonCode: 'model-not-allowed', backendRequests: 0, publication: { quota: 100, warningPercent: null, tiers: [] }, boundaries: [] } }),
  fixture('hard-exhaustion', {
    thresholds: { warnAtBasisPoints: 8000 }, remaining: 0,
    expected: { decision: 'selected', effectiveModel: 'primary-model', reasonCode: 'fallback-disabled', backendRequests: 1, publication: { quota: 100, warningPercent: 80, tiers: [] }, boundaries: [{ consumedTokens: 79, state: 'before-warning' }, { consumedTokens: 80, state: 'at-warning' }, { consumedTokens: 81, state: 'after-warning' }, { consumedTokens: 99, state: 'after-warning' }, { consumedTokens: 100, state: 'at-limit' }, { consumedTokens: 101, state: 'after-limit' }] },
  }),
  fixture('soft-grace', {
    action: 'SOFT_WARNING', thresholds: { graceBasisPoints: 2500 }, remaining: 25,
    expected: { decision: 'selected', effectiveModel: 'primary-model', reasonCode: 'fallback-disabled', backendRequests: 1, publication: { quota: 125, warningPercent: 80, tiers: [] }, boundaries: [{ consumedTokens: 99, state: 'before-warning' }, { consumedTokens: 100, state: 'at-warning' }, { consumedTokens: 101, state: 'after-warning' }, { consumedTokens: 124, state: 'after-warning' }, { consumedTokens: 125, state: 'at-limit' }, { consumedTokens: 126, state: 'after-limit' }] },
  }),
  fixture('throttle', {
    action: 'THROTTLE', thresholds: { tiers: [{ atBasisPoints: 7000, tierCode: 'tier-reduced' }, { atBasisPoints: 9000, tierCode: 'tier-minimal' }] },
    expected: { decision: 'selected', effectiveModel: 'primary-model', reasonCode: 'fallback-disabled', backendRequests: 1, publication: { quota: null, warningPercent: null, tiers: ['tier-reduced', 'tier-minimal'] }, boundaries: [{ consumedTokens: 69, tierCode: null }, { consumedTokens: 70, tierCode: 'tier-reduced' }, { consumedTokens: 71, tierCode: 'tier-reduced' }, { consumedTokens: 89, tierCode: 'tier-reduced' }, { consumedTokens: 90, tierCode: 'tier-minimal' }, { consumedTokens: 91, tierCode: 'tier-minimal' }] },
  }),
  fixture('fallback', {
    thresholds: { warnAtBasisPoints: 8000 }, remaining: 19,
    policy: { fallback: { enabled: true, maxDepth: 1, chain: [{ from: 'primary-model', to: 'fallback-model' }] } },
    expected: { decision: 'selected', effectiveModel: 'fallback-model', reasonCode: 'fallback-applied', backendRequests: 1, publication: { quota: 100, warningPercent: 80, tiers: [] }, boundaries: [{ consumedTokens: 79, state: 'before-warning' }, { consumedTokens: 80, state: 'at-warning' }, { consumedTokens: 81, state: 'after-warning' }, { consumedTokens: 99, state: 'after-warning' }, { consumedTokens: 100, state: 'at-limit' }, { consumedTokens: 101, state: 'after-limit' }] },
  }),
]);
