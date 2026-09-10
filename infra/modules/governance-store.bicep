metadata description = 'Governance persistence for the AI gateway control plane.'

@description('Base name used to derive the account name.')
param name string

@description('Deployment environment discriminator.')
param environmentName string

@description('Deployment location.')
param location string = resourceGroup().location

@description('Resource tags.')
param tags object = {}

@description('Logical database that holds the governance containers.')
param databaseName string = 'governance'

@description('Days a usage event is retained before it expires.')
@minValue(1)
@maxValue(3650)
param eventRetentionDays int = 400

@description('Subnet holding the private endpoint for the governance store.')
@minLength(1)
param privateEndpointSubnetResourceId string

@description('Private DNS zone that resolves the store endpoint to its private address.')
@minLength(1)
param privateDnsZoneResourceId string

var resourceSuffix = take(uniqueString(subscription().id, resourceGroup().id, environmentName), 6)
var accountName = toLower(take('cosmos-${name}-${environmentName}-${resourceSuffix}', 44))

// Must stay identical to app/persistence/container-topology.mjs. The infrastructure
// contract test compares the two, because the application is not permitted to create
// containers at run time.
var containers = [
  {
    name: 'governance'
    partitionKeyPaths: ['/scopeGroupId']
    defaultTtl: null
  }
  {
    name: 'rollups'
    partitionKeyPaths: ['/scopeGroupId']
    defaultTtl: null
  }
  {
    name: 'events'
    partitionKeyPaths: ['/scopeGroupId', '/dateBucket']
    defaultTtl: eventRetentionDays * 86400
  }
  {
    name: 'leases'
    partitionKeyPaths: ['/id']
    defaultTtl: null
  }
]

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: accountName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    // Identity-based access only. No account key can be used.
    disableLocalAuth: true
    disableKeyBasedMetadataWriteAccess: true
    enableAutomaticFailover: true
    publicNetworkAccess: 'Disabled'
    minimalTlsVersion: 'Tls12'
    defaultIdentity: 'FirstPartyIdentity'
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    backupPolicy: {
      type: 'Periodic'
      periodicModeProperties: {
        backupIntervalInMinutes: 240
        backupRetentionIntervalInHours: 8
        backupStorageRedundancy: 'Local'
      }
    }
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
  }
}

resource governanceContainers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = [
  for container in containers: {
    parent: database
    name: container.name
    properties: {
      // A container without a retention policy omits the property. Sending an
      // explicit null is rejected, which only a real deployment revealed.
      resource: union(
        {
          id: container.name
          partitionKey: {
            paths: container.partitionKeyPaths
            kind: length(container.partitionKeyPaths) > 1 ? 'MultiHash' : 'Hash'
            version: 2
          }
        },
        container.defaultTtl == null ? {} : { defaultTtl: container.defaultTtl }
      )
    }
  }
]

// Governance data is never reachable from the internet. The account is closed, so
// the only route to it is this endpoint from inside the network.
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${accountName}-sql'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetResourceId
    }
    privateLinkServiceConnections: [
      {
        name: 'sql'
        properties: {
          privateLinkServiceId: account.id
          groupIds: [
            'Sql'
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
        name: 'sql'
        properties: {
          privateDnsZoneId: privateDnsZoneResourceId
        }
      }
    ]
  }
}

// Data-plane access is granted by governance-store-access.bicep, because the
// identity it grants belongs to a runtime that needs this account's endpoint.

output accountName string = account.name
output accountResourceId string = account.id
output documentEndpoint string = account.properties.documentEndpoint
output databaseName string = database.name
output containerNames array = [for (container, index) in containers: container.name]
output localAuthDisabled bool = true
output capacityMode string = 'Serverless'
output createdResourceIds array = concat(
  [
    account.id
    database.id
  ],
  map(governanceContainers, container => container.id),
  [
    privateEndpoint.id
    privateEndpointDns.id
  ]
)
