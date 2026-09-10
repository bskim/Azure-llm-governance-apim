metadata description = 'Grants a runtime identity data-plane access to the governance store.'

@description('Name of the existing governance store account.')
@minLength(3)
param storeAccountName string

@description('Principal that reads and writes governance documents at run time.')
@minLength(36)
param dataPlanePrincipalId string

// Built-in Azure Cosmos DB Data Contributor. Scoped to this account only, and
// deliberately not a management-plane role: the runtime reads and writes
// documents but can never alter the account or its containers.
var dataContributorRoleDefinitionId = '00000000-0000-0000-0000-000000000002'

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: storeAccountName
}

// This lives outside the store module because the identity being granted access
// belongs to a runtime that itself needs the store endpoint, and one of the two
// has to be created first.
resource dataPlaneAssignment 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: account
  name: guid(account.id, dataPlanePrincipalId, dataContributorRoleDefinitionId)
  properties: {
    principalId: dataPlanePrincipalId
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/${dataContributorRoleDefinitionId}'
    scope: account.id
  }
}

output roleAssignmentName string = dataPlaneAssignment.name
output roleDefinitionId string = dataContributorRoleDefinitionId
output roleAssignmentId string = dataPlaneAssignment.id
output createdResourceIds array = [
  dataPlaneAssignment.id
]
