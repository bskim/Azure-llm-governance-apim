metadata description = 'Grants the governance runtime the account-scoped read access required for Foundry provider metadata, quota, and Azure Monitor metric reads.'

@description('Name of the selected Microsoft Foundry account.')
@minLength(2)
param foundryAccountName string

@description('Function managed identity that reads provider metadata and metrics.')
@minLength(36)
param readerPrincipalId string

// Built-in Monitoring Reader. This grants read-only resource and monitoring access at
// one Foundry account; it deliberately does not grant subscription-wide quota access.
var monitoringReaderRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '43d0d8ad-25c7-4714-9337-8ba259a9fe05'
)

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

resource providerReaderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundryAccount
  name: guid(foundryAccount.id, readerPrincipalId, monitoringReaderRoleDefinitionId)
  properties: {
    roleDefinitionId: monitoringReaderRoleDefinitionId
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Allow the governance runtime to read provider metadata, quota, and metrics for this Foundry account.'
  }
}

output roleAssignmentName string = providerReaderAssignment.name
output roleAssignmentId string = providerReaderAssignment.id
output createdResourceIds array = [
  providerReaderAssignment.id
]
