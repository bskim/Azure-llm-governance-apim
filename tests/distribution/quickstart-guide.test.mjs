import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { buildInitialGovernanceSet } from '../../app/governance-domain/policy/initial-governance-set.mjs';

const guide = await readFile(new URL('../../docs/00-quickstart.md', import.meta.url), 'utf8');
const koreanGuide = await readFile(new URL('../../docs/00-quickstart_ko.md', import.meta.url), 'utf8');

test('the quickstart carries the shortest complete PoC path', () => {
  for (const content of [guide, koreanGuide]) {
    assert.match(content, /npm ci/);
    assert.match(content, /npm test/);
    assert.match(content, /IncludePersistenceIntegration/);
    assert.match(content, /CREATE_FOUNDRY false/);
    assert.match(content, /DEPLOY_GATEWAY true/);
    assert.doesNotMatch(content, /REUSE_EXISTING_GATEWAY|EXISTING_APIM/);
    assert.match(content, /Initialize-Governance\.mjs[\s\S]*--dry-run/);
    assert.match(content, /model_not_allowed/);
    assert.match(content, /Remove-Deployment\.ps1[\s\S]*-ManifestPath[\s\S]*-StatePath[\s\S]*-ReadbackPath[\s\S]*-Preview[\s\S]*-OutputPath/);
    assert.doesNotMatch(content, /Remove-Deployment\.ps1[\s\S]*-WhatIf/);
    assert.doesNotMatch(content, /Remove-Deployment\.ps1[\s\S]*-EnvironmentName/);
  }
});

test('the bridge uses the qualified deployed API scope', () => {
  for (const content of [guide, koreanGuide]) {
    assert.match(content, /azd env get-value ENTRA_API_SCOPE/);
    assert.doesNotMatch(content, /azd env get-value ENTRA_REQUIRED_SCOPE/);
    assert.match(content, /agent-auth-bridge\.mjs[\s\S]*--scope \$scope/);
    assert.doesNotMatch(content, /Ocp-Apim-Subscription-Key|['"]api-key['"]/i);
  }
});

test('the minimal governance example is accepted by the real builder', () => {
  const section = guide.slice(guide.indexOf('## Publish Minimal Governance'));
  const block = /```json\s+(\{[\s\S]*?\})\s+```/.exec(section);
  assert.ok(block, 'the minimal governance JSON example is absent');
  const input = JSON.parse(block[1]
    .replace('<tenant-id>', '00000000-0000-4000-8000-000000000001')
    .replace('<engineering-group-object-id>', '00000000-0000-4000-8000-000000000002')
    .replace('<foundry-deployment>', 'deploy-coding-primary'));
  const built = buildInitialGovernanceSet({
    input,
    at: '2026-09-01T00:00:00.000Z',
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
  assert.equal(built.content.snapshots.modelRegistrySnapshot.applications.length, 0);
  assert.equal(built.content.snapshots.budgetSnapshot.budgets.length, 0);
});

test('the request examples prove an allowed path and a policy refusal', () => {
  assert.match(guide, /model = 'coding-primary'[\s\S]*StatusCode[\s\S]*Expect `200`/);
  assert.match(guide, /model = 'not-allowed'[\s\S]*StatusCode[\s\S]*Expect `403`/);
  assert.match(guide, /Do not retry it/);
});