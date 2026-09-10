targetScope = 'resourceGroup'

param functionAppName string
param baseAppSettings object

@minLength(3)
param keyVaultName string

@minLength(1)
param secretName string

@description('Optional Key Vault secret name containing a deployment-owned generic notification webhook endpoint. Empty leaves the fallback disabled.')
param notificationWebhookSecretName string = ''

resource functionApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionAppName
}

// sites/config is a full-document PUT. Repeat every base setting and add only the
// Key Vault reference after the vault grant, private endpoint, and DNS are complete.
resource appSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: union(baseAppSettings, {
    PRINCIPAL_KEY_SECRET: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=${secretName})'
  }, empty(notificationWebhookSecretName)
    ? {}
    : {
        NOTIFICATION_WEBHOOK_ENDPOINT: '@Microsoft.KeyVault(VaultName=${keyVaultName};SecretName=${notificationWebhookSecretName})'
      })
}

output configurationResourceId string = appSettings.id