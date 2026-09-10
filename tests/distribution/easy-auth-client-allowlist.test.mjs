import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConfigurationUrl,
  diffDocuments,
  readRequiredEnvironment,
  repairEasyAuthClientAllowlist,
} from '../../tools/distribution/Repair-EasyAuthClientAllowlist.mjs';

function baseDocument({ allowedApplications } = {}) {
  const defaultAuthorizationPolicy = {
    allowedPrincipals: {},
    ...(allowedApplications === undefined ? {} : { allowedApplications }),
  };
  return {
    id: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/example-rg'
      + '/providers/Microsoft.Web/sites/example-site/config/authsettingsV2',
    name: 'authsettingsV2',
    type: 'Microsoft.Web/sites/config',
    properties: {
      globalValidation: {
        requireAuthentication: true,
        unauthenticatedClientAction: 'Return401',
        redirectToProvider: 'azureactivedirectory',
        excludedPaths: ['/api/healthz'],
      },
      identityProviders: {
        azureActiveDirectory: {
          enabled: true,
          registration: {
            openIdIssuer: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0',
            clientId: '00000000-0000-0000-0000-000000000001',
          },
          validation: {
            allowedAudiences: [
              '00000000-0000-0000-0000-000000000001',
              'api://00000000-0000-0000-0000-000000000001',
            ],
            defaultAuthorizationPolicy,
          },
        },
      },
      login: { tokenStore: { enabled: false } },
      platform: { enabled: true, runtimeVersion: '~1' },
    },
  };
}

function withoutAllowedApplications(document) {
  const clone = structuredClone(document);
  delete clone.properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedApplications;
  return clone;
}

test('an empty allowedApplications array is removed and every other field is sent back unchanged', async () => {
  const before = baseDocument({ allowedApplications: [] });
  const after = withoutAllowedApplications(before);
  let sentBody;
  let readCount = 0;
  const transport = {
    read: async () => { readCount += 1; return readCount === 1 ? before : after; },
    write: async (document) => { sentBody = document; },
  };

  const result = await repairEasyAuthClientAllowlist({ transport });

  assert.equal(result.outcome, 'repaired');
  assert.deepEqual(sentBody, withoutAllowedApplications(before));
});

test('an absent allowedApplications key is a no-op and reports success', async () => {
  const document = baseDocument();
  const transport = {
    read: async () => document,
    write: async () => { throw new Error('write must not be called'); },
  };

  const result = await repairEasyAuthClientAllowlist({ transport });

  assert.equal(result.outcome, 'absent');
});

test('a non-empty allowedApplications array is left unchanged', async () => {
  const document = baseDocument({ allowedApplications: ['00000000-0000-0000-0000-000000000002'] });
  const transport = {
    read: async () => document,
    write: async () => { throw new Error('write must not be called'); },
  };

  const result = await repairEasyAuthClientAllowlist({ transport });

  assert.equal(result.outcome, 'populated');
});

test('a field changed by the write is reported rather than ignored', async () => {
  const before = baseDocument({ allowedApplications: [] });
  const after = withoutAllowedApplications(before);
  after.properties.globalValidation.unauthenticatedClientAction = 'AllowAnonymous';
  let readCount = 0;
  const transport = {
    read: async () => { readCount += 1; return readCount === 1 ? before : after; },
    write: async () => {},
  };

  await assert.rejects(
    () => repairEasyAuthClientAllowlist({ transport }),
    (error) => {
      assert.equal(error.code, 'easy-auth-repair-unexpected-drift');
      assert.match(error.message, /properties\.globalValidation\.unauthenticatedClientAction/);
      return true;
    },
  );
});

test('a missing required environment value fails with a named error rather than a stack trace', () => {
  assert.throws(
    () => readRequiredEnvironment({}),
    (error) => {
      assert.equal(error.code, 'easy-auth-repair-environment-missing');
      assert.match(error.message, /AZURE_SUBSCRIPTION_ID/);
      return true;
    },
  );
  assert.throws(
    () => readRequiredEnvironment({ AZURE_SUBSCRIPTION_ID: 'sub-id' }),
    /GATEWAY_RESOURCE_GROUP_NAME/,
  );
});

test('a complete environment is read into the transport arguments', () => {
  const values = readRequiredEnvironment({
    AZURE_SUBSCRIPTION_ID: 'sub-id',
    GATEWAY_RESOURCE_GROUP_NAME: 'rg-name',
    CONTROL_PLANE_FUNCTION_APP: 'site-name',
  });
  assert.deepEqual(values, { subscriptionId: 'sub-id', resourceGroupName: 'rg-name', siteName: 'site-name' });
});

test('the configuration URL names the exact ARM resource and api-version', () => {
  const url = buildConfigurationUrl({ subscriptionId: 'sub-id', resourceGroupName: 'rg-name', siteName: 'site-name' });
  assert.equal(
    url,
    'https://management.azure.com/subscriptions/sub-id/resourceGroups/rg-name'
      + '/providers/Microsoft.Web/sites/site-name/config/authsettingsV2?api-version=2024-04-01',
  );
});

test('an ignored path does not mask an unrelated leaf at a different path', () => {
  const before = { a: { b: 1 }, c: [] };
  const after = { a: { b: 2 }, c: undefined };
  assert.deepEqual(diffDocuments(before, after, ['c']), ['a.b']);
});
