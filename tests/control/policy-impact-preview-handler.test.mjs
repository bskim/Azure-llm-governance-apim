import assert from 'node:assert/strict';
import test from 'node:test';

import { createPolicyImpactPreviewHandler } from '../../app/functions/handlers/policy-impact-preview.mjs';
import { createPolicyImpactCallerIdentity } from '../../app/functions/composition-root.mjs';

const AUDIENCE = 'api://governance';

function header(roles, { includePolicyIdentity = true, delegated = true, extraClaims = [] } = {}) {
  const claims = [
    { typ: 'aud', val: AUDIENCE },
    { typ: 'tid', val: 'tenant-1' },
    { typ: 'oid', val: 'object-1' },
    ...roles.map((role) => ({ typ: 'roles', val: role })),
    ...(delegated ? [{ typ: 'scp', val: 'Governance.Access' }] : []),
    ...extraClaims,
  ];
  if (includePolicyIdentity) {
    claims.push({ typ: 'sub', val: 'subject-1' }, { typ: 'azp', val: 'application-1' });
  }
  return Buffer.from(JSON.stringify({ role_typ: 'roles', claims })).toString('base64');
}

function request(roles, options = {}) {
  return {
    headers: new Headers({
      'content-type': 'application/json',
      'x-ms-client-principal': header(roles, options),
    }),
    text: async () => JSON.stringify({
      revisionId: 'revision-0002',
      expectedRevisionNumber: 2,
      apiFamily: 'openai-responses',
      target: { kind: 'current-caller' },
    }),
  };
}

test('read authority previews only the verified current caller', async () => {
  let received;
  const handler = createPolicyImpactPreviewHandler({
    preview: { preview: async (input) => {
      received = input;
      return { readModelVersion: 'policy-impact-preview.v1', state: 'no-change' };
    } },
    expectedAudience: AUDIENCE,
  });
  const response = await handler(request(['Governance.Read']), { invocationId: 'request-1' });

  assert.equal(response.status, 200);
  assert.equal(received.targetContext.tenantId, 'tenant-1');
  assert.equal(received.targetContext.subjectId, 'subject-1');
  assert.equal(received.targetContext.applicationId, 'application-1');
  assert.equal(received.targetContext.authenticationFlow, 'delegated');
  assert.equal(received.targetContext.evidence, 'verified-control-plane-token');
  assert.equal(JSON.stringify(response.jsonBody).includes('subject-1'), false);
});

test('application callers retain their workload flow instead of becoming delegated users', async () => {
  let identity;
  const handler = createPolicyImpactPreviewHandler({
    preview: { preview: async ({ targetContext }) => {
      identity = createPolicyImpactCallerIdentity(targetContext, '2026-07-24T10:00:00.000Z');
      return { state: 'unavailable' };
    } },
    expectedAudience: AUDIENCE,
  });
  const response = await handler(request(['Governance.Administer'], { delegated: false }));
  assert.equal(response.status, 200);
  assert.equal(identity.subject.principalType, 'workload');
  assert.equal(identity.application.authenticationFlow, 'application');
  assert.equal(identity.subject.subjectId, 'subject-1');
  assert.equal(identity.application.applicationId, 'application-1');
});

test('delegated preview identity preserves the token subject rather than substituting the directory object', async () => {
  let identity;
  const handler = createPolicyImpactPreviewHandler({
    preview: { preview: async ({ targetContext }) => {
      identity = createPolicyImpactCallerIdentity(targetContext, '2026-07-24T10:00:00.000Z');
      return { state: 'unavailable' };
    } },
    expectedAudience: AUDIENCE,
  });
  const response = await handler(request(['Governance.Read']));
  assert.equal(response.status, 200);
  assert.equal(identity.subject.principalType, 'user');
  assert.equal(identity.subject.subjectId, 'subject-1');
  assert.notEqual(identity.subject.subjectId, 'object-1');
  assert.equal(identity.application.authenticationFlow, 'delegated');
});

test('ambiguous token identity and contradictory application flow refuse before policy resolution', async () => {
  const handler = createPolicyImpactPreviewHandler({
    preview: { preview: async () => assert.fail('unestablished identity must not be resolved') },
    expectedAudience: AUDIENCE,
  });
  for (const extraClaims of [
    [{ typ: 'idtyp', val: 'app' }],
    [{ typ: 'sub', val: 'another-subject' }],
    [{ typ: 'appid', val: 'another-application' }],
  ]) {
    const response = await handler(request(['Governance.Read'], { extraClaims }));
    assert.equal(response.status, 503);
    assert.equal(response.jsonBody.error.reasonCode, 'caller-policy-evidence-unavailable');
  }
});

test('unauthorized and unverifiable callers are refused before comparison', async () => {
  let calls = 0;
  const handler = createPolicyImpactPreviewHandler({
    preview: { preview: async () => { calls += 1; } },
    expectedAudience: AUDIENCE,
  });

  const denied = await handler(request(['Policy.Resolve']), { invocationId: 'request-2' });
  assert.equal(denied.status, 403);
  assert.equal(denied.jsonBody.error.code, 'preview_denied');

  const unavailable = await handler(
    request(['Governance.Read'], { includePolicyIdentity: false }),
    { invocationId: 'request-3' },
  );
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.jsonBody.error.reasonCode, 'caller-policy-evidence-unavailable');
  const objectOnly = await handler(request(['Governance.Read'], {
    includePolicyIdentity: false,
    extraClaims: [{ typ: 'azp', val: 'application-1' }],
  }));
  assert.equal(objectOnly.status, 503, 'oid must not substitute for an absent token subject');
  assert.equal(calls, 0);
});
