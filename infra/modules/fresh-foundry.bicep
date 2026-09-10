targetScope = 'resourceGroup'

@description('Azure region for the Microsoft Foundry hierarchy.')
param location string = resourceGroup().location

@description('Tags applied to owned Foundry resources.')
param tags object = {}

@description('Globally unique name for the new Microsoft Foundry account.')
@minLength(2)
param foundryAccountName string

@description('Name of the new Microsoft Foundry project.')
@minLength(2)
param foundryProjectName string

@description('Name of the new model deployment.')
@minLength(1)
param deploymentName string

@description('Model catalog name deployed by fresh mode.')
@minLength(1)
param modelName string

@description('Pinned model version deployed by fresh mode.')
@minLength(1)
param modelVersion string

@description('Model format expected by the Cognitive Services deployment resource.')
@minLength(1)
param modelFormat string

@description('Model deployment SKU.')
@minLength(1)
param modelSkuName string

@description('Model deployment capacity in provider-defined units.')
@minValue(1)
param modelCapacity int

@sealed()
type modelDeploymentConfiguration = {
  @minLength(1)
  deploymentName: string
  @minLength(1)
  modelName: string
  @minLength(1)
  modelVersion: string
  @minLength(1)
  modelFormat: string
  @minLength(1)
  skuName: string
  @minValue(1)
  capacity: int
}

@description('Optional second model deployment. Supply either an empty array or exactly one complete object.')
@maxLength(1)
param secondModelDeployments modelDeploymentConfiguration[] = []

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: foundryAccountName
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    allowProjectManagement: true
    customSubDomainName: foundryAccountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
  tags: tags
}

resource foundryProject 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  name: foundryProjectName
  parent: foundryAccount
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: foundryProjectName
    description: 'Microsoft Foundry project created by the fresh distribution preset.'
  }
  tags: tags
}

resource foundryDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  name: deploymentName
  parent: foundryAccount
  sku: {
    name: modelSkuName
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: modelFormat
      name: modelName
      version: modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  tags: tags
}

resource secondFoundryDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [for deployment in secondModelDeployments: {
  name: deployment.deploymentName
  parent: foundryAccount
  sku: {
    name: deployment.skuName
    capacity: deployment.capacity
  }
  properties: {
    model: {
      format: deployment.modelFormat
      name: deployment.modelName
      version: deployment.modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  tags: tags
  dependsOn: [
    foundryDeployment
  ]
}]

var secondDeploymentResourceIds = [for (deployment, index) in secondModelDeployments: secondFoundryDeployment[index].id]

output accountName string = foundryAccount.name
output projectName string = foundryProject.name
output deploymentName string = foundryDeployment.name
output accountResourceId string = foundryAccount.id
output projectResourceId string = foundryProject.id
output deploymentResourceId string = foundryDeployment.id
output secondDeploymentResourceId string = empty(secondModelDeployments) ? '' : secondFoundryDeployment[0].id
output createdResourceIds string[] = concat(
  [
    foundryAccount.id
    foundryProject.id
    foundryDeployment.id
  ],
  secondDeploymentResourceIds
)