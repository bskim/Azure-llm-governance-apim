targetScope = 'subscription'

extension microsoftGraphV1

@description('Stable workload name used to derive application registration names.')
@minLength(1)
param name string

@description('Deployment location metadata.')
param location string

@description('Deployment tags retained as module metadata.')
param tags object = {}

@description('Short environment identifier used in application registration names.')
@minLength(1)
param environmentName string

@description('Object ID of the human or group that owns the gateway app registrations.')
@minLength(36)
param entraApplicationOwnerObjectId string

@description('''Object ID of the user or group that receives the governance administrator role at deployment. Required: governance configuration is authored through the console, so a deployment with no administrator produces a system nobody can configure.''')
@minLength(36)
param governanceAdministratorPrincipalId string

@description('Directory group object IDs assigned to the gateway API, comma-separated. Empty creates no governed-team assignment.')
param governanceMembershipGroupIds string = ''

@description('''Origin the deployed administrative interface is served from. Entra refuses a sign-in redirect to any origin not listed here, so the deployed console has to be named at deployment rather than added by hand afterwards.''')
@minLength(1)
param adminConsoleOrigin string

@description('Local development origin for the administrative interface.')
param adminConsoleDevelopmentOrigin string = 'http://localhost:4173'

var identitySuffix = take(uniqueString(tenant().tenantId, name, environmentName), 13)
var gatewayApiUniqueName = '${name}-api-${environmentName}-${identitySuffix}'
var gatewayCliUniqueName = '${name}-cli-${environmentName}-${identitySuffix}'
var gatewayApiIdentifierUri = 'api://${tenant().tenantId}/${gatewayApiUniqueName}'
var gatewayAccessScope = 'Gateway.Access'
var gatewayAccessScopeId = guid(tenant().tenantId, gatewayApiUniqueName, gatewayAccessScope)
var governedMembershipGroupIds = empty(governanceMembershipGroupIds) ? [] : split(governanceMembershipGroupIds, ',')

// The governance API is a separate resource from the inference gateway so a token
// minted to call a model can never be replayed against administration.
var adminApiUniqueName = '${name}-admin-api-${environmentName}-${identitySuffix}'
var adminSpaUniqueName = '${name}-admin-spa-${environmentName}-${identitySuffix}'
var adminApiIdentifierUri = 'api://${tenant().tenantId}/${adminApiUniqueName}'
var adminAccessScope = 'Governance.Access'
var adminAccessScopeId = guid(tenant().tenantId, adminApiUniqueName, adminAccessScope)
var administerRole = 'Governance.Administer'
var readRole = 'Governance.Read'
var resolvePolicyRole = 'Policy.Resolve'
var administerRoleId = guid(tenant().tenantId, adminApiUniqueName, administerRole)
var readRoleId = guid(tenant().tenantId, adminApiUniqueName, readRole)
var resolvePolicyRoleId = guid(tenant().tenantId, adminApiUniqueName, resolvePolicyRole)

resource gatewayCliApplication 'Microsoft.Graph/applications@v1.0' = {
  displayName: 'LLM Governance Gateway CLI (${environmentName})'
  uniqueName: gatewayCliUniqueName
  description: 'Single-tenant public client for interactive AI gateway access.'
  signInAudience: 'AzureADMyOrg'
  isFallbackPublicClient: true
  publicClient: {
    redirectUris: [
      'http://localhost'
    ]
  }
  owners: {
    relationshipSemantics: 'append'
    relationships: [
      entraApplicationOwnerObjectId
    ]
  }
  tags: [
    'llm-governance-apim'
    environmentName
    'public-client'
  ]
}

resource gatewayApiApplication 'Microsoft.Graph/applications@v1.0' = {
  displayName: 'LLM Governance Gateway API (${environmentName})'
  uniqueName: gatewayApiUniqueName
  description: 'Single-tenant resource API for governed model inference.'
  signInAudience: 'AzureADMyOrg'
  groupMembershipClaims: 'ApplicationGroup'
  identifierUris: [
    gatewayApiIdentifierUri
  ]
  api: {
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: gatewayAccessScopeId
        adminConsentDisplayName: 'Access the LLM governance gateway'
        adminConsentDescription: 'Allows this application to call governed model inference operations on behalf of the signed-in user.'
        userConsentDisplayName: 'Access the LLM governance gateway'
        userConsentDescription: 'Allows this application to call governed model inference operations on your behalf.'
        value: gatewayAccessScope
        type: 'User'
        isEnabled: true
      }
    ]
    preAuthorizedApplications: [
      {
        appId: gatewayCliApplication.appId
        delegatedPermissionIds: [
          gatewayAccessScopeId
        ]
      }
    ]
  }
  optionalClaims: {
    accessToken: [
      {
        name: 'acct'
        essential: false
      }
    ]
  }
  owners: {
    relationshipSemantics: 'append'
    relationships: [
      entraApplicationOwnerObjectId
    ]
  }
  tags: [
    'llm-governance-apim'
    environmentName
    'resource-api'
  ]
}

resource gatewayCliServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: gatewayCliApplication.appId
  displayName: gatewayCliApplication.displayName
  appRoleAssignmentRequired: false
  tags: [
    'WindowsAzureActiveDirectoryIntegratedApp'
  ]
}

resource gatewayApiServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: gatewayApiApplication.appId
  displayName: gatewayApiApplication.displayName
  appRoleAssignmentRequired: false
  tags: [
    'WindowsAzureActiveDirectoryIntegratedApp'
  ]
}

resource governedTeamGroupGrants 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [for groupId in governedMembershipGroupIds: {
  appRoleId: '00000000-0000-0000-0000-000000000000'
  principalId: groupId
  resourceId: gatewayApiServicePrincipal.id
}]

resource adminSpaApplication 'Microsoft.Graph/applications@v1.0' = {
  displayName: 'LLM Governance Admin Console (${environmentName})'
  uniqueName: adminSpaUniqueName
  description: 'Single-tenant single-page client for the governance administration interface.'
  signInAudience: 'AzureADMyOrg'
  // Registered on both platforms: the console is a browser app (spa), and the
  // bootstrap initializer must also sign in where no browser can receive a
  // redirect at all (a jump host, a container, an isolated network, CI).
  isFallbackPublicClient: true
  spa: {
    redirectUris: union([adminConsoleOrigin], [adminConsoleDevelopmentOrigin])
  }
  // Entra ignores localhost ports when matching redirects. A distinct native
  // path prevents the initializer and local SPA from selecting each other's flow.
  publicClient: {
    redirectUris: [
      'http://localhost/governance-bootstrap'
    ]
  }
  owners: {
    relationshipSemantics: 'append'
    relationships: [
      entraApplicationOwnerObjectId
    ]
  }
  tags: [
    'llm-governance-apim'
    environmentName
    'spa-client'
  ]
}

resource adminApiApplication 'Microsoft.Graph/applications@v1.0' = {
  displayName: 'LLM Governance Administration API (${environmentName})'
  uniqueName: adminApiUniqueName
  description: 'Single-tenant resource API for governance administration and reporting.'
  signInAudience: 'AzureADMyOrg'
  // Preview needs the caller's governed memberships, not just groups assigned admin roles.
  groupMembershipClaims: 'SecurityGroup'
  identifierUris: [
    adminApiIdentifierUri
  ]
  // Two roles, because governance has exactly two capabilities to separate: changing
  // budgets and configuration, and reading what they did. A model caller receives
  // neither, so an ordinary gateway user has no administration access at all.
  appRoles: [
    {
      id: administerRoleId
      allowedMemberTypes: [
        'User'
      ]
      displayName: 'Governance Administrator'
      description: 'Read governance state and change budgets, entitlements, and configuration.'
      value: administerRole
      isEnabled: true
    }
    {
      id: readRoleId
      allowedMemberTypes: [
        'User'
      ]
      displayName: 'Governance Auditor'
      description: 'Read governance state, budgets, and usage reporting without changing anything.'
      value: readRole
      isEnabled: true
    }
    {
      // The gateway is a machine caller resolving caller policy. It holds neither
      // human role, so it can never read administration data.
      id: resolvePolicyRoleId
      allowedMemberTypes: [
        'Application'
      ]
      displayName: 'Policy Resolution'
      description: 'Resolve the effective policy for a caller during request admission.'
      value: resolvePolicyRole
      isEnabled: true
    }
  ]
  api: {
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: adminAccessScopeId
        adminConsentDisplayName: 'Access governance administration'
        adminConsentDescription: 'Allows this application to call governance administration operations on behalf of the signed-in user.'
        userConsentDisplayName: 'Access governance administration'
        userConsentDescription: 'Allows this application to call governance administration operations on your behalf.'
        value: adminAccessScope
        type: 'Admin'
        isEnabled: true
      }
    ]
    preAuthorizedApplications: [
      {
        appId: adminSpaApplication.appId
        delegatedPermissionIds: [
          adminAccessScopeId
        ]
      }
    ]
  }
  owners: {
    relationshipSemantics: 'append'
    relationships: [
      entraApplicationOwnerObjectId
    ]
  }
  tags: [
    'llm-governance-apim'
    environmentName
    'resource-api'
  ]
}

resource adminSpaServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: adminSpaApplication.appId
  displayName: adminSpaApplication.displayName
  appRoleAssignmentRequired: false
  tags: [
    'WindowsAzureActiveDirectoryIntegratedApp'
  ]
}

// Entra refuses a token to anyone without a role assignment, so an unassigned
// caller is stopped before the API is ever reached.
resource adminApiServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: adminApiApplication.appId
  displayName: adminApiApplication.displayName
  appRoleAssignmentRequired: true
  tags: [
    'WindowsAzureActiveDirectoryIntegratedApp'
  ]
}

// The first administrator is granted at deployment because everything else is
// authored through the console. Without this the deployment would stand up a
// governance system that nobody is permitted to configure. A group is the better
// choice here than a person, and either is accepted.
resource governanceAdministratorGrant 'Microsoft.Graph/appRoleAssignedTo@v1.0' = {
  appRoleId: administerRoleId
  principalId: governanceAdministratorPrincipalId
  resourceId: adminApiServicePrincipal.id
}

output deploymentLocation string = location
output deploymentTags object = tags
output apiApplicationId string = gatewayApiApplication.appId
output apiAudience string = gatewayApiApplication.appId
output apiScope string = '${gatewayApiIdentifierUri}/${gatewayAccessScope}'
output cliApplicationId string = gatewayCliApplication.appId
output requiredScope string = gatewayAccessScope
output tenantId string = tenant().tenantId
output adminApiApplicationId string = adminApiApplication.appId
output adminApiAudience string = adminApiApplication.appId
output adminApiScope string = '${adminApiIdentifierUri}/${adminAccessScope}'
output adminApiServicePrincipalId string = adminApiServicePrincipal.id
output adminSpaApplicationId string = adminSpaApplication.appId
output adminAdministerRole string = administerRole
output adminReadRole string = readRole
output policyResolveRoleId string = resolvePolicyRoleId
output createdDirectoryObjects array = [
  {
    kind: 'entra-application'
    objectId: gatewayApiApplication.id
    appId: gatewayApiApplication.appId
  }
  {
    kind: 'entra-application'
    objectId: gatewayCliApplication.id
    appId: gatewayCliApplication.appId
  }
  {
    kind: 'entra-application'
    objectId: adminApiApplication.id
    appId: adminApiApplication.appId
  }
  {
    kind: 'entra-application'
    objectId: adminSpaApplication.id
    appId: adminSpaApplication.appId
  }
  {
    kind: 'entra-service-principal'
    objectId: gatewayApiServicePrincipal.id
    applicationObjectId: gatewayApiApplication.id
    appId: gatewayApiApplication.appId
  }
  {
    kind: 'entra-service-principal'
    objectId: gatewayCliServicePrincipal.id
    applicationObjectId: gatewayCliApplication.id
    appId: gatewayCliApplication.appId
  }
  {
    kind: 'entra-service-principal'
    objectId: adminApiServicePrincipal.id
    applicationObjectId: adminApiApplication.id
    appId: adminApiApplication.appId
  }
  {
    kind: 'entra-service-principal'
    objectId: adminSpaServicePrincipal.id
    applicationObjectId: adminSpaApplication.id
    appId: adminSpaApplication.appId
  }
]
output createdGraphAssignmentIds array = concat(
  map(governedTeamGroupGrants, grant => grant.id),
  [
    governanceAdministratorGrant.id
  ]
)
