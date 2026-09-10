metadata description = 'Grants a runtime identity read access to the usage log source.'

@description('Name of the existing shared Log Analytics workspace.')
@minLength(4)
param workspaceName string

@description('Principal that reads usage windows at run time.')
@minLength(36)
param usageReaderPrincipalId string

// Built-in Log Analytics Reader. It permits querying this workspace and nothing
// else: the projector reads usage windows but can never change collection,
// retention, or the diagnostic settings that feed it.
var logAnalyticsReaderRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '73c42c96-874c-492b-b04d-ab87d138a893'
)

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: workspaceName
}

// This lives outside the observability module for the same reason the store grant
// does: the identity being granted access belongs to a runtime created later.
resource usageReaderAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: workspace
  name: guid(workspace.id, usageReaderPrincipalId, logAnalyticsReaderRoleDefinitionId)
  properties: {
    roleDefinitionId: logAnalyticsReaderRoleDefinitionId
    principalId: usageReaderPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Allow the scheduled projector to read usage windows from gateway resource logs.'
  }
}

output roleAssignmentName string = usageReaderAssignment.name
output roleAssignmentId string = usageReaderAssignment.id
output createdResourceIds array = [
  usageReaderAssignment.id
]
