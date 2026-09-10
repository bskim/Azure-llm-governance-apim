import { errorResponse, jsonResponse } from './http-response.mjs';
import { authorize, unavailable } from './admin-access.mjs';
import { referencePricesFor } from '../../governance-domain/registry/price-reference.mjs';
import { ENTRA_ROLE_MAPPING } from '../../governance-domain/authorization/admin-role-authorization.mjs';

/**
 * The published meters for the account's deployments, as reference.
 *
 * A route of its own, and not part of the Models reading, because the price list is a
 * separate paged source of well over a thousand meters: putting it on the screen's own
 * request would make every load wait for a number nothing enforces. The console asks
 * for it when a reader opens the section.
 *
 * Read-only, and it publishes nothing. The answer says how each deployment's meters
 * were found -- its own placement, another placement, or not at all -- so a reader is
 * never left to work out whether an empty list means free or means missing.
 */

export function createModelPricesHandler({
  readProviderDeployments,
  readModelPrices,
  region = null,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  clock,
} = {}) {
  if (typeof readProviderDeployments !== 'function') {
    throw new TypeError('readProviderDeployments is required: the meters are matched to deployments.');
  }
  if (typeof readModelPrices !== 'function') {
    throw new TypeError('readModelPrices must be supplied: this route has nothing else to answer from.');
  }
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    throw new TypeError('expectedAudience is required.');
  }

  return async function modelPrices(request, context) {
    const requestId = context?.invocationId;
    const { failure } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      capability: 'read-governance',
      requestId,
    });
    if (failure) return failure;

    let deployments;
    try {
      deployments = (await readProviderDeployments())?.deployments ?? [];
    } catch (error) {
      const refused = unavailable(error, requestId);
      if (refused) return refused;
      context?.error?.('Reading the provider deployments failed.', { reason: error?.name });
      return errorResponse(503, 'provider_unavailable', { requestId });
    }

    let meters;
    try {
      ({ meters } = await readModelPrices());
    } catch (error) {
      context?.warn?.('Reading the published price list failed.', { reason: error?.name });
      return errorResponse(503, 'price_source_unavailable', { requestId });
    }

    return jsonResponse(
      200,
      {
        readModelVersion: 'model-prices.v1',
        generatedAt: clock.nowIso(),
        region,
        // Stated on the answer, because the reader is being shown a reference and the
        // authority for what was actually charged is not this product.
        authority: 'azure-billing',
        deployments: deployments
          .map((deployment) => ({
            deploymentName: deployment.deploymentName,
            modelName: deployment.modelName,
            skuName: deployment.skuName,
            ...referencePricesFor({
              modelName: deployment.modelName,
              skuName: deployment.skuName,
              meters,
            }),
          }))
          .sort((left, right) => left.deploymentName.localeCompare(right.deploymentName)),
      },
      { requestId },
    );
  };
}
