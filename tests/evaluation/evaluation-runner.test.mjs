import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluationFixtures } from '../../tools/evaluation/fixtures.mjs';
import { runCli } from '../../tools/evaluation/run-local-evaluation.mjs';
import { evaluateFixture, isValidMockObservation, runEvaluation, validateFixtures } from '../../tools/evaluation/runner.mjs';

test('runs all six deterministic offline scenarios with distinct evidence labels', async () => {
  const report = await runEvaluation();
  assert.equal(report.pass, true);
  assert.deepEqual(report.scenarios.map((scenario) => scenario.scenarioId), ['allow', 'denied-model', 'hard-exhaustion', 'soft-grace', 'throttle', 'fallback']);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.pass, true, scenario.scenarioId);
    assert.match(scenario.unverified.join(' '), /actual APIM gateway HTTP enforcement is not verified/i);
    assert.deepEqual(scenario.evidence.map((evidence) => evidence.kind), ['reference', 'mock', 'static-smoke']);
  }
  assert.equal(report.scenarios.find((scenario) => scenario.scenarioId === 'denied-model').observed.backendRequests, 0);
  assert.equal(report.scenarios.find((scenario) => scenario.scenarioId === 'fallback').observed.mock.model, 'fallback-model');
});

test('fails when a broken expected value is supplied instead of copying expected into observed', async () => {
  const fixtures = structuredClone(evaluationFixtures);
  fixtures[0].expected.effectiveModel = 'incorrect-model';
  const report = await runEvaluation({ fixtures });
  assert.equal(report.pass, false);
  assert.equal(report.scenarios[0].pass, false);
  assert.equal(report.scenarios[0].observed.effectiveModel, 'primary-model');
});

test('returns a nonzero CLI status when an evaluation report has a mismatch', async () => {
  let output = '';
  const status = await runCli({
    run: async () => ({ pass: false, scenarios: [] }),
    stdout: { write(value) { output += value; } },
    stderr: { write() {} },
  });
  assert.equal(status, 1);
  assert.match(output, /"pass": false/);
});

test('CLI rejects arguments and errors, and returns nonzero for a real expected mismatch', async () => {
  let error = '';
  assert.equal(await runCli({ args: ['--live'], stdout: { write() {} }, stderr: { write(value) { error += value; } } }), 2);
  assert.match(error, /Usage/);
  assert.equal(await runCli({ run: async () => { throw new Error('fixture failure'); }, stdout: { write() {} }, stderr: { write() {} } }), 1);
  const fixtures = structuredClone(evaluationFixtures);
  fixtures[0].expected.publication.quota = 101;
  assert.equal(await runCli({ run: () => runEvaluation({ fixtures }), stdout: { write() {} }, stderr: { write() {} } }), 1);
});

test('validates deterministic fixture identities, contracts, and finite global caps', () => {
  const badId = structuredClone(evaluationFixtures);
  badId[0].id = 'unknown';
  assert.throws(() => validateFixtures(badId), /invalid or duplicated/);
  const badPolicy = structuredClone(evaluationFixtures);
  badPolicy[0].budgetSnapshot.status = 'invalid';
  assert.throws(() => validateFixtures(badPolicy), /status is unsupported/);
  const badFallback = structuredClone(evaluationFixtures);
  badFallback[0].policy.fallback = null;
  assert.throws(() => validateFixtures(badFallback), /fallback must be an object/);
  const excessiveCaps = structuredClone(evaluationFixtures);
  excessiveCaps[0].caps.maxOutputTokens = 1025;
  assert.throws(() => validateFixtures(excessiveCaps), /finite global upper bound/);
});

test('rejects malformed, missing, wrong-usage, and wrong-model mock observations', () => {
  const valid = { requestCount: 1, status: 200, model: 'primary-model', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }, error: null };
  assert.equal(isValidMockObservation(valid, 'primary-model'), true);
  assert.equal(isValidMockObservation({ ...valid, usage: null }, 'primary-model'), false);
  assert.equal(isValidMockObservation({ ...valid, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 6 } }, 'primary-model'), false);
  assert.equal(isValidMockObservation({ ...valid, status: 400, error: 'malformed-mock-response' }, 'primary-model'), false);
  assert.equal(isValidMockObservation({ ...valid, model: 'wrong-model' }, 'primary-model'), false);
});

test('repeats deterministically, prevents calls when token caps are below fixed mock usage, and omits raw secrets', async () => {
  const first = await runEvaluation();
  const second = await runEvaluation();
  assert.deepEqual(first, second);
  const capped = structuredClone(evaluationFixtures);
  capped[0].caps.maxOutputTokens = 1;
  const report = await runEvaluation({ fixtures: capped });
  assert.equal(report.scenarios[0].observed.backendRequests, 0);
  assert.equal(report.scenarios[0].observed.mock.error, 'known-mock-usage-exceeds-cap');
  assert.equal(report.pass, false);
  assert.equal(JSON.stringify(first).includes('evaluation-token'), false);
});

test('fails when a hand-authored budget publication expectation no longer matches', async () => {
  const fixtures = structuredClone(evaluationFixtures);
  fixtures[3].expected.publication.warningPercent = 81;
  const report = await runEvaluation({ fixtures });
  assert.equal(report.scenarios[3].pass, false);
  assert.equal(report.scenarios[3].observed.publication.warningPercent, 80);
});

test('throttle boundary positions use the published token quota rather than a fixed percentage denominator', async () => {
  const fixture = structuredClone(evaluationFixtures.find((entry) => entry.id === 'throttle'));
  fixture.budgetSnapshot.budgets[0].limit.amount = 200;
  const report = await evaluateFixture(fixture);
  assert.equal(report.pass, false);
  assert.deepEqual(report.observed.boundaries, [
    { consumedTokens: 139, tierCode: null },
    { consumedTokens: 140, tierCode: 'tier-reduced' },
    { consumedTokens: 141, tierCode: 'tier-reduced' },
    { consumedTokens: 179, tierCode: 'tier-reduced' },
    { consumedTokens: 180, tierCode: 'tier-minimal' },
    { consumedTokens: 181, tierCode: 'tier-minimal' },
  ]);
});

test('a request or token cap cannot produce a passing selected-model scenario without a mock observation', async () => {
  for (const cap of ['maxRequests', 'maxOutputTokens']) {
    const fixture = structuredClone(evaluationFixtures[0]);
    fixture.caps[cap] = cap === 'maxRequests' ? 0 : 1;
    fixture.expected.backendRequests = 0;
    const report = await evaluateFixture(fixture);
    assert.equal(report.observed.backendRequests, 0);
    assert.equal(report.pass, false);
  }
});

test('rejects unbounded or incomplete fixture sets before requests are made', () => {
  const fixtures = structuredClone(evaluationFixtures);
  fixtures.pop();
  assert.throws(() => validateFixtures(fixtures), /exactly six scenarios/);
  const invalidCaps = structuredClone(evaluationFixtures);
  invalidCaps[0].caps.maxTotalTokens = -1;
  assert.throws(() => validateFixtures(invalidCaps), /integer of at least 1/);
});
