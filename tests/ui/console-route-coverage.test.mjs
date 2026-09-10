import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/**
 * A screen the console offers has to reach something the deployment serves.
 *
 * The notifications screen existed, its read model existed, and its route did not:
 * the console simply never offered it, so a finding could be raised, retried and
 * exhausted with no way for anyone to see it. Nothing failed, which is why nothing
 * reported it.
 */

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

// The route a deployment would serve for each screen, keyed by screen. The client
// builds its live map from this by keeping only the screens the deployment declares,
// so this table is the naming convention and `screens` in the builder is the claim.
function deployedPaths(source) {
  const table = source.match(/const DEPLOYED_SCREEN_PATHS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(table, 'the client must name the route each screen would use');
  return Object.fromEntries(
    [...table[1].matchAll(/'?([\w-]+)'?:\s*'(\/api\/v1\/admin\/[^']*)'/g)].map(
      ([, screen, path]) => [screen, path],
    ),
  );
}

// Routes the client asks for that belong to no screen.
function auxiliaryPaths(source) {
  return Object.fromEntries(
    [...source.matchAll(/(\w+Path):\s*'(\/api\/v1\/admin\/[^']*)'/g)].map(([, name, path]) => [name, path]),
  );
}

function screenPathNames(source) {
  const screens = source.slice(source.indexOf('const SCREENS = '));
  return Object.fromEntries(
    [...screens.matchAll(/^ {2}'?([\w-]+)'?:\s*Object\.freeze\(\{[\s\S]*?path:\s*'(\w+Path)'/gm)].map(
      ([, screen, name]) => [screen, name],
    ),
  );
}

function registeredRoutes(source) {
  return new Set([...source.matchAll(/route:\s*'([^']+)'/g)].map(([, route]) => `/api/${route}`));
}

function offeredScreens(source) {
  const declared = source.match(/screens:\s*\[([^\]]*)\]/);
  assert.ok(declared, 'the console build must declare which screens a deployment offers');
  return [...declared[1].matchAll(/'([\w-]+)'/g)].map(([, screen]) => screen);
}

test('every screen the deployment offers can reach a route the host registers', async () => {
  const [client, builder, host] = await Promise.all([
    read('app/admin-ui/public/app.mjs'),
    read('tools/build-admin-ui.mjs'),
    read('app/functions/index.mjs'),
  ]);

  const paths = deployedPaths(client);
  const names = screenPathNames(client);
  const routes = registeredRoutes(host);
  const screens = offeredScreens(builder);

  assert.ok(screens.length > 0, 'a deployment that offers no screen has no console');
  for (const screen of screens) {
    assert.ok(names[screen], `${screen} must be a screen the client knows`);
    assert.ok(paths[screen], `${screen} must have a deployed path`);
    assert.ok(routes.has(paths[screen]), `${screen} is offered but ${paths[screen]} is not registered`);
  }
});

test('a screen whose route the host does not register is not offered', async () => {
  // The other direction: the console must not present a screen that would fail.
  const [client, builder, host] = await Promise.all([
    read('app/admin-ui/public/app.mjs'),
    read('tools/build-admin-ui.mjs'),
    read('app/functions/index.mjs'),
  ]);

  const paths = deployedPaths(client);
  const routes = registeredRoutes(host);
  const offered = new Set(offeredScreens(builder));

  // Against the REAL data: nothing offered may be unserved. Checking this alone can
  // go vacuous once the deployment happens to serve every screen it offers, which is
  // exactly the state this repository reached — there is nothing left to iterate.
  const unservedReal = Object.keys(paths).filter((screen) => paths[screen] && !routes.has(paths[screen]));
  for (const screen of unservedReal) {
    assert.ok(!offered.has(screen), `${screen} has no route, so the console must not offer it`);
  }

  // So the rule itself is probed instead of relying on the real data to still contain
  // a gap: take a COPY of the registered routes, remove one offered screen's route
  // from it, and require the rule to flag exactly that screen as offered-but-unserved.
  // This keeps the check falsifiable no matter how complete the deployment becomes.
  const [probeScreen] = [...offered].filter((screen) => paths[screen]);
  assert.ok(probeScreen, 'need an offered screen with a deployed path to probe the rule with');

  const probedRoutes = new Set(routes);
  probedRoutes.delete(paths[probeScreen]);

  const unservedUnderProbe = Object.keys(paths)
    .filter((screen) => paths[screen] && !probedRoutes.has(paths[screen]));
  assert.ok(unservedUnderProbe.includes(probeScreen), 'removing a route must surface its screen as unserved');

  const violations = unservedUnderProbe.filter((screen) => offered.has(screen));
  assert.ok(violations.includes(probeScreen), `${probeScreen} must be caught as offered-but-unserved`);
});

test('the acknowledgement the notifications screen offers is a route that exists', async () => {
  const [client, host] = await Promise.all([
    read('app/admin-ui/public/app.mjs'),
    read('app/functions/index.mjs'),
  ]);

  const { acknowledgePath } = auxiliaryPaths(client);
  assert.ok(acknowledgePath, 'a deployment must have somewhere to send an acknowledgement');
  assert.ok(registeredRoutes(host).has(acknowledgePath), `${acknowledgePath} is not registered`);
});

test('the published meters the models screen offers are a route that exists', async () => {
  // It belongs to no screen's own reading on purpose: the price list is a paged source
  // of well over a thousand meters and nothing enforces it, so it is asked for only
  // when a reader opens the section. That still has to be somewhere the host answers.
  const [client, host] = await Promise.all([
    read('app/admin-ui/public/app.mjs'),
    read('app/functions/index.mjs'),
  ]);

  const { modelPricesPath } = auxiliaryPaths(client);
  assert.ok(modelPricesPath, 'the console must name where the published meters are read from');
  assert.ok(registeredRoutes(host).has(modelPricesPath), `${modelPricesPath} is not registered`);
});

test('the console does not name the actor a deployment takes from the token', async () => {
  // A body that carried an actor code would let the screen sign a name it has no
  // standing to claim, and the deployed handler would have to choose which to trust.
  const client = await read('app/admin-ui/public/app.mjs');
  const call = client.slice(client.indexOf('async function acknowledgeNotification'));
  const body = call.slice(0, call.indexOf('});'));

  assert.match(body, /session\.mode === 'local'/, 'the actor code must be local-only');
  assert.ok(!/^\s*body: JSON\.stringify\(\{ key, actorCode/m.test(body));
});
