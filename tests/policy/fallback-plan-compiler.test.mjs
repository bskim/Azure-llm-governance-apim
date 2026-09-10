import assert from 'node:assert/strict';
import test from 'node:test';

import { assertModelRegistrySnapshotV1 } from '../../app/governance-domain/registry/model-registry-validator.mjs';
import {
  assertFallbackPolicySnapshotV1,
  compileFallbackPlan,
  derivePermittedTargets,
} from '../../app/governance-domain/policy/fallback-plan-compiler.mjs';

const evaluationTime = '2026-08-07T00:00:00.000Z';
const tenantId = 'contoso.tenant.001';

function model(modelKey, overrides = {}) {
  return {
    modelKey,
    providerKey: 'azure-openai',
    apiFamilies: ['openai-chat-completions', 'openai-responses'],
    lifecycle: 'generally-available',
    safetyPolicy: 'local-default-policy',
    ...overrides,
  };
}

// A three-step ladder that is strictly cheaper at each step and loses nothing else.
function registry(models = null) {
  return assertModelRegistrySnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'model-registry-001',
      tenantId,
      version: 1,
      status: 'complete',
      capturedAt: '2026-08-06T23:55:00.000Z',
      expiresAt: '2026-08-07T00:30:00.000Z',
      sourceRevision: 'model-registry-source-001',
      models:
        models ??
        [
          model('tier-a'),
          model('tier-b'),
          model('tier-c'),
        ],
      applications: [],
    },
    { evaluationTime, principalTenantId: tenantId },
  );
}

function plan(overrides = {}) {
  return {
    planId: 'budget-ladder',
    planVersion: 1,
    state: 'active',
    target: { kind: 'global', key: null },
    enabled: true,
    onExhausted: 'continue-with-requested',
    edges: [
      { from: 'tier-a', to: 'tier-b' },
      { from: 'tier-b', to: 'tier-c' },
    ],
    validFrom: '2026-08-01T00:00:00.000Z',
    validUntil: null,
    issuedBy: { kind: 'system', key: 'governance-publisher' },
    reasonCode: 'budget-pressure-ladder',
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    contractVersion: 'v1',
    snapshotId: 'fallback-policy-001',
    tenantId,
    version: 1,
    status: 'complete',
    capturedAt: '2026-08-06T23:55:00.000Z',
    expiresAt: '2026-08-07T00:30:00.000Z',
    sourceRevision: 'fallback-source-001',
    plans: [plan()],
    ...overrides,
  };
}

function acceptSnapshot(value = snapshot()) {
  return assertFallbackPolicySnapshotV1(value, { evaluationTime, principalTenantId: tenantId });
}

function assertSnapshotRejected(build, expectation) {
  assert.throws(
    () => assertFallbackPolicySnapshotV1(build(), { evaluationTime, principalTenantId: tenantId }),
    expectation,
  );
}

function compile({
  planOverrides = {},
  models = null,
  allowedModels = ['tier-a', 'tier-b', 'tier-c'],
  apiFamily = 'openai-responses',
} = {}) {
  const accepted = acceptSnapshot(snapshot({ plans: [plan(planOverrides)] }));
  return compileFallbackPlan({
    plan: accepted.plans[0],
    registry: registry(models),
    allowedModels,
    evaluationTime,
    apiFamily,
  });
}

function blockedBy(result, from) {
  return result.rejections.find((rejection) => rejection.from === from)?.blockedBy ?? null;
}

test('a same-provider, strictly cheaper, non-losing ladder compiles in full', () => {
  const result = compile();

  assert.equal(result.disposition, 'compiled');
  assert.equal(result.enabled, true);
  assert.deepEqual(result.chain, [
    { from: 'tier-a', to: 'tier-b' },
    { from: 'tier-b', to: 'tier-c' },
  ]);
  assert.deepEqual(result.rejections, []);
  assert.equal(result.onExhausted, 'continue-with-requested');
});

test('a plan maps many primaries but every request takes exactly one hop', () => {
  // Downgrade is deliberately single step: a primary model has one cheaper
  // alternative and stops there. A longer authored path means a different primary
  // has its own alternative, not that one request walks further.
  const result = compile();

  assert.equal(result.maxDepth, 1);
});

test('one rejected hop does not discard the hops that remain permitted', () => {
  const result = compile({
    apiFamily: 'openai-responses',
    models: [
      model('tier-a'),
      model('tier-b'),
      // tier-c cannot answer Responses, so the tier-b hop is refused while the
      // tier-a hop compiles: a plan is reduced to what holds, not abandoned.
      model('tier-c', { apiFamilies: ['openai-chat-completions'] }),
    ],
  });

  assert.deepEqual(result.chain, [{ from: 'tier-a', to: 'tier-b' }]);
  assert.equal(blockedBy(result, 'tier-b'), 'fallback-api-family-narrowed');
  assert.equal(result.enabled, true);
});

test('the targets offered for authoring are the ones the compiler would accept', () => {
  const models = [
    model('tier-a'),
    model('tier-b'),
    model('tier-c', { apiFamilies: ['openai-chat-completions'] }),
  ];
  const allowedModels = ['tier-a', 'tier-b', 'tier-c'];

  const onResponses = derivePermittedTargets({
    registry: registry(models),
    allowedModels,
    source: 'tier-a',
    apiFamily: 'openai-responses',
  });
  assert.deepEqual(onResponses.permitted, ['tier-b']);
  assert.deepEqual(onResponses.refused, [
    { modelKey: 'tier-c', blockedBy: 'fallback-api-family-narrowed' },
  ]);

  // The same source on the other route reaches the cheaper model the first refused,
  // which is the whole reason the offer is made per contract.
  const onChat = derivePermittedTargets({
    registry: registry(models),
    allowedModels,
    source: 'tier-a',
    apiFamily: 'openai-chat-completions',
  });
  assert.deepEqual(onChat.permitted, ['tier-b', 'tier-c']);

  // And every offer holds when actually compiled, which is what stops the screen
  // and the compiler from drifting into two different answers.
  for (const target of onChat.permitted) {
    const compiled = compile({
      planOverrides: { edges: [{ from: 'tier-a', to: target }] },
      models,
      allowedModels,
      apiFamily: 'openai-chat-completions',
    });
    assert.deepEqual(compiled.chain, [{ from: 'tier-a', to: target }], target);
  }
});

test('a source is never offered itself, and a degraded registry offers nothing', () => {
  const offered = derivePermittedTargets({
    registry: registry(),
    allowedModels: ['tier-a', 'tier-b', 'tier-c'],
    source: 'tier-a',
    apiFamily: 'openai-responses',
  });
  assert.equal(offered.permitted.includes('tier-a'), false);
  assert.equal(offered.refused.some((entry) => entry.modelKey === 'tier-a'), false);

  const degraded = assertModelRegistrySnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'model-registry-002',
      tenantId,
      version: 2,
      status: 'stale',
      reason: 'catalogue publisher behind',
      capturedAt: '2026-08-06T23:55:00.000Z',
      expiresAt: '2026-08-07T00:30:00.000Z',
      sourceRevision: 'model-registry-source-002',
      models: [],
      applications: [],
    },
    { evaluationTime, principalTenantId: tenantId },
  );
  const fromDegraded = derivePermittedTargets({
    registry: degraded,
    allowedModels: ['tier-a', 'tier-b', 'tier-c'],
    source: 'tier-a',
    apiFamily: 'openai-responses',
  });
  // Offering a target out of a catalogue that is behind would invite an authored hop
  // nobody can currently evaluate.
  assert.deepEqual(fromDegraded.permitted, []);
  assert.deepEqual(fromDegraded.refused, []);
});

test('compiler output is frozen and deterministically ordered', () => {
  const first = compile();
  const second = compile();

  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.chain));
  assert.deepEqual(first, second);
});

test('a plan whose every hop is rejected is disabled but keeps its rejections visible', () => {
  const result = compile({ allowedModels: ['tier-a'] });

  assert.equal(result.disposition, 'compiled');
  assert.equal(result.enabled, false);
  assert.deepEqual(result.chain, []);
  assert.equal(result.reasonCode, 'fallback-no-permitted-target');
  assert.equal(blockedBy(result, 'tier-a'), 'fallback-target-not-entitled');
});

test('an authored cycle is refused when the plan is validated, before any allowlist is known', () => {
  assertSnapshotRejected(
    () => snapshot({ plans: [plan({ edges: [{ from: 'tier-a', to: 'tier-b' }, { from: 'tier-b', to: 'tier-a' }] })] }),
    /cycle/i,
  );
});

test('a cycle is still refused when entitlement would have hidden it', () => {
  // The regression this test exists for: filtering hops against a caller's allowlist
  // before checking the graph would reduce this plan to an empty chain and report it
  // as merely disabled, so the same configuration would be valid or invalid depending
  // on who asked.
  const cyclic = snapshot({
    plans: [plan({ edges: [{ from: 'tier-a', to: 'tier-b' }, { from: 'tier-b', to: 'tier-a' }] })],
  });

  assertSnapshotRejected(() => cyclic, /cycle/i);
});

test('a three-node cycle names the edge that closes it', () => {
  assertSnapshotRejected(
    () =>
      snapshot({
        plans: [
          plan({
            edges: [
              { from: 'tier-a', to: 'tier-b' },
              { from: 'tier-b', to: 'tier-c' },
              { from: 'tier-c', to: 'tier-a' },
            ],
          }),
        ],
      }),
    /tier-c.*tier-a|cycle/i,
  );
});

test('a self loop is refused', () => {
  assertSnapshotRejected(
    () => snapshot({ plans: [plan({ edges: [{ from: 'tier-a', to: 'tier-a' }] })] }),
    /itself|self/i,
  );
});

test('a model may have at most one successor', () => {
  assertSnapshotRejected(
    () =>
      snapshot({
        plans: [plan({ edges: [{ from: 'tier-a', to: 'tier-b' }, { from: 'tier-a', to: 'tier-c' }] })],
      }),
    /more than one/i,
  );
});

test('a plan declares no depth of its own, because the walk is always one hop', () => {
  assertSnapshotRejected(() => snapshot({ plans: [plan({ maxDepth: 2 })] }), /not allowed/);
  assert.equal(compile().maxDepth, 1);
});

test('an exhaustion policy is optional and defaults to serving the requested model', () => {
  assertSnapshotRejected(() => snapshot({ plans: [plan({ onExhausted: 'retry' })] }), /onExhausted/);
  acceptSnapshot(snapshot({ plans: [plan({ onExhausted: 'deny' })] }));

  const withoutPolicy = plan();
  delete withoutPolicy.onExhausted;
  const accepted = acceptSnapshot(snapshot({ plans: [withoutPolicy] }));

  assert.equal(
    compileFallbackPlan({
      plan: accepted.plans[0],
      registry: registry(),
      allowedModels: ['tier-a', 'tier-b', 'tier-c'],
      evaluationTime,
      apiFamily: 'openai-responses',
    }).onExhausted,
    'continue-with-requested',
  );
});

test('a stated exhaustion policy survives compilation unchanged', () => {
  assert.equal(compile({ planOverrides: { onExhausted: 'deny' } }).onExhausted, 'deny');
});

test('a plan that does not say its callers accept a substitute has not said so', () => {
  assertSnapshotRejected(
    () => snapshot({ plans: [plan({ modelSelectionIntent: 'whatever-is-cheapest' })] }),
    /modelSelectionIntent/,
  );

  const unstated = plan();
  delete unstated.modelSelectionIntent;
  const accepted = acceptSnapshot(snapshot({ plans: [unstated] }));
  const compiled = compileFallbackPlan({
    plan: accepted.plans[0],
    registry: registry(),
    allowedModels: ['tier-a', 'tier-b', 'tier-c'],
    evaluationTime,
    apiFamily: 'openai-responses',
  });

  assert.equal(compiled.modelSelectionIntent, 'pinned');
  // The ladder still compiles. Authoring the hops and opting callers into them are
  // separate acts, so a wide plan can be published before anyone is moved onto it.
  assert.ok(compiled.chain.length > 0);
});

test('the intent is carried on every disposition, not only a compiled one', () => {
  const disabledPlan = compile({ planOverrides: { enabled: false, modelSelectionIntent: 'preferred' } });

  assert.equal(disabledPlan.disposition, 'disabled');
  assert.equal(disabledPlan.modelSelectionIntent, 'preferred');
  assert.equal(compile({ planOverrides: { modelSelectionIntent: 'preferred' } }).modelSelectionIntent, 'preferred');
});

test('the notice mode defaults to the channel every response can carry', () => {
  assertSnapshotRejected(
    () => snapshot({ plans: [plan({ substitutionNotice: 'toast' })] }),
    /substitutionNotice/,
  );

  const unstated = plan();
  delete unstated.substitutionNotice;
  const accepted = acceptSnapshot(snapshot({ plans: [unstated] }));

  assert.equal(
    compileFallbackPlan({
      plan: accepted.plans[0],
      registry: registry(),
      allowedModels: ['tier-a', 'tier-b', 'tier-c'],
      evaluationTime,
      apiFamily: 'openai-responses',
    }).substitutionNotice,
    'header',
  );
  assert.equal(compile({ planOverrides: { substitutionNotice: 'inline' } }).substitutionNotice, 'inline');
});

test('a degraded registry yields an unavailable disposition rather than a partial chain', () => {
  const degraded = assertModelRegistrySnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'model-registry-002',
      tenantId,
      version: 2,
      status: 'stale',
      reason: 'catalogue publisher behind',
      capturedAt: '2026-08-06T23:55:00.000Z',
      expiresAt: '2026-08-07T00:30:00.000Z',
      sourceRevision: 'model-registry-source-002',
      models: [],
      applications: [],
    },
    { evaluationTime, principalTenantId: tenantId },
  );

  const result = compileFallbackPlan({
    plan: acceptSnapshot().plans[0],
    registry: degraded,
    allowedModels: ['tier-a', 'tier-b', 'tier-c'],
    evaluationTime,
    apiFamily: 'openai-responses',
  });

  assert.equal(result.disposition, 'unavailable');
  assert.equal(result.enabled, false);
  assert.deepEqual(result.chain, []);
  assert.equal(result.reasonCode, 'model-registry-unavailable');
});

test('a degraded fallback snapshot cannot carry plans at all', () => {
  assertSnapshotRejected(
    () => snapshot({ status: 'stale', reason: 'publisher behind' }),
    /cannot carry/,
  );
  const degraded = acceptSnapshot(snapshot({ status: 'stale', reason: 'publisher behind', plans: [] }));
  assert.deepEqual(degraded.plans, []);
});

test('a revoked, expired, or out-of-window plan is disabled without inspecting its hops', () => {
  for (const state of ['revoked', 'expired']) {
    assert.equal(compile({ planOverrides: { state } }).disposition, 'disabled');
  }
  assert.equal(
    compile({ planOverrides: { validFrom: '2026-09-01T00:00:00.000Z' } }).disposition,
    'disabled',
  );
  assert.equal(
    compile({ planOverrides: { validUntil: '2026-08-06T00:00:00.000Z' } }).disposition,
    'disabled',
  );
});

test('an opted-out plan is disabled but remains auditable', () => {
  const result = compile({ planOverrides: { enabled: false } });

  assert.equal(result.disposition, 'disabled');
  assert.equal(result.reasonCode, 'fallback-not-opted-in');
});

test('a differently published target is permitted when it answers the same contract', () => {
  // Measured on the account: every deployment answers the same route and is chosen by
  // the model field in the body, so publisher identity does not decide reachability.
  const result = compile({
    planOverrides: { edges: [{ from: 'tier-a', to: 'tier-b' }] },
    models: [
      model('tier-a'),
      model('tier-b', {
        providerKey: 'anthropic',
        apiFamilies: ['anthropic-messages', 'openai-chat-completions', 'openai-responses'],
      }),
      model('tier-c'),
    ],
  });

  assert.equal(blockedBy(result, 'tier-a'), null);
});

test('a hop that keeps the same content-safety policy is permitted', () => {
  const result = compile({
    planOverrides: { edges: [{ from: 'tier-a', to: 'tier-b' }] },
    models: [
      model('tier-a', { safetyPolicy: 'local-default-policy' }),
      model('tier-b', {
        safetyPolicy: 'local-default-policy',
      }),
      model('tier-c'),
    ],
  });

  assert.deepEqual(result.chain, [{ from: 'tier-a', to: 'tier-b' }]);
});

test('a hop is judged against the contract in use, not everything the source could serve', () => {
  // The same authored hop, the same two models: refused on the route the target
  // cannot answer, and permitted on the one it can. Comparing the models' whole
  // contract sets refused both, which kept every chat client off the cheaper half
  // of the catalogue.
  const models = [
    model('tier-a', { apiFamilies: ['openai-chat-completions', 'openai-responses'] }),
    model('tier-b', {
      apiFamilies: ['openai-chat-completions'],
    }),
    model('tier-c'),
  ];
  const planOverrides = { edges: [{ from: 'tier-a', to: 'tier-b' }] };

  const onResponses = compile({ planOverrides, models, apiFamily: 'openai-responses' });
  assert.equal(blockedBy(onResponses, 'tier-a'), 'fallback-api-family-narrowed');

  const onChat = compile({ planOverrides, models, apiFamily: 'openai-chat-completions' });
  assert.equal(blockedBy(onChat, 'tier-a'), null);
  assert.deepEqual(onChat.chain, [{ from: 'tier-a', to: 'tier-b' }]);
});

test('a cheaper hop is not refused for capacity the caller can recover from', () => {
  // Context and output ceilings were dropped as compatibility classes: exceeding one
  // is an immediate error the caller can compact and retry, unlike the losses the
  // remaining classes guard, which are silent or unroutable.
  const result = compile({
    planOverrides: { edges: [{ from: 'tier-a', to: 'tier-b' }] },
    models: [
      model('tier-a'),
      model('tier-b', {
      }),
      model('tier-c'),
    ],
  });

  assert.equal(blockedBy(result, 'tier-a'), null);
});

test('maturity does not decide a hop, because deploying a model and pointing at it is a choice', () => {
  for (const lifecycle of ['preview', 'deprecated', 'retired']) {
    const result = compile({
      planOverrides: { edges: [{ from: 'tier-a', to: 'tier-b' }] },
      models: [
        model('tier-a'),
        model('tier-b', {
          lifecycle,
        }),
        model('tier-c'),
      ],
    });

    assert.equal(blockedBy(result, 'tier-a'), null, lifecycle);
  }
});

test('an unregistered endpoint of a hop blocks it instead of compiling a chain that skips it', () => {
  const result = compile({
    planOverrides: { edges: [{ from: 'tier-a', to: 'tier-b' }] },
    models: [model('tier-a'), model('tier-c')],
  });

  assert.equal(blockedBy(result, 'tier-a'), 'fallback-model-unregistered');
  assert.deepEqual(result.chain, []);
});

test('a hop whose source the caller cannot use is unreachable rather than target-blocked', () => {
  const result = compile({ allowedModels: ['tier-b', 'tier-c'] });

  assert.equal(blockedBy(result, 'tier-a'), 'fallback-source-not-entitled');
  assert.deepEqual(result.chain, [{ from: 'tier-b', to: 'tier-c' }]);
});

test('a plan captured for another tenant is refused', () => {
  assertSnapshotRejected(() => snapshot({ tenantId: 'other.tenant.002' }), /tenant/i);
});

test('plans are sorted and unique by plan identifier', () => {
  assertSnapshotRejected(
    () => snapshot({ plans: [plan({ planId: 'zeta' }), plan({ planId: 'alpha' })] }),
    /sorted/,
  );
  assertSnapshotRejected(() => snapshot({ plans: [plan(), plan()] }), /duplicate/i);
});

test('unknown fields are refused on the snapshot and on a plan', () => {
  assertSnapshotRejected(() => snapshot({ backendUrl: 'x' }), /not allowed/);
  assertSnapshotRejected(() => snapshot({ plans: [plan({ deploymentName: 'x' })] }), /not allowed/);
});

test('an edge count beyond the reviewed bound is refused', () => {
  const edges = Array.from({ length: 33 }, (_, index) => ({
    from: `m${String(index).padStart(2, '0')}`,
    to: `m${String(index + 100).padStart(3, '0')}`,
  }));

  assertSnapshotRejected(() => snapshot({ plans: [plan({ edges })] }), /edges/);
});
