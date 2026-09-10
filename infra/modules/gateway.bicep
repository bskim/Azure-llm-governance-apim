targetScope = 'resourceGroup'

@description('Stable workload name used to derive Azure resource names.')
@minLength(1)
param name string

@description('Globally unique API Management service name.')
@minLength(1)
param apimName string

@description('Azure region for all resources in this module.')
param location string = resourceGroup().location

@description('Tags applied to resources that support tags.')
param tags object = {}

@description('Short environment identifier used in resource names.')
@minLength(1)
param environmentName string

@description('API Management publisher organization name.')
param publisherName string

@description('API Management publisher contact email.')
param publisherEmail string

@description('API Management SKU. BasicV2 is the public default; Developer is intended only for bounded non-production verification.')
@allowed([
  'BasicV2'
  'Developer'
])
param apimSku string = 'BasicV2'

@description('Microsoft Entra tenant that issues gateway access tokens.')
param entraTenantId string

@description('Audience required in gateway access tokens.')
param entraApiAudience string

@description('Interactive client application allowed to call the gateway.')
param entraClientApplicationId string

@description('Delegated scope required in gateway access tokens.')
param entraRequiredScope string

@description('Azure CLI public client permitted to reach the gateway from a local sign-in. The nil GUID when the profile is not configured, which no client can present.')
param entraDeveloperClientApplicationId string = '00000000-0000-0000-0000-000000000000'

@description('Application role an Azure-hosted workload must carry to use the workload authentication branch instead of the delegated one. The literal "disabled" when not configured.')
param entraWorkloadAppRole string = 'disabled'

@description('Name of the existing Microsoft Foundry account.')
param foundryAccountName string

@description('Second Microsoft Foundry account whose deployments can share load with the first. Empty when no second account exists, which leaves one backend serving everything.')
param secondaryFoundryAccountName string = ''

@description('Comma-separated deployment names every pool member serves. Empty means no model is pooled and the primary backend serves every request.')
param pooledModelDeployments string = ''

@description('Public logical model alias accepted from clients.')
param logicalModelAlias string

@description('Existing Foundry deployment selected by the logical alias.')
param defaultModelDeploymentName string

@description('Protective per-caller request limit.')
@minValue(1)
param requestsPerMinute int

@description('Protective per-caller token limit.')
@minValue(1)
param tokensPerMinute int

@description('''Existing Log Analytics workspace the gateway writes to. Leave empty to have this module create one.''')
param logAnalyticsWorkspaceResourceId string = ''

@description('Endpoint that resolves a caller effective policy document on a cache miss.')
param governancePolicyEndpoint string = ''

@description('Managed identity audience for the governance policy endpoint.')
param governancePolicyAudience string = ''

@description('Enable policy resolution only after a durable published-policy source is deployed.')
param governancePolicyEnabled bool = false

@description('''How long the gateway waits for caller policy before refusing. Measured 2026-08-18 over ten
forced restarts, the control plane answered in 1.13 to 5.39 seconds, and resolution itself adds 84 ms at the
median and 411 ms at its worst. Waiting used to be pure cost, because a caller who timed out was served a
deployment default anyway; since that grant was withdrawn, waiting is what turns a refusal into a success. The
ceiling stays, because the wait is also how long a caller sits before being refused when the control plane is
genuinely down.''')
@minValue(8)
@maxValue(10)
param governancePolicyTimeoutSeconds int = 10

@description('How long a resolved caller policy stays cached in the gateway.')
@minValue(5)
@maxValue(3600)
param policyCacheSeconds int = 60

@description('Sentence prepended to a non-streamed response whose model was substituted. {model} is replaced with the model that answered.')
param substitutionNoticeText string = 'Note: organization policy served this response with a different model. Model used: {model}'

var resourceSuffix = take(uniqueString(subscription().id, resourceGroup().id, environmentName), 6)
var logAnalyticsName = take('log-${name}-${environmentName}-${resourceSuffix}', 63)
var applicationInsightsName = take('appi-${name}-${environmentName}-${resourceSuffix}', 260)
var foundryBackendName = 'foundry-account-openai-v1'
var foundryBackendUrl = 'https://${foundryAccountName}.cognitiveservices.azure.com/openai/v1'
var secondaryBackendName = 'foundry-secondary-openai-v1'
var secondaryBackendUrl = 'https://${secondaryFoundryAccountName}.cognitiveservices.azure.com/openai/v1'
var secondaryBackendConfigured = !empty(secondaryFoundryAccountName)
var poolBackendName = 'foundry-account-pool'
// 429 is deliberately absent from the failure condition. A provider throttling one caller is
// not a broken backend, and tripping on it would turn that caller's rate limit into an outage
// for every other caller of a backend that is still healthy; the 429 and its Retry-After are
// relayed to the caller unchanged instead. Do not add 429 here.
var backendCircuitBreaker = {
  rules: [
    {
      name: 'backend-server-errors'
      failureCondition: {
        count: 5
        interval: 'PT1M'
        errorReasons: [
          'Server errors'
        ]
        statusCodeRanges: [
          {
            min: 500
            max: 599
          }
        ]
      }
      tripDuration: 'PT1M'
      acceptRetryAfter: true
    }
  ]
}
var poolMembers = concat(
  [
    {
      id: resourceId('Microsoft.ApiManagement/service/backends', apimName, foundryBackendName)
      priority: 1
      weight: 50
    }
  ],
  secondaryBackendConfigured
    ? [
        {
          id: resourceId('Microsoft.ApiManagement/service/backends', apimName, secondaryBackendName)
          priority: 1
          weight: 50
        }
      ]
    : []
)
var publicApiDefinition = loadJsonContent('../../apim/apis/inference.openapi.json')
var inferencePolicyXml = loadTextContent('../../apim/policies/inference.xml')
var oauthProtectedResourceApiDefinition = loadJsonContent('../../apim/apis/oauth-protected-resource.openapi.json')
var oauthProtectedResourcePolicyXml = loadTextContent('../../apim/policies/oauth-protected-resource.xml')
var apimApiDefinition = shallowMerge([
  publicApiDefinition
  {
    servers: []
    paths: {
      '/chat/completions': publicApiDefinition.paths['/v1/chat/completions']
      '/responses': publicApiDefinition.paths['/v1/responses']
    }
  }
])

module logAnalytics 'br/public:avm/res/operational-insights/workspace:0.16.0' = if (empty(logAnalyticsWorkspaceResourceId)) {
  params: {
    name: logAnalyticsName
    location: location
    tags: tags
    dataRetention: 30
    dailyQuotaGb: '0.5'
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

// The control plane writes to the same workspace, so it is provisioned outside
// this module and passed in. The fallback keeps standalone gateway deployments
// working unchanged.
var workspaceResourceId = empty(logAnalyticsWorkspaceResourceId)
  ? logAnalytics!.outputs.resourceId
  : logAnalyticsWorkspaceResourceId

module applicationInsights 'br/public:avm/res/insights/component:0.8.0' = {
  params: {
    name: applicationInsightsName
    location: location
    tags: tags
    workspaceResourceId: workspaceResourceId
    applicationType: 'web'
    disableIpMasking: false
    disableLocalAuth: true
    enableTelemetry: false
    immediatePurgeDataOn30Days: true
    retentionInDays: 30
    samplingPercentage: 100
  }
}

module apim 'br/public:avm/res/api-management/service:0.14.4' = {
  params: {
    name: apimName
    location: location
    tags: tags
    publisherName: publisherName
    publisherEmail: publisherEmail
    sku: apimSku
    skuCapacity: 1
    enableDeveloperPortal: false
    enableTelemetry: false
    managedIdentities: {
      systemAssigned: true
    }
    minApiVersion: '2021-08-01'
    publicNetworkAccess: 'Enabled'
    backends: concat(
      [
        {
          name: foundryBackendName
          description: 'Existing Microsoft Foundry account OpenAI v1 endpoint.'
          protocol: 'http'
          type: 'Single'
          url: foundryBackendUrl
          circuitBreaker: backendCircuitBreaker
          tls: {
            validateCertificateChain: true
            validateCertificateName: true
          }
        }
      ],
      secondaryBackendConfigured
        ? [
            {
              name: secondaryBackendName
              description: 'Second Microsoft Foundry account OpenAI v1 endpoint sharing the pooled deployments.'
              protocol: 'http'
              type: 'Single'
              url: secondaryBackendUrl
              circuitBreaker: backendCircuitBreaker
              tls: {
                validateCertificateChain: true
                validateCertificateName: true
              }
            }
          ]
        : []
    )
    diagnosticSettings: [
      {
        name: 'apim-platform-logs'
        workspaceResourceId: workspaceResourceId
        logAnalyticsDestinationType: 'Dedicated'
        logCategoriesAndGroups: [
          {
            categoryGroup: 'allLogs'
            enabled: true
          }
        ]
        metricCategories: [
          {
            category: 'AllMetrics'
            enabled: true
          }
        ]
      }
    ]
    loggers: [
      {
        name: 'applicationinsights'
        type: 'applicationInsights'
        targetResourceId: applicationInsights.outputs.resourceId
        credentials: {
          connectionString: applicationInsights.outputs.connectionString
          identityClientId: 'systemAssigned'
        }
        isBuffered: true
      }
      {
        name: 'azuremonitor'
        type: 'azureMonitor'
        isBuffered: true
      }
    ]
    namedValues: [
      {
        name: 'entra-tenant-id'
        displayName: 'entra-tenant-id'
        secret: false
        value: entraTenantId
      }
      {
        name: 'entra-api-audience'
        displayName: 'entra-api-audience'
        secret: false
        value: entraApiAudience
      }
      {
        name: 'entra-client-application-id'
        displayName: 'entra-client-application-id'
        secret: false
        value: entraClientApplicationId
      }
      {
        name: 'entra-required-scope'
        displayName: 'entra-required-scope'
        secret: false
        value: entraRequiredScope
      }
      {
        name: 'entra-developer-client-application-id'
        displayName: 'entra-developer-client-application-id'
        secret: false
        value: entraDeveloperClientApplicationId
      }
      {
        name: 'entra-workload-app-role'
        displayName: 'entra-workload-app-role'
        secret: false
        value: entraWorkloadAppRole
      }
      {
        name: 'gateway-host'
        displayName: 'gateway-host'
        secret: false
        value: '${apimName}.azure-api.net'
      }
      {
        name: 'default-model-alias'
        displayName: 'default-model-alias'
        secret: false
        value: logicalModelAlias
      }
      {
        name: 'default-model-deployment'
        displayName: 'default-model-deployment'
        secret: false
        value: defaultModelDeploymentName
      }
      {
        name: 'gateway-policy-version'
        displayName: 'gateway-policy-version'
        secret: false
        value: '1.1.3'
      }
      {
        name: 'requests-per-minute'
        displayName: 'requests-per-minute'
        secret: false
        value: string(requestsPerMinute)
      }
      {
        name: 'organization-tokens-per-minute'
        displayName: 'organization-tokens-per-minute'
        secret: false
        value: string(tokensPerMinute)
      }
      {
        name: 'governance-policy-endpoint'
        displayName: 'governance-policy-endpoint'
        secret: false
        value: empty(governancePolicyEndpoint) ? ' ' : governancePolicyEndpoint
      }
      {
        name: 'governance-policy-audience'
        displayName: 'governance-policy-audience'
        secret: false
        value: empty(governancePolicyAudience) ? ' ' : governancePolicyAudience
      }
      {
        name: 'governance-policy-enabled'
        displayName: 'governance-policy-enabled'
        secret: false
        value: string(governancePolicyEnabled)
      }
      {
        name: 'allow-ungoverned-evaluation-mode'
        displayName: 'allow-ungoverned-evaluation-mode'
        secret: false
        value: 'false'
      }
      {
        name: 'default-effective-policy'
        displayName: 'default-effective-policy'
        secret: false
        value: '{}'
      }
      {
        name: 'governance-policy-timeout-seconds'
        displayName: 'governance-policy-timeout-seconds'
        secret: false
        value: string(governancePolicyTimeoutSeconds)
      }
      {
        name: 'policy-cache-seconds'
        displayName: 'policy-cache-seconds'
        secret: false
        value: string(policyCacheSeconds)
      }
      {
        name: 'throttle-tier-reduced-calls'
        displayName: 'throttle-tier-reduced-calls'
        secret: false
        value: string(max(1, requestsPerMinute / 2))
      }
      {
        name: 'throttle-tier-minimal-calls'
        displayName: 'throttle-tier-minimal-calls'
        secret: false
        value: string(max(1, requestsPerMinute / 10))
      }
      {
        name: 'substitution-notice-text'
        displayName: 'substitution-notice-text'
        secret: false
        value: substitutionNoticeText
      }
      {
        name: 'pooled-model-deployments'
        displayName: 'pooled-model-deployments'
        secret: false
        // A named value cannot be empty, and the policy reads blank as unset, so a space carries it.
        value: empty(pooledModelDeployments) ? ' ' : pooledModelDeployments
      }
      {
        name: 'c0-proxy-key'
        displayName: 'c0-proxy-key'
        secret: true
        value: 'disabled'
      }
    ]
  }
}

// Declared whether or not a second account exists, because the policy names it and a policy
// referencing a backend that is absent is not deployable. With no second account it holds the
// primary alone, and the empty pooled-model list means nothing routes to it.
module foundryBackendPool 'br/public:avm/res/api-management/service/backend:0.2.2' = {
  params: {
    apiManagementServiceName: apimName
    name: poolBackendName
    description: 'Load-balanced pool of Microsoft Foundry accounts that serve the same deployments.'
    type: 'Pool'
    pool: {
      services: poolMembers
    }
    enableTelemetry: false
  }
  dependsOn: [
    apim
  ]
}

resource applicationInsightsResource 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}

var monitoringMetricsPublisherRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '3913510d-42f4-4e42-8a64-420c390055eb'
)

resource applicationInsightsPublisherRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationInsightsResource.id, apimName, monitoringMetricsPublisherRoleDefinitionId)
  scope: applicationInsightsResource
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleDefinitionId
    principalId: apim.outputs.systemAssignedMIPrincipalId!
    principalType: 'ServicePrincipal'
    description: 'Allow API Management to publish body-free telemetry and token metrics.'
  }
}

module inferenceApi 'br/public:avm/res/api-management/service/api:0.2.2' = {
  params: {
    apiManagementServiceName: apim.outputs.name
    name: 'inference'
    displayName: 'Azure AI Governance Gateway API'
    description: 'Explicit OpenAI-compatible operations governed by Microsoft Entra ID and API Management.'
    path: 'v1'
    serviceUrl: foundryBackendUrl
    format: 'openapi+json'
    value: string(apimApiDefinition)
    protocols: [
      'https'
    ]
    subscriptionRequired: false
    policies: [
      {
        format: 'rawxml'
        value: inferencePolicyXml
      }
    ]
    diagnostics: [
      {
        name: 'applicationinsights'
        loggerName: 'applicationinsights'
        alwaysLog: 'allErrors'
        httpCorrelationProtocol: 'W3C'
        logClientIp: false
        metrics: true
        operationNameFormat: 'Name'
        samplingPercentage: 100
        verbosity: 'error'
        frontend: {
          request: {
            body: {
              bytes: 0
            }
            headers: []
          }
          response: {
            body: {
              bytes: 0
            }
            headers: []
          }
        }
        backend: {
          request: {
            body: {
              bytes: 0
            }
            headers: []
          }
          response: {
            body: {
              bytes: 0
            }
            headers: []
          }
        }
      }
    ]
    enableTelemetry: false
  }
  dependsOn: [
    applicationInsightsPublisherRole
    foundryBackendPool
  ]
}

// RFC 9728 protected-resource metadata, on its own anonymous API rather than an
// anonymous operation on `inference` so no operation policy has to skip the API
// policy that governs every other route. No backend, no diagnostics.
module oauthProtectedResourceApi 'br/public:avm/res/api-management/service/api:0.2.2' = {
  params: {
    apiManagementServiceName: apim.outputs.name
    name: 'oauth-protected-resource'
    displayName: 'OAuth 2.0 Protected Resource Metadata'
    description: 'RFC 9728 protected resource metadata for the gateway API, served anonymously.'
    path: ''
    // The imported document declares a relative server, which becomes an invalid service URL, and
    // this API answers from its own policy and never forwards. The address says so by not resolving.
    serviceUrl: 'https://oauth-protected-resource.invalid'
    format: 'openapi+json'
    value: string(oauthProtectedResourceApiDefinition)
    protocols: [
      'https'
    ]
    subscriptionRequired: false
    policies: [
      {
        format: 'rawxml'
        value: oauthProtectedResourcePolicyXml
      }
    ]
    enableTelemetry: false
  }
}

resource createdApim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

resource createdAzureMonitorLogger 'Microsoft.ApiManagement/service/loggers@2024-05-01' existing = {
  name: 'azuremonitor'
  parent: createdApim
}

resource createdInferenceApi 'Microsoft.ApiManagement/service/apis@2024-05-01' existing = {
  name: 'inference'
  parent: createdApim
}

// Preview API version: `largeLanguageModel` does not exist at 2024-05-01, the latest stable.
resource inferenceAzureMonitorDiagnostic 'Microsoft.ApiManagement/service/apis/diagnostics@2024-06-01-preview' = {
  name: 'azuremonitor'
  parent: createdInferenceApi
  properties: {
    loggerId: createdAzureMonitorLogger.id
    alwaysLog: 'allErrors'
    logClientIp: false
    metrics: false
    sampling: {
      samplingType: 'fixed'
      percentage: 100
    }
    verbosity: 'information'
    frontend: {
      request: { body: { bytes: 0 }, headers: [] }
      response: { body: { bytes: 0 }, headers: [] }
    }
    backend: {
      request: { body: { bytes: 0 }, headers: [] }
      response: { body: { bytes: 0 }, headers: [] }
    }
    // Token counts only. `requests`/`responses` accept no partial setting, so adding
    // either would capture whole prompts and completions.
    largeLanguageModel: {
      logs: 'enabled'
    }
  }
  dependsOn: [
    apim
    inferenceApi
  ]
}

output apimName string = apim.outputs.name
output apimPrincipalId string = apim.outputs.systemAssignedMIPrincipalId!
output apiUrl string = 'https://${apim.outputs.name}.azure-api.net/v1'
output logAnalyticsWorkspaceId string = workspaceResourceId
output createdResourceIds array = [
  applicationInsights.outputs.resourceId
  apim.outputs.resourceId
  foundryBackendPool.outputs.resourceId
  applicationInsightsPublisherRole.id
  inferenceApi.outputs.resourceId
  oauthProtectedResourceApi.outputs.resourceId
  inferenceAzureMonitorDiagnostic.id
]
output roleAssignmentIds array = [
  applicationInsightsPublisherRole.id
]
output requiresRecursiveApimReadback bool = true
