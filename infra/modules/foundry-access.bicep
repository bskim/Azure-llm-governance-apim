targetScope = 'resourceGroup'

@description('Stable name for the Foundry access assignment.')
@minLength(1)
param name string

@description('Deployment location metadata.')
param location string = resourceGroup().location

@description('Deployment tags retained as module metadata.')
param tags object = {}

@description('Name of the existing Microsoft Foundry account in this resource group.')
@minLength(2)
param foundryAccountName string

@description('Object ID of the API Management system-assigned managed identity.')
@minLength(36)
param principalId string

@description('Deterministic role-assignment resource name calculated without runtime identity properties.')
param roleAssignmentName string

var cognitiveServicesOpenAIUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
)

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

resource foundryInferenceRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: roleAssignmentName
  scope: foundryAccount
  properties: {
    roleDefinitionId: cognitiveServicesOpenAIUserRoleDefinitionId
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: '${name}: allow the AI gateway to invoke existing OpenAI model deployments.'
  }
}

output deploymentLocation string = location
output deploymentTags object = tags
output roleAssignmentId string = foundryInferenceRole.id
output createdResourceIds array = [
  foundryInferenceRole.id
]
