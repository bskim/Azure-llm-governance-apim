[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$storePath = Join-Path $repositoryRoot 'infra\modules\governance-store.bicep'
$runtimePath = Join-Path $repositoryRoot 'infra\modules\governance-runtime.bicep'
$authenticationPath = Join-Path $repositoryRoot 'infra\modules\control-plane-authentication.bicep'

function Assert-Infrastructure {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

Assert-Infrastructure (Test-Path -LiteralPath $storePath -PathType Leaf) 'The governance store module is missing.'
Assert-Infrastructure (Test-Path -LiteralPath $runtimePath -PathType Leaf) 'The governance runtime module is missing.'
Assert-Infrastructure (Test-Path -LiteralPath $authenticationPath -PathType Leaf) 'The control-plane authentication module is missing.'

$store = Get-Content -LiteralPath $storePath -Raw
$runtime = Get-Content -LiteralPath $runtimePath -Raw
$authentication = Get-Content -LiteralPath $authenticationPath -Raw

# Data-plane access is granted from its own module, because the identity it
# grants belongs to a runtime that needs this account's endpoint to exist first.
$accessPath = Join-Path $repositoryRoot 'infra\modules\governance-store-access.bicep'
Assert-Infrastructure (Test-Path -LiteralPath $accessPath -PathType Leaf) 'The governance store access module is missing.'
$access = Get-Content -LiteralPath $accessPath -Raw

# --- Store posture ----------------------------------------------------------
Assert-Infrastructure ($store -match 'disableLocalAuth:\s*true') 'Key-based access to the governance store must be disabled.'
Assert-Infrastructure ($store -match 'disableKeyBasedMetadataWriteAccess:\s*true') 'Key-based metadata writes must be disabled.'
Assert-Infrastructure ($store -match 'enableAutomaticFailover:\s*true') 'The deployed governance-store failover setting must be preserved during later gateway changes.'
Assert-Infrastructure ($store -match "publicNetworkAccess:\s*'Disabled'") 'The governance store must be declared private rather than relying on subscription policy to close it.'
Assert-Infrastructure ($store -notmatch "publicNetworkAccess:\s*'Enabled'") 'The governance store template must never request public network access.'
Assert-Infrastructure ($store -match "name:\s*'EnableServerless'") 'The governance store must use the serverless capacity mode.'
Assert-Infrastructure ($store -notmatch 'listKeys\(') 'The governance store module must never read an account key.'
Assert-Infrastructure ($access -match "'00000000-0000-0000-0000-000000000002'") 'Data-plane access must use the built-in Data Contributor role.'
Assert-Infrastructure ($access -match 'scope:\s*account\.id') 'The data-plane role assignment must be scoped to the account.'
Assert-Infrastructure ($access -match 'sqlRoleDefinitions/') 'Access must be granted through a data-plane role definition.'
Assert-Infrastructure ($access -notmatch 'Microsoft\.Authorization/roleDefinitions') 'Data-plane access must not grant a management-plane role.'
Assert-Infrastructure ($store -notmatch 'primaryMasterKey|secondaryMasterKey|connectionString') 'The governance store module must not surface a credential.'

# --- Container topology parity ---------------------------------------------
# The application is not permitted to create containers, so the declared topology
# and the deployed topology have to agree exactly.
$topologyJson = & node --input-type=module -e @'
import { CONTAINER_TOPOLOGY } from "./app/persistence/container-topology.mjs";
process.stdout.write(JSON.stringify(CONTAINER_TOPOLOGY.map((container) => ({
  id: container.id,
  paths: [...container.partitionKeyPaths],
  hasTtl: container.defaultTimeToLiveSeconds !== null,
}))));
'@
Assert-Infrastructure ($LASTEXITCODE -eq 0) 'Failed to read the application container topology.'
$declared = $topologyJson | ConvertFrom-Json

$bicepContainerBlock = [regex]::Match($store, 'var containers = \[(?<body>.*?)\r?\n\]', 'Singleline')
Assert-Infrastructure ($bicepContainerBlock.Success) 'The store module must declare its containers in one list.'
$body = $bicepContainerBlock.Groups['body'].Value

$deployed = @()
foreach ($entry in [regex]::Matches($body, "name:\s*'(?<name>[a-z-]+)'\s*\r?\n\s*partitionKeyPaths:\s*\[(?<paths>[^\]]*)\]\s*\r?\n\s*defaultTtl:\s*(?<ttl>[^\r\n]+)")) {
    $paths = @([regex]::Matches($entry.Groups['paths'].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    $deployed += [pscustomobject]@{
        id = $entry.Groups['name'].Value
        paths = $paths
        hasTtl = ($entry.Groups['ttl'].Value.Trim() -ne 'null')
    }
}

Assert-Infrastructure ($deployed.Count -eq $declared.Count) "The store module declares $($deployed.Count) containers but the application declares $($declared.Count)."
foreach ($expected in $declared) {
    $actual = $deployed | Where-Object id -eq $expected.id
    Assert-Infrastructure ($null -ne $actual) "The store module does not provision container: $($expected.id)"
    Assert-Infrastructure ((($actual.paths) -join ',') -eq (($expected.paths) -join ',')) "Partition key paths differ for container: $($expected.id)"
    Assert-Infrastructure ($actual.hasTtl -eq $expected.hasTtl) "Time-to-live configuration differs for container: $($expected.id)"
}

$hierarchical = $declared | Where-Object { $_.paths.Count -gt 1 }
Assert-Infrastructure ($hierarchical.Count -ge 1) 'At least one container must use a hierarchical partition key.'
Assert-Infrastructure ($store -match "kind:\s*length\(container\.partitionKeyPaths\) > 1 \? 'MultiHash' : 'Hash'") 'Hierarchical partition keys must be declared as MultiHash.'

# A container with no retention policy must omit the property. Sending an explicit
# null is rejected by the service, and the schema check alone did not catch it.
Assert-Infrastructure ($store -notmatch 'defaultTtl:\s*container\.defaultTtl\s*$') 'A container must not send its retention property unconditionally.'
Assert-Infrastructure ($store -match "container\.defaultTtl == null \? \{\} : \{ defaultTtl: container\.defaultTtl \}") 'A container without retention must omit the property rather than send null.'

# --- Runtime posture --------------------------------------------------------
Assert-Infrastructure ($runtime -match "type:\s*'SystemAssigned'") 'Control plane compute must authenticate with a managed identity.'
Assert-Infrastructure ($runtime -notmatch 'AZURE_CLIENT_SECRET|accountKey|primaryMasterKey') 'Control plane compute must not receive a credential.'
Assert-Infrastructure ($runtime -notmatch 'listKeys\(') 'Control plane compute must never read a storage key.'

# The telemetry destination is the single connection string the control plane may hold,
# and it is not a credential only because local authentication is disabled on the
# component: the key it carries cannot ingest anything. Both halves are asserted, so the
# exception cannot outlive the reason it was granted.
$connectionStringReads = [regex]::Matches($runtime, 'connectionString', 'IgnoreCase').Count
$telemetryConnectionStringReads = [regex]::Matches($runtime, 'applicationInsights\.outputs\.connectionString', 'IgnoreCase').Count
Assert-Infrastructure ($telemetryConnectionStringReads -eq 1) 'The control plane must read its telemetry destination exactly once.'
Assert-Infrastructure ($connectionStringReads -eq $telemetryConnectionStringReads) 'The telemetry destination is the only connection string the control plane may read.'
Assert-Infrastructure ($runtime -match 'disableLocalAuth:\s*true') 'Telemetry ingestion must require the app identity, so the key inside that connection string grants nothing.'
Assert-Infrastructure ($runtime -match "AzureWebJobsStorage__credential:\s*'managedidentity'") 'The host must reach its own storage with a managed identity.'
Assert-Infrastructure ($runtime -match 'allowSharedKeyAccess:\s*false') 'Shared key access to the platform storage account must be disabled.'
Assert-Infrastructure ($runtime -match "type:\s*'SystemAssignedIdentity'") 'The deployment package must be read with the app identity.'
Assert-Infrastructure ($runtime -match 'httpsOnly:\s*true') 'Control plane ingress must reject insecure transport.'
Assert-Infrastructure ($runtime -match 'allowBlobPublicAccess:\s*false') 'The platform storage account must not allow anonymous blob access.'

# --- Private network posture ------------------------------------------------
# This is an internal tool. Nothing it deploys starts life addressable from the
# internet, so the storage account is closed at creation and the compute reaches it
# through the network rather than the account being opened to suit the deployment.
$networkPath = Join-Path $repositoryRoot 'infra\modules\governance-network.bicep'
Assert-Infrastructure (Test-Path -LiteralPath $networkPath -PathType Leaf) 'The governance network module is missing.'
$network = Get-Content -LiteralPath $networkPath -Raw

# Scoped to the storage account rather than to the whole file. The control plane's own
# public access follows the administration posture and is enumerated below, but nothing
# outside this network ever addresses the storage account, so it stays closed in both
# postures and may not be expressed conditionally at all.
$storageBlock = [regex]::Match($runtime, "resource storage 'Microsoft\.Storage/storageAccounts@.*?\r?\n\}", 'Singleline').Value
Assert-Infrastructure (-not [string]::IsNullOrWhiteSpace($storageBlock)) 'The runtime module must declare its platform storage account.'
Assert-Infrastructure ($storageBlock -match "publicNetworkAccess:\s*'Disabled'") 'The platform storage account must be closed to the public network.'
Assert-Infrastructure ($storageBlock -notmatch "'Enabled'") 'The platform storage account must never be expressed as reachable from the public network, conditionally or otherwise.'

# Every public-access decision the module makes, so a resource added later cannot be
# born public without this list changing.
$runtimePublicAccess = @([regex]::Matches($runtime, 'publicNetworkAccess:\s*(?<value>[^\r\n]+)') | ForEach-Object { $_.Groups['value'].Value.Trim() })
Assert-Infrastructure ($runtimePublicAccess.Count -eq 2) "The runtime module makes $($runtimePublicAccess.Count) public-access decisions rather than the two it is known to make: $($runtimePublicAccess -join ', ')"
Assert-Infrastructure (@($runtimePublicAccess | Where-Object { $_ -eq "'Disabled'" }).Count -eq 1) 'Exactly one resource in the runtime module is closed unconditionally, and it is the platform storage account.'
Assert-Infrastructure (@($runtimePublicAccess | Where-Object { $_ -eq 'controlPlanePublicNetworkAccess' }).Count -eq 1) 'The control plane must take its public access from the administration posture rather than from a literal.'
Assert-Infrastructure ($runtime -match "defaultAction:\s*'Deny'") 'The platform storage account must deny network access by default.'
Assert-Infrastructure ($runtime -match 'virtualNetworkSubnetId:\s*functionSubnetResourceId') 'The control plane must route its outbound traffic through the network.'
Assert-Infrastructure ($runtime -match 'vnetRouteAllEnabled:\s*true') 'The control plane must route all outbound traffic through the network, not only private ranges.'
Assert-Infrastructure ($runtime -match 'Microsoft\.Network/privateEndpoints@') 'The platform storage account must be reached through a private endpoint.'
Assert-Infrastructure ($runtime -match 'privateDnsZoneGroups@') 'A private endpoint without a DNS zone group resolves to the public name and fails open.'

# The host writes the deployment package and probes its own metadata on start. A
# sub-resource left off resolves to an endpoint the account now refuses, which is
# how the first deployment failed.
foreach ($group in @('blob', 'queue', 'table')) {
    Assert-Infrastructure ($runtime -match "group:\s*'$group'") "The storage sub-resource has no private endpoint: $group"
    Assert-Infrastructure ($network -match "privatelink\.$group\.") "No private DNS zone resolves the storage sub-resource: $group"
}

Assert-Infrastructure ($network -match "serviceName:\s*'Microsoft\.App/environments'") 'The integration subnet must be delegated to the Flex Consumption platform.'
Assert-Infrastructure ($network -match 'virtualNetworkLinks@') 'A private DNS zone resolves nothing until it is linked to the network.'
Assert-Infrastructure ($network -match 'registrationEnabled:\s*false') 'The network must not register its own records in the private zones.'
Assert-Infrastructure ($network -match 'environment\(\)\.suffixes\.storage') 'Private DNS zone names must follow the cloud rather than be fixed to one.'

# Governance data is the most sensitive thing this system holds, so the store is
# reached the same way as everything else: privately, never over public egress.
Assert-Infrastructure ($store -match 'Microsoft\.Network/privateEndpoints@') 'The governance store must be reached through a private endpoint.'
Assert-Infrastructure ($store -match "groupIds:\s*\[\s*\r?\n\s*'Sql'") 'The governance store private endpoint must target its data plane.'
Assert-Infrastructure ($store -match 'privateDnsZoneGroups@') 'A store private endpoint without a DNS zone group resolves the public name it cannot reach.'
Assert-Infrastructure ($network -match 'privatelink\.documents') 'No private DNS zone resolves the governance store.'

# One function app hosts every server-side component. Per-function scaling keeps
# the request path and the change feed consumer independent inside it.
Assert-Infrastructure ($runtime -match "tier:\s*'FlexConsumption'") 'The control plane must run on the Flex Consumption plan.'
Assert-Infrastructure (([regex]::Matches($runtime, "Microsoft\.Web/sites@")).Count -eq 1) 'The control plane must be a single function app.'
Assert-Infrastructure ($runtime -match "name:\s*'http'\s*\r?\n\s*instanceCount:\s*httpAlwaysReadyInstances") 'Always-ready instances must be scoped to the HTTP scale group.'
$alwaysReadyDefault = [regex]::Match($runtime, 'param httpAlwaysReadyInstances int = (?<value>\d+)')
Assert-Infrastructure ($alwaysReadyDefault.Success -and [int]$alwaysReadyDefault.Groups['value'].Value -ge 1) 'The request path must default to at least one always-ready instance.'

# The administrative interface is static, so it must not consume the request path.
# It is provisioned before the app registrations, because its generated hostname is
# the only origin Entra will accept a sign-in redirect from.
$consoleHostPath = Join-Path $repositoryRoot 'infra\modules\admin-console-host.bicep'
Assert-Infrastructure (Test-Path -LiteralPath $consoleHostPath -PathType Leaf) 'The console host module is missing.'
$consoleHost = Get-Content -LiteralPath $consoleHostPath -Raw
Assert-Infrastructure ($consoleHost -match 'Microsoft\.Web/staticSites@') 'The administrative interface must be hosted as static content.'
Assert-Infrastructure ($runtime -notmatch 'Microsoft\.Web/staticSites@') 'The console host must not be created by the module that depends on its origin.'
Assert-Infrastructure ($runtime -match 'param adminConsoleOrigin string') 'The control plane must be told which origin may call it.'
Assert-Infrastructure ($runtime -notmatch 'Microsoft\.App/containerApps|Microsoft\.ContainerRegistry') 'The control plane must not reintroduce a container platform.'

# --- Deployment wiring ------------------------------------------------------
# The gateway calls the control plane, the control plane reads the store, and the
# store grants the control plane access. Each module must therefore receive what
# it needs from the one before it rather than guessing a name.
$mainPath = Join-Path $repositoryRoot 'infra\main.bicep'
$main = Get-Content -LiteralPath $mainPath -Raw

$wiredModules = @('observability', 'governance-store', 'governance-network', 'admin-console-host', 'governance-runtime', 'governance-store-access', 'usage-source-access', 'control-plane-access', 'gateway')
foreach ($module in $wiredModules) {
    Assert-Infrastructure ($main -match [regex]::Escape("./modules/$module.bicep")) "The deployment does not include module: $module"
}

# --- Control plane authentication -------------------------------------------
# Tokens are validated by the platform, so no handler needs a signing key. An
# unauthenticated request is refused rather than allowed through as anonymous.
Assert-Infrastructure ($runtime -notmatch "name:\s*'authsettingsV2'") 'Function creation must complete before platform authentication is applied.'
Assert-Infrastructure ($authentication -match "name:\s*'authsettingsV2'") 'The control plane must enable platform authentication.'
Assert-Infrastructure ($authentication -match 'requireAuthentication:\s*true') 'Platform authentication must be required, not advisory.'
Assert-Infrastructure ($authentication -match "unauthenticatedClientAction:\s*'Return401'") 'An unauthenticated caller must be refused rather than redirected.'
Assert-Infrastructure ($authentication -match 'allowedAudiences:') 'The control plane must pin the audiences it accepts.'
# Flex Consumption materializes an empty allowedApplications key when the policy is
# omitted, and the deployed runtime measured that shape refusing every valid token.
# An explicitly neutral principal policy prevents that key while authorization remains
# in Entra assignments and handler role checks.
Assert-Infrastructure ($authentication -match 'defaultAuthorizationPolicy:\s*\{\s*\r?\n\s*allowedPrincipals:\s*\{\}') 'The control plane must author the measured neutral policy shape.'
Assert-Infrastructure ($authentication -notmatch 'allowedApplications\s*:') 'The Easy Auth client allowlist key must stay absent; an empty materialized key denied every valid token.'
Assert-Infrastructure ($authentication -match 'environment\(\)\.authentication\.loginEndpoint') 'The issuer must be derived from the deployment cloud.'
Assert-Infrastructure ($authentication -match "excludedPaths:\s*\[\s*\r?\n\s*'/api/healthz'") 'Only the liveness probe may bypass authentication.'
Assert-Infrastructure ($authentication -notmatch 'clientSecret|CLIENT_SECRET') 'Platform authentication must not hold a client secret.'
$authModuleCalls = @([regex]::Matches($main, "module\s+controlPlaneAuthentication(?:Confirmation)?\s+'\./modules/control-plane-authentication\.bicep'"))
Assert-Infrastructure ($authModuleCalls.Count -eq 1) 'The authored authentication document must be applied exactly once after Function creation.'
Assert-Infrastructure ($runtime -match "allowedOrigins:\s*\[\s*\r?\n\s*adminConsoleOrigin") 'Only the deployed console origin may call the control plane from a browser.'
Assert-Infrastructure ($runtime -match 'supportCredentials:\s*false') 'The console presents a bearer token, so cross-origin credentials must stay off.'
Assert-Infrastructure ($main -match 'controlPlaneAudience:\s*identity\.outputs\.adminApiAudience') 'The control plane must accept only the governance audience.'
Assert-Infrastructure ($main -match 'governancePolicyAudience:\s*identity\.outputs\.adminApiAudience') 'The gateway must request a token for the control plane it calls.'
Assert-Infrastructure ($main -match 'gatewayPrincipalId:\s*gateway!?\.outputs\.apimPrincipalId') 'The machine role must be granted to the created gateway identity.'

# The gateway is the only fixed hourly charge here, so the control plane and its
# identity must be deployable and provable without it.
Assert-Infrastructure ($main -match '(?m)^param deployGateway bool') 'Gateway deployment must be selectable.'
Assert-Infrastructure ($main -match 'module gateway.*?=\s*if \(deployGateway\)') 'The supported gateway module must run only when a new gateway is requested.'
Assert-Infrastructure ($main -match 'module controlPlaneAccess.*?=\s*if \(deployGateway\)') 'Without a gateway the machine-role assignment must not deploy.'
Assert-Infrastructure ($main -match 'module foundryAccess.*?=\s*if \(deployGateway\)') 'The created gateway identity must receive Foundry inference access.'
Assert-Infrastructure ($main -notmatch 'reuseExistingGateway|adoptedGateway|existingApim') 'The public entrypoint must not expose existing-APIM adoption.'
Assert-Infrastructure ($main -match 'output GATEWAY_DEPLOYED bool = deployGateway') 'A deployment must publish whether it has a gateway.'
Assert-Infrastructure ($main -notmatch '(?m)^\s*governanceStore.*if \(deployGateway\)') 'The control plane must not become conditional on the gateway.'

Assert-Infrastructure ($main -match 'governancePolicyEndpoint:\s*controlPlane\.outputs\.policyResolutionEndpoint') 'The gateway must resolve caller policy against the deployed control plane.'
Assert-Infrastructure ($main -match 'governanceStoreEndpoint:\s*governanceStore\.outputs\.documentEndpoint') 'The control plane must read the store endpoint from the deployed store.'
# Both the store and the platform storage are unreachable from the internet, so both
# must take their endpoint subnet from the network this deployment created.
Assert-Infrastructure ((([regex]::Matches($main, 'privateEndpointSubnetResourceId:\s*network\.outputs\.privateEndpointSubnetResourceId')).Count) -ge 2) 'Every closed resource must take its endpoint subnet from the deployed network.'
Assert-Infrastructure ($main -match 'dataPlanePrincipalId:\s*controlPlane\.outputs\.functionAppPrincipalId') 'Store access must be granted to the deployed control plane identity.'
Assert-Infrastructure ($main -notmatch 'GOVERNANCE_STORE_KEY|accountKey|listKeys\(') 'The deployment must not surface a store credential.'

# Both the gateway and the control plane write to one workspace, and neither may
# depend on the other to obtain it.
$sharedWorkspace = [regex]::Matches($main, 'logAnalyticsWorkspaceResourceId:\s*observability\.outputs\.workspaceResourceId')
Assert-Infrastructure ($sharedWorkspace.Count -ge 2) 'The gateway and the control plane must share one workspace.'
Assert-Infrastructure ($main -notmatch 'logAnalyticsWorkspaceResourceId:\s*gateway\.outputs') 'The control plane must not take its log destination from the gateway.'

# --- Administration ingress posture -----------------------------------------
# One parameter governs the console and the control plane together. Two would allow a
# deployment where the console is closed and the API it calls is not, which is a posture
# nobody chose and which the deployment would still report as private.
$ingressDeclaration = [regex]::Match($main, "@allowed\(\[\s*'(?<first>[^']+)'\s*'(?<second>[^']+)'\s*\]\)\s*param governanceAdministrationIngress string = '(?<default>[^']+)'")
Assert-Infrastructure ($ingressDeclaration.Success) 'The administration surface must be selected by one bounded parameter, so an unrecognised value is refused rather than deployed.'
$ingressPostures = @($ingressDeclaration.Groups['first'].Value, $ingressDeclaration.Groups['second'].Value)
Assert-Infrastructure (($ingressPostures -join ',') -eq 'public-authenticated,private-only') "The administration postures must be exactly the two supported ones: $($ingressPostures -join ', ')"
Assert-Infrastructure ($ingressDeclaration.Groups['default'].Value -eq 'public-authenticated') 'The default must remain the posture already deployed, so an existing deployment is not closed by an upgrade nobody asked for.'

$parametersPath = Join-Path $repositoryRoot 'infra\main.parameters.json'
$parametersText = Get-Content -LiteralPath $parametersPath -Raw
foreach ($template in @($main, (Get-Content -LiteralPath (Join-Path $repositoryRoot 'infra\modules\gateway.bicep') -Raw))) {
    Assert-Infrastructure ($template -match "@allowed\(\[\s*'BasicV2'\s*'Developer'\s*\]\)\s*param apimSku string = 'BasicV2'") 'APIM SKU selection must permit only Developer verification and the BasicV2 public default.'
}
Assert-Infrastructure ($main -match 'apimSku:\s*apimSku') 'The bounded APIM SKU must reach the gateway.'
Assert-Infrastructure ($parametersText.Contains('${APIM_SKU=BasicV2}')) 'The AZD deployment path must preserve BasicV2 unless Developer is explicitly selected.'
Assert-Infrastructure ($parametersText.Contains('${FOUNDRY_SECOND_MODEL_DEPLOYMENTS=[]}')) 'The AZD deployment path must keep the explicit second model disabled by default.'
Assert-Infrastructure ($parametersText.Contains('${GOVERNANCE_ADMINISTRATION_INGRESS=public-authenticated}')) 'The posture must be reachable through the product deployment path, defaulting to the one already deployed.'
Assert-Infrastructure ($parametersText.Contains('${GOVERNANCE_SCOPE_GROUP_ID=platform-engineering}')) 'The durable governance scope must be configurable while preserving the existing deployment partition.'
Assert-Infrastructure ($parametersText.Contains('${GOVERNANCE_KNOWN_TEAM_KEYS=developer-experience,platform-engineering}')) 'The selectable team set must be configurable while preserving the existing deployment authorization surface.'
Assert-Infrastructure ($parametersText.Contains('${GOVERNANCE_MEMBERSHIP_GROUP_IDS=}')) 'Governed directory groups must be configurable with no customer-specific default.'

foreach ($setting in @('governanceScopeGroupId', 'governanceKnownTeamKeys')) {
    Assert-Infrastructure ($main -match "(?m)^param $setting string") "The deployment must declare governance setting $setting."
    Assert-Infrastructure ($main -match "$setting\s*:\s*$setting") "The deployment must pass governance setting $setting to the control plane."
    Assert-Infrastructure ($runtime -match "(?m)^param $setting string = '") "The runtime must declare governance setting $setting with a compatibility default."
}
Assert-Infrastructure ($runtime -match 'GOVERNANCE_SCOPE_GROUP_ID:\s*governanceScopeGroupId') 'The control plane must receive the scope its durable governance is keyed by.'
Assert-Infrastructure ($runtime -match 'GOVERNANCE_KNOWN_TEAM_KEYS:\s*governanceKnownTeamKeys') 'The control plane must receive the teams a global reader may select.'
Assert-Infrastructure ($runtime -notmatch "GOVERNANCE_SCOPE_GROUP_ID:\s*'") 'The runtime setting must come from a parameter rather than a fixture literal.'
Assert-Infrastructure (([regex]::Matches($main, 'governanceMembershipGroupIds:\s*governanceMembershipGroupIds')).Count -eq 2) 'The governed group set must reach both Entra assignments and the control-plane membership source.'
Assert-Infrastructure ($runtime -match "GOVERNANCE_MEMBERSHIP_SOURCE:\s*empty\(governanceMembershipGroupIds\) \? 'store' : 'directory-claim'") 'The membership source must be derived from the applied governed group set.'
Assert-Infrastructure ($main -notmatch '(?m)^param governanceMembershipSource\b') 'The deployment must expose no second switch that can disagree with its group assignments.'
Assert-Infrastructure ($main -match 'output GOVERNANCE_SCOPE string = governanceScopeGroupId') 'The deployment must report the applied durable governance scope.'
Assert-Infrastructure ($main -match 'output GOVERNANCE_TEAMS string = governanceKnownTeamKeys') 'The deployment must report the applied selectable team set.'
Assert-Infrastructure ($main -match 'output GOVERNANCE_MEMBERSHIP_GROUPS string = governanceMembershipGroupIds') 'The deployment must report the applied governed group set.'
Assert-Infrastructure ($main -match "output GOVERNANCE_MEMBERSHIP_SOURCE string = empty\(governanceMembershipGroupIds\) \? 'store' : 'directory-claim'") 'The deployment must report its derived membership source.'

# The same value, not three values that happen to agree today.
$ingressWiring = [regex]::Matches($main, 'governanceAdministrationIngress:\s*governanceAdministrationIngress')
Assert-Infrastructure ($ingressWiring.Count -eq 3) "The console host, the network and the control plane must all take the one posture parameter; $($ingressWiring.Count) of 3 do."
$postureParameters = @([regex]::Matches($main, '(?m)^param\s+(?<name>\w+)') | ForEach-Object { $_.Groups['name'].Value } | Where-Object { $_ -match 'Ingress|PublicNetwork|PrivateOnly|PrivateEndpoint' })
Assert-Infrastructure (($postureParameters -join ',') -eq 'governanceAdministrationIngress') "The deployment must expose no second switch over the administration surface: $($postureParameters -join ', ')"

foreach ($module in @($consoleHost, $network, $runtime)) {
    Assert-Infrastructure ($module -match "@allowed\(\[\s*'public-authenticated'\s*'private-only'\s*\]\)\s*param governanceAdministrationIngress string = 'public-authenticated'") 'Every module on the administration surface must bound the posture identically, or one of them accepts a value the others refuse.'
}
Assert-Infrastructure ($consoleHost -match "var administrationPublicNetworkAccess = governanceAdministrationIngress == 'private-only' \? 'Disabled' : 'Enabled'") 'The console host must derive its public access from the posture.'
Assert-Infrastructure ($consoleHost -match 'publicNetworkAccess:\s*administrationPublicNetworkAccess') 'The console host must apply the derived value rather than a literal.'
Assert-Infrastructure ($runtime -match "var controlPlanePublicNetworkAccess = privateOnlyAdministration \? 'Disabled' : 'Enabled'") 'The control plane must derive its public access from the posture.'
foreach ($module in @($network, $runtime)) {
    Assert-Infrastructure ($module -match "var privateOnlyAdministration = governanceAdministrationIngress == 'private-only'") 'The private branch must be taken from the posture parameter rather than from a local flag.'
}

# Nothing on the administration surface may be provisioned in the public posture, and a
# private endpoint added later must carry the same condition rather than deploy always.
foreach ($conditional in @('adminConsolePrivateDnsZone', 'adminConsolePrivateDnsZoneLink', 'adminConsolePrivateEndpoint', 'adminConsolePrivateEndpointDns', 'controlPlanePrivateDnsZone', 'controlPlanePrivateDnsZoneLink')) {
    Assert-Infrastructure ($network -match "resource $conditional '[^']+' = if \(privateOnlyAdministration\)") "The network module must create this only when administration is private: $conditional"
}
foreach ($conditional in @('controlPlanePrivateEndpoint', 'controlPlanePrivateEndpointDns')) {
    Assert-Infrastructure ($runtime -match "resource $conditional '[^']+' = if \(privateOnlyAdministration\)") "The runtime module must create this only when administration is private: $conditional"
}
foreach ($declaration in [regex]::Matches($network, "(?m)^resource\s+(?<symbol>\w+)\s+'Microsoft\.Network/privateEndpoints[^']*'\s*=\s*(?<tail>[^\r\n]*)")) {
    Assert-Infrastructure ($declaration.Groups['tail'].Value -match '^if \(privateOnlyAdministration\)') "A private endpoint in the network module must exist only when administration is private: $($declaration.Groups['symbol'].Value)"
}

# The service publishes one group per resource and one zone for the app platform. A wrong
# group id creates an endpoint that resolves nothing, and a zone group left off resolves
# the public name the resource has just stopped answering on.
Assert-Infrastructure ($network -match "groupIds:\s*\[\s*\r?\n\s*'staticSites'") 'The console private endpoint must target the static site group.'
Assert-Infrastructure ($runtime -match "groupIds:\s*\[\s*\r?\n\s*'sites'") 'The control plane private endpoint must target the site group.'
Assert-Infrastructure ($network -match 'privateDnsZoneId:\s*adminConsolePrivateDnsZone\.id') 'The console private endpoint must publish its private address into the zone this deployment created.'
Assert-Infrastructure ($runtime -match 'privateDnsZoneId:\s*controlPlanePrivateDnsZoneResourceId') 'The control plane private endpoint must publish its private address into the zone this deployment created.'

# Scoped to each endpoint rather than to the whole file, because a subnet or a zone that
# is correct somewhere else in the module is still wrong here: an endpoint placed on the
# delegated integration subnet, or a zone group pointing at a storage zone, both deploy
# and then resolve nothing.
$consoleEndpointBlock = [regex]::Match($network, "resource adminConsolePrivateEndpoint '.*?\r?\n\}", 'Singleline').Value
Assert-Infrastructure (-not [string]::IsNullOrWhiteSpace($consoleEndpointBlock)) 'The network module must declare the console private endpoint.'
Assert-Infrastructure ($consoleEndpointBlock -match 'id:\s*privateEndpointSubnet\.id') 'The console private endpoint must be placed on the endpoint subnet, not on the subnet delegated to the function platform.'
Assert-Infrastructure ($consoleEndpointBlock -match 'privateLinkServiceId:\s*adminConsoleResourceId') 'The console private endpoint must attach to the console host the deployment passed in.'

$consoleZoneGroupBlock = [regex]::Match($network, "resource adminConsolePrivateEndpointDns '.*?\r?\n\}", 'Singleline').Value
Assert-Infrastructure (-not [string]::IsNullOrWhiteSpace($consoleZoneGroupBlock)) 'The network module must declare the console DNS zone group.'
Assert-Infrastructure ($consoleZoneGroupBlock -match 'parent:\s*adminConsolePrivateEndpoint\b') 'The console DNS zone group must attach to the console endpoint rather than to another one.'
$consoleZoneIds = @([regex]::Matches($consoleZoneGroupBlock, 'privateDnsZoneId:\s*(?<value>[^\r\n]+)') | ForEach-Object { $_.Groups['value'].Value.Trim() })
Assert-Infrastructure (($consoleZoneIds -join ',') -eq 'adminConsolePrivateDnsZone.id') "The console DNS zone group must resolve exactly one zone and it must be the console zone: $($consoleZoneIds -join ', ')"

$controlPlaneEndpointBlock = [regex]::Match($runtime, "resource controlPlanePrivateEndpoint '.*?\r?\n\}", 'Singleline').Value
Assert-Infrastructure (-not [string]::IsNullOrWhiteSpace($controlPlaneEndpointBlock)) 'The runtime module must declare the control plane private endpoint.'
Assert-Infrastructure ($controlPlaneEndpointBlock -match 'id:\s*privateEndpointSubnetResourceId') 'The control plane private endpoint must be placed on the endpoint subnet the network module deployed.'
Assert-Infrastructure ($controlPlaneEndpointBlock -match 'privateLinkServiceId:\s*functionApp\.id') 'The control plane private endpoint must attach to the function app this module created.'

$controlPlaneZoneGroupBlock = [regex]::Match($runtime, "resource controlPlanePrivateEndpointDns '.*?\r?\n\}", 'Singleline').Value
Assert-Infrastructure (-not [string]::IsNullOrWhiteSpace($controlPlaneZoneGroupBlock)) 'The runtime module must declare the control plane DNS zone group.'
Assert-Infrastructure ($controlPlaneZoneGroupBlock -match 'parent:\s*controlPlanePrivateEndpoint\b') 'The control plane DNS zone group must attach to the control plane endpoint rather than to a storage one.'
$controlPlaneZoneIds = @([regex]::Matches($controlPlaneZoneGroupBlock, 'privateDnsZoneId:\s*(?<value>[^\r\n]+)') | ForEach-Object { $_.Groups['value'].Value.Trim() })
Assert-Infrastructure (($controlPlaneZoneIds -join ',') -eq 'controlPlanePrivateDnsZoneResourceId') "The control plane DNS zone group must resolve exactly one zone and it must be the app platform zone: $($controlPlaneZoneIds -join ', ')"

# The deployment passes both in either posture, so neither may carry a default. An empty
# resource id attaches the endpoint to nothing, and an empty hostname derives the bare
# privatelink prefix, which is a zone that deploys and then resolves nothing.
foreach ($required in @('adminConsoleResourceId', 'adminConsoleDefaultHostname')) {
    Assert-Infrastructure ($network -match "@minLength\(1\)\r?\nparam $required string\r?\n") "The console input must be declared required and non-empty: $required"
    Assert-Infrastructure ($network -notmatch "param $required string\s*=") "The console input must not carry a default that the private branch would accept silently: $required"
}

Assert-Infrastructure ($main -match 'controlPlanePrivateDnsZoneResourceId:\s*network\.outputs\.controlPlanePrivateDnsZoneResourceId') 'The control plane must take its zone from the deployed network rather than name one.'
Assert-Infrastructure ($main -match 'adminConsoleResourceId:\s*adminConsoleHost\.outputs\.staticSiteResourceId') 'The console private endpoint must attach to the deployed console host.'
Assert-Infrastructure ($network -notmatch 'privatelink\.scm|scm\.privatelink') 'The app platform resolves one zone, so a second scm zone would be a name nothing answers on.'
Assert-Infrastructure ($network -match "join\(skip\(split\(adminConsoleDefaultHostname, '\.'\), 1\), '\.'\)") 'The console zone must follow the partition in the hostname the service issued, because a site in a regional partition is not resolved by the plain zone.'
Assert-Infrastructure ($network -match "param controlPlanePrivateDnsZoneName string = 'privatelink\.azurewebsites\.net'") 'The control plane zone must default to the public cloud name and stay overridable, as the other two named zones already are.'

# Closing the public network changes where the issued name resolves, not what it is
# called, so the sign-in redirect and the browser origin are unchanged by the posture.
Assert-Infrastructure ($consoleHost -match "output origin string = 'https://\$\{staticSite\.properties\.defaultHostname\}'") 'The console origin must remain the hostname the service issued.'
Assert-Infrastructure ($consoleHost -notmatch 'customDomain') 'No custom domain may stand in for the issued hostname.'
Assert-Infrastructure ((([regex]::Matches($main, 'adminConsoleOrigin:\s*adminConsoleHost\.outputs\.origin')).Count) -ge 2) 'The sign-in redirect and the control plane CORS origin must both be the deployed console origin.'

# The shared zones are addressed by index by every caller of this module, so the
# administration zones are declared separately and these five keep their positions.
$zoneList = [regex]::Match($network, 'var privateDnsZoneNames = \[(?<body>.*?)\r?\n\]', 'Singleline')
Assert-Infrastructure ($zoneList.Success) 'The shared private DNS zones must be declared in one list.'
$zoneEntries = @($zoneList.Groups['body'].Value -split "\r?\n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
Assert-Infrastructure ($zoneEntries.Count -eq 5) "The shared zone list must hold exactly five entries; it holds $($zoneEntries.Count)."
Assert-Infrastructure ($zoneEntries[3] -eq 'governanceStorePrivateDnsZoneName') 'The governance store must keep index 3 in the shared zone list.'
Assert-Infrastructure ($zoneEntries[4] -eq 'keyStorePrivateDnsZoneName') 'The key store must keep index 4 in the shared zone list.'
Assert-Infrastructure ($zoneList.Groups['body'].Value -notmatch 'adminConsolePrivateDnsZoneName|controlPlanePrivateDnsZoneName') 'An administration zone added to the indexed list would move every zone the other modules address by position.'
$indexedZoneOutputs = [ordered]@{
    blobPrivateDnsZoneResourceId = 0
    queuePrivateDnsZoneResourceId = 1
    tablePrivateDnsZoneResourceId = 2
    governanceStorePrivateDnsZoneResourceId = 3
    keyStorePrivateDnsZoneResourceId = 4
}
foreach ($outputName in $indexedZoneOutputs.Keys) {
    Assert-Infrastructure ($network -match "output $outputName string = privateDnsZones\[$($indexedZoneOutputs[$outputName])\]\.id") "The shared zone output must keep its index: $outputName"
}

[pscustomobject]@{
    Containers = $deployed.Count
    HierarchicalContainers = $hierarchical.Count
    CapacityMode = 'Serverless'
    LocalAuthDisabled = $true
    ComputePlatform = 'FlexConsumption'
    PlatformStorageReachableFrom = 'PrivateEndpointOnly'
    WiredModules = $wiredModules.Count
    AdministrationIngressPostures = ($ingressPostures -join ', ')
    Result = 'Pass'
} | Format-List
