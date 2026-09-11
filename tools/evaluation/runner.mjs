import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createFoundryMock } from '../../tests/mock/foundry-mock.mjs';
import { selectEffectiveModel } from '../../app/governance-domain/policy/effective-model-selector.mjs';
import { assertBudgetSnapshotV1, publishBudgets } from '../../app/governance-domain/policy/budget-publication.mjs';
import { assertModelRegistrySnapshotV1 } from '../../app/governance-domain/registry/model-registry-validator.mjs';
import { DEPLOYED_THROTTLE_TIER_CODES } from '../../app/control-api/throttle-tier-codes.mjs';
import { evaluationFixtures } from './fixtures.mjs';

const FIXTURE_IDS = new Set(['allow', 'denied-model', 'hard-exhaustion', 'soft-grace', 'throttle', 'fallback']);
const FIXED_USAGE = Object.freeze({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
const MAX_REQUESTS = 1;
const MAX_TOKENS = 1024;

function fail(message) { throw new TypeError(message); }
function record(value, path) { if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object.`); }
function integer(value, path, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail(`${path} must be an integer of at least ${minimum}.`); }

export function validateFixtures(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length !== 6) fail('fixtures must contain exactly six scenarios.');
  const ids = new Set();
  for (const fixture of fixtures) {
    record(fixture, 'fixture');
    if (!FIXTURE_IDS.has(fixture.id) || ids.has(fixture.id)) fail(`fixture id is invalid or duplicated: ${fixture.id}.`);
    ids.add(fixture.id);
    if (typeof fixture.requestedModel !== 'string' || fixture.requestedModel.length === 0) fail(`${fixture.id}.requestedModel is required.`);
    if (typeof fixture.evaluationTime !== 'string' || !Number.isFinite(Date.parse(fixture.evaluationTime))) fail(`${fixture.id}.evaluationTime must be RFC 3339.`);
    record(fixture.policy, `${fixture.id}.policy`); record(fixture.registry, `${fixture.id}.registry`); record(fixture.budgetSnapshot, `${fixture.id}.budgetSnapshot`);
    record(fixture.remainingTokensByScope, `${fixture.id}.remainingTokensByScope`); record(fixture.caps, `${fixture.id}.caps`); record(fixture.expected, `${fixture.id}.expected`);
    if (!Array.isArray(fixture.policy.allowedModels) || !fixture.policy.allowedModels.every((model) => typeof model === 'string')) fail(`${fixture.id}.policy.allowedModels must be a string array.`);
    record(fixture.policy.fallback, `${fixture.id}.policy.fallback`);
    assertModelRegistrySnapshotV1(fixture.registry, { evaluationTime: fixture.evaluationTime, principalTenantId: fixture.tenantId });
    assertBudgetSnapshotV1(fixture.budgetSnapshot, { evaluationTime: fixture.evaluationTime, principalTenantId: fixture.tenantId });
    for (const key of ['maxRequests', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens']) integer(fixture.caps[key], `${fixture.id}.caps.${key}`, key === 'maxRequests' ? 0 : 1);
    if (fixture.caps.maxRequests > MAX_REQUESTS || fixture.caps.maxInputTokens > MAX_TOKENS || fixture.caps.maxOutputTokens > MAX_TOKENS || fixture.caps.maxTotalTokens > MAX_TOKENS) fail(`${fixture.id}.caps exceeds the evaluator's finite global upper bound.`);
  }
  if (ids.size !== FIXTURE_IDS.size) fail('all required scenarios must be present.');
  return true;
}

async function staticSmokeEvidence() {
  const xml = await readFile(new URL('../../apim/policies/inference.xml', import.meta.url), 'utf8');
  const checks = ['effectiveModel', 'allowedModels', 'fallback', 'rate-limit-by-key'].map((term) => ({ term, present: xml.includes(term) }));
  return { kind: 'static-smoke', status: checks.every((check) => check.present) ? 'passed' : 'failed', checks, limitation: 'Text smoke check only; it does not run Test-InferencePolicy.ps1 and does not verify APIM HTTP enforcement.' };
}

function boundaryCases(publication) {
  const action = publication.entries[0].action;
  if (action === 'THROTTLE') {
    const tiers = publication.throttleTiers;
    const quota = publication.entries[0].convertedTokenQuota;
    const boundaries = tiers.flatMap((tier) => {
      const threshold = Math.ceil(quota * tier.atBasisPoints / 10_000);
      return [threshold - 1, threshold, threshold + 1];
    });
    return boundaries.map((consumedTokens) => ({
      consumedTokens,
      tierCode: [...tiers].reverse().find((tier) => consumedTokens * 10_000 >= quota * tier.atBasisPoints)?.tierCode ?? null,
    }));
  }
  const quota = publication.limits[0].tokenQuota;
  const warning = publication.warnThresholdPercent === null ? null : Math.floor((quota * publication.warnThresholdPercent) / 100);
  if (warning === null) return [];
  return [warning - 1, warning, warning + 1, quota - 1, quota, quota + 1].map((consumedTokens) => ({
    consumedTokens,
    state: consumedTokens < warning ? 'before-warning' : consumedTokens === warning ? 'at-warning' : consumedTokens < quota ? 'after-warning' : consumedTokens === quota ? 'at-limit' : 'after-limit',
  }));
}

function publicationObservation(publication) {
  return {
    quota: publication.limits[0]?.tokenQuota ?? null,
    warningPercent: publication.warnThresholdPercent,
    tiers: publication.throttleTiers.map((tier) => tier.tierCode),
  };
}

export function isValidMockObservation(mock, selectedModel) {
  return mock.error === null && (
    (mock.requestCount === 0 && selectedModel === null && mock.status === null && mock.usage === null) ||
    (mock.requestCount === 1 &&
    mock.status === 200 &&
    mock.model === selectedModel &&
    isDeepStrictEqual(mock.usage, FIXED_USAGE))
  );
}

async function invokeMock(model, caps) {
  if (FIXED_USAGE.input_tokens > caps.maxInputTokens || FIXED_USAGE.output_tokens > caps.maxOutputTokens || FIXED_USAGE.total_tokens > caps.maxTotalTokens) return { requestCount: 0, status: null, model: null, usage: null, error: 'known-mock-usage-exceeds-cap' };
  const mock = createFoundryMock({ expectedModel: model, controlToken: 'evaluation-control-token' });
  try {
    const baseUrl = await mock.listen();
    const url = new URL(`${baseUrl}/openai/v1/responses`);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') fail('evaluation mock must be loopback-only.');
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2_000), headers: { authorization: 'Bearer evaluation-token', 'content-type': 'application/json' }, body: JSON.stringify({ model, input: 'hello', max_output_tokens: caps.maxOutputTokens }) });
    let body;
    try { body = await response.json(); } catch { return { requestCount: mock.requests.length, status: response.status, model: mock.requests[0]?.body?.model ?? null, usage: null, error: 'malformed-mock-response' }; }
    return { requestCount: mock.requests.length, status: response.status, model: mock.requests[0]?.body?.model ?? null, usage: body.usage ?? null, error: null };
  } finally { await mock.close(); }
}

export async function evaluateFixture(fixture, { staticEvidence } = {}) {
  validateFixtures([fixture, ...evaluationFixtures.filter((candidate) => candidate.id !== fixture.id)]);
  staticEvidence ??= await staticSmokeEvidence();
  const registry = assertModelRegistrySnapshotV1(fixture.registry, { evaluationTime: fixture.evaluationTime, principalTenantId: fixture.tenantId });
  const budgetSnapshot = assertBudgetSnapshotV1(fixture.budgetSnapshot, { evaluationTime: fixture.evaluationTime, principalTenantId: fixture.tenantId });
  const publication = publishBudgets({ budgetSnapshot, registry, allowedModels: fixture.policy.allowedModels, declaredTierCodes: DEPLOYED_THROTTLE_TIER_CODES, evaluationTime: fixture.evaluationTime });
  const allowed = fixture.policy.allowedModels.includes(fixture.requestedModel);
  const decision = allowed ? selectEffectiveModel({ requestedModel: fixture.requestedModel, effectivePolicy: { ...fixture.policy, limits: publication.limits, warnThresholdPercent: publication.warnThresholdPercent }, remainingTokensByScope: fixture.remainingTokensByScope }) : { decision: 'denied', effectiveModel: null, reasonCode: 'model-not-allowed' };
  const mock = decision.decision === 'selected' && fixture.caps.maxRequests >= 1 ? await invokeMock(decision.effectiveModel, fixture.caps) : { requestCount: 0, status: null, model: null, usage: null, error: decision.decision === 'selected' ? 'request-cap-prevents-call' : null };
  const observed = { decision: decision.decision, effectiveModel: decision.effectiveModel, reasonCode: decision.reasonCode, backendRequests: mock.requestCount, publication: publicationObservation(publication), boundaries: boundaryCases(publication) };
  const mockValid = isValidMockObservation(mock, decision.effectiveModel);
  const passed = isDeepStrictEqual(fixture.expected, observed) && mock.requestCount <= fixture.caps.maxRequests && mockValid && staticEvidence.status === 'passed';
  return { scenarioId: fixture.id, fixedInputs: { requestedModel: fixture.requestedModel, remainingTokensByScope: fixture.remainingTokensByScope, caps: fixture.caps }, expected: fixture.expected, observed: { ...observed, mock: { status: mock.status, model: mock.model, usage: mock.usage, error: mock.error } }, pass: passed, evidence: [{ kind: 'reference', status: 'observed', source: 'publishBudgets and effective-model-selector', limitation: 'Boundary positions are arithmetic over published thresholds, not a quota or rate enforcement engine. Model selection does not enforce HARD quotas.' }, { kind: 'mock', status: mock.status === null ? 'not-invoked' : 'observed', source: 'loopback Foundry mock' }, staticEvidence], unverified: ['Budget publication is a local reference result, not actual gateway enforcement.', 'Actual APIM gateway HTTP enforcement is not verified.', 'Distributed rate enforcement is not verified.', 'No Azure or external endpoint was called.'] };
}

export async function runEvaluation({ fixtures = evaluationFixtures } = {}) {
  validateFixtures(fixtures);
  const staticEvidence = await staticSmokeEvidence();
  const scenarios = [];
  for (const fixture of fixtures) scenarios.push(await evaluateFixture(fixture, { staticEvidence }));
  return { mode: 'offline-loopback-mock', pass: scenarios.every((scenario) => scenario.pass), scenarios, evidenceSummary: 'Static smoke, local domain references, and loopback mock observations are separate evidence; actual APIM remains unverified.' };
}
