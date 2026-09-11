import assert from 'node:assert/strict';
import test from 'node:test';
import { createBudgetObservationDetails } from '../../app/admin-ui/public/budget-observation-view.mjs';

function render(consumption) {
  return createBudgetObservationDetails(consumption, {
    createElement: (tag, className, text = '') => ({
      tag, className, text, children: [],
      append(...children) { this.children.push(...children); },
    }),
    t: (key, values = {}) => `${key}${Object.keys(values).length === 0 ? '' : JSON.stringify(values)}`,
    formatTime: (value) => `time:${value}`,
    formatNumber: (value) => `${value}`,
  });
}

const observation = {
  requestedBudgetVersion: 2,
  requestedWindow: { start: '2026-08-10T00:00:00.000Z', end: '2026-08-10T04:00:00.000Z' },
  latestClosedWindow: { start: '2026-08-10T03:00:00.000Z', end: '2026-08-10T04:00:00.000Z' },
  coverageDetailState: 'listed',
  missingWindows: [],
  policyVersionEvidence: { state: 'not-collected', value: null },
  counterIdentityEvidence: { state: 'not-collected' },
};

function definitions(node) {
  const children = node.children.find((child) => child.tag === 'dl').children;
  return Object.fromEntries(children.filter((_child, index) => index % 2 === 0)
    .map((child, index) => [child.text, children[index * 2 + 1].text]));
}

test('renders observed interval, complete window and coverage separately from requested version and uncollected counter evidence', () => {
  const node = render({ windowsCovered: 4, windowsMissing: 0, observation });
  const fields = definitions(node);
  assert.equal(node.tag, 'details');
  assert.equal(node.children[0].tag, 'summary');
  assert.equal(fields['budgetObservation.requestedVersion'], '2');
  assert.equal(fields['budgetObservation.covered'], '4');
  assert.equal(fields['budgetObservation.missing'], '0');
  assert.match(fields['budgetObservation.requestedWindow'], /time:2026-08-10T00:00/);
  assert.match(fields['budgetObservation.latestCompleteWindow'], /time:2026-08-10T03:00/);
  assert.equal(fields['budgetObservation.policyVersion'], 'budgetObservation.notCollected');
  assert.equal(fields['budgetObservation.counterIdentity'], 'budgetObservation.notCollected');
  assert.ok(node.children.some((child) => child.text === 'budgetObservation.versionCaveat'));
  assert.ok(node.children.some((child) => child.text === 'budgetObservation.aggregateCaveat'));
});

test('unmeasured or legacy evidence stays unavailable rather than formatting null as zero or an epoch', () => {
  for (const evidence of [undefined, { requestedBudgetVersion: 1, requestedWindow: null, latestClosedWindow: null }]) {
    const fields = definitions(render({ windowsCovered: null, windowsMissing: null, observation: evidence }));
    assert.equal(fields['budgetObservation.covered'], 'budgetObservation.unavailable');
    assert.equal(fields['budgetObservation.missing'], 'budgetObservation.unavailable');
    assert.equal(fields['budgetObservation.requestedWindow'], 'budgetObservation.unavailable');
    assert.equal(fields['budgetObservation.latestCompleteWindow'], 'budgetObservation.unavailable');
    assert.equal(fields['budgetObservation.policyVersion'], 'budgetObservation.unavailable');
  }
});

test('partial evidence presents only eight gap starts and explicitly reports omitted details', () => {
  const missingWindows = Array.from({ length: 12 }, (_item, index) => `gap-${index}`);
  const node = render({ windowsCovered: 2, windowsMissing: 12, remainingTokens: null, observation: { ...observation, missingWindows } });
  assert.equal(node.children.find((child) => child.tag === 'ul').children.length, 8);
  assert.ok(node.children.some((child) => child.text === 'budgetObservation.moreGaps{"count":"4"}'));
  assert.equal(definitions(node)['budgetObservation.missing'], '12');
  const summary = render({
    windowsCovered: 4, windowsMissing: 8756,
    observation: { ...observation, coverageDetailState: 'summary-only', missingWindows: null },
  });
  assert.ok(summary.children.some((child) => child.text === 'budgetObservation.summaryOnly'));
  assert.equal(summary.children.some((child) => child.tag === 'ul'), false);
});

test('changing requested budget version never manufactures observed policy or counter identity', () => {
  for (const requestedBudgetVersion of [1, 2]) {
    const fields = definitions(render({ observation: { ...observation, requestedBudgetVersion } }));
    assert.equal(fields['budgetObservation.requestedVersion'], String(requestedBudgetVersion));
    assert.equal(fields['budgetObservation.policyVersion'], 'budgetObservation.notCollected');
    assert.equal(fields['budgetObservation.counterIdentity'], 'budgetObservation.notCollected');
  }
  const fields = definitions(render({ observation: { ...observation, policyVersionEvidence: { state: 'changed', value: 99 } } }));
  assert.equal(fields['budgetObservation.policyVersion'], 'budgetObservation.unavailable');
});
