/**
 * A deterministic slice of the published price list for local development.
 *
 * The live list is well over a thousand meters and changes without notice, so the one
 * thing a local run cannot do is show what the price section looks like. These rows are
 * shaped and named as the live eastus2 list names them, and are read by the same
 * `referencePricesFor`, so what the screen renders here is what the matching rule
 * actually produces rather than a picture of it.
 *
 * The three states are all present on purpose: one deployment's own placement is
 * published, one has meters only for another placement, and one has none at all. So are
 * the two exclusions -- a neighbouring model whose name merely starts the same way, and
 * a batch meter for a path this gateway does not serve -- because a rule that only ever
 * runs against agreeable data is not a rule anybody has seen work.
 */

function meter(meterName, retailPrice) {
  return Object.freeze({
    meterName,
    productName: 'Azure AI Foundry Models',
    retailPrice,
    currencyCode: 'USD',
    unitOfMeasure: '1M',
    armRegionName: 'eastus2',
    effectiveStartDate: '2026-05-01T00:00:00Z',
  });
}

const ROWS = Object.freeze([
  meter('Coding Fast Inp Gl 1M Tokens', 0.75),
  meter('Coding Fast Opt Gl 1M Tokens', 4.5),
  meter('Coding Fast cd Inp Gl 1M Tokens', 0.075),
  // Named after a different model. Its base name is `codingfastmini`, so it belongs to
  // no deployment here -- this is the row that would be wrongly adopted if the match
  // were a prefix rather than an equality.
  meter('Coding Fast Mini Inp Gl 1M Tokens', 0.2),
  // Batch submission is not the path this gateway serves, so it is dropped even though
  // the name matches exactly.
  meter('Coding Fast Batch Inp Gl 1M Tokens', 0.375),
  // Published only for the data-zone placement while the deployment is global, which is
  // what the screen labels as not this deployment's own placement.
  meter('Coding Primary Inp DZ 1M Tokens', 2.5),
  meter('Coding Primary Opt DZ 1M Tokens', 15),
]);

export function getDeterministicModelPrices() {
  return { region: 'eastus2', truncated: false, meters: ROWS };
}
