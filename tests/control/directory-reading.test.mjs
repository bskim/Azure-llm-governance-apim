import assert from 'node:assert/strict';
import test from 'node:test';

import { createEntraDirectoryQuery } from '../../app/providers/entra-directory-query.mjs';
import { createScheduledDirectoryProjector } from '../../app/control-api/scheduled-directory-projector.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';

const NOW = '2026-07-24T10:00:00.000Z';
const TENANT = 'tenant-local-demo';
const SCOPE_GROUP_ID = 'platform-engineering';
const clock = { nowIso: () => NOW };
const credential = { getToken: async () => ({ token: 'token-value' }) };
const createCredential = () => credential;
const code = ({ subjectId }) => `actor1-${subjectId.replaceAll('-', '')}`;

const TEAMS = [
  { teamKey: 'platform-engineering', membershipGroupId: 'group-platform' },
  { teamKey: 'developer-experience', membershipGroupId: 'group-developer' },
];

function graph(members) {
  const seen = [];
  const transport = async (url) => {
    seen.push(url);
    for (const [groupId, sets] of Object.entries(members)) {
      if (!url.includes(`/groups/${groupId}/`)) continue;
      if (sets.fail) {
        const error = new Error('directory-read-failed');
        error.code = 'directory-read-failed';
        throw error;
      }
      const ids = url.includes('transitiveMembers') ? sets.transitive : sets.direct;
      return { value: ids.map((id) => ({ id })) };
    }
    return { value: [] };
  };
  return { transport, seen };
}

test('only the governed groups are asked about, and only for identifiers', async () => {
  const { transport, seen } = graph({
    'group-platform': { direct: ['oid-a'], transitive: ['oid-a', 'oid-b'] },
    'group-developer': { direct: ['oid-c'], transitive: ['oid-c'] },
  });
  const read = createEntraDirectoryQuery({ createCredential, deriveDirectoryCode: code, transport });
  const reading = await read({ tenantId: TENANT, teams: TEAMS });

  assert.equal(reading.groups.length, 2);
  assert.equal(reading.source.state, 'complete');
  // The permission Graph offers is tenant-wide, so the narrowing that is available is
  // to ask about nothing governance does not name.
  assert.ok(seen.every((url) => /\/groups\/group-(platform|developer)\//.test(url)));
  // A display name, a principal name and a mail address are all personal data. The
  // request never asks for them, which is the only place that can be enforced.
  assert.ok(seen.every((url) => url.includes('$select=id')));
  for (const forbidden of ['displayName', 'userPrincipalName', 'mail', 'givenName', 'surname']) {
    assert.ok(seen.every((url) => !url.includes(forbidden)), `${forbidden} must not be requested`);
  }
});

test('a directory object identifier never reaches the reading', async () => {
  const { transport } = graph({
    'group-platform': { direct: ['oid-a'], transitive: ['oid-a', 'oid-b'] },
    'group-developer': { direct: [], transitive: [] },
  });
  const read = createEntraDirectoryQuery({ createCredential, deriveDirectoryCode: code, transport });
  const serialised = JSON.stringify(await read({ tenantId: TENANT, teams: TEAMS }));

  for (const objectId of ['oid-a', 'oid-b']) {
    assert.ok(!serialised.includes(`"${objectId}"`), `${objectId} must be pseudonymised`);
  }
  assert.ok(serialised.includes('actor1-oida'));
});

test('membership below the group is inherited, and the difference is read not assumed', async () => {
  const { transport } = graph({
    'group-platform': { direct: ['oid-a'], transitive: ['oid-a', 'oid-b'] },
    'group-developer': { direct: [], transitive: [] },
  });
  const read = createEntraDirectoryQuery({ createCredential, deriveDirectoryCode: code, transport });
  const [platform] = (await read({ tenantId: TENANT, teams: TEAMS })).groups;

  assert.deepEqual(
    platform.members.map((member) => member.membership).sort(),
    ['direct', 'inherited'],
  );
});

test('one unreadable group makes the reading partial rather than smaller', async () => {
  const { transport } = graph({
    'group-platform': { direct: ['oid-a'], transitive: ['oid-a'] },
    'group-developer': { fail: true },
  });
  const read = createEntraDirectoryQuery({ createCredential, deriveDirectoryCode: code, transport });
  const reading = await read({ tenantId: TENANT, teams: TEAMS });

  assert.equal(reading.groups.length, 1);
  assert.equal(reading.source.state, 'truncated');
});

test('a directory nothing could be read from refuses rather than reporting an empty one', async () => {
  const { transport } = graph({
    'group-platform': { fail: true },
    'group-developer': { fail: true },
  });
  const read = createEntraDirectoryQuery({ createCredential, deriveDirectoryCode: code, transport });
  await assert.rejects(() => read({ tenantId: TENANT, teams: TEAMS }), /directory-read-failed/);
});

test('the query refuses to be built without a way to pseudonymise', () => {
  assert.throws(() => createEntraDirectoryQuery({ createCredential, transport: async () => ({}) }), TypeError);
  assert.throws(() => createEntraDirectoryQuery({ deriveDirectoryCode: code }), TypeError);
});

/**
 * A managed identity token is minted once and reused for hours, so an instance that read
 * the directory before the Graph permission was granted holds a token Graph refuses.
 * Measured on a deployment: one instance projected the reading while another, two minutes
 * later, was still refused, and a restart did not replace it. Azure caches these tokens in
 * its own back end for about 24 hours and does not allow a forced refresh, so what this
 * covers is the copy held in this process, not the wait.
 */
test('a refused reading is asked again with a credential made after the refusal', async () => {
  let granted = false;
  const issued = [];
  const forbidden = () => Object.assign(new Error('directory-read-failed'), {
    code: 'directory-read-failed',
    status: 403,
  });

  const read = createEntraDirectoryQuery({
    // Each credential captures the grant as it stood when it was made, which is what a
    // token does. Asking the same one again could never answer differently.
    createCredential: () => {
      const permitted = granted;
      issued.push(permitted);
      return { getToken: async () => ({ token: permitted ? 'after-grant' : 'before-grant' }) };
    },
    deriveDirectoryCode: code,
    transport: async (url, { getToken }) => {
      if ((await getToken()) !== 'after-grant') throw forbidden();
      const ids = url.includes('/groups/group-platform/') ? ['oid-a'] : [];
      return { value: ids.map((id) => ({ id })) };
    },
  });

  await assert.rejects(() => read({ tenantId: TENANT, teams: TEAMS }), /directory-read-failed/);
  assert.deepEqual(issued, [false, false], 'a refusal must be re-asked with a new credential, once');

  granted = true;
  const reading = await read({ tenantId: TENANT, teams: TEAMS });
  assert.equal(reading.groups.length, 2);
  assert.equal(issued.at(-1), true, 'the run after the grant must use a token issued after it');
});

function projectorWith({ readPublishedSnapshots, readGovernedDirectory, store = createInMemoryGovernanceStore() }) {
  return {
    store,
    run: createScheduledDirectoryProjector({
      store,
      readPublishedSnapshots,
      readGovernedDirectory,
      clock,
      scopeGroupId: SCOPE_GROUP_ID,
    }),
  };
}

const published = async () => ({
  entitlementSnapshot: { version: 4, tenantId: TENANT, teamCatalog: TEAMS },
});

test('a reading is projected and stored where the screen looks for it', async () => {
  const { transport } = graph({
    'group-platform': { direct: ['oid-a'], transitive: ['oid-a', 'oid-b'] },
    'group-developer': { direct: ['oid-c'], transitive: ['oid-c'] },
  });
  const { store, run } = projectorWith({
    readPublishedSnapshots: published,
    readGovernedDirectory: createEntraDirectoryQuery({ createCredential, deriveDirectoryCode: code, transport }),
  });

  const result = await run();
  assert.equal(result.outcome, 'projected');
  assert.equal(result.completeness, 'complete');
  assert.equal(result.groups, 2);
  assert.equal(result.users, 3);

  const stored = await store.readDirectorySnapshot({ scopeGroupId: SCOPE_GROUP_ID });
  assert.equal(stored.document.configurationVersion, 'entitlement-4');
  assert.equal(stored.document.groups.length, 2);
});

test('which groups are governed comes from the published set, never from the tenant', async () => {
  // Without a published set there is no list of governed groups, and reading every
  // group in the directory instead would be a wider question than governance asked.
  const { run } = projectorWith({
    readPublishedSnapshots: async () => {
      throw Object.assign(new Error('unavailable'), { reasonCode: 'published-policy-source-incomplete' });
    },
    readGovernedDirectory: async () => assert.fail('the directory must not be read'),
  });

  assert.deepEqual(await run(), {
    outcome: 'skipped',
    reasonCode: 'published-policy-source-incomplete',
    at: NOW,
  });
});

test('an unreadable directory leaves the previous reading in place to age', async () => {
  const { transport } = graph({
    'group-platform': { direct: ['oid-a'], transitive: ['oid-a'] },
    'group-developer': { direct: [], transitive: [] },
  });
  const store = createInMemoryGovernanceStore();
  await projectorWith({
    store,
    readPublishedSnapshots: published,
    readGovernedDirectory: createEntraDirectoryQuery({ createCredential, deriveDirectoryCode: code, transport }),
  }).run();
  const before = await store.readDirectorySnapshot({ scopeGroupId: SCOPE_GROUP_ID });

  const result = await projectorWith({
    store,
    readPublishedSnapshots: published,
    readGovernedDirectory: async () => {
      throw Object.assign(new Error('directory-read-failed'), { code: 'directory-read-failed' });
    },
  }).run();

  assert.equal(result.outcome, 'unavailable');
  const after = await store.readDirectorySnapshot({ scopeGroupId: SCOPE_GROUP_ID });
  assert.deepEqual(after.document.groups, before.document.groups);
});

test('the projector refuses to be built without what it needs', () => {
  const store = createInMemoryGovernanceStore();
  const args = {
    store,
    readPublishedSnapshots: published,
    readGovernedDirectory: async () => ({}),
    clock,
    scopeGroupId: SCOPE_GROUP_ID,
  };
  for (const missing of ['store', 'readPublishedSnapshots', 'readGovernedDirectory', 'clock', 'scopeGroupId']) {
    assert.throws(() => createScheduledDirectoryProjector({ ...args, [missing]: undefined }), TypeError, missing);
  }
});
