import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { buildInitialGovernanceSet } from '../../app/governance-domain/policy/initial-governance-set.mjs';

const guide = await readFile(new URL('../../docs/01-deployment.md', import.meta.url), 'utf8');
const koreanGuide = await readFile(new URL('../../docs/01-deployment_ko.md', import.meta.url), 'utf8');
const parameters = await readFile(new URL('../../infra/main.parameters.json', import.meta.url), 'utf8');

test('the public deployment guide carries no workstation-specific npm policy', () => {
  const workstationTerms = new RegExp([
    ['package', 'feed', 'proxy'].join(''),
    ['corporate', ' npm'].join(''),
    ['internal', ' feed'].join(''),
    ['npm', ' mirror'].join(''),
    ['npm', ' proxy'].join(''),
    '사내.*(?:npm|미러|프록시)',
  ].join('|'), 'i');
  assert.doesNotMatch(
    guide,
    workstationTerms,
  );
});

test('every required deployment setting in the guide is wired through the azd parameter file', () => {
  for (const name of [
    'AZURE_LOCATION',
    'GATEWAY_RESOURCE_GROUP_NAME',
    'ENTRA_APPLICATION_OWNER_OBJECT_ID',
    'GOVERNANCE_ADMINISTRATOR_PRINCIPAL_ID',
    'FOUNDRY_RESOURCE_GROUP_NAME',
    'FOUNDRY_ACCOUNT_NAME',
    'FOUNDRY_PROJECT_NAME',
    'FOUNDRY_DEFAULT_MODEL_DEPLOYMENT',
    'GATEWAY_LOGICAL_MODEL_ALIAS',
    'GOVERNANCE_SCOPE_GROUP_ID',
    'GOVERNANCE_KNOWN_TEAM_KEYS',
    'GOVERNANCE_MEMBERSHIP_GROUP_IDS',
    'PRINCIPAL_KEY_MODE',
    'PRINCIPAL_KEY_STORE_NAME',
    'PRINCIPAL_KEY_SECRET_NAME',
    'CONTROL_PLANE_MAXIMUM_INSTANCE_COUNT',
    'CONTROL_PLANE_INSTANCE_MEMORY_MB',
  ]) {
    assert.match(parameters, new RegExp(`\\$\\{${name}(?:=|\\})`), `${name} is documented but not wired`);
  }
  assert.match(guide, /azd env set AZURE_SUBSCRIPTION_ID <subscription-id>/);
});

test('the deployment contract keeps FC1 capacity customer-validated in both languages', () => {
  for (const document of [guide, koreanGuide]) {
    assert.match(document, /CONTROL_PLANE_MAXIMUM_INSTANCE_COUNT/);
    assert.match(document, /CONTROL_PLANE_INSTANCE_MEMORY_MB/);
    assert.doesNotMatch(document, /281 core|197 core|53-core|Account-specific quota/);
  }
  assert.match(guide, /capacity planning[\s\S]*target[\s\S]*subscription's quota/);
  assert.match(guide, /does not establish regional capacity[\s\S]*Confirm current quota/);
  assert.match(koreanGuide, /용량 계획[\s\S]*대상 구독 할당량/);
  assert.match(koreanGuide, /지역별 용량을 확정하거나[\s\S]*현재 할당량을 확인/);
});

test('both guides document opt-in evaluation settings without changing deployment defaults', () => {
  const wired = JSON.parse(parameters).parameters;
  assert.equal(wired.apimSku.value, '${APIM_SKU=BasicV2}');
  assert.equal(wired.secondModelDeployments.value, '${FOUNDRY_SECOND_MODEL_DEPLOYMENTS=[]}');
  for (const document of [guide, koreanGuide]) {
    assert.match(document, /APIM_SKU=Developer/);
    assert.match(document, /FOUNDRY_SECOND_MODEL_DEPLOYMENTS/);
    assert.match(document, /ConvertTo-Json -InputObject \$secondModels -Compress/);
    assert.match(document, /CREATE_FOUNDRY=true/);
    assert.match(document, /OWNERSHIP_VALIDATION_STAGE=bootstrap/);
    assert.match(document, /postprovision/);
    for (const field of ['deploymentName', 'modelName', 'modelVersion', 'modelFormat', 'skuName', 'capacity']) {
      assert.match(document, new RegExp(`${field} = `));
    }
  }
  assert.match(guide, /same verification resource group/);
  assert.match(guide, /not proof of creation/);
  assert.match(guide, /Reused Foundry resources remain external references/);
  assert.match(guide, /Local template tests are not Azure end-to-end evidence/);
});

test('both guides expose fixed webhook and initial rollup settings without exposing the webhook value', () => {
  const wired = JSON.parse(parameters).parameters;
  assert.equal(wired.notificationWebhookSecretName.value, '${NOTIFICATION_WEBHOOK_SECRET_NAME=}');
  assert.equal(wired.rollupStartedFrom.value, '${ROLLUP_STARTED_FROM=}');
  for (const document of [guide, koreanGuide]) {
    assert.match(document, /NOTIFICATION_WEBHOOK_SECRET_NAME/);
    assert.match(document, /ROLLUP_STARTED_FROM/);
    assert.match(document, /Key Vault/);
    assert.match(document, /48/);
    assert.doesNotMatch(document, /NOTIFICATION_WEBHOOK_ENDPOINT/);
  }
});

test('the documented bootstrap input is accepted by the real builder after placeholders are replaced', () => {
  const section = guide.slice(guide.indexOf('### Product: Bootstrap Governance'));
  const block = /```json\s+(\{[\s\S]*?\})\s+```/.exec(section);
  assert.ok(block, 'the bootstrap JSON example is absent');
  const input = JSON.parse(block[1]
    .replace('<tenant-id>', '00000000-0000-4000-8000-000000000001')
    .replace('<entra-group-object-id>', '00000000-0000-4000-8000-000000000002')
    .replace('<foundry-deployment-name>', 'deploy-coding-primary')
    .replace('<caller-client-id>', '00000000-0000-4000-8000-000000000003'));
  const built = buildInitialGovernanceSet({
    input,
    at: '2026-08-26T02:00:00.000Z',
    deployments: [{
      deploymentName: 'deploy-coding-primary',
      modelName: 'coding-primary',
      modelVersion: '1',
      modelFormat: 'OpenAI',
      capabilities: { chatCompletion: true, responses: true },
      raiPolicyName: null,
    }],
  });
  assert.equal(built.content.snapshots.entitlementSnapshot.teamCatalog[0].teamKey, 'engineering');
  assert.equal(built.content.snapshots.entitlementSnapshot.bindings.length, 2);
  assert.equal(
    built.content.snapshots.entitlementSnapshot.bindings.some(
      (binding) => binding.target.kind === 'team' && binding.target.key === 'engineering',
    ),
    true,
  );
  assert.equal(built.content.snapshots.modelRegistrySnapshot.applications.length, 1);
});

test('the guide bootstraps one closed stable key store before the main deployment', () => {
  assert.match(guide, /Initialize-PrincipalKeyStore\.ps1[\s\S]*-Preview/);
  assert.match(guide, /public access disabled/);
  assert.match(guide, /48 random bytes in memory/);
  assert.doesNotMatch(guide, /azd env set-secret PRINCIPAL_DERIVATION_SECRET/);
  assert.match(guide, /503 governance_unavailable/);
});

test('both guides document caller-supplied create-only ownership evidence', () => {
  for (const document of [guide, koreanGuide]) {
    for (const setting of [
      'verification',
      '-OwnershipPreflightPath',
      '-OwnershipPlanPath',
      'CREATE_ONLY_OWNERSHIP_VALIDATION=true',
      'OWNERSHIP_PLAN_FILE',
      'OWNERSHIP_PREFLIGHT_FILE',
      'OWNERSHIP_MANIFEST_FILE',
      'OWNERSHIP_STATE_FILE',
      'OWNERSHIP_READBACK_FILE',
    ]) {
      assert.ok(document.includes(setting), `missing ownership setting: ${setting}`);
    }
  }
});

test('the guide requires governance bootstrap and recurring catalogue refresh', () => {
  assert.match(guide, /Initialize-Governance\.mjs[\s\S]*--dry-run/);
  assert.match(guide, /Refresh catalogue from provider/);
  assert.match(guide, /Do \*\*not\*\* deploy\s+application code[\s\S]*manually send a partial document/);
  assert.match(guide, /body-free `403`[\s\S]*empty `allowedApplications`[\s\S]*control-plane-authentication\.bicep/);
  assert.match(guide, /three samples 30 seconds apart[\s\S]*anonymous `401`[\s\S]*authenticated `200`/);
  assert.match(guide, /Do \*\*not\*\*[\s\S]*restart the Function App[\s\S]*partial document/);
});

test('the guide separates read-only verification from mutating recovery', () => {
  const section = guide.slice(guide.indexOf('## Verify The Deployment'));
  assert.doesNotMatch(section, /Every command below is read-only/);
  assert.match(section, /Recovery commands are labeled separately and change live resources/);
  assert.match(section, /Repair-EasyAuthClientAllowlist\.mjs[\s\S]*mutating recovery command|mutating recovery command[\s\S]*Repair-EasyAuthClientAllowlist\.mjs/);
  assert.match(section, /recovery changes the live authentication resource[\s\S]*az deployment group create/);
});

test('the removal guide names an approval planner, not a deletion executor', () => {
  for (const document of [guide, koreanGuide]) {
    assert.match(document, /ownership-contract\.mjs/);
    assert.match(document, /ownership-contract-fixture\.mjs/);
    assert.match(document, /never delete|삭제나 영구 삭제를 수행하지 않습니다/);
    assert.match(document, /not deletion executors|삭제 실행기가 아닙니다/);
    assert.match(document, /exact owned resource|정확한 소유 리소스/);
    assert.match(document, /reused Foundry|재사용한\s+Foundry/);
    assert.match(document, /produces neither a manifest|매니페스트, 상태, 조회 결과를 만들지 않으며/);
    assert.match(document, /azd down/);
    assert.match(document, /\.\.\/tools\/deployment\/ownership-contract\.mjs/);
    assert.match(document, /\.\.\/tests\/infra\/fixtures\/ownership-contract-fixture\.mjs/);
  }
});

test('the guide distinguishes OR model grants from restrictive independent budgets', () => {
  const section = guide.slice(guide.indexOf('#### How Policies Combine'));
  assert.match(section, /OR across matching subject, application, and governed-team grants/);
  assert.match(section, /organization allowlist is a ceiling, not an admission grant/);
  assert.match(section, /All applicable budgets apply as independent counters/);
  assert.match(section, /Budgets with different periods are not added or converted/);
  assert.match(section, /Team Red grants[\s\S]*Team Blue grants[\s\S]*subject policy grants/);
  assert.match(section, /3 million subject budget is the first practical ceiling/);
});

test('the guide names policy-combination extension boundaries without promising the roadmap', () => {
  const section = guide.slice(guide.indexOf('#### Customizing The Combination Rules'));
  for (const path of [
    'governance-authorization-evaluator.mjs',
    'effective-policy-composer.mjs',
    'fallback-plan-compiler.mjs',
    'effective-policy-document.schema.json',
    'apim/policies/inference.xml',
    'tests/policy/Test-InferencePolicy.ps1',
  ]) {
    assert.match(section, new RegExp(path.replaceAll('.', '\\.').replaceAll('/', '\\/')));
  }
  assert.match(section, /Do not implement a new rule only in the Admin UI or only in API Management/);
  // The label has to say this is not prioritized. What separates the two halves of it is
  // punctuation, and pinning that made a prose edit look like a broken contract.
  assert.match(section, /Future work\W{1,3}not currently prioritized/);
  assert.match(section, /roadmap marker, not a promise/);
});
