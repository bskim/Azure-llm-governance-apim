targetScope = 'resourceGroup'

@minLength(3)
param keyVaultName string

@minLength(1)
param secretName string
param readerPrincipalId string
param privateEndpointSubnetResourceId string
param privateDnsZoneResourceId string
param location string = resourceGroup().location
param tags object = {}

var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource secret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' existing = {
  parent: keyVault
  name: secretName
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, readerPrincipalId, secretsUserRoleId)
  properties: {
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${keyVaultName}-vault'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetResourceId
    }
    privateLinkServiceConnections: [
      {
        name: 'vault'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: [
            'vault'
          ]
        }
      }
    ]
  }
}

resource privateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: privateDnsZoneResourceId
        }
      }
    ]
  }
}

output derivationSecretReference string = '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=${secret.name})'
output verifiedSecretUri string = secret.properties.secretUri
output createdResourceIds array = [
  secretsUser.id
  privateEndpoint.id
  privateEndpointDns.id
]
output roleAssignmentIds array = [
  secretsUser.id
]
output externalResourceIds array = [
  keyVault.id
  secret.id
]