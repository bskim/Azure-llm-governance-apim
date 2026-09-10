import assert from 'node:assert/strict';
import test from 'node:test';

import { referencePricesFor } from '../../app/governance-domain/registry/price-reference.mjs';

// Shaped as the live eastus2 list names them, including the spellings that differ
// between publishers and between generations of the same publisher.
function meter(meterName, retailPrice, overrides = {}) {
  return {
    meterName,
    retailPrice,
    currencyCode: 'USD',
    unitOfMeasure: '1M',
    armRegionName: 'eastus2',
    ...overrides,
  };
}

const LIVE = [
  meter('5.4 inp Gl 1M Tokens', 2.5),
  meter('5.4 opt Gl 1M Tokens', 15),
  meter('5.4 cd inp Gl 1M Tokens', 0.25),
  meter('5.4 longco inp Gl 1M Tokens', 5),
  meter('5.4 mini Inp Gl 1M Tokens', 0.75),
  meter('5.4 mini Opt Gl 1M Tokens', 4.5),
  meter('5.4 nano Inp Gl 1M Tokens', 0.2),
  meter('5.4 pro inp Gl 1M Tokens', 30),
  meter('5.4 Batch inp Gl 1M Tokens', 1.25),
  meter('gpt-4.1-ft input regional Tokens', 0.0022, { unitOfMeasure: '1K' }),
  meter('gpt-4.1-ft hosting regional Unit', 1.7, { unitOfMeasure: '1 Hour' }),
  meter('FW Kimi K2.6 Inp DZ Tokens', 0.001045, { unitOfMeasure: '1K' }),
  meter('FW Kimi K2.6 Outp DZ Tokens', 0.0044, { unitOfMeasure: '1K' }),
];

test('a deployment gets the meters named after its own model and no relative of it', () => {
  const { match, rows } = referencePricesFor({
    modelName: 'gpt-5.4',
    skuName: 'GlobalStandard',
    meters: LIVE,
  });

  assert.equal(match, 'exact');
  assert.deepEqual(
    rows.map((row) => row.meterName).sort(),
    ['5.4 cd inp Gl 1M Tokens', '5.4 inp Gl 1M Tokens', '5.4 longco inp Gl 1M Tokens', '5.4 opt Gl 1M Tokens'],
  );
});

test('a variant is its own model, so mini does not answer for the model it is named after', () => {
  const { rows } = referencePricesFor({
    modelName: 'gpt-5.4-mini',
    skuName: 'GlobalStandard',
    meters: LIVE,
  });

  assert.deepEqual(
    rows.map((row) => row.meterName),
    ['5.4 mini Inp Gl 1M Tokens', '5.4 mini Opt Gl 1M Tokens'],
  );
});

test('batch, provisioned and fine-tuning meters are not this gateway to bill', () => {
  const { rows } = referencePricesFor({
    modelName: 'gpt-5.4',
    skuName: 'GlobalStandard',
    meters: LIVE,
  });
  assert.equal(rows.some((row) => /batch/i.test(row.meterName)), false);

  const fineTuned = referencePricesFor({
    modelName: 'gpt-4.1',
    skuName: 'Standard',
    meters: LIVE,
  });
  assert.equal(fineTuned.match, 'not-found');
  assert.deepEqual(fineTuned.rows, []);
});

test('meters published only under another placement are shown, and said to be that', () => {
  // The account's Kimi deployment is GlobalStandard while its meters are published
  // data-zone. Withholding them would leave the screen emptier than the price list.
  const { match, rows } = referencePricesFor({
    modelName: 'Kimi-K2.6',
    skuName: 'GlobalStandard',
    meters: LIVE,
  });

  assert.equal(match, 'closest');
  assert.equal(rows.length, 2);
});

test('a model the region publishes nothing for is not-found rather than empty and unexplained', () => {
  const { match, rows } = referencePricesFor({
    modelName: 'grok-4.3',
    skuName: 'GlobalStandard',
    meters: LIVE,
  });

  assert.equal(match, 'not-found');
  assert.deepEqual(rows, []);
});

test('the reading is refused rather than answered from nothing', () => {
  assert.throws(() => referencePricesFor({ modelName: '', skuName: 'GlobalStandard', meters: [] }), TypeError);
  assert.throws(() => referencePricesFor({ modelName: 'gpt-5.4', skuName: '', meters: [] }), TypeError);
  assert.throws(() => referencePricesFor({ modelName: 'gpt-5.4', skuName: 'GlobalStandard', meters: null }), TypeError);
});
