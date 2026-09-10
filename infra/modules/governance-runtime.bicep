metadata description = 'Serverless compute for the governance control plane, the rollup projector, and the administrative interface.'

@description('Base name used to derive resource names.')
@minLength(3)
@maxLength(12)
param name string

@description('Deployment environment discriminator.')
@minLength(1)
@maxLength(20)
param environmentName string

@description('Deployment location.')
param location string = resourceGroup().location

@description('Origin the administrative interface is served from. It is the only browser origin allowed to call this control plane.')
@minLength(1)
param adminConsoleOrigin string

@description('Resource tags.')
param tags object = {}

@description('Log Analytics workspace that receives platform and application logs.')
param logAnalyticsWorkspaceResourceId string

@description('Resource ID of the selected Foundry account. The runtime uses this account-scoped address for provider metadata, quota, and metric reads.')
@minLength(1)
param providerAccountResourceId string

@description('Governance store endpoint the control plane reads and writes.')
param governanceStoreEndpoint string

@description('Governance store database name.')
param governanceDatabaseName string

@description('Scope the control plane uses for durable governance partitioning and document identifiers.')
@minLength(1)
@maxLength(64)
param governanceScopeGroupId string = 'platform-engineering'

@description('Team keys a global reader may select, comma-separated, sorted, and unique.')
@minLength(1)
param governanceKnownTeamKeys string = 'developer-experience,platform-engineering'

@description('Directory group object IDs assigned to the gateway API, comma-separated. Empty keeps store-backed membership.')
param governanceMembershipGroupIds string = ''

@description('''Maximum instances for each Flex Consumption scale group. This repository pins the unapproved development/verification contract to 28: one always-ready reserve plus seven scale groups times 28 is 197 cores, leaving 53 below the documented 250-core regional default. Raising this requires a separately reviewed, evidence-bound quota contract.''')
@minValue(1)
@maxValue(28)
param maximumInstanceCount int = 28

@description('''Instance memory in megabytes. The local FC1 budget proof is valid only at 2,048 MB, so this deployment contract is pinned rather than allowing 4,096 MB to bypass the core calculation.''')
@allowed([2048])
param instanceMemoryMB int = 2048

@description('''Always-ready instances held for the HTTP scale group. The gateway resolves caller policy on this path when its cache misses, so one instance keeps a cold start off that path. Zero allows full scale to zero and accepts that the first caller after idle resolves against the degraded default cap.''')
@minValue(0)
@maxValue(10)
param httpAlwaysReadyInstances int = 1

@description('''Workspace identifier the usage query addresses. This is the workspace ID the query API expects, not the resource ID. Empty leaves the projector on its unavailable source, which degrades a window rather than inventing a quiet hour.''')
param usageWorkspaceCustomerId string = ''

@description('Audience every caller of this control plane must present.')
@minLength(1)
param controlPlaneAudience string

@description('API Management API whose resource logs carry governed usage.')
@minLength(1)
param governedApiId string = 'inference'

@description('Initial hourly window boundary for schedule backfill when no durable checkpoint exists. Empty begins at the current boundary.')
param rollupStartedFrom string = ''

@description('Node runtime version for the function app.')
@allowed(['22', '24'])
param nodeVersion string = '24'

@description('Subnet the function app routes its outbound traffic through.')
@minLength(1)
param functionSubnetResourceId string

@description('Subnet holding the private endpoints for the platform storage account.')
@minLength(1)
param privateEndpointSubnetResourceId string

@description('Private DNS zone that resolves the blob endpoint to its private address.')
@minLength(1)
param blobPrivateDnsZoneResourceId string

@description('Private DNS zone that resolves the queue endpoint to its private address.')
@minLength(1)
param queuePrivateDnsZoneResourceId string

@description('Private DNS zone that resolves the table endpoint to its private address.')
@minLength(1)
param tablePrivateDnsZoneResourceId string

@description('''Ingress posture for the whole governance administration surface. public-authenticated leaves this control plane addressable from the internet and gated by platform authentication alone. private-only closes it to the public network and reaches it through a private endpoint instead, so the console browser and any deployment agent must already be on the network: a package publish from outside it is refused rather than silently allowed.''')
@allowed([
  'public-authenticated'
  'private-only'
])
param governanceAdministrationIngress string = 'public-authenticated'

@description('Private DNS zone that resolves this control plane to its private address. Read only when the administration surface is private.')
param controlPlanePrivateDnsZoneResourceId string = ''

var resourceSuffix = take(uniqueString(subscription().id, resourceGroup().id, environmentName), 6)
// A storage account name is capped at 24 characters with no separators, so it is
// derived from a fixed-length hash rather than from truncated readable parts:
// truncation would cut the distinguishing suffix off and invite a collision.
var storageAccountName = toLower('st${uniqueString(resourceGroup().id, name, environmentName)}')
var planName = take('plan-${name}-${environmentName}-${resourceSuffix}', 40)
var functionAppName = take('func-${name}-${environmentName}-${resourceSuffix}', 60)
// The control plane is a separate application from the gateway and gets its own
// component, on the workspace both already share so one query spans them.
var applicationInsightsName = take('appi-ctl-${name}-${environmentName}-${resourceSuffix}', 260)
var deploymentContainerName = 'deployment-package'
var privateOnlyAdministration = governanceAdministrationIngress == 'private-only'
// Only the control plane follows the administration posture. The storage account below
// is closed in both postures, because nothing outside this network ever addresses it.
var controlPlanePublicNetworkAccess = privateOnlyAdministration ? 'Disabled' : 'Enabled'

// The host reaches blob for the deployment package and its own metadata, and probes
// queue and table as part of starting. Leaving either of those two on the public
// name would resolve to an endpoint the account now refuses.
var storagePrivateEndpoints = [
  {
    group: 'blob'
    dnsZoneResourceId: blobPrivateDnsZoneResourceId
  }
  {
    group: 'queue'
    dnsZoneResourceId: queuePrivateDnsZoneResourceId
  }
  {
    group: 'table'
    dnsZoneResourceId: tablePrivateDnsZoneResourceId
  }
]

// Platform metadata and the deployment package only. Governance data lives in the
// governance store, never here. Nothing outside the network reaches it: this is an
// internal tool, so the deployment does not start from an account the internet can
// address and then try to narrow it later.
resource storage 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

resource storagePrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = [
  for endpoint in storagePrivateEndpoints: {
    name: 'pe-${storageAccountName}-${endpoint.group}'
    location: location
    tags: tags
    properties: {
      subnet: {
        id: privateEndpointSubnetResourceId
      }
      privateLinkServiceConnections: [
        {
          name: endpoint.group
          properties: {
            privateLinkServiceId: storage.id
            groupIds: [
              endpoint.group
            ]
          }
        }
      ]
    }
  }
]

resource storagePrivateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = [
  for (endpoint, index) in storagePrivateEndpoints: {
    parent: storagePrivateEndpoint[index]
    name: 'default'
    properties: {
      privateDnsZoneConfigs: [
        {
          name: endpoint.group
          properties: {
            privateDnsZoneId: endpoint.dnsZoneResourceId
          }
        }
      ]
    }
  }
]

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2024-01-01' = {
  parent: storage
  name: 'default'
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' = {
  parent: blobService
  name: deploymentContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  tags: tags
  sku: {
    tier: 'FlexConsumption'
    name: 'FC1'
  }
  kind: 'functionapp'
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  // The deployment tool finds the resource a service belongs to by this tag.
  tags: union(tags, { 'azd-service-name': 'control-plane' })
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    publicNetworkAccess: controlPlanePublicNetworkAccess
    // This app must be created with integration already in place. Flex Consumption
    // fixes the network context of its deployment path at creation, so an app created
    // without a subnet and integrated afterwards keeps uploading the deployment
    // package from outside the network and is refused by the private storage account.
    // Recreate the app rather than patching integration onto an existing one.
    virtualNetworkSubnetId: functionSubnetResourceId
    vnetRouteAllEnabled: true
    siteConfig: {
      // The console is served from another origin, so it is named here rather than
      // letting any page in a browser call this API. Credentials are not shared,
      // because the console presents a bearer token instead of a cookie.
      cors: {
        allowedOrigins: [
          adminConsoleOrigin
        ]
        supportCredentials: false
      }
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: {
            // Shared key access is disabled on the account, so the platform reads
            // the deployment package with the app's own identity.
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: instanceMemoryMB
        alwaysReady: [
          {
            name: 'http'
            instanceCount: httpAlwaysReadyInstances
          }
        ]
      }
      runtime: {
        name: 'node'
        version: nodeVersion
      }
    }
  }
  dependsOn: [
    storagePrivateEndpointDns
  ]
}

// The endpoint the console browser and the deployment agent reach once the public name
// is closed. A private endpoint without its zone group resolves the public name it can
// no longer reach, so the two are declared together.
resource controlPlanePrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateOnlyAdministration) {
  name: take('pe-${functionAppName}-sites', 80)
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetResourceId
    }
    privateLinkServiceConnections: [
      {
        name: 'sites'
        properties: {
          privateLinkServiceId: functionApp.id
          groupIds: [
            'sites'
          ]
        }
      }
    ]
  }
}

resource controlPlanePrivateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateOnlyAdministration) {
  parent: controlPlanePrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'sites'
        properties: {
          privateDnsZoneId: controlPlanePrivateDnsZoneResourceId
        }
      }
    ]
  }
}

module applicationInsights 'br/public:avm/res/insights/component:0.8.0' = {
  params: {
    name: applicationInsightsName
    location: location
    tags: tags
    workspaceResourceId: logAnalyticsWorkspaceResourceId
    applicationType: 'web'
    disableIpMasking: false
    disableLocalAuth: true
    enableTelemetry: false
    immediatePurgeDataOn30Days: true
    retentionInDays: 30
    samplingPercentage: 100
  }
}

var baseAppSettings = {
  // Identity-based connections only. No account key or storage connection string is
  // stored anywhere in this deployment.
  AzureWebJobsStorage__accountName: storage.name
  AzureWebJobsStorage__credential: 'managedidentity'
  GOVERNANCE_STORE_ENDPOINT: governanceStoreEndpoint
  GOVERNANCE_DATABASE_NAME: governanceDatabaseName
  GOVERNANCE_SCOPE_GROUP_ID: governanceScopeGroupId
  GOVERNANCE_KNOWN_TEAM_KEYS: governanceKnownTeamKeys
  GOVERNANCE_MEMBERSHIP_SOURCE: empty(governanceMembershipGroupIds) ? 'store' : 'directory-claim'
  USAGE_WORKSPACE_ID: usageWorkspaceCustomerId
  GOVERNED_API_ID: governedApiId
  ROLLUP_STARTED_FROM: rollupStartedFrom
  PROVIDER_ACCOUNT_RESOURCE_ID: providerAccountResourceId
  CONTROL_PLANE_AUDIENCE: controlPlaneAudience
  // Both are required: the first says where telemetry goes, the second that it is
  // sent with this app's identity. Without the connection string the host has no
  // destination and every scheduled outcome is silently discarded.
  APPLICATIONINSIGHTS_CONNECTION_STRING: applicationInsights.outputs.connectionString
  APPLICATIONINSIGHTS_AUTHENTICATION_STRING: 'Authorization=AAD'
}

resource appSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: baseAppSettings
}

resource applicationInsightsResource 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}

var monitoringMetricsPublisherRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '3913510d-42f4-4e42-8a64-420c390055eb'
)

// Local authentication is disabled on the component, so without this the host holds a
// destination it is refused at, which looks exactly like sending nothing.
resource applicationInsightsPublisherRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationInsightsResource.id, functionAppName, monitoringMetricsPublisherRoleDefinitionId)
  scope: applicationInsightsResource
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleDefinitionId
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
    description: 'Allow the control plane to publish its own telemetry.'
  }
  dependsOn: [
    applicationInsights
  ]
}

// The host reads its own metadata and the deployment package with this identity.
var storageBlobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'

resource storageRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, storageBlobDataOwnerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataOwnerRoleId
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource functionDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: functionApp
  name: 'governance-control-plane'
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// The administrative interface is static, so it is served as static content
// rather than by paying a function execution to return a file that never changes.
output functionAppName string = functionApp.name
output baseAppSettings object = baseAppSettings
output functionAppPrincipalId string = functionApp.identity.principalId
output functionAppEndpoint string = 'https://${functionApp.properties.defaultHostName}'
output policyResolutionEndpoint string = 'https://${functionApp.properties.defaultHostName}/api/v1/internal/effective-policy'
output storageAccountName string = storage.name
output httpAlwaysReadyInstances int = httpAlwaysReadyInstances
output createdResourceIds array = concat(
  [
    storage.id
    blobService.id
    deploymentContainer.id
    plan.id
    functionApp.id
    applicationInsights.outputs.resourceId
    appSettings.id
    applicationInsightsPublisherRole.id
    storageRoleAssignment.id
    functionDiagnostics.id
  ],
  map(storagePrivateEndpoint, endpoint => endpoint.id),
  map(storagePrivateEndpointDns, dnsGroup => dnsGroup.id),
  privateOnlyAdministration
    ? [
        controlPlanePrivateEndpoint.id
        controlPlanePrivateEndpointDns.id
      ]
    : []
)
output roleAssignmentIds array = [
  applicationInsightsPublisherRole.id
  storageRoleAssignment.id
]
