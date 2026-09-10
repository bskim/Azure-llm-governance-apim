import assert from 'node:assert/strict';
import test from 'node:test';

import { readFoundryModelPrices, MAX_PAGES } from '../../app/providers/foundry-price-query.mjs';

function retailItem(overrides = {}) {
  return {
    meterName: '5.4 mini Inp glbl',
    productName: 'Azure OpenAI Foundry Models',
    retailPrice: 0.15,
    currencyCode: 'USD',
    unitOfMeasure: '1M',
    armRegionName: 'eastus2',
    effectiveStartDate: '2026-07-01T00:00:00Z',
    // A field the projection must not carry through untouched.
    skuName: 'not-a-projected-field',
    meterId: 'ignored-meter-id',
    ...overrides,
  };
}

function page(items, nextPageLink = null) {
  return { Items: items, NextPageLink: nextPageLink, Count: items.length };
}

test('reads a single page and projects only the fields a price decision needs', async () => {
  const calls = [];
  const transport = async (url) => {
    calls.push(url);
    return page([retailItem()]);
  };

  const result = await readFoundryModelPrices({ region: 'eastus2', transport });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/prices\.azure\.com\/api\/retail\/prices\?\$filter=/);
  // The filter is URL-encoded; decode it to check the two clauses are both present.
  const decodedFilter = decodeURIComponent(calls[0].split('$filter=')[1]);
  assert.match(decodedFilter, /serviceName eq 'Foundry Models'/);
  assert.match(decodedFilter, /armRegionName eq 'eastus2'/);

  assert.equal(result.region, 'eastus2');
  assert.equal(result.truncated, false);
  assert.equal(result.pagesRead, 1);
  assert.equal(result.meters.length, 1);
  assert.deepEqual(
    Object.keys(result.meters[0]).sort(),
    ['armRegionName', 'currencyCode', 'effectiveStartDate', 'meterName', 'productName', 'retailPrice', 'unitOfMeasure'].sort(),
  );
  assert.equal(result.meters[0].meterName, '5.4 mini Inp glbl');
  assert.equal(Object.hasOwn(result.meters[0], 'skuName'), false);
  assert.equal(Object.hasOwn(result.meters[0], 'meterId'), false);
});

test('follows NextPageLink until the provider reports no further page', async () => {
  let call = 0;
  const transport = async () => {
    call += 1;
    if (call === 1) {
      return page([retailItem({ meterName: 'page-one' })], 'https://prices.azure.com/api/retail/prices?$skiptoken=1');
    }
    return page([retailItem({ meterName: 'page-two' })], null);
  };

  const result = await readFoundryModelPrices({ region: 'eastus2', transport });

  assert.equal(call, 2);
  assert.equal(result.pagesRead, 2);
  assert.deepEqual(result.meters.map((meter) => meter.meterName), ['page-one', 'page-two']);
  assert.equal(result.truncated, false);
});

test('a runaway NextPageLink is reported as truncation, not read as a complete answer', async () => {
  let call = 0;
  const transport = async () => {
    call += 1;
    return page([retailItem({ meterName: `page-${call}` })], 'https://prices.azure.com/api/retail/prices?$skiptoken=next');
  };

  const result = await readFoundryModelPrices({ region: 'eastus2', transport });

  assert.equal(call, MAX_PAGES);
  assert.equal(result.pagesRead, MAX_PAGES);
  assert.equal(result.meters.length, MAX_PAGES);
  assert.equal(result.truncated, true);
});

test('a region shaped to smuggle a second filter clause is refused before any request is sent', async () => {
  let called = false;
  const transport = async () => {
    called = true;
    return page([]);
  };

  await assert.rejects(
    () => readFoundryModelPrices({ region: "eastus2' or 1 eq 1", transport }),
    TypeError,
  );
  assert.equal(called, false);
});

test('an empty or mixed-case region is refused the same way', async () => {
  await assert.rejects(() => readFoundryModelPrices({ region: '', transport: async () => page([]) }), TypeError);
  await assert.rejects(() => readFoundryModelPrices({ region: 'EastUS2', transport: async () => page([]) }), TypeError);
});

test('an omitted transport is a caller error, not a silent network call', async () => {
  await assert.rejects(() => readFoundryModelPrices({ region: 'eastus2', transport: null }), TypeError);
});
