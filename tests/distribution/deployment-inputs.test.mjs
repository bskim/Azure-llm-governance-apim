import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  FC1_SCALE_CONTRACT,
  validateDeploymentInputs,
  validateFc1ScaleBudget,
  validateNotificationWebhookSecretName,
  validateRollupStartedFrom,
} from '../../tools/distribution/Validate-DeploymentInputs.mjs';

const secretReference = ['akvs:', '', 'example', 'reference'].join('/');
const pwshAvailable = spawnSync('pwsh', ['-NoProfile', '-Command', '$null']).status === 0;
const defaultFc1 = {
  instanceMemoryMB: 2048,
  maximumInstanceCount: 28,
  scaleGroupCount: 7,
  alwaysReadyReserve: 1,
  worstCaseCores: 197,
  regionalDefaultMarginCores: 53,
};

test('legacy direct mode requires the secure value', () => {
  assert.throws(() => validateDeploymentInputs({}), /principal-key-direct-secret-required/);
  assert.deepEqual(validateDeploymentInputs({ PRINCIPAL_DERIVATION_SECRET: secretReference }), {
    mode: 'direct',
    configured: true,
    fc1: defaultFc1,
    secondModelDeployments: [],
    createOnly: null,
  });
});

test('existing mode requires both non-secret resource names', () => {
  assert.deepEqual(validateDeploymentInputs({
    PRINCIPAL_KEY_MODE: 'existing',
    PRINCIPAL_KEY_STORE_NAME: 'example-vault',
    PRINCIPAL_KEY_SECRET_NAME: 'principal-key-item',
  }), {
    mode: 'existing', configured: true, fc1: defaultFc1, secondModelDeployments: [], createOnly: null,
  });
  assert.throws(
    () => validateDeploymentInputs({ PRINCIPAL_KEY_MODE: 'existing', PRINCIPAL_KEY_STORE_NAME: 'example-vault' }),
    /principal-key-existing-incomplete/,
  );
});

test('the two secret sources cannot be combined', () => {
  assert.throws(
    () => validateDeploymentInputs({
      PRINCIPAL_KEY_MODE: 'existing',
      PRINCIPAL_KEY_STORE_NAME: 'example-vault',
      PRINCIPAL_KEY_SECRET_NAME: 'principal-key-item',
      PRINCIPAL_DERIVATION_SECRET: secretReference,
    }),
    /principal-key-existing-carries-direct-secret/,
  );
  assert.throws(
    () => validateDeploymentInputs({ PRINCIPAL_KEY_STORE_NAME: 'example-vault' }),
    /principal-key-direct-carries-existing-input/,
  );
});

test('secondary Foundry deployment array is complete and requires fresh Foundry creation', () => {
  const secondModel = JSON.stringify([{
    deploymentName: 'secondary',
    modelName: 'gpt-4.1-nano',
    modelVersion: '2025-04-14',
    modelFormat: 'OpenAI',
    skuName: 'GlobalStandard',
    capacity: 1,
  }]);
  assert.throws(
    () => validateDeploymentInputs({
      PRINCIPAL_DERIVATION_SECRET: secretReference,
      FOUNDRY_SECOND_MODEL_DEPLOYMENTS: secondModel,
      CREATE_FOUNDRY: 'false',
    }),
    /second-model-deployments-require-create-foundry/,
  );
  assert.deepEqual(
    validateDeploymentInputs({
      PRINCIPAL_DERIVATION_SECRET: secretReference,
      FOUNDRY_SECOND_MODEL_DEPLOYMENTS: secondModel,
      CREATE_FOUNDRY: 'true',
    }).secondModelDeployments,
    JSON.parse(secondModel),
  );
  assert.throws(
    () => validateDeploymentInputs({
      PRINCIPAL_DERIVATION_SECRET: secretReference,
      FOUNDRY_SECOND_MODEL_DEPLOYMENTS: '[{"deploymentName":"secondary"}]',
      CREATE_FOUNDRY: 'true',
    }),
    /contract-string-required: secondModelDeployments\[\]\.modelName/,
  );
  assert.throws(
    () => validateDeploymentInputs({
      PRINCIPAL_DERIVATION_SECRET: secretReference,
      FOUNDRY_SECOND_MODEL_DEPLOYMENTS: '[{"deploymentName":"secondary","modelName":"gpt-4.1-nano","modelVersion":"2025-04-14","modelFormat":"OpenAI","skuName":"GlobalStandard","capacity":1}]',
    }),
    /second-model-deployments-require-create-foundry/,
  );
});

test('the preprovision command executes its validation on Windows paths', () => {
  const tool = fileURLToPath(new URL('../../tools/distribution/Validate-DeploymentInputs.mjs', import.meta.url));
  const accepted = spawnSync(process.execPath, [tool], {
    encoding: 'utf8',
    env: { ...process.env, PRINCIPAL_KEY_MODE: 'direct', PRINCIPAL_DERIVATION_SECRET: secretReference, PRINCIPAL_KEY_STORE_NAME: '', PRINCIPAL_KEY_SECRET_NAME: '' },
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), {
    mode: 'direct',
    configured: true,
    fc1: defaultFc1,
    secondModelDeployments: [],
    createOnly: null,
  });

  const refused = spawnSync(process.execPath, [tool], {
    encoding: 'utf8',
    env: { ...process.env, PRINCIPAL_KEY_MODE: 'existing', PRINCIPAL_KEY_STORE_NAME: '', PRINCIPAL_KEY_SECRET_NAME: '' },
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /principal-key-existing-incomplete/);
});

test('FC1 default budget preserves 53 cores below the documented regional default', () => {
  assert.deepEqual(validateFc1ScaleBudget({}), defaultFc1);
  assert.equal(
    FC1_SCALE_CONTRACT.alwaysReadyReserve
      + ((FC1_SCALE_CONTRACT.httpScaleGroups + FC1_SCALE_CONTRACT.timerScaleGroups) * 40),
    281,
    'the replaced default must reproduce the unsafe local baseline',
  );
  assert.equal(
    FC1_SCALE_CONTRACT.alwaysReadyReserve
      + ((FC1_SCALE_CONTRACT.httpScaleGroups + FC1_SCALE_CONTRACT.timerScaleGroups)
        * FC1_SCALE_CONTRACT.hardCeiling),
    246,
    '35 is the quota-derived hard ceiling, not an approved deployment value',
  );
});

test('FC1 validation rejects unapproved scale, hard-ceiling, and memory bypasses', () => {
  assert.throws(
    () => validateFc1ScaleBudget({ CONTROL_PLANE_MAXIMUM_INSTANCE_COUNT: '29' }),
    /fc1-quota-approval-evidence-required-for-maximum-instance-count-above-28/,
  );
  assert.throws(
    () => validateFc1ScaleBudget({ CONTROL_PLANE_MAXIMUM_INSTANCE_COUNT: '36' }),
    /fc1-maximum-instance-count-exceeds-repository-hard-ceiling-35/,
  );
  assert.throws(
    () => validateFc1ScaleBudget({ CONTROL_PLANE_INSTANCE_MEMORY_MB: '4096' }),
    /fc1-instance-memory-contract-requires-2048/,
  );
  assert.throws(
    () => validateFc1ScaleBudget({ CONTROL_PLANE_MAXIMUM_INSTANCE_COUNT: '28.5' }),
    /fc1-maximum-instance-count-must-be-a-positive-integer/,
  );
  assert.deepEqual(
    validateFc1ScaleBudget({ CONTROL_PLANE_ALWAYS_READY_INSTANCES: '10' }),
    { ...defaultFc1, alwaysReadyReserve: 10, worstCaseCores: 206, regionalDefaultMarginCores: 44 },
  );
  assert.throws(
    () => validateFc1ScaleBudget({ CONTROL_PLANE_ALWAYS_READY_INSTANCES: '11' }),
    /fc1-always-ready-instances-exceeds-bicep-ceiling-10/,
  );
});

test('initial rollup backfill must be an exact hourly boundary', () => {
  assert.equal(
    validateRollupStartedFrom({ ROLLUP_STARTED_FROM: '2026-08-10T09:00:00.000Z' }),
    '2026-08-10T09:00:00.000Z',
  );
  assert.equal(validateRollupStartedFrom({ ROLLUP_STARTED_FROM: '' }), null);
  for (const value of ['2026-08-10T09:00:01.000Z', 'not-an-instant']) {
    assert.throws(
      () => validateRollupStartedFrom({ ROLLUP_STARTED_FROM: value }),
      /ROLLUP_STARTED_FROM/,
    );
  }
  assert.throws(
    () => validateDeploymentInputs({
      PRINCIPAL_DERIVATION_SECRET: secretReference,
      ROLLUP_STARTED_FROM: '2026-08-10T09:00:01.000Z',
    }),
    /ROLLUP_STARTED_FROM/,
  );
});

test('a fixed webhook exposes only a valid non-secret Key Vault secret name', () => {
  assert.equal(
    validateNotificationWebhookSecretName({ NOTIFICATION_WEBHOOK_SECRET_NAME: 'notification-webhook-endpoint' }),
    'notification-webhook-endpoint',
  );
  assert.equal(validateNotificationWebhookSecretName({ NOTIFICATION_WEBHOOK_SECRET_NAME: '' }), null);
  for (const value of ['notification_webhook', 'notification webhook', 'x'.repeat(128)]) {
    assert.throws(
      () => validateNotificationWebhookSecretName({ NOTIFICATION_WEBHOOK_SECRET_NAME: value }),
      /notification-webhook-secret-name/,
    );
  }
  assert.throws(
    () => validateDeploymentInputs({
      PRINCIPAL_DERIVATION_SECRET: secretReference,
      NOTIFICATION_WEBHOOK_SECRET_NAME: 'notification_webhook',
    }),
    /notification-webhook-secret-name/,
  );
});

test('explicit create-only validation refuses to continue without ownership evidence', () => {
  assert.throws(
    () => validateDeploymentInputs({
      [['AZURE', 'ENV', 'NAME'].join('_')]: 'customer-validation-fixture',
      CREATE_ONLY_OWNERSHIP_VALIDATION: 'true',
      GATEWAY_RESOURCE_GROUP_NAME: 'rg-customer-validation-fixture',
      PRINCIPAL_KEY_MODE: 'existing',
      PRINCIPAL_KEY_STORE_NAME: 'kv-customer-fixture',
      PRINCIPAL_KEY_SECRET_NAME: 'principal-derivation-key',
    }),
    /create-only-preflight-required/,
  );
});

test('the key-store bootstrap is idempotent and never persists the generated value', async () => {
  const source = await readFile(new URL('../../tools/distribution/Initialize-PrincipalKeyStore.ps1', import.meta.url), 'utf8');
  assert.equal((source.match(/az deployment sub create/g) ?? []).length, 1);
  assert.equal((source.match(/az deployment sub what-if/g) ?? []).length, 1);
  assert.doesNotMatch(source, /--query '\{state:properties\.provisioningState/);
  assert.match(source, /outputs\.PRINCIPAL_KEY_STORE_NAME\.value/);
  assert.match(source, /RandomNumberGenerator]::Fill/);
  assert.match(source, /GetTempFileName\(\)/);
  assert.match(source, /finally\s*\{[\s\S]*Remove-SecureParameterFile \$parameterPath/);
  assert.match(source, /function Remove-SecureParameterFile[\s\S]*Remove-Item[\s\S]*Test-Path/);
  assert.ok(source.indexOf('az deployment sub show') < source.indexOf('RandomNumberGenerator]::Fill'));
  assert.match(source, /azd env set PRINCIPAL_DERIVATION_SECRET ''/);
  assert.doesNotMatch(source, /azd env unset/);
  assert.match(source, /azd env set PRINCIPAL_KEY_MODE existing/);
  assert.match(source, /OWNERSHIP_VALIDATION_STAGE = Read-OptionalAzdValue 'OWNERSHIP_VALIDATION_STAGE'/);
  assert.doesNotMatch(source, /az keyvault secret set/);
  assert.doesNotMatch(source, /Write-(?:Host|Output)[^\n]*\$secret/i);
  assert.doesNotMatch(source, /Read-AzdValue 'ENTRA_TENANT_ID'/);
  assert.match(source, /if \(\$null -eq \$result\)[\s\S]*completed without establishing a preview or ready result/);
});

test('the key-store bootstrap executes failure and recovery branches', { skip: !pwshAvailable }, () => {
  const tool = fileURLToPath(new URL('../../tools/distribution/Initialize-PrincipalKeyStore.ps1', import.meta.url));
  const result = spawnSync('pwsh', ['-NoProfile', '-File', tool, '-SelfTest'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const stdout = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(stdout, /Result\s*:\s*Pass/);
  assert.match(stdout, /DeploymentBranches\s*:\s*5/);
  assert.match(stdout, /VaultBranches\s*:\s*2/);
});