@description('Name of the key store.')
param keyVaultName string

@description('Principal identifier of the control-plane identity that reads the secret.')
param readerPrincipalId string

@description('Subnet the private endpoint is placed in.')
param privateEndpointSubnetResourceId string

@description('Private DNS zone that resolves the key store to its private address.')
param privateDnsZoneResourceId string

@description('Pseudonym derivation secret. Held only here and never by application configuration.')
@secure()
@minLength(32)
param derivationSecret string

param location string = resourceGroup().location
param tags object = {}

var secretName = 'principal-key-secret'
// Key Vault Secrets User. Reading one secret is the whole need, so nothing wider is granted.
var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

/*
  A pseudonym has to be stable for as long as the identifiers derived from it are read,
  so the secret behind it is durable product state and takes the same posture as the
  rest of it: closed to the public network, reachable only from inside the network, and
  read through an identity rather than copied into configuration.
*/
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

// Written through the management plane, which is how a closed vault is populated
// without opening its data plane to whoever is running the deployment.
resource derivationSecretValue 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: keyVault
  name: secretName
  properties: {
    value: derivationSecret
    attributes: {
      enabled: true
    }
  }
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

// Without a zone group the private address is never published and the client
// resolves the public name it cannot reach.
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

output derivationSecretReference string = '@Microsoft.KeyVault(SecretUri=${derivationSecretValue.properties.secretUri})'
output createdResourceIds array = [
  keyVault.id
  derivationSecretValue.id
  secretsUser.id
  privateEndpoint.id
  privateEndpointDns.id
]
output roleAssignmentIds array = [
  secretsUser.id
]
output purgeProtectionEnabled bool = true
output softDeleteRetentionInDays int = 7
