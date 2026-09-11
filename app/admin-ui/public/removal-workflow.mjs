const TARGET_KINDS = new Set(['team', 'model']);

function fail(message) {
  throw new TypeError(message);
}

export function buildRemovalPlanPayload({ kind, key, reasonCode } = {}) {
  if (!TARGET_KINDS.has(kind)) fail('Removal target kind must be team or model.');
  if (typeof key !== 'string' || key.length === 0) fail('Removal target key is required.');
  if (typeof reasonCode !== 'string' || reasonCode.length === 0) fail('Removal reason code is required.');
  return Object.freeze({ target: Object.freeze({ kind, key }), reasonCode });
}

export function validateRemovalPlan(plan, request) {
  if (plan?.readModelVersion !== 'removal-plan.v1') fail('Removal plan version is unsupported.');
  if (plan.target?.kind !== request.target.kind || plan.target?.key !== request.target.key || plan.reasonCode !== request.reasonCode) fail('Removal plan does not match the selected target and reason.');
  if (typeof plan.planDigest !== 'string' || plan.planDigest.length === 0 || !Array.isArray(plan.references) || !Array.isArray(plan.blockers) || typeof plan.canPropose !== 'boolean') fail('Removal plan is incomplete.');
  const referenceIds = new Set();
  for (const reference of plan.references) {
    if (typeof reference?.referenceId !== 'string' || reference.referenceId.length === 0 || referenceIds.has(reference.referenceId) || typeof reference.kind !== 'string' || typeof reference.code !== 'string' || !['active', 'revoked', 'expired'].includes(reference.state) || typeof reference.action !== 'string') fail('Removal plan contains an invalid reference.');
    referenceIds.add(reference.referenceId);
  }
  for (const blocker of plan.blockers) {
    if (typeof blocker?.reasonCode !== 'string' || blocker.reasonCode.length === 0) fail('Removal plan contains an invalid blocker.');
  }
  return plan;
}

export function buildRemovalProposalPayload(plan, request, selectedReferenceIds) {
  validateRemovalPlan(plan, request);
  if (!plan.canPropose || plan.blockers.length > 0) fail('Removal plan cannot be proposed while blockers remain.');
  if (!Array.isArray(selectedReferenceIds)) fail('Removal acknowledgements must be an array.');
  const referenceIds = plan.references.map((reference) => reference.referenceId);
  if (new Set(selectedReferenceIds).size !== selectedReferenceIds.length || selectedReferenceIds.some((id) => !referenceIds.includes(id))) fail('Removal acknowledgements must name plan references exactly once.');
  if (selectedReferenceIds.length !== referenceIds.length) fail('Every removal-plan reference must be explicitly acknowledged.');
  return Object.freeze({ ...request, planDigest: plan.planDigest, selectedReferenceIds: Object.freeze([...selectedReferenceIds]) });
}
