import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelPricesHandler } from '../../app/functions/handlers/admin-model-prices.mjs';

const AUDIENCE = 'api://control-plane';
const clock = { nowIso: () => '2026-07-24T10:00:00.000Z' };
const invocation = { invocationId: 'invocation-1', error: () => {}, warn: () => {} };

function requestWith({ roles = ['Governance.Administer'] } = {}) {
  const principal = {
    auth_typ: 'aad',
    role_typ: 'roles',
    claims: [{ typ: 'aud', val: AUDIENCE }, ...roles.map((role) => ({ typ: 'roles', val: role }))],
  };
  const headers = new Map([
    ['x-ms-client-principal', Buffer.from(JSON.stringify(principal), 'utf8').toString('base64')],
  ]);
  return { headers: { get: (name) => headers.get(name.toLowerCase()) ?? null } };
}

const DEPLOYMENTS = {
  deployments: [
    { deploymentName: 'deploy-swift', modelName: 'coding-swift', skuName: 'GlobalStandard' },
    { deploymentName: 'deploy-quiet', modelName: 'never-published', skuName: 'GlobalStandard' },
  ],
};

const METERS = {
  meters: [
    {
      meterName: 'coding swift Inp Gl 1M Tokens',
      retailPrice: 2.5,
      currencyCode: 'USD',
      unitOfMeasure: '1M',
      armRegionName: 'eastus2',
    },
    {
      meterName: 'coding swift Batch Inp Gl 1M Tokens',
      retailPrice: 1.25,
      currencyCode: 'USD',
      unitOfMeasure: '1M',
      armRegionName: 'eastus2',
    },
  ],
};

function handlerFor(overrides = {}) {
  return createModelPricesHandler({
    readProviderDeployments: async () => DEPLOYMENTS,
    readModelPrices: async () => METERS,
    region: 'eastus2',
    expectedAudience: AUDIENCE,
    clock,
    ...overrides,
  });
}

test('every deployment is answered, and says how its meters were found', async () => {
  const response = await handlerFor()(requestWith(), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'model-prices.v1');
  // Stated on the answer: what a period actually cost is not this product's to say.
  assert.equal(response.jsonBody.authority, 'azure-billing');

  const [quiet, swift] = response.jsonBody.deployments;
  assert.equal(swift.deploymentName, 'deploy-swift');
  assert.equal(swift.match, 'exact');
  assert.deepEqual(swift.rows.map((row) => row.meterName), ['coding swift Inp Gl 1M Tokens']);

  // A deployment the region publishes nothing for is present and named, so an empty
  // list is never left to read as free.
  assert.equal(quiet.deploymentName, 'deploy-quiet');
  assert.equal(quiet.match, 'not-found');
  assert.deepEqual(quiet.rows, []);
});

test('a price list that cannot be reached is reported, not answered as no meters', async () => {
  const response = await handlerFor({
    readModelPrices: async () => {
      throw new Error('network-refused');
    },
  })(requestWith(), invocation);

  assert.equal(response.status, 503);
});

test('reading the reference needs the read capability and nothing more', async () => {
  const reader = await handlerFor()(requestWith({ roles: ['Governance.Read'] }), invocation);
  assert.equal(reader.status, 200);

  const stranger = await handlerFor()(requestWith({ roles: [] }), invocation);
  assert.equal(stranger.status, 403);
});

test('the route refuses to be built without a source for either half', () => {
  assert.throws(
    () => createModelPricesHandler({ readModelPrices: async () => METERS, expectedAudience: AUDIENCE, clock }),
    TypeError,
  );
  assert.throws(
    () => createModelPricesHandler({ readProviderDeployments: async () => DEPLOYMENTS, expectedAudience: AUDIENCE, clock }),
    TypeError,
  );
});
