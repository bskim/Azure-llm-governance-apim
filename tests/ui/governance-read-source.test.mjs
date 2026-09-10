import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertGovernanceReadSource,
  GOVERNANCE_READ_SOURCE_CAPABILITIES,
  GOVERNANCE_READ_SOURCE_METHODS,
} from '../../app/control-api/governance-read-source.mjs';
import { createLocalGovernanceSource } from '../../app/control-api/local-governance-source.mjs';

const EVALUATION_TIME = '2026-07-24T10:00:00.000Z';
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const routingFile = path.resolve(moduleDirectory, '..', '..', 'app', 'control-api', 'local-admin-server.mjs');

function localSource() {
  return createLocalGovernanceSource({ evaluationTime: EVALUATION_TIME });
}

test('the development source satisfies the contract it declares', () => {
  const source = localSource();
  assert.equal(assertGovernanceReadSource(source), source);
  assert.deepEqual(source.describe(), { sourceKind: 'development', durability: 'ephemeral' });
});

test('a source missing any single method is refused', () => {
  for (const method of GOVERNANCE_READ_SOURCE_METHODS) {
    const partial = { ...localSource() };
    delete partial[method];
    assert.throws(
      () => assertGovernanceReadSource(partial),
      (error) => error instanceof TypeError && error.message.includes(method),
      `omitting ${method} must be refused`,
    );
  }
});

test('a source missing any single capability is refused', () => {
  for (const capability of GOVERNANCE_READ_SOURCE_CAPABILITIES) {
    const source = localSource();
    const capabilities = { ...source.capabilities };
    delete capabilities[capability];
    assert.throws(
      () => assertGovernanceReadSource({ ...source, capabilities }),
      (error) => error instanceof TypeError && error.message.includes(capability),
      `omitting ${capability} must be refused`,
    );
  }
});

test('a capability declared as an empty list is refused, because it offers nothing', () => {
  const source = localSource();
  assert.throws(
    () => assertGovernanceReadSource({ ...source, capabilities: { ...source.capabilities, overviewFixtures: [] } }),
    (error) => error instanceof TypeError,
  );
});

test('a source must say what kind it is and whether it survives a restart', () => {
  const source = localSource();
  for (const described of [undefined, {}, { sourceKind: 'fixtures', durability: 'durable' }, { sourceKind: 'stored' }]) {
    assert.throws(
      () => assertGovernanceReadSource({ ...source, describe: () => described }),
      (error) => error instanceof TypeError,
      `describe() returning ${JSON.stringify(described)} must be refused`,
    );
  }
});

test('the routing file reaches governance data only through the source', async () => {
  // The seam exists so that later work migrating a screen to a store edits its own
  // source rather than this file. An import that reaches around it removes that.
  const routing = await readFile(routingFile, 'utf8');
  const dataImports = [...routing.matchAll(/from '\.\.\/local-adapters\/([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    dataImports,
    ['deterministic-time.mjs'],
    'the only permitted adapter import is the request-id sequence, which carries no governance data',
  );
});

test('the widened entitlement is a view of the same fixture, and is not the default', () => {
  const source = localSource();
  const asShipped = source.readGovernanceSnapshots();
  const widened = source.readGovernanceSnapshots({ entitlementView: 'both-models' });

  const globalAllowlist = (snapshots) =>
    snapshots.entitlementSnapshot.bindings.find((binding) => binding.target.kind === 'global')
      ?.modelAllowlist ?? [];

  assert.equal(globalAllowlist(asShipped).length, 1, 'the shipped fixture withholds the cheaper model');
  assert.deepEqual(globalAllowlist(widened), ['coding-fast', 'coding-primary']);
  assert.deepEqual(
    globalAllowlist(source.readGovernanceSnapshots()),
    globalAllowlist(asShipped),
    'widening one read must not change the next one',
  );
});

test('every declared capability names something the source can actually produce', () => {
  const source = localSource();
  for (const fixtureName of source.capabilities.overviewFixtures) {
    // Two of the overview fixtures exist to be refused by the route rather than read.
    if (['error', 'denied'].includes(fixtureName)) continue;
    assert.ok(
      source.readOverview({ fixtureName, scope: 'global', teamKey: 'platform-engineering' }),
      fixtureName,
    );
  }
  for (const fixtureName of source.capabilities.usersGroupsFixtures) {
    if (['error', 'denied'].includes(fixtureName)) continue;
    assert.ok(source.readUsersGroups({ fixtureName }), fixtureName);
  }
  for (const entitlementView of source.capabilities.entitlementViews) {
    assert.ok(source.readGovernanceSnapshots({ entitlementView }).entitlementSnapshot, entitlementView);
  }
});

test('an evaluation time is required, because every fixture is read relative to one', () => {
  for (const evaluationTime of [undefined, '', 'yesterday', 42]) {
    assert.throws(
      () => createLocalGovernanceSource({ evaluationTime }),
      (error) => error instanceof TypeError,
    );
  }
});
