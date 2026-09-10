/**
 * Reads the public Azure Retail Prices API for Foundry Models meters.
 *
 * The endpoint takes no credential, so the thing to guard against is not an
 * unauthorised caller but an authorised one smuggling something extra into the
 * request. `region` is the one value this module accepts from outside, and it is
 * folded straight into an OData `$filter` string; a value like
 * `eastus2' or 1 eq 1` would rewrite the query rather than merely naming a region,
 * and an unvalidated path segment would do the same to the URL. `region` is
 * therefore checked against a narrow shape BEFORE it is used anywhere.
 *
 * Nothing here mutates, and the transport is injected so a test never touches the
 * network, exactly as `foundry-quota-query.mjs` does.
 */

const RETAIL_PRICES_ENDPOINT = 'https://prices.azure.com/api/retail/prices';
const SERVICE_NAME = 'Foundry Models';

// Real Azure ARM region names are lower-case letters and digits only (`eastus2`,
// `westus3`). Anything else cannot be a region and is refused rather than encoded,
// because encoding a malformed value would still deliver it, just percent-escaped.
const REGION = /^[a-z][a-z0-9]{1,63}$/;

// Pagination has no documented ceiling. A real answer for one service in one region
// is a handful of pages; treating anything past this as truncated turns a runaway or
// looping NextPageLink into a stated limitation instead of a silent partial answer
// reported as complete.
export const MAX_PAGES = 20;

function fail(message) {
  throw new TypeError(message);
}

async function retailPricesGet(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error('retail-price-read-failed');
    error.code = 'retail-price-read-failed';
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/** Only the fields a price decision needs. The rest of a retail-price item is not carried. */
function projectMeter(item) {
  return {
    meterName: item?.meterName ?? null,
    productName: item?.productName ?? null,
    retailPrice: Number.isFinite(item?.retailPrice) ? item.retailPrice : null,
    currencyCode: typeof item?.currencyCode === 'string' ? item.currencyCode : null,
    unitOfMeasure: typeof item?.unitOfMeasure === 'string' ? item.unitOfMeasure : null,
    armRegionName: typeof item?.armRegionName === 'string' ? item.armRegionName : null,
    effectiveStartDate: typeof item?.effectiveStartDate === 'string' ? item.effectiveStartDate : null,
  };
}

/**
 * Reads every published Foundry Models meter for one region.
 *
 * @param region - an Azure ARM region name. Validated before it reaches the filter
 *   or the URL; see the module header for why.
 * @param transport - `(url) => Promise<json>` GET, injected so a test never reaches
 *   the network. Defaults to an unauthenticated `fetch`, matching the endpoint.
 */
export async function readFoundryModelPrices({ region, transport = retailPricesGet }) {
  if (typeof region !== 'string' || !REGION.test(region)) {
    fail('region must be a bounded lower-case ARM region name.');
  }
  if (typeof transport !== 'function') fail('transport must be callable.');

  const filter = `serviceName eq '${SERVICE_NAME}' and armRegionName eq '${region}'`;
  let url = `${RETAIL_PRICES_ENDPOINT}?$filter=${encodeURIComponent(filter)}`;

  const meters = [];
  let pagesRead = 0;
  let truncated = false;

  while (typeof url === 'string' && url.length > 0) {
    if (pagesRead >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const page = await transport(url);
    for (const item of Array.isArray(page?.Items) ? page.Items : []) {
      meters.push(projectMeter(item));
    }
    pagesRead += 1;
    const next = page?.NextPageLink;
    url = typeof next === 'string' && next.length > 0 ? next : null;
  }

  return Object.freeze({
    region,
    meters: Object.freeze(meters),
    pagesRead,
    truncated,
  });
}
