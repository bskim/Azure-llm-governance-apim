import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { selectEffectiveModel } from '../../app/governance-domain/policy/effective-model-selector.mjs';

const policyXml = await readFile(new URL('../../apim/policies/inference.xml', import.meta.url), 'utf8');

const SCOPES = ['organization', 'team', 'subject', 'application'];

function policy({ chain = [], enabled = chain.length > 0, maxDepth = 2, warnThresholdPercent = 80, allowedModels = ['tier-a', 'tier-b', 'tier-c'], limits = null, resolution = 'resolved', modelSelectionIntent = 'preferred', modelPressure = null } = {}) {
  const document = {
    resolution,
    allowedModels,
    warnThresholdPercent,
    modelSelectionIntent,
    limits:
      limits ?? [{ scope: 'organization', modelScope: 'all-models', tokenQuota: 1000, quotaPeriod: 'Daily' }],
    fallback: { enabled, maxDepth, chain },
  };
  if (modelPressure !== null) document.modelPressure = modelPressure;
  return document;
}

const ladder = [
  { from: 'tier-a', to: 'tier-b' },
  { from: 'tier-b', to: 'tier-c' },
];

/**
 * Rows are the contract between this evaluator and the deployed policy expression.
 * If a row needs an input the effective policy document does not already carry, the
 * gateway cannot reproduce this answer and the evaluator would be a simulation
 * rather than a reference.
 */
const parityRows = [
  {
    name: 'no breach keeps the requested model',
    policy: policy({ chain: ladder }),
    remaining: { organization: 1000 },
    requested: 'tier-a',
    expected: 'tier-a',
    hops: 0,
  },
  {
    name: 'any breach walks the whole ladder rather than one rung per threshold band',
    policy: policy({ chain: ladder }),
    remaining: { organization: 200 },
    requested: 'tier-a',
    expected: 'tier-c',
    hops: 2,
  },
  {
    name: 'one token below the threshold does not trigger',
    policy: policy({ chain: ladder }),
    remaining: { organization: 201 },
    requested: 'tier-a',
    expected: 'tier-a',
    hops: 0,
  },
  {
    name: 'a deeper breach still stops at the configured depth',
    policy: policy({ chain: ladder, maxDepth: 1 }),
    remaining: { organization: 0 },
    requested: 'tier-a',
    expected: 'tier-b',
    hops: 1,
  },
  {
    name: 'a full ladder walks to its end',
    policy: policy({ chain: ladder, maxDepth: 2 }),
    remaining: { organization: 0 },
    requested: 'tier-a',
    expected: 'tier-c',
    hops: 2,
  },
  {
    name: 'a breach on a narrower scope triggers just as an organization breach does',
    policy: policy({
      chain: ladder,
      limits: [
        { scope: 'organization', modelScope: 'all-models', tokenQuota: 1000, quotaPeriod: 'Daily' },
        { scope: 'subject', modelScope: 'all-models', tokenQuota: 100, quotaPeriod: 'Daily' },
      ],
    }),
    remaining: { organization: 1000, subject: 10 },
    requested: 'tier-a',
    expected: 'tier-c',
    hops: 2,
  },
  {
    name: 'a scope with no reported remainder is not treated as exhausted',
    policy: policy({
      chain: ladder,
      limits: [
        { scope: 'organization', modelScope: 'all-models', tokenQuota: 1000, quotaPeriod: 'Daily' },
        { scope: 'team', modelScope: 'all-models', tokenQuota: 100, quotaPeriod: 'Daily' },
      ],
    }),
    remaining: { organization: 1000 },
    requested: 'tier-a',
    expected: 'tier-a',
    hops: 0,
  },
  {
    name: 'disabled fallback keeps the requested model under any pressure',
    policy: policy({ chain: [], enabled: false }),
    remaining: { organization: 0 },
    requested: 'tier-a',
    expected: 'tier-a',
    hops: 0,
  },
  {
    name: 'a degraded resolution never downgrades',
    policy: policy({ chain: [], enabled: false, resolution: 'default' }),
    remaining: { organization: 0 },
    requested: 'tier-a',
    expected: 'tier-a',
    hops: 0,
  },
  {
    name: 'a requested model with no outgoing hop is served unchanged',
    policy: policy({ chain: ladder }),
    remaining: { organization: 0 },
    requested: 'tier-c',
    expected: 'tier-c',
    hops: 0,
  },
  {
    name: 'a hop whose target left the allowlist stops the walk',
    policy: policy({ chain: ladder, allowedModels: ['tier-a', 'tier-b'] }),
    remaining: { organization: 0 },
    requested: 'tier-a',
    expected: 'tier-b',
    hops: 1,
  },
];

for (const row of parityRows) {
  test(`selection: ${row.name}`, () => {
    const result = selectEffectiveModel({
      requestedModel: row.requested,
      effectivePolicy: row.policy,
      remainingTokensByScope: row.remaining,
    });

    assert.equal(result.effectiveModel, row.expected);
    assert.equal(result.hops, row.hops);
    assert.equal(result.decision, 'selected');
  });
}

test('the walk depth is set by the plan, not by how far past the threshold the caller is', () => {
  // Recorded deliberately. A caller one token past the warning threshold and a caller
  // with an exhausted quota reach the same model, so maxDepth configures how far a
  // breach jumps rather than a graduated response. Anything graduated needs separate
  // thresholds per rung, which this contract does not carry.
  const barelyOver = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: policy({ chain: ladder }),
    remainingTokensByScope: { organization: 200 },
  });
  const exhausted = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: policy({ chain: ladder }),
    remainingTokensByScope: { organization: 0 },
  });

  assert.equal(barelyOver.effectiveModel, exhausted.effectiveModel);
  assert.equal(barelyOver.hops, exhausted.hops);
});

test('every parity row is expressible from the effective policy document alone', () => {
  // The falsification guard. The deployed expression reads only these fields, so a
  // row needing anything else would mean the gateway cannot reach the same answer.
  const permitted = new Set([
    'resolution',
    'allowedModels',
    'warnThresholdPercent',
    'modelSelectionIntent',
    'modelPressure',
    'limits',
    'fallback',
  ]);

  for (const row of parityRows) {
    for (const key of Object.keys(row.policy)) {
      assert.ok(permitted.has(key), `${row.name} relies on ${key}, which the gateway does not read.`);
    }
  }
});

test('the deployed expression reads the same policy fields this evaluator reads', () => {
  const expression = policyXml.slice(
    policyXml.indexOf('<set-variable name="effectiveModel"'),
    policyXml.indexOf('<set-variable name="fallbackApplied"'),
  );

  assert.ok(expression.length > 0, 'the effective model expression must be present.');
  for (const field of ['fallback', 'warnThresholdPercent', 'modelSelectionIntent', 'modelPressure', 'limits', 'allowedModels', 'maxDepth', 'chain']) {
    assert.ok(expression.includes(`"${field}"`), `the expression must read ${field}.`);
  }
});

test('a model at its own budget threshold is downgraded without waiting for the shared cap', () => {
  // The product this serves gives each model its own budget. Waiting for the
  // organization-wide cap would spend almost all of the expensive model's budget first,
  // which is the opposite of what the downgrade is for.
  const withPressure = policy({
    chain: [{ from: 'tier-a', to: 'tier-b' }],
    modelPressure: [{ model: 'tier-a', consumedBasisPoints: 8200 }],
  });
  const decision = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: withPressure,
    remainingTokensByScope: {},
  });

  assert.equal(decision.effectiveModel, 'tier-b');
  assert.equal(decision.reasonCode, 'fallback-applied');
  assert.deepEqual(decision.breachedScopes, []);
  assert.equal(decision.modelPressureBreached, true);
});

test('another model burning its budget does not downgrade this one', () => {
  const decision = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: policy({
      chain: [{ from: 'tier-a', to: 'tier-b' }],
      modelPressure: [{ model: 'tier-c', consumedBasisPoints: 9900 }],
    }),
    remainingTokensByScope: {},
  });

  assert.equal(decision.effectiveModel, 'tier-a');
  assert.equal(decision.reasonCode, 'within-budget');
  assert.equal(decision.modelPressureBreached, false);
});

test('an unmeasured model is not treated as a model at zero pressure or at full pressure', () => {
  // Absent means nobody measured. Reading it as zero would never downgrade; reading it
  // as full would downgrade a caller nowhere near their cap.
  const decision = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: policy({ chain: [{ from: 'tier-a', to: 'tier-b' }] }),
    remainingTokensByScope: {},
  });

  assert.equal(decision.effectiveModel, 'tier-a');
  assert.equal(decision.modelPressureBreached, false);
});

test('a pinned caller is still told their model is under pressure', () => {
  // The pin decides the model. It does not make the pressure stop being a fact the
  // decision record has to carry.
  const decision = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: policy({
      chain: [{ from: 'tier-a', to: 'tier-b' }],
      modelSelectionIntent: 'pinned',
      modelPressure: [{ model: 'tier-a', consumedBasisPoints: 9000 }],
    }),
    remainingTokensByScope: {},
  });

  assert.equal(decision.reasonCode, 'model-pinned');
  assert.equal(decision.modelPressureBreached, true);
});

test('the deployed expression breaches on reaching the threshold, not on passing it', () => {
  const expression = policyXml.slice(
    policyXml.indexOf('<set-variable name="effectiveModel"'),
    policyXml.indexOf('<set-variable name="fallbackApplied"'),
  );

  // `>=` in the gateway and `>=` here are what make the boundary rows above agree.
  assert.ok(expression.includes('&gt;= threshold'), 'the expression must breach at the threshold.');
});

test('the deployed expression walks one successor per model, bounded by maxDepth', () => {
  const expression = policyXml.slice(
    policyXml.indexOf('<set-variable name="effectiveModel"'),
    policyXml.indexOf('<set-variable name="fallbackApplied"'),
  );

  assert.ok(expression.includes('depth &lt; maxDepth'), 'the walk must be bounded by maxDepth.');
  assert.ok(expression.includes('FirstOrDefault'), 'the walk must take one successor per model.');
  assert.ok(expression.includes('allowed.Contains(next)'), 'the walk must stay inside the allowlist.');
});

test('a compile-time superset of wire contracts removes the need for a runtime family check', () => {
  // If the target serves every family the source serves, then it serves whichever
  // family is in flight, because the request already reached the source.
  const source = ['openai-chat-completions', 'openai-responses'];
  const target = ['anthropic-messages', 'openai-chat-completions', 'openai-responses'];

  for (const inFlight of source) {
    assert.ok(target.includes(inFlight), `${inFlight} must remain servable after the hop.`);
  }
});

test('exhaustion under a deny policy is a denial the gateway does not currently express', () => {
  const result = selectEffectiveModel({
    requestedModel: 'tier-c',
    effectivePolicy: policy({ chain: ladder, onExhausted: 'deny' }),
    remainingTokensByScope: { organization: 0 },
    onExhausted: 'deny',
  });

  assert.equal(result.decision, 'denied');
  assert.equal(result.effectiveModel, null);
  assert.equal(result.reasonCode, 'fallback-exhausted');

  const expression = policyXml.slice(
    policyXml.indexOf('<set-variable name="effectiveModel"'),
    policyXml.indexOf('<set-variable name="fallbackApplied"'),
  );
  assert.ok(
    !expression.includes('fallback-exhausted'),
    'the deployed expression has no denial branch, so enabling deny is a gateway change.',
  );
});

test('continuing with the requested model still records that pressure was present', () => {
  const result = selectEffectiveModel({
    requestedModel: 'tier-c',
    effectivePolicy: policy({ chain: ladder }),
    remainingTokensByScope: { organization: 0 },
  });

  assert.equal(result.decision, 'selected');
  assert.equal(result.effectiveModel, 'tier-c');
  assert.equal(result.hops, 0);
  assert.deepEqual(result.breachedScopes, ['organization']);
  assert.equal(result.reasonCode, 'fallback-exhausted-served-as-requested');
});

test('breached scopes are reported in a stable order', () => {
  const result = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: policy({
      chain: ladder,
      limits: SCOPES.map((scope) => ({
        scope,
        modelScope: 'all-models',
        tokenQuota: 1000,
        quotaPeriod: 'Daily',
      })),
    }),
    remainingTokensByScope: { application: 0, subject: 0, team: 0, organization: 0 },
  });

  assert.deepEqual(result.breachedScopes, SCOPES);
});

test('the selection result is frozen', () => {
  const result = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: policy({ chain: ladder }),
    remainingTokensByScope: { organization: 1000 },
  });

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.breachedScopes));
});

test('a pinned caller keeps the model it named however far past the threshold it is', () => {
  const result = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: policy({ chain: ladder, modelSelectionIntent: 'pinned' }),
    remainingTokensByScope: { organization: 0 },
  });

  assert.equal(result.effectiveModel, 'tier-a');
  assert.equal(result.hops, 0);
  assert.equal(result.reasonCode, 'model-pinned');
  // The pin suppresses the substitute, not the signal. An administrator still has to
  // be able to see that this caller is over its threshold.
  assert.deepEqual(result.breachedScopes, ['organization']);
});

test('an absent intent pins, so a caller that never opted in is never rerouted', () => {
  const configured = policy({ chain: ladder });
  delete configured.modelSelectionIntent;

  const result = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: configured,
    remainingTokensByScope: { organization: 0 },
  });

  assert.equal(result.effectiveModel, 'tier-a');
  assert.equal(result.reasonCode, 'model-pinned');
});

test('a pinned caller under a deny policy is still served, because nothing was exhausted', () => {
  const result = selectEffectiveModel({
    requestedModel: 'tier-a',
    effectivePolicy: policy({ chain: ladder, modelSelectionIntent: 'pinned' }),
    remainingTokensByScope: { organization: 0 },
    onExhausted: 'deny',
  });

  assert.equal(result.decision, 'selected');
  assert.equal(result.reasonCode, 'model-pinned');
});

test('the deployed expression reads the intent, and treats anything but preferred as a pin', () => {
  const start = policyXml.indexOf('<set-variable name="effectiveModel"');
  const expression = policyXml.slice(start, policyXml.indexOf('</set-variable>', start));

  assert.ok(expression.includes('modelSelectionIntent'), 'the gateway must read the declared intent.');
  assert.ok(
    expression.includes('== null ? "pinned"'),
    'an absent intent must pin at the gateway too, or the two sides disagree on the default.',
  );
  assert.ok(
    expression.includes('intent != "preferred"'),
    'the gateway must opt in to substitution rather than opt out of it.',
  );
  assert.ok(
    expression.indexOf('modelSelectionIntent') < expression.indexOf('warnThresholdPercent'),
    'the intent must be checked before the threshold, so a pin costs no evaluation.',
  );
});

