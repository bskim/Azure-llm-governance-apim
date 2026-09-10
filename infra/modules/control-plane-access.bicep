targetScope = 'subscription'

extension microsoftGraphV1

metadata description = 'Grants the gateway identity the machine role it needs to resolve caller policy.'

@description('Object ID of the governance API service principal that owns the role.')
@minLength(36)
param adminApiServicePrincipalId string

@description('Application role ID granted for policy resolution.')
@minLength(36)
param policyResolveRoleId string

@description('Principal ID of the gateway managed identity that resolves caller policy.')
@minLength(36)
param gatewayPrincipalId string

// This lives outside the identity module because the identity being granted the
// role belongs to a gateway created after the app registrations exist.
resource policyResolutionGrant 'Microsoft.Graph/appRoleAssignedTo@v1.0' = {
  appRoleId: policyResolveRoleId
  principalId: gatewayPrincipalId
  resourceId: adminApiServicePrincipalId
}

output roleAssignmentId string = policyResolutionGrant.id
output createdGraphAssignmentIds array = [
  policyResolutionGrant.id
]
