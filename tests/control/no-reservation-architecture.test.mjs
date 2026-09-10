import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createGovernanceStore } from '../../app/persistence/cosmos-governance-store.mjs';
import { OUTCOMES, EXCHANGE_STATES } from '../../app/governance-domain/usage/usage-record-validator.mjs';

/**
 * `ADR-0007` put money owed out of scope and `ADR-0002` removed reservation and
 * settlement, so a request is admitted on what has already been counted rather than on
 * capacity held for it. That is an absence, and an absence nobody checks comes back:
 * the shape is easy to reach for the moment somebody wants an exact cap.
 *
 * Vocabulary alone cannot express this — the product legitimately says "settle" for
 * applying changes to a notification and "reserved" in prose. What a reservation
 * actually needs is somewhere to hold the claim and a state to hold it in, so those two
 * places are what this checks.
 */

const HOLDING_VERBS = ['reserve', 'unreserve', 'settle', 'release', 'commit', 'hold', 'compensate', 'refund'];

function operationsOf(store) {
  const names = [];
  for (let layer = store; layer && layer !== Object.prototype; layer = Object.getPrototypeOf(layer)) {
    for (const name of Object.getOwnPropertyNames(layer)) {
      if (typeof store[name] === 'function') names.push(name);
    }
  }
  return [...new Set(names)];
}

function holdingOperations(names) {
  return names.filter((name) => HOLDING_VERBS.some((verb) => name.toLowerCase().startsWith(verb)));
}

test('neither store offers anywhere to hold a claim against a request', () => {
  // The detector is checked against a surface that does have one, so a green result
  // means it looked rather than that it matched nothing.
  assert.deepEqual(holdingOperations(['readRollup', 'reserveTokens', 'settleUsage']), ['reserveTokens', 'settleUsage']);

  const inMemory = operationsOf(createInMemoryGovernanceStore());
  // Constructed against a client that is never called: the surface is what is being
  // checked, not a round trip.
  const cosmos = operationsOf(createGovernanceStore({
    client: { database: () => ({ container: () => ({}) }) },
    databaseId: 'governance',
  }));

  assert.ok(inMemory.length > 20, 'the in-memory store surface was not read');
  assert.ok(cosmos.length > 20, 'the Cosmos store surface was not read');
  assert.deepEqual(holdingOperations(inMemory), []);
  assert.deepEqual(holdingOperations(cosmos), []);

  // Both stores must expose the same surface, or one of them could grow the operation
  // the other refuses to have.
  assert.deepEqual([...inMemory].sort(), [...cosmos].sort());
});

test('a usage record has no state between requested and counted', () => {
  for (const outcome of OUTCOMES) assert.ok(!HOLDING_VERBS.some((verb) => outcome.startsWith(verb)));
  for (const state of EXCHANGE_STATES) assert.ok(!HOLDING_VERBS.some((verb) => state.startsWith(verb)));

  // A record describes a request that already happened. `reserved` or `pending` would
  // mean capacity was taken from somebody before anything was served, which is the
  // subsystem both decisions removed.
  assert.deepEqual([...OUTCOMES].sort(), ['failed', 'refused', 'served']);
  assert.deepEqual([...EXCHANGE_STATES].sort(), ['abandoned', 'complete', 'failed']);
});
