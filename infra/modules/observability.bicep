metadata description = 'Shared Log Analytics workspace for the gateway and the control plane.'

@description('Base name used to derive the workspace name.')
@minLength(3)
param name string

@description('Deployment environment discriminator.')
@minLength(1)
@maxLength(20)
param environmentName string

@description('Deployment location.')
param location string = resourceGroup().location

@description('Resource tags.')
param tags object = {}

@description('Retention in days for collected logs.')
@minValue(30)
@maxValue(730)
param dataRetentionDays int = 30

@description('Daily ingestion ceiling in gigabytes. Caps cost when a policy or trigger becomes unexpectedly noisy.')
param dailyQuotaGb string = '0.5'

var resourceSuffix = take(uniqueString(subscription().id, resourceGroup().id, environmentName), 6)
var workspaceName = take('log-${name}-${environmentName}-${resourceSuffix}', 63)

// The gateway and the control plane both write here. It is provisioned ahead of
// both so neither has to depend on the other to obtain a destination.
module workspace 'br/public:avm/res/operational-insights/workspace:0.16.0' = {
  params: {
    name: workspaceName
    location: location
    tags: tags
    dataRetention: dataRetentionDays
    dailyQuotaGb: dailyQuotaGb
    enableTelemetry: false
    features: {
      disableLocalAuth: true
      enableLogAccessUsingOnlyResourcePermissions: true
      immediatePurgeDataOn30Days: true
    }
    forceCmkForQuery: false
    skuName: 'PerGB2018'
  }
}

output workspaceResourceId string = workspace.outputs.resourceId
output workspaceName string = workspaceName
// The query API addresses a workspace by this identifier, not by its resource ID.
output workspaceCustomerId string = workspace.outputs.logAnalyticsWorkspaceId
output createdResourceIds array = [
  workspace.outputs.resourceId
]
