import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeployedPolicyResolver,
  createPublishedPolicyResolver,
  KNOWN_TEAM_KEYS,
  readGovernanceKnownTeamKeys,
  readGovernanceScopeGroupId,
  ROLLUP_CONFIG,
} from '../../app/functions/composition-root.mjs';
import { principalMembershipDocument } from '../../app/governance-domain/directory/principal-membership-document.mjs';
import {
  governanceSnapshotDocument,
  GOVERNANCE_SNAPSHOT_KINDS,
  GOVERNANCE_SNAPSHOT_PROPERTIES,
} from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const NOW = '2026-07-24T10:00:00.000Z';
const SCOPE_GROUP_ID = ROLLUP_CONFIG.scopeGroupId;
const TENANT_ID = 'tenant-local-demo';
const SUBJECT_ID = 'user-local-admin';
const SECRET = 'a-deployment-derivation-secret-of-sufficient-length';
const clock = { nowIso: () => NOW };

const CALLER = Object.freeze({
  tenantId: TENANT_ID,
  subjectId: SUBJECT_ID,
  applicationId: 'app-local-console',
});

async function publishedStore({ withMembership = true, kinds = GOVERNANCE_SNAPSHOT_KINDS } = {}) {
  const store = createInMemoryGovernanceStore();
  const snapshots = getDeterministicGovernanceSnapshots();
  for (const kind of kinds) {
    await store.putGovernanceSnapshot(
      governanceSnapshotDocument({
        scopeGroupId: SCOPE_GROUP_ID,
        kind,
        snapshot: snapshots[GOVERNANCE_SNAPSHOT_PROPERTIES[kind]],
      }),
      { ifMatch: null, evaluationTime: NOW },
    );
  }
  if (withMembership) {
    await store.putPrincipalMembership(
      principalMembershipDocument({
        scopeGroupId: SCOPE_GROUP_ID,
        memberships: {
          snapshotId: 'membership-0001',
          status: 'complete',
          source: 'control-plane',
          tenantId: TENANT_ID,
          subjectId: SUBJECT_ID,
          resolvedAt: '2026-07-24T09:58:00.000Z',
          expiresAt: '2026-07-24T10:03:00.000Z',
          maxAgeSeconds: 300,
          sourceRevision: 'directory-0001',
          groups: [
            { groupId: 'group-governance-admin', membership: 'direct', authorizationRelevant: true },
          ],
        },
      }),
      { ifMatch: null, evaluationTime: NOW },
    );
  }
  return store;
}

const resolverFor = (store) =>
  createPublishedPolicyResolver({ store, scopeGroupId: SCOPE_GROUP_ID, clock, secret: SECRET });

test('an unconfigured deployment keeps the scope and teams its existing records use', () => {
  assert.equal(readGovernanceScopeGroupId({}), 'platform-engineering');
  assert.deepEqual([...readGovernanceKnownTeamKeys({})], ['developer-experience', 'platform-engineering']);
  assert.equal(ROLLUP_CONFIG.scopeGroupId, readGovernanceScopeGroupId({}));
  assert.deepEqual([...KNOWN_TEAM_KEYS], [...readGovernanceKnownTeamKeys({})]);
});

test('explicit governance scope and team settings are parsed without request input', () => {
  assert.equal(readGovernanceScopeGroupId({ GOVERNANCE_SCOPE_GROUP_ID: 'organization' }), 'organization');
  assert.deepEqual(
    [...readGovernanceKnownTeamKeys({ GOVERNANCE_KNOWN_TEAM_KEYS: 'alpha,beta,gamma' })],
    ['alpha', 'beta', 'gamma'],
  );
});

test('a stated but unusable governance scope is refused rather than defaulted', () => {
  for (const value of ['', 'Platform-Engineering', 'platform engineering', 'a|b', '-leading', 'x'.repeat(65)]) {
    assert.throws(() => readGovernanceScopeGroupId({ GOVERNANCE_SCOPE_GROUP_ID: value }), TypeError);
  }
});

test('a stated but unusable team set is refused rather than defaulted', () => {
  for (const value of ['', 'alpha,,beta', 'alpha, beta', 'beta,alpha', 'alpha,alpha', 'Alpha,beta']) {
    assert.throws(() => readGovernanceKnownTeamKeys({ GOVERNANCE_KNOWN_TEAM_KEYS: value }), TypeError);
  }
});

test('a fully published deployment resolves a caller-specific policy', async () => {
  const resolved = await resolverFor(await publishedStore()).resolve(CALLER);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.document.resolution, 'resolved');
  assert.ok(resolved.document.allowedModels.length > 0);
  assert.ok(resolved.document.attribution.subjectKey.startsWith('sk1-'));
});

test('a caller with no published membership is refused, not handed a smaller grant', async () => {
  // An absent membership document is the roster answering that it does not list this
  // caller. A conservative document would still hand them a model, so removing someone
  // from the published set would grant access rather than withdraw it -- and would keep
  // granting it to tokens issued long after the removal.
  const store = await publishedStore({ withMembership: false });
  const refused = await resolverFor(store).resolve(CALLER);
  const governed = await resolverFor(await publishedStore()).resolve(CALLER);

  assert.equal(refused.status, 403);
  assert.equal(refused.reasonCode, 'membership-evidence-unmapped');
  assert.equal(refused.document, null);

  assert.equal(governed.status, 200);
  assert.ok(governed.document.allowedModels.length > 0);
});

test('an incomplete snapshot set reports the source unavailable rather than resolving', async () => {
  const store = await publishedStore({ kinds: ['assignment', 'entitlement'] });
  await assert.rejects(
    () => resolverFor(store).resolve(CALLER),
    (error) => error.name === 'PolicySourceUnavailableError',
  );
});

test('the pseudonym is derived from the configured secret, so a different one differs', async () => {
  const store = await publishedStore();
  const first = await resolverFor(store).resolve(CALLER);
  const second = await createPublishedPolicyResolver({
    store,
    scopeGroupId: SCOPE_GROUP_ID,
    clock,
    secret: 'a-completely-different-derivation-secret-value',
  }).resolve(CALLER);

  assert.notEqual(first.document.attribution.subjectKey, second.document.attribution.subjectKey);
});

test('a stand-in secret is refused rather than producing pseudonyms nothing agrees with', () => {
  const unresolvedReference =
    '@Microsoft.KeyVault(SecretUri=https://example.invalid/secrets/principal-key-secret/0000)';
  for (const secret of ['', 'secret', 'too-short', unresolvedReference]) {
    assert.throws(
      () => createPublishedPolicyResolver({ store: createInMemoryGovernanceStore(), scopeGroupId: SCOPE_GROUP_ID, clock, secret }),
      TypeError,
      `secret ${JSON.stringify(secret)} must be refused`,
    );
  }
});

test('an unresolved key store reference never becomes the pseudonym pepper', async () => {
  // The platform delivers the reference text itself when it cannot resolve it. It is
  // long, unusual, and public, so every length and placeholder check passes.
  const resolver = createDeployedPolicyResolver(
    {
      GOVERNANCE_STORE_ENDPOINT: 'https://example.invalid',
      GOVERNANCE_DATABASE_NAME: 'governance',
      PRINCIPAL_KEY_SECRET:
        '@Microsoft.KeyVault(SecretUri=https://example.invalid/secrets/principal-key-secret/0000)',
    },
    clock,
  );
  await assert.rejects(
    () => resolver.resolve(CALLER),
    (error) => error.name === 'PolicySourceUnavailableError',
  );
});

test('an unconfigured deployment keeps the resolver that reports unavailable', async () => {
  for (const environment of [
    {},
    { GOVERNANCE_STORE_ENDPOINT: 'https://example.invalid', GOVERNANCE_DATABASE_NAME: 'governance' },
    { PRINCIPAL_KEY_SECRET: SECRET },
  ]) {
    const resolver = createDeployedPolicyResolver(environment, clock);
    await assert.rejects(
      () => resolver.resolve(CALLER),
      (error) => error.name === 'PolicySourceUnavailableError',
      `environment ${JSON.stringify(Object.keys(environment))} must report unavailable`,
    );
  }
});

test('a deployment states where membership comes from, and an unknown source is refused', async () => {
  // The two sources disagree about a caller the directory has removed, so which one is
  // in use cannot be left to whichever happens to answer.
  const configured = {
    GOVERNANCE_STORE_ENDPOINT: 'https://example.invalid',
    GOVERNANCE_DATABASE_NAME: 'governance',
    PRINCIPAL_KEY_SECRET: SECRET,
  };
  for (const source of ['store', 'directory-claim', undefined]) {
    const environment = source === undefined
      ? configured
      : { ...configured, GOVERNANCE_MEMBERSHIP_SOURCE: source };
    assert.ok(createDeployedPolicyResolver(environment, clock));
  }

  // A misspelling must not quietly fall back to reading the published roster.
  const misspelled = createDeployedPolicyResolver(
    { ...configured, GOVERNANCE_MEMBERSHIP_SOURCE: 'directory' },
    clock,
  );
  await assert.rejects(
    () => misspelled.resolve(CALLER),
    (error) => error.name === 'PolicySourceUnavailableError',
  );
});

test('a configured store with a refused secret does not stop the host from starting', async () => {
  const resolver = createDeployedPolicyResolver(
    {
      GOVERNANCE_STORE_ENDPOINT: 'https://example.invalid',
      GOVERNANCE_DATABASE_NAME: 'governance',
      PRINCIPAL_KEY_SECRET: 'secret',
    },
    clock,
  );
  await assert.rejects(
    () => resolver.resolve(CALLER),
    (error) => error.name === 'PolicySourceUnavailableError',
  );
});

test('a setting that has stopped mattering is refused by name, without stopping the host', async () => {
  // Every caller is refused when this resolver is absent, so a host that will not boot
  // would be a total outage nobody could read the settings of. The fault has to arrive
  // as a named refusal instead.
  const resolver = createDeployedPolicyResolver(
    {
      GOVERNANCE_STORE_ENDPOINT: 'https://example.invalid',
      GOVERNANCE_DATABASE_NAME: 'governance',
      PRINCIPAL_KEY_SECRET: SECRET,
      GOVERNANCE_MEMBERSHIP_SOURCE: 'directory-claim',
      GOVERNANCE_DEGRADED_MODELS: 'some-model',
    },
    clock,
  );
  await assert.rejects(
    () => resolver.resolve(CALLER),
    (error) =>
      error.name === 'PolicySourceUnavailableError' &&
      error.message === 'withdrawn-degraded-setting-present',
  );
});
