targetScope = 'subscription'

@minLength(1)
@maxLength(20)
param environmentName string

param location string

@minLength(1)
param gatewayResourceGroupName string

@secure()
@minLength(32)
param derivationSecret string

var workloadName = 'llm-governance-apim'
var shortWorkloadName = 'llmgov'
var resourceSuffix = take(uniqueString(subscription().id, gatewayResourceGroupName, environmentName, location), 6)
var keyVaultName = take('kv-${shortWorkloadName}-${environmentName}-${resourceSuffix}', 24)
var resourceGroupTags = {
  'azd-env-name': environmentName
  environment: environmentName
  workload: workloadName
}
var keyStoreTags = union(resourceGroupTags, {
  purpose: 'principal-key-store'
})

resource gatewayResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: gatewayResourceGroupName
  location: location
  tags: resourceGroupTags
}

module keyStore './modules/principal-key-store-bootstrap.bicep' = {
  scope: resourceGroup(gatewayResourceGroupName)
  params: {
    keyVaultName: keyVaultName
    derivationSecret: derivationSecret
    location: location
    tags: keyStoreTags
  }
  dependsOn: [
    gatewayResourceGroup
  ]
}

output PRINCIPAL_KEY_STORE_NAME string = keyStore.outputs.keyVaultName
output PRINCIPAL_KEY_SECRET_NAME string = keyStore.outputs.secretName
output OWNERSHIP_MANIFEST_SEED object = {
  schemaVersion: 'llm-governance-bicep-ownership-seed/v1'
  identity: {
    tenantId: subscription().tenantId
    subscriptionId: subscription().subscriptionId
    environmentName: environmentName
    resourceGroupName: gatewayResourceGroupName
    resourceGroupId: gatewayResourceGroup.id
    location: location
  }
  createdResourceIds: concat([
    gatewayResourceGroup.id
  ], keyStore.outputs.createdResourceIds)
  externalReferences: []
  keyVaultLifecycle: {
    resourceId: keyStore.outputs.createdResourceIds[0]
    purgeProtectionEnabled: keyStore.outputs.purgeProtectionEnabled
    softDeleteRetentionInDays: keyStore.outputs.softDeleteRetentionInDays
    deletionDisposition: 'DeletedPendingRetention'
  }
  requiresCreationReceipts: true
  requiresExactReadback: true
}