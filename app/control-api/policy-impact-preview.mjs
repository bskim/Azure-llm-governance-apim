import { API_FAMILIES } from '../governance-domain/registry/model-registry-validator.mjs';

const PREVIEWABLE_STATES = new Set(['draft', 'approved', 'failed']);
const SEMANTIC_FIELDS = Object.freeze([
  'allowedModels',
  'modelDeployments',
  'limits',
  'warnThresholdPercent',
  'throttleTiers',
  'fallback',
  'fallbackRestrictions',
  'modelSelectionIntent',
  'substitutionNotice',
]);

export class PolicyImpactPreviewError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PolicyImpactPreviewError';
    this.code = code;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function fingerprint(value) {
  return JSON.stringify(canonical(value));
}

function snapshotVersions(snapshots) {
  return Object.fromEntries(
    Object.entries(snapshots).map(([name, snapshot]) => [name, snapshot?.version ?? null]),
  );
}

function outcome(result) {
  if (result?.status !== 200 || result.document === null) {
    return {
      state: result?.status === 403 ? 'refused' : 'unavailable',
      reasonCode: result?.reasonCode ?? 'policy-resolution-unavailable',
      policy: null,
    };
  }
  return {
    state: 'resolved',
    reasonCode: result.reasonCode,
    policy: {
      ...Object.fromEntries(
        SEMANTIC_FIELDS
          .filter((key) => Object.hasOwn(result.document, key))
          .map((key) => [key, structuredClone(result.document[key])]),
      ),
      fallbackRestrictions: {
        disposition: result.evaluation?.fallback?.disposition ?? 'unavailable',
        reasonCode: result.evaluation?.fallback?.reasonCode ?? 'fallback-evidence-unavailable',
        rejections: structuredClone(result.evaluation?.fallback?.rejections ?? []),
      },
    },
  };
}

function changes(before, after) {
  if (before.state !== after.state || before.reasonCode !== after.reasonCode) {
    return [{
      category: 'resolution',
      before: { state: before.state, reasonCode: before.reasonCode },
      after: { state: after.state, reasonCode: after.reasonCode },
    }];
  }
  if (before.policy === null || after.policy === null) return [];
  return SEMANTIC_FIELDS
    .filter((field) => fingerprint(before.policy[field]) !== fingerprint(after.policy[field]))
    .map((field) => ({
      category: field,
      before: structuredClone(before.policy[field] ?? null),
      after: structuredClone(after.policy[field] ?? null),
    }));
}

function comparisonState(before, after, differences) {
  if (before.state === 'unavailable' || after.state === 'unavailable') return 'unavailable';
  if (before.state === 'refused' && after.state === 'refused') return 'refused';
  return differences.length === 0 ? 'no-change' : 'changed';
}

function assertDependencies(dependencies) {
  for (const method of [
    'readActiveSnapshots',
    'readDraft',
    'readRevision',
    'readActiveRevision',
    'resolvePolicy',
  ]) {
    if (typeof dependencies?.[method] !== 'function') {
      throw new TypeError(`${method} is required.`);
    }
  }
  if (typeof dependencies.clock?.nowIso !== 'function') throw new TypeError('clock is required.');
}

/**
 * Compares a stored proposal with the serving set without publishing either one.
 *
 * The resolver callback is the only policy calculator used for both sides. The
 * surrounding reads are repeated after resolution so a changing active set or
 * lifecycle revision is reported as stale instead of producing a mixed comparison.
 */
export function createPolicyImpactPreview(dependencies) {
  assertDependencies(dependencies);
  const {
    readActiveSnapshots,
    readDraft,
    readRevision,
    readActiveRevision,
    resolvePolicy,
    clock,
  } = dependencies;

  return Object.freeze({
    async preview({
      revisionId,
      expectedRevisionNumber,
      apiFamily,
      target = { kind: 'current-caller' },
      targetContext,
    }) {
      if (typeof revisionId !== 'string' || revisionId.length === 0) {
        throw new PolicyImpactPreviewError('revision-required');
      }
      if (!Number.isSafeInteger(expectedRevisionNumber) || expectedRevisionNumber < 1) {
        throw new PolicyImpactPreviewError('revision-number-required');
      }
      if (target?.kind !== 'current-caller' || Object.keys(target).length !== 1) {
        throw new PolicyImpactPreviewError('target-not-supported');
      }
      if (!API_FAMILIES.includes(apiFamily)) {
        throw new PolicyImpactPreviewError('api-family-not-supported');
      }

      const revisionBefore = await readRevision({ revisionId });
      if (revisionBefore === null) throw new PolicyImpactPreviewError('revision-absent');
      if (revisionBefore.revisionNumber !== expectedRevisionNumber) {
        throw new PolicyImpactPreviewError('preview-stale');
      }
      if (!PREVIEWABLE_STATES.has(revisionBefore.state)) {
        throw new PolicyImpactPreviewError('proposal-not-previewable');
      }

      const activeBefore = await readActiveSnapshots();
      const activeRevisionBefore = await readActiveRevision();
      const draft = await readDraft({ revisionId });
      if (draft === null) throw new PolicyImpactPreviewError('draft-content-absent');
      const proposed = draft.content?.snapshots;
      if (proposed === null || typeof proposed !== 'object') {
        throw new PolicyImpactPreviewError('draft-content-incomplete');
      }

      const evaluatedAt = clock.nowIso();
      const request = { apiFamily };
      const [beforeResult, afterResult] = await Promise.all([
        resolvePolicy({ snapshots: activeBefore, request, targetContext, evaluatedAt }),
        resolvePolicy({ snapshots: proposed, request, targetContext, evaluatedAt }),
      ]);

      const [activeAfter, activeRevisionAfter, revisionAfter] = await Promise.all([
        readActiveSnapshots(),
        readActiveRevision(),
        readRevision({ revisionId }),
      ]);
      if (
        fingerprint(activeBefore) !== fingerprint(activeAfter)
        || activeRevisionBefore?.revisionId !== activeRevisionAfter?.revisionId
        || revisionAfter?.revisionNumber !== revisionBefore.revisionNumber
        || revisionAfter?.state !== revisionBefore.state
      ) {
        throw new PolicyImpactPreviewError('preview-stale');
      }

      const before = outcome(beforeResult);
      const after = outcome(afterResult);
      const differences = changes(before, after);
      const controlPlaneIdentity = targetContext?.evidence === 'verified-control-plane-token';
      return {
        readModelVersion: 'policy-impact-preview.v1',
        generatedAt: evaluatedAt,
        state: comparisonState(before, after, differences),
        target: {
          kind: 'current-caller',
          evidence: targetContext?.evidence ?? 'caller-evidence-unavailable',
          ...(controlPlaneIdentity
            ? {
                identityBasis: 'control-plane-token',
                ...(targetContext.authenticationFlow === 'delegated'
                  || targetContext.authenticationFlow === 'application'
                  ? { authenticationFlow: targetContext.authenticationFlow }
                  : {}),
              }
            : {}),
        },
        apiFamily,
        revision: {
          revisionCode: revisionBefore.revisionId,
          revisionNumber: revisionBefore.revisionNumber,
          state: revisionBefore.state,
        },
        basis: {
          activeRevisionCode: activeRevisionBefore?.revisionId ?? null,
          activeVersions: snapshotVersions(activeBefore),
          proposedVersions: snapshotVersions(proposed),
        },
        before,
        after,
        changes: differences,
        limitations: [
          'static-policy-resolution',
          'live-budget-consumption-not-evaluated',
          'next-request-outcome-not-guaranteed',
          ...(controlPlaneIdentity ? ['inference-token-identity-not-established'] : []),
        ],
      };
    },
  });
}
