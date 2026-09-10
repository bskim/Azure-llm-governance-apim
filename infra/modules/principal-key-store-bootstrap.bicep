targetScope = 'resourceGroup'

param keyVaultName string

@secure()
@minLength(32)
param derivationSecret string

param location string = resourceGroup().location
param tags object = {}

var secretName = 'principal-key-secret'

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
    }
  }
}

// ARM writes the initial value through the management plane, so the vault never has
// to expose a public data-plane endpoint to the deployment workstation.
resource secret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: secretName
  properties: {
    value: derivationSecret
    attributes: {
      enabled: true
    }
  }
}

output keyVaultName string = keyVault.name
output secretName string = secret.name
output createdResourceIds array = [
  keyVault.id
  secret.id
]
output purgeProtectionEnabled bool = true
output softDeleteRetentionInDays int = 7