import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CONTAINER_TOPOLOGY,
  DEPLOYMENT_PROFILES,
  assertContainerTopology,
  containersForProfile,
} from '../../app/persistence/container-topology.mjs';
import {
  assertEffectivePolicyDocument,
  isEffectivePolicyDocumentValid,
} from '../../app/governance-domain/policy/effective-policy-validator.mjs';

async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`./fixtures/effective-policy/${name}`, import.meta.url), 'utf8'),
  );
}

const resolved = await fixture('valid-resolved.json');
const degraded = await fixture('valid-degraded-default.json');

function mutate(mutator, base = resolved) {
  const copy = structuredClone(base);
  mutator(copy);
  return copy;
}

test('the declared container topology is internally consistent', () => {
  assert.equal(assertContainerTopology(), true);
  assert.deepEqual(
    CONTAINER_TOPOLOGY.map((container) => container.id).sort(),
    ['events', 'governance', 'leases', 'rollups'],
  );
});

test('no container is created at runtime', () => {
  for (const container of CONTAINER_TOPOLOGY) {
    assert.equal(container.createdAtRuntime, false, `${container.id} must be pre-provisioned`);
    assert.equal(container.provisionedBy, 'infrastructure');
  }
});

test('the default profile excludes event-stream containers', () => {
  const ids = containersForProfile('always').map((container) => container.id).sort();
  assert.deepEqual(ids, ['governance', 'rollups']);

  const escalated = containersForProfile('event-stream').map((container) => container.id).sort();
  assert.deepEqual(escalated, ['events', 'governance', 'leases', 'rollups']);
});

test('the usage event container partitions hierarchically and expires records', () => {
  const events = CONTAINER_TOPOLOGY.find((container) => container.id === 'events');
  assert.deepEqual([...events.partitionKeyPaths], ['/scopeGroupId', '/dateBucket']);
  assert.ok(events.defaultTimeToLiveSeconds > 0);
});

test('an unknown deployment profile is rejected', () => {
  assert.throws(() => containersForProfile('production'), TypeError);
  assert.equal(DEPLOYMENT_PROFILES.includes('production'), false);
});

test('topology defects are detected', () => {
  const cases = [
    [{ id: 'Governance', partitionKeyPaths: ['/scopeGroupId'], profile: 'always', provisionedBy: 'infrastructure', createdAtRuntime: false, defaultTimeToLiveSeconds: null, writtenBy: ['x'] }, 'uppercase id'],
    [{ id: 'a', partitionKeyPaths: [], profile: 'always', provisionedBy: 'infrastructure', createdAtRuntime: false, defaultTimeToLiveSeconds: null, writtenBy: ['x'] }, 'no partition key'],
    [{ id: 'a', partitionKeyPaths: ['/a', '/b', '/c', '/d'], profile: 'always', provisionedBy: 'infrastructure', createdAtRuntime: false, defaultTimeToLiveSeconds: null, writtenBy: ['x'] }, 'too deep'],
    [{ id: 'a', partitionKeyPaths: ['scopeGroupId'], profile: 'always', provisionedBy: 'infrastructure', createdAtRuntime: false, defaultTimeToLiveSeconds: null, writtenBy: ['x'] }, 'unrooted path'],
    [{ id: 'a', partitionKeyPaths: ['/a'], profile: 'always', provisionedBy: 'infrastructure', createdAtRuntime: true, defaultTimeToLiveSeconds: null, writtenBy: ['x'] }, 'runtime creation'],
    [{ id: 'a', partitionKeyPaths: ['/a'], profile: 'always', provisionedBy: 'application', createdAtRuntime: false, defaultTimeToLiveSeconds: null, writtenBy: ['x'] }, 'application provisioning'],
    [{ id: 'a', partitionKeyPaths: ['/a'], profile: 'always', provisionedBy: 'infrastructure', createdAtRuntime: false, defaultTimeToLiveSeconds: 0, writtenBy: ['x'] }, 'zero time to live'],
  ];

  for (const [container, label] of cases) {
    assert.throws(() => assertContainerTopology([container]), TypeError, label);
  }

  const duplicate = { id: 'a', partitionKeyPaths: ['/a'], profile: 'always', provisionedBy: 'infrastructure', createdAtRuntime: false, defaultTimeToLiveSeconds: null, writtenBy: ['x'] };
  assert.throws(() => assertContainerTopology([duplicate, { ...duplicate }]), TypeError);
});

test('valid effective policy documents are accepted', () => {
  assert.equal(assertEffectivePolicyDocument(resolved), true);
  assert.equal(assertEffectivePolicyDocument(degraded), true);
});

test('every per-model fixture limit names an allowed deployed model', () => {
  const deployments = new Set(resolved.modelDeployments.map((deployment) => deployment.modelKey));
  for (const limit of resolved.limits.filter((limit) => limit.modelScope === 'per-model')) {
    assert.ok(typeof limit.modelKey === 'string' && limit.modelKey.length > 0);
    assert.ok(resolved.allowedModels.includes(limit.modelKey), limit.modelKey);
    assert.ok(deployments.has(limit.modelKey), limit.modelKey);
  }
});

test('the document identifier is derived, not supplied', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.id = 'effective-policy|other|pk-8f3a2c91d4e6b705'; })),
    TypeError,
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.scopeGroupId = 'team-other'; })),
    TypeError,
  );
});

test('fallback can never widen entitlement', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.fallback.chain[0].to = 'model-unlisted'; })),
    TypeError,
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.fallback.chain[0].from = 'model-unlisted'; })),
    TypeError,
  );
});

test('fallback chains are acyclic, deterministic, and depth bounded', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => {
      d.fallback.chain = [
        { from: 'model-large', to: 'model-small' },
        { from: 'model-small', to: 'model-large' },
      ];
    })),
    TypeError,
    'cycle',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => {
      d.fallback.chain.push({ from: 'model-large', to: 'model-mini' });
    })),
    TypeError,
    'two targets for one model',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.fallback.maxDepth = 1; })),
    TypeError,
    'exceeds max depth',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => {
      d.fallback.chain = [{ from: 'model-mini', to: 'model-mini' }];
    })),
    TypeError,
    'self reference',
  );
});

test('a degraded resolution disables fallback', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => {
      d.fallback.enabled = true;
      d.fallback.chain = [{ from: 'model-mini', to: 'model-mini' }];
    }, degraded)),
    TypeError,
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => {
      d.fallback.chain = [{ from: 'model-large', to: 'model-small' }];
      d.fallback.enabled = false;
    })),
    TypeError,
    'chain must be empty when disabled',
  );
});

test('limits require an organization-wide backstop and reject duplicates', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => {
      d.limits = d.limits.filter(
        (limit) => !(limit.scope === 'organization' && limit.modelScope === 'all-models'),
      );
    })),
    TypeError,
    'missing organization cap',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => {
      d.limits.push({
        scope: 'team',
        modelScope: 'all-models',
        tokenQuota: 5,
        quotaPeriod: 'Daily',
      });
    })),
    TypeError,
    'duplicate scope pair',
  );
});

test('quotas are whole token counts', () => {
  for (const value of [0, -1, 1.5, '1000', Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(
      isEffectivePolicyDocumentValid(mutate((d) => { d.limits[0].tokenQuota = value; })),
      false,
      `tokenQuota ${String(value)} must be rejected`,
    );
  }
});

test('the allowlist is sorted and free of duplicates', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => {
      d.allowedModels = ['model-small', 'model-mini', 'model-large'];
    })),
    TypeError,
    'unsorted',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => {
      d.allowedModels = ['model-mini', 'model-mini'];
    })),
    TypeError,
    'duplicate',
  );
});

test('expiry must follow resolution time', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.expiresAt = d.resolvedAt; })),
    TypeError,
  );
});

test('the document carries no endpoint or credential value', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.scopeGroupId = 'https:--x'; })),
    TypeError,
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.allowedModels = ['Bearer_abc']; })),
    TypeError,
  );
});

test('unknown fields are rejected', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.backendEndpoint = 'x'; })),
    TypeError,
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.limits[0].burst = 1; })),
    TypeError,
  );
});

test('a threshold is required whenever fallback is enabled', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { delete d.warnThresholdPercent; })),
    TypeError,
  );
  for (const value of [0, 100, 50.5]) {
    assert.equal(
      isEffectivePolicyDocumentValid(mutate((d) => { d.warnThresholdPercent = value; })),
      false,
      `threshold ${String(value)} must be rejected`,
    );
  }
});

test('attribution carries versioned pseudonyms and a canonical team', () => {
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.attribution.subjectKey = 'subject-0001'; })),
    TypeError,
    'raw subject',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.attribution.applicationKey = 'sk1-3xQm7pR2vLnB8dKfWzYtHcJa9SgUeNiOw0'; })),
    TypeError,
    'wrong pseudonym kind',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.attribution.teamKey = 'Team-Platform'; })),
    TypeError,
    'non-canonical team',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.attribution.teamKey = 'team-other'; })),
    TypeError,
    'team must match scope group',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { delete d.attribution; })),
    TypeError,
    'attribution required',
  );
  assert.throws(
    () => assertEffectivePolicyDocument(mutate((d) => { d.attribution.extra = 'x'; })),
    TypeError,
    'closed attribution',
  );
});
