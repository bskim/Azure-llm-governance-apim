targetScope = 'subscription'

@description('Short environment identifier used for tags and deterministic resource names.')
@minLength(1)
@maxLength(20)
param environmentName string

@description('Azure region for gateway-owned resources.')
param location string

@description('Dedicated resource group for gateway-owned resources.')
@minLength(1)
param gatewayResourceGroupName string

@description('API Management publisher organization name.')
@minLength(1)
param publisherName string

@description('API Management publisher contact email.')
@minLength(3)
param publisherEmail string

@description('''Deploy the API Management gateway. False deploys the control plane, its identity, and the console alone, which is how the identity and administration path is proven before an hourly-billed gateway exists. The gateway is the only component here with a fixed hourly charge.''')
param deployGateway bool = true

@description('API Management SKU. BasicV2 remains the public default; Developer is available for bounded non-production verification.')
@allowed([
  'BasicV2'
  'Developer'
])
param apimSku string = 'BasicV2'

@description('Object ID of the human or group that owns the gateway app registrations.')
@minLength(36)
param entraApplicationOwnerObjectId string

@description('''Object ID of the user or group that receives the governance administrator role. Required: with no administrator the deployment produces a governance system nobody can configure.''')
@minLength(36)
param governanceAdministratorPrincipalId string

@description('''Whether this deployment creates the Microsoft Foundry hierarchy or connects to one that already exists. Creating it is the option for a customer with an empty subscription; connecting is the option for one who already runs models. Both reach the same end state, which is why they are one template rather than two.''')
param createFoundry bool = false

@description('Resource group holding the Microsoft Foundry account. Created when this deployment creates the hierarchy, referenced otherwise.')
@minLength(1)
param foundryResourceGroupName string

@description('Name of the Microsoft Foundry account. Created when this deployment creates the hierarchy, referenced otherwise.')
@minLength(2)
param foundryAccountName string

@description('Name of the Microsoft Foundry project. Created when this deployment creates the hierarchy, referenced otherwise.')
@minLength(2)
param foundryProjectName string

@description('Public logical model alias accepted from clients.')
@minLength(1)
param logicalModelAlias string

@description('Foundry deployment selected by the logical alias. Created when this deployment creates the hierarchy, referenced otherwise.')
@minLength(1)
param defaultModelDeploymentName string

@description('Model catalog name to deploy. Read only when this deployment creates the Foundry hierarchy. The default is open-weight because a hosted model reaches a state where existing deployments keep serving and new ones are refused, which makes any default here expire; confirm the name, version and format together before creating a hierarchy.')
@minLength(1)
param modelName string = 'gpt-oss-120b'

@description('Pinned model version to deploy. Read only when this deployment creates the Foundry hierarchy. Check the version with the name: a model can be offered at one version and refused at another.')
@minLength(1)
param modelVersion string = '1'

@description('Model format expected by the Cognitive Services deployment resource. Read only when this deployment creates the Foundry hierarchy. It belongs to the model rather than to the account, so it changes with the model name.')
@minLength(1)
param modelFormat string = 'OpenAI-OSS'

@description('Model deployment SKU such as GlobalStandard. Read only when this deployment creates the Foundry hierarchy.')
@minLength(1)
param modelSkuName string = 'GlobalStandard'

@description('Model deployment capacity in provider-defined units. Read only when this deployment creates the Foundry hierarchy.')
@minValue(1)
param modelCapacity int = 10

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

@description('Optional second model deployment created in the same new Foundry account. Supply either an empty array or exactly one complete object. Distribution validation rejects a nonempty array unless createFoundry is true.')
@maxLength(1)
param secondModelDeployments modelDeploymentConfiguration[] = []

@description('Requests per minute allowed to each caller.')
@minValue(1)
param requestsPerMinute int = 10

@description('Tokens per minute allowed across the whole organization, not per caller: the counter this feeds is shared by every caller.')
@minValue(1)
param tokensPerMinute int = 50000

@description('Azure CLI public client permitted to reach the gateway from a local sign-in. The nil GUID when the profile is not configured, which no client can present.')
param entraDeveloperClientApplicationId string = '00000000-0000-0000-0000-000000000000'

@description('Application role an Azure-hosted workload must carry to use the workload authentication branch instead of the delegated one. The literal "disabled" when not configured.')
param entraWorkloadAppRole string = 'disabled'

@description('Second Microsoft Foundry account whose deployments can share load with the first. Empty when no second account exists, which leaves one backend serving everything.')
param secondaryFoundryAccountName string = ''

@description('Comma-separated deployment names every pool member serves. Empty means no model is pooled and the primary backend serves every request.')
param pooledModelDeployments string = ''

@description('Governance store database name.')
@minLength(1)
param governanceDatabaseName string = 'governance'

@description('Scope the control plane uses for durable governance partitioning and document identifiers.')
@minLength(1)
@maxLength(64)
param governanceScopeGroupId string = 'platform-engineering'

@description('Team keys a global reader may select, comma-separated, sorted, and unique.')
@minLength(1)
param governanceKnownTeamKeys string = 'developer-experience,platform-engineering'

@description('Directory group object IDs assigned to the gateway API, comma-separated. Empty keeps store-backed membership.')
param governanceMembershipGroupIds string = ''

@description('Pseudonym derivation secret. Supplied at deployment time; an empty value deploys no key store and leaves policy resolution reporting unavailable.')
@secure()
param principalDerivationSecret string = ''

@description('''Principal key-store mode. direct preserves the secure-parameter compatibility path; existing attaches the vault created by the bootstrap command.''')
@allowed([
  'direct'
  'existing'
])
param principalKeyMode string = 'direct'

@description('Existing principal key-store name when principalKeyMode is existing.')
param principalKeyStoreName string = ''

@description('Existing principal derivation secret name when principalKeyMode is existing.')
param principalKeySecretName string = ''

@description('Optional Key Vault secret name containing the deployment-owned generic notification webhook endpoint. The endpoint value itself is never a deployment parameter.')
param notificationWebhookSecretName string = ''

@description('Initial hourly window boundary for schedule backfill when no durable checkpoint exists. Empty begins at the current boundary.')
param rollupStartedFrom string = ''

@description('''Always-ready instances held for the control plane request path. One keeps a cold start off the gateway cache-miss path; zero allows full scale to zero and accepts degraded resolution for the first caller after idle.''')
@minValue(0)
@maxValue(10)
param controlPlaneAlwaysReadyInstances int = 1

@description('''Maximum instances for each control-plane Flex Consumption scale group. The development/verification default and unapproved ceiling are 28 at 2,048 MB: 1 always-ready reserve + 7 scale groups * 28 = 197 cores, leaving 53 below the documented 250-core regional default.''')
@minValue(1)
@maxValue(28)
param controlPlaneMaximumInstanceCount int = 28

@description('''Control-plane Flex Consumption instance memory in megabytes. Pinned at 2,048 MB because the repository-local seven-group core budget is verified only for this size.''')
@allowed([2048])
param controlPlaneInstanceMemoryMB int = 2048

@description('Region for the administrative interface. Static Web Apps is available in a limited set of regions.')
param staticSiteLocation string = location

@description('''Ingress posture for the whole governance administration surface, which is the console and the control plane together. public-authenticated leaves both addressable from the internet and gated by sign-in alone. private-only closes both to browser and API traffic from the public network and provisions the private endpoints and private DNS zones that replace their public names. Console asset deployment is unaffected by its private endpoint, while publishing the control-plane package requires a deployment agent with a network path to the private Function endpoint.''')
@allowed([
  'public-authenticated'
  'private-only'
])
param governanceAdministrationIngress string = 'public-authenticated'

var tags = {
  'azd-env-name': environmentName
  environment: environmentName
  workload: 'llm-governance-apim'
}
var workloadName = 'llm-governance-apim'
// Storage account names cap at 24 characters with no separators, so resources
// under that limit derive from a short form rather than the workload name.
var shortWorkloadName = 'llmgov'
var resourceSuffix = take(uniqueString(subscription().id, gatewayResourceGroupName, environmentName, location), 6)
var apimName = take('apim-${workloadName}-${environmentName}-${resourceSuffix}', 50)
var directPrincipalKeyMode = principalKeyMode == 'direct'
var existingPrincipalKeyMode = principalKeyMode == 'existing'
var directPrincipalKeyStoreName = take('kv-${shortWorkloadName}-${environmentName}-${resourceSuffix}', 24)
var principalKeyConfigured = (directPrincipalKeyMode && length(principalDerivationSecret) >= 32) || (existingPrincipalKeyMode && !empty(principalKeyStoreName) && !empty(principalKeySecretName))
var cognitiveServicesOpenAIUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
)

resource existingFoundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
  scope: resourceGroup(foundryResourceGroupName)
}

resource existingFoundryProject 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' existing = {
  name: foundryProjectName
  parent: existingFoundryAccount
}

resource existingFoundryDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' existing = {
  name: defaultModelDeploymentName
  parent: existingFoundryAccount
}

var primaryFoundryAccountResourceId = createFoundry ? foundry!.outputs.accountResourceId : existingFoundryAccount.id

// Only when this deployment owns the hierarchy. The names above are the same names
// either way, so nothing downstream has to know which option was taken.
resource foundryResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = if (createFoundry && toLower(foundryResourceGroupName) != toLower(gatewayResourceGroupName)) {
  name: foundryResourceGroupName
  location: location
  tags: tags
}

module foundry './modules/fresh-foundry.bicep' = if (createFoundry) {
  scope: resourceGroup(foundryResourceGroupName)
  params: {
    location: location
    tags: tags
    foundryAccountName: foundryAccountName
    foundryProjectName: foundryProjectName
    deploymentName: defaultModelDeploymentName
    modelName: modelName
    modelVersion: modelVersion
    modelFormat: modelFormat
    modelSkuName: modelSkuName
    modelCapacity: modelCapacity
    secondModelDeployments: secondModelDeployments
  }
  dependsOn: [
    foundryResourceGroup
    gatewayResourceGroup
  ]
}

// A pool may only balance across members that serve the same model, so the second account is
// created from the same module as the first: parity of model, version and format is by
// construction rather than by two parameter lists being kept in agreement by hand.
module secondaryFoundry './modules/fresh-foundry.bicep' = if (createFoundry && !empty(secondaryFoundryAccountName)) {
  scope: resourceGroup(foundryResourceGroupName)
  params: {
    location: location
    tags: tags
    foundryAccountName: secondaryFoundryAccountName
    foundryProjectName: foundryProjectName
    deploymentName: defaultModelDeploymentName
    modelName: modelName
    modelVersion: modelVersion
    modelFormat: modelFormat
    modelSkuName: modelSkuName
    modelCapacity: modelCapacity
  }
  dependsOn: [
    foundryResourceGroup
    gatewayResourceGroup
  ]
}

// The console host comes first: its generated hostname is the only origin the app
// registration may accept a sign-in redirect from, and it cannot be predicted.
module adminConsoleHost './modules/admin-console-host.bicep' = {
  scope: gatewayResourceGroup
  params: {
    name: shortWorkloadName
    location: staticSiteLocation
    tags: tags
    environmentName: environmentName
    governanceAdministrationIngress: governanceAdministrationIngress
  }
}

module identity './modules/identity.bicep' = {
  params: {
    name: workloadName
    location: location
    tags: tags
    environmentName: environmentName
    entraApplicationOwnerObjectId: entraApplicationOwnerObjectId
    governanceAdministratorPrincipalId: governanceAdministratorPrincipalId
    governanceMembershipGroupIds: governanceMembershipGroupIds
    adminConsoleOrigin: adminConsoleHost.outputs.origin
  }
}

resource gatewayResourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: gatewayResourceGroupName
  location: location
  tags: tags
}

// The gateway and the control plane share one workspace, so it is provisioned
// before either. That also keeps the gateway from depending on the control plane
// for a log destination while the control plane depends on the gateway for none.
module observability './modules/observability.bicep' = {
  scope: gatewayResourceGroup
  params: {
    name: workloadName
    location: location
    tags: tags
    environmentName: environmentName
  }
}

module governanceStore './modules/governance-store.bicep' = {
  scope: gatewayResourceGroup
  params: {
    name: workloadName
    location: location
    tags: tags
    environmentName: environmentName
    databaseName: governanceDatabaseName
    privateEndpointSubnetResourceId: network.outputs.privateEndpointSubnetResourceId
    privateDnsZoneResourceId: network.outputs.governanceStorePrivateDnsZoneResourceId
  }
}

module network './modules/governance-network.bicep' = {
  scope: gatewayResourceGroup
  params: {
    name: shortWorkloadName
    location: location
    tags: tags
    environmentName: environmentName
    governanceAdministrationIngress: governanceAdministrationIngress
    adminConsoleResourceId: adminConsoleHost.outputs.staticSiteResourceId
    adminConsoleDefaultHostname: adminConsoleHost.outputs.defaultHostname
  }
}

module controlPlane './modules/governance-runtime.bicep' = {
  scope: gatewayResourceGroup
  params: {
    name: shortWorkloadName
    location: location
    adminConsoleOrigin: adminConsoleHost.outputs.origin
    tags: tags
    environmentName: environmentName
    logAnalyticsWorkspaceResourceId: observability.outputs.workspaceResourceId
    providerAccountResourceId: primaryFoundryAccountResourceId
    usageWorkspaceCustomerId: observability.outputs.workspaceCustomerId
    controlPlaneAudience: identity.outputs.adminApiAudience
    rollupStartedFrom: rollupStartedFrom
    governanceStoreEndpoint: governanceStore.outputs.documentEndpoint
    governanceDatabaseName: governanceDatabaseName
    governanceScopeGroupId: governanceScopeGroupId
    governanceKnownTeamKeys: governanceKnownTeamKeys
    governanceMembershipGroupIds: governanceMembershipGroupIds
    httpAlwaysReadyInstances: controlPlaneAlwaysReadyInstances
    maximumInstanceCount: controlPlaneMaximumInstanceCount
    instanceMemoryMB: controlPlaneInstanceMemoryMB
    functionSubnetResourceId: network.outputs.functionSubnetResourceId
    privateEndpointSubnetResourceId: network.outputs.privateEndpointSubnetResourceId
    blobPrivateDnsZoneResourceId: network.outputs.blobPrivateDnsZoneResourceId
    queuePrivateDnsZoneResourceId: network.outputs.queuePrivateDnsZoneResourceId
    tablePrivateDnsZoneResourceId: network.outputs.tablePrivateDnsZoneResourceId
    governanceAdministrationIngress: governanceAdministrationIngress
    controlPlanePrivateDnsZoneResourceId: network.outputs.controlPlanePrivateDnsZoneResourceId
  }
}

// Apply authsettingsV2 only after Function creation completes. A failed root provision
// therefore cannot be followed by a supported code deployment, and a reprovision never
// removes the authentication document that already protects deployed handlers.
module controlPlaneAuthentication './modules/control-plane-authentication.bicep' = {
  scope: gatewayResourceGroup
  params: {
    functionAppName: controlPlane.outputs.functionAppName
    entraTenantId: identity.outputs.tenantId
    controlPlaneAudience: identity.outputs.adminApiAudience
  }
}

// Direct mode is invoked even for an invalid secret so the key-store module's secure
// parameter validation rejects the deployment rather than producing partial policy wiring.
module controlPlaneKeyStore './modules/control-plane-key-store.bicep' = if (directPrincipalKeyMode) {
  scope: gatewayResourceGroup
  params: {
    keyVaultName: directPrincipalKeyStoreName
    readerPrincipalId: controlPlane.outputs.functionAppPrincipalId
    privateEndpointSubnetResourceId: network.outputs.privateEndpointSubnetResourceId
    privateDnsZoneResourceId: network.outputs.keyStorePrivateDnsZoneResourceId
    derivationSecret: principalDerivationSecret
    location: location
    tags: tags
  }
}

module existingControlPlaneKeyStore './modules/existing-control-plane-key-store.bicep' = if (existingPrincipalKeyMode) {
  scope: gatewayResourceGroup
  params: {
    keyVaultName: principalKeyStoreName
    secretName: principalKeySecretName
    readerPrincipalId: controlPlane.outputs.functionAppPrincipalId
    privateEndpointSubnetResourceId: network.outputs.privateEndpointSubnetResourceId
    privateDnsZoneResourceId: network.outputs.keyStorePrivateDnsZoneResourceId
    location: location
    tags: tags
  }
}

module directPrincipalKeySetting './modules/control-plane-principal-key-setting.bicep' = if (directPrincipalKeyMode) {
  scope: gatewayResourceGroup
  params: {
    functionAppName: controlPlane.outputs.functionAppName
    baseAppSettings: controlPlane.outputs.baseAppSettings
    keyVaultName: directPrincipalKeyStoreName
    secretName: 'principal-key-secret'
    notificationWebhookSecretName: notificationWebhookSecretName
  }
  dependsOn: [
    controlPlaneKeyStore
  ]
}

module existingPrincipalKeySetting './modules/control-plane-principal-key-setting.bicep' = if (existingPrincipalKeyMode) {
  scope: gatewayResourceGroup
  params: {
    functionAppName: controlPlane.outputs.functionAppName
    baseAppSettings: controlPlane.outputs.baseAppSettings
    keyVaultName: principalKeyStoreName
    secretName: principalKeySecretName
    notificationWebhookSecretName: notificationWebhookSecretName
  }
  dependsOn: [
    existingControlPlaneKeyStore
  ]
}

// Granted after the runtime exists, because the identity being granted access is
// created with it.
module governanceStoreAccess './modules/governance-store-access.bicep' = {  scope: gatewayResourceGroup
  params: {
    storeAccountName: governanceStore.outputs.accountName
    dataPlanePrincipalId: controlPlane.outputs.functionAppPrincipalId
  }
}

module usageSourceAccess './modules/usage-source-access.bicep' = {
  scope: gatewayResourceGroup
  params: {
    workspaceName: observability.outputs.workspaceName
    usageReaderPrincipalId: controlPlane.outputs.functionAppPrincipalId
  }
}

// Provider discovery and metrics are restricted to the selected account. The
// subscription-wide quota pool remains intentionally unavailable to this identity.
module foundryProviderReaderAccess './modules/foundry-provider-reader-access.bicep' = {
  scope: resourceGroup(foundryResourceGroupName)
  params: {
    foundryAccountName: foundryAccountName
    readerPrincipalId: controlPlane.outputs.functionAppPrincipalId
  }
}

module gateway './modules/gateway.bicep' = if (deployGateway) {
  scope: gatewayResourceGroup
  params: {
    name: workloadName
    apimName: apimName
    location: location
    tags: tags
    environmentName: environmentName
    publisherName: publisherName
    publisherEmail: publisherEmail
    apimSku: apimSku
    entraTenantId: identity.outputs.tenantId
    entraApiAudience: identity.outputs.apiAudience
    entraClientApplicationId: identity.outputs.cliApplicationId
    entraRequiredScope: identity.outputs.requiredScope
    entraDeveloperClientApplicationId: entraDeveloperClientApplicationId
    entraWorkloadAppRole: entraWorkloadAppRole
    foundryAccountName: foundryAccountName
    secondaryFoundryAccountName: secondaryFoundryAccountName
    pooledModelDeployments: pooledModelDeployments
    logicalModelAlias: logicalModelAlias
    defaultModelDeploymentName: defaultModelDeploymentName
    requestsPerMinute: requestsPerMinute
    tokensPerMinute: tokensPerMinute
    logAnalyticsWorkspaceResourceId: observability.outputs.workspaceResourceId
    governancePolicyEndpoint: controlPlane.outputs.policyResolutionEndpoint
    governancePolicyAudience: identity.outputs.adminApiAudience
    governancePolicyEnabled: principalKeyConfigured
  }
}

// Granted after the gateway exists, because the identity being granted the machine
// role is created with it.
module controlPlaneAccess './modules/control-plane-access.bicep' = if (deployGateway) {
  params: {
    adminApiServicePrincipalId: identity.outputs.adminApiServicePrincipalId
    policyResolveRoleId: identity.outputs.policyResolveRoleId
    gatewayPrincipalId: gateway!.outputs.apimPrincipalId
  }
}

module foundryAccess './modules/foundry-access.bicep' = if (deployGateway) {
  scope: resourceGroup(foundryResourceGroupName)
  params: {
    name: 'foundry-inference-access'
    location: location
    tags: tags
    foundryAccountName: foundryAccountName
    principalId: gateway!.outputs.apimPrincipalId
    roleAssignmentName: guid(
      subscription().id,
      foundryResourceGroupName,
      foundryAccountName,
      gatewayResourceGroupName,
      apimName,
      cognitiveServicesOpenAIUserRoleDefinitionId
    )
  }
}

// The pool sends the same managed identity to either member, so a second backend the gateway
// cannot authenticate to is a member that fails every request it is given.
module secondaryFoundryAccess './modules/foundry-access.bicep' = if (deployGateway && !empty(secondaryFoundryAccountName)) {
  scope: resourceGroup(foundryResourceGroupName)
  params: {
    name: 'foundry-secondary-inference-access'
    location: location
    tags: tags
    foundryAccountName: secondaryFoundryAccountName
    principalId: gateway!.outputs.apimPrincipalId
    roleAssignmentName: guid(
      subscription().id,
      foundryResourceGroupName,
      secondaryFoundryAccountName,
      gatewayResourceGroupName,
      apimName,
      cognitiveServicesOpenAIUserRoleDefinitionId
    )
  }
  dependsOn: [
    secondaryFoundry
  ]
}

output AZURE_RESOURCE_GROUP string = gatewayResourceGroup.name
output APIM_NAME string = !deployGateway ? '' : gateway!.outputs.apimName
output API_URL string = !deployGateway ? '' : gateway!.outputs.apiUrl
output GATEWAY_DEPLOYED bool = deployGateway
output LOG_ANALYTICS_WORKSPACE_ID string = observability.outputs.workspaceResourceId
output GOVERNANCE_STORE_ENDPOINT string = governanceStore.outputs.documentEndpoint
output GOVERNANCE_DATABASE_NAME string = governanceDatabaseName
output CONTROL_PLANE_FUNCTION_APP string = controlPlane.outputs.functionAppName
output CONTROL_PLANE_ENDPOINT string = controlPlane.outputs.functionAppEndpoint
output POLICY_RESOLUTION_ENDPOINT string = controlPlane.outputs.policyResolutionEndpoint
output ADMIN_INTERFACE_ENDPOINT string = adminConsoleHost.outputs.origin
output GOVERNANCE_ADMINISTRATION_INGRESS string = governanceAdministrationIngress
output GOVERNANCE_SCOPE string = governanceScopeGroupId
output GOVERNANCE_TEAMS string = governanceKnownTeamKeys
output GOVERNANCE_MEMBERSHIP_GROUPS string = governanceMembershipGroupIds
output GOVERNANCE_MEMBERSHIP_SOURCE string = empty(governanceMembershipGroupIds) ? 'store' : 'directory-claim'
output GOVERNANCE_POLICY_RESOLUTION string = principalKeyConfigured ? 'per-caller' : 'invalid-unconfigured'
output CONTROL_PLANE_COMPUTE string = 'FlexConsumption'
output ENTRA_API_APPLICATION_ID string = identity.outputs.apiApplicationId
output ENTRA_API_AUDIENCE string = identity.outputs.apiAudience
output ENTRA_API_SCOPE string = identity.outputs.apiScope
output ENTRA_CLI_APPLICATION_ID string = identity.outputs.cliApplicationId
output ENTRA_REQUIRED_SCOPE string = identity.outputs.requiredScope
output ENTRA_TENANT_ID string = identity.outputs.tenantId
output ENTRA_ADMIN_API_AUDIENCE string = identity.outputs.adminApiAudience
output ENTRA_ADMIN_API_SCOPE string = identity.outputs.adminApiScope
output ENTRA_ADMIN_SPA_APPLICATION_ID string = identity.outputs.adminSpaApplicationId
output DISTRIBUTION_MODE string = createFoundry ? 'fresh' : 'existing'
output APIM_OWNERSHIP string = !deployGateway ? 'none' : 'created'
output FOUNDRY_OWNERSHIP string = createFoundry ? 'created' : 'existing'
output ENDPOINT_GOVERNANCE_MODE string = deployGateway ? 'ExplicitApim' : 'none'
output BACKEND_ENDPOINT_CLASS string = deployGateway ? 'FoundryAccountOpenAIV1' : 'none'
output FOUNDRY_ACCOUNT_RESOURCE_ID string = primaryFoundryAccountResourceId
output FOUNDRY_PROJECT_RESOURCE_ID string = createFoundry ? foundry!.outputs.projectResourceId : existingFoundryProject.id
output FOUNDRY_MODEL_DEPLOYMENT_RESOURCE_ID string = createFoundry ? foundry!.outputs.deploymentResourceId : existingFoundryDeployment.id
output FOUNDRY_SECOND_MODEL_DEPLOYMENT_RESOURCE_ID string = createFoundry && !empty(secondModelDeployments) ? foundry!.outputs.secondDeploymentResourceId : ''
output FOUNDRY_ADMIN_ASSOCIATION string = 'manual-required'
output FOUNDRY_PROJECT_ENROLLMENT string = 'manual-required'
output OWNERSHIP_MANIFEST_SEED object = {
  schemaVersion: 'llm-governance-bicep-ownership-seed/v1'
  identity: {
    tenantId: subscription().tenantId
    subscriptionId: subscription().subscriptionId
    environmentName: environmentName
    resourceGroupName: gatewayResourceGroupName
    resourceGroupId: gatewayResourceGroup.id
    location: location
  }
  createdResourceIds: concat(
    [
      gatewayResourceGroup.id
    ],
    createFoundry && toLower(foundryResourceGroupName) != toLower(gatewayResourceGroupName) ? [
      foundryResourceGroup.id
    ] : [],
    createFoundry ? foundry!.outputs.createdResourceIds : [],
    createFoundry && !empty(secondaryFoundryAccountName) ? secondaryFoundry!.outputs.createdResourceIds : [],
    adminConsoleHost.outputs.createdResourceIds,
    observability.outputs.createdResourceIds,
    governanceStore.outputs.createdResourceIds,
    network.outputs.createdResourceIds,
    controlPlane.outputs.createdResourceIds,
    controlPlaneAuthentication.outputs.createdResourceIds,
    directPrincipalKeyMode ? controlPlaneKeyStore!.outputs.createdResourceIds : existingControlPlaneKeyStore!.outputs.createdResourceIds,
    governanceStoreAccess.outputs.createdResourceIds,
    usageSourceAccess.outputs.createdResourceIds,
    foundryProviderReaderAccess.outputs.createdResourceIds,
    deployGateway ? gateway!.outputs.createdResourceIds : [],
    deployGateway ? foundryAccess!.outputs.createdResourceIds : [],
    deployGateway && !empty(secondaryFoundryAccountName) ? secondaryFoundryAccess!.outputs.createdResourceIds : []
  )
  createdAzureRoleAssignmentIds: concat(
    controlPlane.outputs.roleAssignmentIds,
    directPrincipalKeyMode ? controlPlaneKeyStore!.outputs.roleAssignmentIds : existingControlPlaneKeyStore!.outputs.roleAssignmentIds,
    [
      governanceStoreAccess.outputs.roleAssignmentId
      usageSourceAccess.outputs.roleAssignmentId
      foundryProviderReaderAccess.outputs.roleAssignmentId
    ],
    deployGateway ? gateway!.outputs.roleAssignmentIds : [],
    deployGateway ? foundryAccess!.outputs.createdResourceIds : [],
    deployGateway && !empty(secondaryFoundryAccountName) ? secondaryFoundryAccess!.outputs.createdResourceIds : []
  )
  createdDirectoryObjects: identity.outputs.createdDirectoryObjects
  createdGraphAssignmentIds: concat(
    identity.outputs.createdGraphAssignmentIds,
    deployGateway ? controlPlaneAccess!.outputs.createdGraphAssignmentIds : []
  )
  externalReferences: concat(
    !createFoundry ? [
      {
        id: existingFoundryAccount.id
        classification: 'external-reference'
      }
      {
        id: existingFoundryProject.id
        classification: 'external-reference'
      }
      {
        id: existingFoundryDeployment.id
        classification: 'external-reference'
      }
    ] : [],
    !createFoundry && !empty(secondaryFoundryAccountName) ? [
      {
        id: resourceId(foundryResourceGroupName, 'Microsoft.CognitiveServices/accounts', secondaryFoundryAccountName)
        classification: 'external-reference'
      }
      {
        id: resourceId(foundryResourceGroupName, 'Microsoft.CognitiveServices/accounts/deployments', secondaryFoundryAccountName, defaultModelDeploymentName)
        classification: 'external-reference'
      }
    ] : []
  )
  protectedResourceIds: concat(
    !createFoundry ? [
      subscriptionResourceId('Microsoft.Resources/resourceGroups', foundryResourceGroupName)
      existingFoundryAccount.id
      existingFoundryProject.id
      existingFoundryDeployment.id
    ] : [],
    !createFoundry && !empty(secondaryFoundryAccountName) ? [
      resourceId(foundryResourceGroupName, 'Microsoft.CognitiveServices/accounts', secondaryFoundryAccountName)
      resourceId(foundryResourceGroupName, 'Microsoft.CognitiveServices/accounts/deployments', secondaryFoundryAccountName, defaultModelDeploymentName)
    ] : []
  )
  keyVaultLifecycle: {
    purgeProtectionEnabled: directPrincipalKeyMode ? controlPlaneKeyStore!.outputs.purgeProtectionEnabled : null
    softDeleteRetentionInDays: directPrincipalKeyMode ? controlPlaneKeyStore!.outputs.softDeleteRetentionInDays : null
    deletionDisposition: directPrincipalKeyMode ? 'DeletedPendingRetention' : 'bootstrap-manifest-required'
    referencedResourceIds: existingPrincipalKeyMode ? existingControlPlaneKeyStore!.outputs.externalResourceIds : []
    ownershipResolution: directPrincipalKeyMode ? 'main-deployment-receipt' : 'principal-key-bootstrap-receipt'
  }
  bootstrapManifestRequired: existingPrincipalKeyMode
  requiresCreationReceipts: true
  requiresRecursiveApimReadback: deployGateway ? gateway!.outputs.requiresRecursiveApimReadback : false
  requiresExactReadback: true
}
