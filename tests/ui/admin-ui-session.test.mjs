import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSessionContract,
  createLocalSession,
  loadSession,
  readSessionConfig,
} from '../../app/admin-ui/public/session.mjs';

test('the local session carries no credential and claims none', async () => {
  const session = assertSessionContract(createLocalSession());

  assert.equal(session.mode, 'local');
  assert.deepEqual(await session.getAuthorizationHeader(), {});
  assert.deepEqual(session.describe(), { mode: 'local', signedIn: false, name: null });
  await session.signIn();
  await session.signOut();
});

test('an absent or unreadable configuration means local rather than broken', async () => {
  const responses = [
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ mode: 'something-else' }) }),
    async () => {
      throw new Error('offline');
    },
  ];

  for (const fetchImpl of responses) {
    assert.deepEqual(await readSessionConfig(fetchImpl), { mode: 'local' });
  }
});

test('a deployment configuration is passed through intact', async () => {
  const config = {
    mode: 'entra',
    clientId: 'client-0000',
    authority: 'https://login.example.invalid/tenant',
    scope: 'api://resource/Governance.Access',
    apiBaseUrl: 'https://control-plane.example.invalid',
  };

  assert.deepEqual(await readSessionConfig(async () => ({ ok: true, json: async () => config })), config);
});

test('the authentication library is loaded only when a deployment asks for it', async () => {
  let loaded = 0;
  const importVendor = async () => {
    loaded += 1;
    return { createEntraSession: () => createLocalSession() };
  };

  await loadSession({ mode: 'local' }, importVendor);
  assert.equal(loaded, 0);

  await loadSession({ mode: 'entra' }, importVendor);
  assert.equal(loaded, 1);
});

test('a replacement that does not meet the contract is refused at load', async () => {
  await assert.rejects(
    () => loadSession({ mode: 'entra' }, async () => ({ createEntraSession: () => ({ mode: 'custom' }) })),
    TypeError,
  );
  assert.throws(() => assertSessionContract({ ...createLocalSession(), mode: '' }), TypeError);
});

test('the contract is the whole surface an organization has to implement', () => {
  const session = createLocalSession();

  assert.deepEqual(
    Object.keys(session).sort(),
    ['describe', 'getAuthorizationHeader', 'mode', 'signIn', 'signOut'],
  );
});

test('a deployment says which screens it serves, and the default is the one that exists', async () => {
  const withScreens = await readSessionConfig(async () => ({
    ok: true,
    json: async () => ({ mode: 'entra', clientId: 'c', authority: 'a', scope: 's', screens: ['overview'] }),
  }));

  assert.deepEqual(withScreens.screens, ['overview']);
  // A configuration that names none is not a configuration that serves all.
  const withoutScreens = await readSessionConfig(async () => ({
    ok: true,
    json: async () => ({ mode: 'entra', clientId: 'c', authority: 'a', scope: 's' }),
  }));
  assert.equal(withoutScreens.screens, undefined);
});
