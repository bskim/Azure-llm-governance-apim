import assert from 'node:assert/strict';
import test from 'node:test';

import { readVerifiedCaller } from '../../app/control-api/client-principal.mjs';

const AUDIENCE = 'api-audience-0000';

function principal(claims) {
  return Buffer.from(JSON.stringify({ auth_typ: 'aad', role_typ: 'roles', claims }), 'utf8').toString('base64');
}
test('a platform that forwards identity-model claim URIs still names the caller', () => {
  // Roles already tolerated a provider naming the claim differently; tenant and
  // subject did not, so a caller could arrive with readable roles and no identity.
  const header = principal([
    { typ: 'aud', val: AUDIENCE },
    { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: 'tenant-0000' },
    { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: 'object-0000' },
    { typ: 'roles', val: 'Governance.Administer' },
  ]);
  const caller = readVerifiedCaller({
    headers: { get: (name) => (name === 'x-ms-client-principal' ? header : null) },
    expectedAudience: AUDIENCE,
  });

  assert.equal(caller.tenantId, 'tenant-0000');
  assert.equal(caller.objectId, 'object-0000');
});

test('a caller the platform did not identify is null rather than an empty string', () => {
  const header = principal([
    { typ: 'aud', val: AUDIENCE },
    { typ: 'tid', val: '' },
    { typ: 'roles', val: 'Governance.Read' },
  ]);
  const caller = readVerifiedCaller({
    headers: { get: (name) => (name === 'x-ms-client-principal' ? header : null) },
    expectedAudience: AUDIENCE,
  });

  assert.equal(caller.tenantId, null);
  assert.equal(caller.objectId, null);
});
