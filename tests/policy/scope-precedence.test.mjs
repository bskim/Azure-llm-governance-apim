import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEffectiveEntitlementBindings } from '../../app/governance-domain/authorization/governance-authorization-evaluator.mjs';
import { selectFallbackPlan } from '../../app/governance-domain/policy/fallback-plan-compiler.mjs';

const binding = (kind, modelAllowlist, limits = {}) => ({
  target: { kind, key: `${kind}-key` },
  modelAllowlist,
  limits,
});

const plan = (kind, key) => ({ target: { kind, key }, planId: `${kind}-plan` });

test('specific grants combine by union under the organization ceiling', () => {
  const narrowed = evaluateEffectiveEntitlementBindings([
    binding('global', ['A', 'B', 'C']),
    binding('team', ['B', 'C']),
    binding('subject', ['B']),
  ]);
  assert.deepEqual(narrowed.modelAllowlist, ['B', 'C']);

  const widened = evaluateEffectiveEntitlementBindings([
    binding('global', ['A', 'B', 'C']),
    binding('subject', ['A', 'B', 'C', 'D']),
  ]);
  assert.deepEqual(widened.modelAllowlist, ['A', 'B', 'C'], 'D was never the organization to give');
});

test('naming a model the organization does not list refuses the caller rather than granting it', () => {
  // The surprising half of the organization ceiling, and the one an administrator has to be told:
  // a grant that shares nothing with the wider scope is not a grant, it is a denial.
  const disjoint = evaluateEffectiveEntitlementBindings([
    binding('global', ['A', 'B', 'C']),
    binding('subject', ['D']),
  ]);
  assert.equal(disjoint.decision, 'deny');
  assert.equal(disjoint.reasonCode, 'model-intersection-empty');
  assert.deepEqual(disjoint.modelAllowlist, []);
});

test('limits take the minimum across every scope that names one', () => {
  const merged = evaluateEffectiveEntitlementBindings([
    binding('global', ['A'], { requestsPerMinute: 60, tokensPerMinute: 300_000 }),
    binding('team', ['A'], { requestsPerMinute: 10 }),
    binding('subject', ['A'], { tokensPerMinute: 50_000 }),
  ]);
  assert.equal(merged.limits.requestsPerMinute, 10);
  assert.equal(merged.limits.tokensPerMinute, 50_000);

  const raised = evaluateEffectiveEntitlementBindings([
    binding('global', ['A'], { requestsPerMinute: 10 }),
    binding('subject', ['A'], { requestsPerMinute: 1000 }),
  ]);
  assert.equal(raised.limits.requestsPerMinute, 10, 'a subject cannot be given more than the organization allows');
});

test('the downgrade plan overrides rather than combining, most specific first', () => {
  // The one axis where a narrower scope is not merely narrower. A subject plan replaces
  // the team plan whole, which is how a subject may decline downgrade and spend the
  // budget it was already bounded by.
  const plans = [
    plan('global', null),
    plan('team', 'team-a'),
    plan('subject', 'subject-a'),
    plan('application', 'app-a'),
  ];

  assert.equal(
    selectFallbackPlan({ plans, applicationId: 'app-a', subjectId: 'subject-a', teamKey: 'team-a' }).planId,
    'application-plan',
  );
  assert.equal(
    selectFallbackPlan({ plans, applicationId: 'other', subjectId: 'subject-a', teamKey: 'team-a' }).planId,
    'subject-plan',
  );
  assert.equal(
    selectFallbackPlan({ plans, applicationId: 'other', subjectId: 'other', teamKey: 'team-a' }).planId,
    'team-plan',
  );
  assert.equal(
    selectFallbackPlan({ plans, applicationId: 'other', subjectId: 'other', teamKey: 'other' }).planId,
    'global-plan',
  );
});
