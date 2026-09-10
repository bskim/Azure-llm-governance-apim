targetScope = 'resourceGroup'

@description('Existing Function App whose administration routes are protected.')
param functionAppName string

@description('Microsoft Entra tenant accepted by the administration API.')
param entraTenantId string

@description('Administration API audience accepted by Easy Auth.')
param controlPlaneAudience string

resource functionApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionAppName
}

// The platform validates the token before a request reaches a handler. Authorization
// remains in Entra app-role assignments and handler capability checks, so this document
// deliberately carries no client or principal allowlist.
resource authentication 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  properties: {
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'Return401'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [
        '/api/healthz'
      ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
          clientId: controlPlaneAudience
        }
        validation: {
          allowedAudiences: [
            controlPlaneAudience
            'api://${controlPlaneAudience}'
          ]
          // App Service materializes an empty allowedApplications collection when the whole policy is
          // omitted. On Flex Consumption that empty key is enforced as deny-all even
          // though the documented contract restricts only nonempty arrays. Author the
          // neutral principal policy explicitly so the client allowlist key stays absent.
          defaultAuthorizationPolicy: {
            allowedPrincipals: {}
          }
        }
      }
    }
    login: {
      tokenStore: {
        enabled: false
      }
    }
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
  }
}

output configurationResourceId string = authentication.id
output createdResourceIds array = [
  authentication.id
]