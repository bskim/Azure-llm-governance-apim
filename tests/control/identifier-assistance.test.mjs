import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIdentifierEvidence,
  deriveCurrentCallerDiagnostic,
  projectKnownAuthorizedIdentifiers,
} from '../../app/control-api/identifier-assistance.mjs';
import { createAccessOptionsHandler } from '../../app/functions/handlers/admin-access.mjs';
import { createPrincipalKeyDeriver } from '../../app/governance-domain/identity/principal-key-derivation.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { createLocalAdminServer } from '../../app/control-api/local-admin-server.mjs';

const deriver = createPrincipalKeyDeriver({
  secret: 'identifier-assistance-test-secret-which-is-long-enough',
});

function verifiedRequest(claims) {
  const principal = Buffer.from(JSON.stringify({
    role_typ: 'roles',
    claims: [
      { typ: 'aud', val: 'api://control-plane' },
      { typ: 'tid', val: 'tenant-1' },
      { typ: 'oid', val: 'directory-object-1' },
      ...claims,
      { typ: 'roles', val: 'Governance.Administer' },
    ],
  }), 'utf8').toString('base64');
  return {
    headers: { get: (name) => name === 'x-ms-client-principal' ? principal : null },
  };
}

test('caller diagnostics derive sk1 and ak1 from verified sub and client ID, never oid', () => {
  const evidence = buildIdentifierEvidence({
    identity: {
      tenantId: 'tenant-1',
      objectId: 'directory-object-1',
      subjectId: 'gateway-subject-1',
      applicationId: 'client-1',
    },
    deriver,
    snapshots: getDeterministicGovernanceSnapshots(),
  });

  assert.equal(evidence.version, 'identifier-evidence.v1');
  assert.equal(evidence.currentCaller.state, 'available');
  assert.equal(evidence.currentCaller.scope, 'control-plane-token');
  assert.equal(evidence.currentCaller.source, 'verified-control-plane-token');
  assert.equal(evidence.currentCaller.notInferenceIdentityProof, true);
  assert.equal(evidence.currentCaller.notEntitlementTarget, true);
  assert.equal(
    evidence.currentCaller.subjectKey,
    deriver.deriveSubjectKey({ tenantId: 'tenant-1', subjectId: 'gateway-subject-1' }),
  );
  assert.equal(
    evidence.currentCaller.applicationKey,
    deriver.deriveApplicationKey({ tenantId: 'tenant-1', applicationId: 'client-1' }),
  );
  assert.notEqual(evidence.currentCaller.subjectKey, deriver.deriveSubjectKey({
    tenantId: 'tenant-1',
    subjectId: 'directory-object-1',
  }));
  assert.doesNotMatch(JSON.stringify(evidence.currentCaller), /gateway-subject-1|client-1|directory-object-1/);
});

test('ambiguous or missing subject/client identity and a missing deriver are explicit unavailable states', () => {
  const ambiguous = deriveCurrentCallerDiagnostic({
    identity: {
      tenantId: 'tenant-1',
      subjectId: null,
      applicationId: 'client-1',
    },
    deriver,
  });

  assert.deepEqual(
    { state: ambiguous.state, reasonCode: ambiguous.reasonCode },
    { state: 'unavailable', reasonCode: 'caller-identifiers-unavailable' },
  );
  const missingDeriver = deriveCurrentCallerDiagnostic({
    identity: { tenantId: 'tenant-1', subjectId: 'sub-1', applicationId: 'client-1' },
  });
  assert.deepEqual(
    { state: missingDeriver.state, reasonCode: missingDeriver.reasonCode },
    { state: 'unavailable', reasonCode: 'derivation-unavailable' },
  );
});

test('access options derive only verified sub and azp and never return raw claims', async () => {
  const handler = createAccessOptionsHandler({
    readPublishedSnapshots: async () => getDeterministicGovernanceSnapshots(),
    clock: { nowIso: () => '2026-07-24T10:00:00.000Z' },
    expectedAudience: 'api://control-plane',
    deriver,
  });
  const response = await handler(verifiedRequest([
    { typ: 'sub', val: 'gateway-subject-1' },
    { typ: 'azp', val: 'client-1' },
  ]), { invocationId: 'identifier-test' });
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.identifierEvidence.currentCaller.state, 'available');
  assert.doesNotMatch(JSON.stringify(response.jsonBody.identifierEvidence), /gateway-subject-1|client-1|directory-object-1/);
});

test('known values retain source and identifier namespaces', () => {
  const known = projectKnownAuthorizedIdentifiers(getDeterministicGovernanceSnapshots());
  assert.ok(known.some((entry) => entry.sourceKind === 'entitlement-target'
    && entry.identifierKind === 'gateway-subject'
    && entry.value === 'user-local-admin'));
  assert.ok(known.some((entry) => entry.sourceKind === 'entitlement-target'
    && entry.identifierKind === 'application-client-id'
    && entry.value === 'app-local-agent'));
  assert.ok(known.some((entry) => entry.sourceKind === 'team-membership'
    && entry.identifierKind === 'entra-group-id'));
  assert.ok(known.some((entry) => entry.identifierKind === 'logical-model-alias'));
  assert.ok(known.some((entry) => entry.identifierKind === 'provider-deployment-name'));
  assert.ok(!known.some((entry) => entry.identifierKind === 'gateway-subject'
    && entry.value?.startsWith('actor')));
});

test('local access options report authoritative fixture evidence without a principal-context route', async () => {
  const server = createLocalAdminServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/local/access-options?persona=governance-admin`,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.identifierEvidence.version, 'identifier-evidence.v1');
    assert.equal(payload.identifierEvidence.currentCaller.scope, 'local-authoritative-fixture');
    assert.equal(payload.identifierEvidence.currentCaller.source, 'local-authoritative-fixture');
    assert.equal(payload.identifierEvidence.currentCaller.state, 'available');
    assert.equal(payload.identifierEvidence.currentCaller.notEntitlementTarget, true);
    const principalContext = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/internal/principal-context`,
    );
    assert.equal(principalContext.status, 404);
    assert.doesNotMatch(JSON.stringify(payload.identifierEvidence.currentCaller), /user-local-admin|app-local-console/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
