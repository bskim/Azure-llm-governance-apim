import { resolveApplicationAttribution, resolveModelDescriptor } from '../registry/model-registry-validator.mjs';
import { selectEffectiveModel } from './effective-model-selector.mjs';

const APPLICATION_KEY = /^ak[0-9]+-[A-Za-z0-9._-]{16,120}$/;

function fail(message) {
  throw new TypeError(message);
}

function assertRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
}

function attributionFor(registry, applicationId, applicationKey) {
  if (typeof applicationKey !== 'string' || !APPLICATION_KEY.test(applicationKey)) {
    fail('applicationKey must be a versioned application pseudonym.');
  }
  if (registry.status !== 'complete') {
    return Object.freeze({ applicationKey, quality: null, displayCode: null, reasonCode: 'model-registry-unavailable' });
  }
  const resolved = resolveApplicationAttribution(registry, applicationId);
  return Object.freeze({
    applicationKey,
    quality: resolved.quality,
    displayCode: resolved.displayCode,
    reasonCode: resolved.reasonCode,
  });
}

function unavailableDecision({ requestedModel, reasonCode, attribution, effectivePolicy, registry, evaluationTime }) {
  return Object.freeze({
    contractVersion: 'v1',
    documentType: 'model-selection-decision',
    decision: 'unavailable',
    reasonCode,
    requested: Object.freeze({ modelKey: requestedModel, providerKey: null }),
    effective: null,
    hops: 0,
    modelSelectionIntent: effectivePolicy.modelSelectionIntent ?? 'pinned',
    trigger: Object.freeze({
      kind: 'evidence-unavailable',
      warnThresholdPercent: null,
      breachedScopes: Object.freeze([]),
    }),
    applicationAttribution: attribution,
    exhausted: null,
    configVersion: effectivePolicy.configVersion ?? null,
    registrySnapshotId: registry.snapshotId,
    registrySnapshotVersion: registry.version,
    evaluationTime,
  });
}

/**
 * Produces the body-free record of which model a request was governed onto.
 *
 * This is the accounting and audit view, not the gateway's decision: the gateway
 * selects the model, and `selectEffectiveModel` is the proven-equivalent reference
 * for that selection. What this adds is the identity a usage record needs and the
 * gateway does not carry, namely provider identity on both sides, the quality of
 * the calling application's attribution, and the price version the decision was
 * made under.
 *
 * When the catalogue cannot supply those, the record is `unavailable` rather than
 * partially filled in. The request may still have been served; what is missing is
 * the evidence to describe it, and a decision without provider identity is not one
 * this product will emit.
 */
export function decideModelSelection({
  requestedModel,
  effectivePolicy,
  remainingTokensByScope = {},
  registry,
  applicationId,
  applicationKey,
  fallbackRejections = [],
  onExhausted = 'continue-with-requested',
  evaluationTime,
} = {}) {
  assertRecord(effectivePolicy, 'effectivePolicy');
  assertRecord(registry, 'registry');
  if (!Array.isArray(fallbackRejections)) fail('fallbackRejections must be an array.');

  const attribution = attributionFor(registry, applicationId, applicationKey);

  if (registry.status !== 'complete') {
    return unavailableDecision({
      requestedModel,
      reasonCode: 'model-registry-unavailable',
      attribution,
      effectivePolicy,
      registry,
      evaluationTime,
    });
  }

  const source = resolveModelDescriptor(registry, requestedModel);
  if (source === null) {
    return unavailableDecision({
      requestedModel,
      reasonCode: 'requested-model-unregistered',
      attribution,
      effectivePolicy,
      registry,
      evaluationTime,
    });
  }

  const selection = selectEffectiveModel({
    requestedModel,
    effectivePolicy,
    remainingTokensByScope,
    onExhausted,
  });

  const breached = selection.breachedScopes.length > 0;
  const intent = effectivePolicy.modelSelectionIntent ?? 'pinned';
  const trigger = Object.freeze({
    kind: breached ? 'threshold-breach' : 'none',
    warnThresholdPercent: breached ? (effectivePolicy.warnThresholdPercent ?? null) : null,
    breachedScopes: Object.freeze([...selection.breachedScopes]),
  });

  if (selection.decision === 'denied' || selection.hops === 0) {
    const rejection = fallbackRejections.find((entry) => entry.from === requestedModel);
    // A plan that compiled to nothing and a deployment with no plan at all reach the
    // selector identically, because the effective policy document carries only the
    // resulting chain. So a configured denial can be asked for and not carried out.
    // Recording it as a denial would describe something that did not happen; leaving
    // it out would hide a governance gap from the auditor who configured it.
    //
    // A pin is the other case entirely. Fallback was never consulted, so it was never
    // exhausted, and reporting an unenforced denial would send an administrator looking
    // for a defect instead of at the caller's own declared intent.
    const pinned = intent !== 'preferred';
    const unenforcedPolicy =
      !pinned && selection.decision === 'selected' && onExhausted === 'deny' && breached
        ? 'deny'
        : null;
    const exhausted = breached
      ? Object.freeze({
          modelKey: requestedModel,
          providerKey: source.providerKey,
          blockedBy: pinned ? 'model-pinned' : (rejection?.blockedBy ?? 'fallback-no-configured-target'),
          unenforcedPolicy,
        })
      : null;

    return Object.freeze({
      contractVersion: 'v1',
      documentType: 'model-selection-decision',
      decision: selection.decision,
      reasonCode: selection.reasonCode,
      requested: Object.freeze({ modelKey: requestedModel, providerKey: source.providerKey }),
      effective:
        selection.decision === 'denied'
          ? null
          : Object.freeze({ modelKey: requestedModel, providerKey: source.providerKey }),
      hops: 0,
      modelSelectionIntent: intent,
      trigger,
      applicationAttribution: attribution,
      exhausted,
      configVersion: effectivePolicy.configVersion ?? null,
      registrySnapshotId: registry.snapshotId,
      registrySnapshotVersion: registry.version,
      evaluationTime,
    });
  }

  const target = resolveModelDescriptor(registry, selection.effectiveModel);
  if (target === null) {
    return unavailableDecision({
      requestedModel,
      reasonCode: 'effective-model-unregistered',
      attribution,
      effectivePolicy,
      registry,
      evaluationTime,
    });
  }

  return Object.freeze({
    contractVersion: 'v1',
    documentType: 'model-selection-decision',
    decision: 'selected',
    reasonCode: selection.reasonCode,
    requested: Object.freeze({ modelKey: requestedModel, providerKey: source.providerKey }),
    effective: Object.freeze({ modelKey: target.modelKey, providerKey: target.providerKey }),
    hops: selection.hops,
    modelSelectionIntent: intent,
    trigger,
    applicationAttribution: attribution,
    exhausted: null,
    configVersion: effectivePolicy.configVersion ?? null,
    registrySnapshotId: registry.snapshotId,
    registrySnapshotVersion: registry.version,
    evaluationTime,
  });
}
