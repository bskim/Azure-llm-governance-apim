/**
 * The published meters for a deployment, as reference and never as a rate.
 *
 * This product does not carry a price. Azure publishes a model's meters split across
 * context length, cache read and write, batch and provisioned capacity, and global or
 * data-zone placement, and which one applies is decided by the request rather than by
 * the model; collapsing that into one number was the thing this replaced. So the
 * meters are shown as published, and what a period actually cost is answered by Azure
 * Billing.
 *
 * The match is stated rather than assumed. A meter belongs to a deployment when the
 * name left after removing the billing words equals the deployment's model name, so
 * `gpt-5.4` does not pick up `5.4 mini` and `gpt-4.1` does not pick up `4.1 nano`.
 * Where the account's own placement has no meters the others are still shown, labelled
 * as not the deployment's placement, because withholding them would leave the screen
 * emptier than the price list is.
 */

// Words Azure appends to say how a meter is billed. Everything else is the model's own
// name, which is what keeps mini, nano, pro and the named variants apart.
const BILLING_WORDS = new Set([
  'inp', 'inpt', 'input', 'opt', 'outp', 'outpt', 'output', 'tokens', 'token',
  'cd', 'cchd', 'cache', 'cached', 'ch', 'wr', 'std',
  'gl', 'glbl', 'global', 'dz', 'dzone', 'datazone', 'regnl', 'rgnl', 'regional', 'regn',
  'shortco', 'longco', '1m', '1k',
]);

// Not the path this gateway serves: batch submission, provisioned capacity, and
// fine-tuning together with the hosting it is billed under.
const NOT_SERVED = new Set(['batch', 'pp', 'prov', 'ft', 'hosting', 'training', 'unit']);

const PLACEMENT_WORDS = Object.freeze({
  GlobalStandard: new Set(['gl', 'glbl', 'global']),
  DataZoneStandard: new Set(['dz', 'dzone', 'datazone']),
  Standard: new Set(['regnl', 'rgnl', 'regional', 'regn']),
});

// The publisher prefixes its own meters and the deployment name may carry the same
// word, so one is compared with and without it rather than guessing which side has it.
const VENDOR_PREFIX = /^(gpt|fw)/;

export const PRICE_REFERENCE_MATCHES = Object.freeze(['exact', 'closest', 'not-found']);

function fail(message) {
  throw new TypeError(message);
}

function flatten(value) {
  return (value ?? '').toLowerCase().replaceAll(/[^a-z0-9.]/g, '');
}

function wordsOf(value) {
  return (value ?? '')
    .toLowerCase()
    .split(/[\s-]+/)
    .map((word) => word.replaceAll(/[^a-z0-9.]/g, ''))
    .filter((word) => word.length > 0);
}

function baseNameOf(words) {
  return flatten(words.filter((word) => !BILLING_WORDS.has(word)).join(''));
}

function projectRow(meter) {
  return Object.freeze({
    meterName: meter.meterName,
    retailPrice: meter.retailPrice,
    currencyCode: meter.currencyCode,
    unitOfMeasure: meter.unitOfMeasure,
    armRegionName: meter.armRegionName,
  });
}

/**
 * @param modelName - the provider's own model name for the deployment, not the alias
 *   this product routes on: the meters are named after the model, not the deployment.
 * @param skuName - the deployment's SKU, which decides which placement's meters are
 *   the deployment's own.
 * @param meters - the projection `readFoundryModelPrices` returns.
 */
export function referencePricesFor({ modelName, skuName, meters } = {}) {
  if (typeof modelName !== 'string' || modelName.length === 0) fail('modelName is required.');
  if (typeof skuName !== 'string' || skuName.length === 0) fail('skuName is required.');
  if (!Array.isArray(meters)) fail('meters must be an array.');

  const wanted = flatten(modelName);
  const withoutVendor = wanted.replace(VENDOR_PREFIX, '');
  const placement = PLACEMENT_WORDS[skuName] ?? new Set();

  const named = [];
  for (const meter of meters) {
    const words = wordsOf(meter.meterName);
    if (words.some((word) => NOT_SERVED.has(word))) continue;
    const base = baseNameOf(words);
    if (base !== wanted && base !== withoutVendor && base !== `fw${withoutVendor}`) continue;
    named.push({ meter, onPlacement: words.some((word) => placement.has(word)) });
  }

  const onPlacement = named.filter((entry) => entry.onPlacement);
  const chosen = onPlacement.length > 0 ? onPlacement : named;
  const match = onPlacement.length > 0 ? 'exact' : named.length > 0 ? 'closest' : 'not-found';

  return Object.freeze({
    match,
    rows: Object.freeze(
      chosen
        .map((entry) => projectRow(entry.meter))
        .sort((left, right) => left.meterName.localeCompare(right.meterName)),
    ),
  });
}
