[CmdletBinding()]
param(
    [switch]$PublicOnly,

    [string]$TemplatePath = (Join-Path $PSScriptRoot '..\..\infra\main.bicep')
)

$ErrorActionPreference = 'Stop'

function Assert-Iac {
    param(
        [Parameter(Mandatory)]
        [bool]$Condition,

        [Parameter(Mandatory)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Get-CompiledResources {
    param(
        [Parameter(Mandatory)]
        [object]$Template,

        [string]$Path = '$'
    )

    $resources = @()
    if ($null -eq $Template.resources) {
        return $resources
    }

    $currentResources = if ($Template.resources -is [array]) {
        @($Template.resources | ForEach-Object {
            [pscustomobject]@{
                Symbol = '[]'
                Resource = $_
            }
        })
    }
    else {
        @($Template.resources.PSObject.Properties | ForEach-Object {
            [pscustomobject]@{
                Symbol = $_.Name
                Resource = $_.Value
            }
        })
    }

    foreach ($entry in $currentResources) {
        $resource = $entry.Resource
        $resourcePath = "$Path/$($entry.Symbol)"
        $resources += [pscustomobject]@{
            Path = $resourcePath
            Resource = $resource
        }
        if ($null -ne $resource.properties.template) {
            $resources += Get-CompiledResources -Template $resource.properties.template -Path $resourcePath
        }
    }

    return $resources
}

$bicep = Get-Command bicep -ErrorAction Stop
$compiledLines = @(& $bicep.Source build $TemplatePath --stdout)
Assert-Iac ($LASTEXITCODE -eq 0) 'Bicep compilation failed.'
$compiledText = $compiledLines -join [Environment]::NewLine
$compiledTemplate = $compiledText | ConvertFrom-Json

$infraRoot = Split-Path -Parent $TemplatePath
$bicepFiles = @(Get-ChildItem -LiteralPath $infraRoot -Filter '*.bicep' -Recurse)
$mainSourceText = Get-Content -LiteralPath $TemplatePath -Raw
Assert-Iac ($mainSourceText.Contains('if (createFoundry && toLower(foundryResourceGroupName) != toLower(gatewayResourceGroupName))')) 'A shared Foundry/gateway resource group must not be declared twice.'
foreach ($moduleName in @('foundry', 'secondaryFoundry')) {
    $dependencyPattern = "module $moduleName '[^']+'[\s\S]*?dependsOn:\s*\[\s*foundryResourceGroup\s*gatewayResourceGroup\s*\]"
    Assert-Iac ($mainSourceText -match $dependencyPattern) "$moduleName must wait for resource-group creation in both shared and separate group modes."
}
$mainModuleFiles = @(
    (Join-Path $infraRoot 'modules\identity.bicep'),
    (Join-Path $infraRoot 'modules\gateway.bicep'),
    (Join-Path $infraRoot 'modules\foundry-access.bicep'),
    (Join-Path $infraRoot 'modules\foundry-provider-reader-access.bicep')
)
$sourceText = (@($mainSourceText) + @($mainModuleFiles | ForEach-Object { Get-Content -LiteralPath $_ -Raw })) -join [Environment]::NewLine

$existingFoundryDeclarations = [ordered]@{
    'Microsoft.CognitiveServices/accounts' = 'existingFoundryAccount'
    'Microsoft.CognitiveServices/accounts/projects' = 'existingFoundryProject'
    'Microsoft.CognitiveServices/accounts/deployments' = 'existingFoundryDeployment'
}
foreach ($entry in $existingFoundryDeclarations.GetEnumerator()) {
    $pattern = "resource\s+$($entry.Value)\s+'$([regex]::Escape($entry.Key))@[^']+'\s+existing\s*="
    Assert-Iac ($mainSourceText -match $pattern) "Existing-create mode must declare $($entry.Key) as existing."
}

$accountDeclarations = @([regex]::Matches($sourceText, "resource\s+\w+\s+'Microsoft\.CognitiveServices/accounts@[^']+'\s+(?<existing>existing\s+)?="))
Assert-Iac ($accountDeclarations.Count -ge 2) 'Existing-create mode and its access module must declare Foundry account references.'
Assert-Iac (@($accountDeclarations | Where-Object { -not $_.Groups['existing'].Success }).Count -eq 0) 'Every Foundry account declaration in existing-create mode must be existing-only.'
Assert-Iac (-not $sourceText.Contains('br/public:avm/res/cognitive-services/account:')) 'IaC must not invoke a module that creates a Cognitive Services account.'

$remoteModules = @([regex]::Matches($sourceText, "br/public:(?<path>[^']+):(?<version>[^']+)"))
Assert-Iac ($remoteModules.Count -ge 4) 'Expected pinned Azure Verified Modules were not found.'
foreach ($remoteModule in $remoteModules) {
    Assert-Iac ($remoteModule.Groups['version'].Value -match '^\d+\.\d+\.\d+$') "AVM reference must use a fixed semantic version: $($remoteModule.Value)"
}

$gatewayModuleText = Get-Content -LiteralPath (Join-Path $infraRoot 'modules\gateway.bicep') -Raw
foreach ($templateText in @($mainSourceText, $gatewayModuleText)) {
    $apimSkuDeclaration = [regex]::Match($templateText, "@allowed\(\[\s*'BasicV2'\s*'Developer'\s*\]\)\s*param apimSku string = 'BasicV2'")
    Assert-Iac $apimSkuDeclaration.Success 'API Management SKU selection must be bounded to BasicV2 and Developer and preserve BasicV2 as the default.'
}
Assert-Iac ($mainSourceText -match 'apimSku:\s*apimSku') 'The selected API Management SKU must reach the gateway module.'
Assert-Iac ($gatewayModuleText -match 'sku:\s*apimSku') 'The gateway must pass the bounded SKU to the API Management module.'
Assert-Iac (-not $sourceText.Contains("sku: 'StandardV2'")) 'The development template must not incur Standard v2 fixed cost before the network phase.'
Assert-Iac ($sourceText.Contains('skuCapacity: 1')) 'Development API Management capacity must be one unit.'
Assert-Iac ($sourceText.Contains("path: 'v1'")) 'The APIM API suffix must be v1.'
Assert-Iac ($sourceText.Contains("'/responses': publicApiDefinition.paths['/v1/responses']")) 'The Responses schema must be imported under the APIM-relative path.'
Assert-Iac ($sourceText.Contains("'/chat/completions': publicApiDefinition.paths['/v1/chat/completions']")) 'The Chat schema must be imported under the APIM-relative path.'
Assert-Iac ($sourceText.Contains("format: 'openapi+json'")) 'APIM must import the path-transformed OpenAPI document.'
Assert-Iac ($sourceText.Contains('value: string(apimApiDefinition)')) 'APIM must import the generated deployment contract.'
Assert-Iac ($sourceText.Contains('var apimApiDefinition = shallowMerge([')) 'The APIM contract must replace the nested paths object instead of recursively merging it.'
Assert-Iac (-not $sourceText.Contains('union(publicApiDefinition')) 'Recursive union would retain public /v1 paths and create a double-prefix API surface.'
Assert-Iac (-not $sourceText.Contains("'/v1/v1/")) 'The transformed contract must not produce a /v1/v1 route.'
foreach ($module in @{ 'standalone gateway' = $gatewayModuleText }.GetEnumerator()) {
    $byteSettings = @([regex]::Matches($module.Value, 'bytes:\s*(\d+)'))
    Assert-Iac ($byteSettings.Count -gt 0) "The $($module.Key) must declare diagnostic body byte settings."
    foreach ($setting in $byteSettings) {
        Assert-Iac ($setting.Groups[1].Value -eq '0') "The $($module.Key) must disable all frontend and backend body logging."
    }
}

# Without `largeLanguageModel` the LLM token log stays empty, and the usage query's
# leftouter join then reports every served request as an abandoned stream.
foreach ($module in @{ 'standalone gateway' = $gatewayModuleText }.GetEnumerator()) {
    $diagnosticVersions = @([regex]::Matches($module.Value, "service/apis/diagnostics@(?<version>[0-9a-z\-]+)'"))
    Assert-Iac ($diagnosticVersions.Count -eq 1) "The $($module.Key) must declare exactly one API diagnostic."
    Assert-Iac ($diagnosticVersions[0].Groups['version'].Value -ne '2024-05-01') "The $($module.Key) API diagnostic must use an API version that supports LLM logging."
    Assert-Iac ($module.Value -match "largeLanguageModel:\s*\{[^}]*logs:\s*'enabled'") "The $($module.Key) must enable the LLM token log."
    foreach ($contentSetting in @('requests:', 'responses:', 'messages:', 'maxSizeInBytes')) {
        Assert-Iac (-not $module.Value.Contains($contentSetting)) "The $($module.Key) must not capture LLM message content ($contentSetting)."
    }
}
# The organization token counter is shared by every caller. A description calling it
# per-caller invites an operator to multiply it by the number of users and cap the whole
# organization at one user's share.
foreach ($template in @('main.bicep')) {
    $text = Get-Content -LiteralPath (Join-Path $infraRoot $template) -Raw
    $tokenDescription = [regex]::Match($text, "@description\('([^']*)'\)\s*\r?\n\s*@minValue\(1\)\s*\r?\n\s*param tokensPerMinute")
    Assert-Iac ($tokenDescription.Success) "$template must document the token allowance."
    Assert-Iac ($tokenDescription.Groups[1].Value -notmatch '(?i)per-caller') "$template must not describe the shared organization token counter as per-caller."
    Assert-Iac ($tokenDescription.Groups[1].Value -match '(?i)organization') "$template must name the scope the token counter actually uses."
}

if (-not $PublicOnly) {
    # Two targeted templates owning one named value means whichever ran last wins, silently.
    # A what-if caught the policy template reverting an allowance change; these values belong
    # to the allowance template alone.
    $allowanceOwned = @('throttle-tier-reduced-calls', 'throttle-tier-minimal-calls', 'requests-per-minute', 'organization-tokens-per-minute', 'default-effective-policy')
    $allowanceText = Get-Content -LiteralPath (Join-Path $infraRoot 'c0-allowances.bicep') -Raw
    $policyUpgradeText = Get-Content -LiteralPath (Join-Path $infraRoot 'c0-policy-upgrade.bicep') -Raw
    foreach ($value in $allowanceOwned) {
        Assert-Iac ($allowanceText.Contains($value)) "The allowance template must own: $value"
        Assert-Iac (-not $policyUpgradeText.Contains($value)) "The policy template must not also write: $value"
    }
    $allowanceNamedValueNames = @([regex]::Matches($allowanceText, "\{\s*name:\s*'(?<name>[^']+)'") | ForEach-Object { $_.Groups['name'].Value })
    foreach ($admissionSwitch in @('governance-policy-enabled', 'allow-ungoverned-evaluation-mode')) {
        Assert-Iac ($allowanceNamedValueNames -notcontains $admissionSwitch) "The allowance-only template must not mutate admission switch: $admissionSwitch"
    }

    # The C0 policy upgrade is applied to older gateways, so every named value newly
    # referenced by the policy must be created before APIM receives the new policy body.
    $c0PolicyUpgradeOwnedNamedValues = @(
        'substitution-notice-text',
        'entra-developer-client-application-id',
        'entra-workload-app-role',
        'pooled-model-deployments',
        'allow-ungoverned-evaluation-mode'
    )
    $c0PolicyUpgradeNamedValueBlock = [regex]::Match($policyUpgradeText, 'var\s+newNamedValues\s*=\s*\[(?<body>[\s\S]*?)\r?\n\]')
    Assert-Iac $c0PolicyUpgradeNamedValueBlock.Success 'The C0 policy upgrade must declare its newly required named values in one list.'
    $c0PolicyUpgradeNames = @([regex]::Matches($c0PolicyUpgradeNamedValueBlock.Groups['body'].Value, "name:\s*'(?<name>[^']+)'") | ForEach-Object { $_.Groups['name'].Value })
    $c0PolicyUpgradeNameSet = ($c0PolicyUpgradeNames | Sort-Object -Unique) -join '|'
    $c0PolicyUpgradeExpectedNameSet = ($c0PolicyUpgradeOwnedNamedValues | Sort-Object) -join '|'
    Assert-Iac ($c0PolicyUpgradeNameSet -eq $c0PolicyUpgradeExpectedNameSet) 'The C0 policy upgrade must provision exactly every new named-value substitution it owns.'
    Assert-Iac ($policyUpgradeText -match 'param\s+allowUngovernedEvaluationMode\s+bool(?!\s*=)') 'The C0 policy upgrade must require the caller to explicitly choose whether ungoverned evaluation is enabled.'
    Assert-Iac ($policyUpgradeText -match "name:\s*'allow-ungoverned-evaluation-mode'\s*,\s*value:\s*string\(allowUngovernedEvaluationMode\)") 'The C0 policy upgrade must provision the explicit ungoverned-evaluation choice before writing the policy.'
    $policyDependencyBlock = [regex]::Match($policyUpgradeText, "resource\s+inferencePolicy\s+'Microsoft\.ApiManagement/service/apis/policies@[^']+'\s*=\s*\{(?<body>[\s\S]*?)\r?\n\}")
    Assert-Iac $policyDependencyBlock.Success 'The C0 policy upgrade must declare the inference policy resource.'
    Assert-Iac ($policyDependencyBlock.Groups['body'].Value -match 'dependsOn:\s*\[\s*\r?\n\s*namedValues') 'The C0 inference policy must wait for every newly provisioned named value.'
}

Assert-Iac ($sourceText.Contains('5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')) 'The Foundry assignment must use Cognitive Services OpenAI User.'
Assert-Iac ($sourceText.Contains("scope: foundryAccount")) 'The inference role must be scoped to the existing Foundry account.'
Assert-Iac ($sourceText.Contains("principalType: 'ServicePrincipal'")) 'The APIM managed identity role assignment must identify a service principal.'
Assert-Iac ($sourceText.Contains('3913510d-42f4-4e42-8a64-420c390055eb')) 'APIM telemetry must use Monitoring Metrics Publisher.'
Assert-Iac ($sourceText.Contains('scope: applicationInsightsResource')) 'The telemetry role must be scoped to the Application Insights component.'
Assert-Iac ($sourceText.Contains("identityClientId: 'systemAssigned'")) 'The Application Insights logger must authenticate with the APIM system-assigned identity.'
Assert-Iac ($sourceText.Contains('connectionString: applicationInsights.outputs.connectionString')) 'The Application Insights logger must use the managed-identity connection-string pattern.'
Assert-Iac ($sourceText.Contains('43d0d8ad-25c7-4714-9337-8ba259a9fe05')) 'The provider reader must use the built-in Monitoring Reader role.'
Assert-Iac ($sourceText.Contains('scope: foundryAccount')) 'The provider reader must be scoped to the Foundry account.'
Assert-Iac ($mainSourceText -match 'providerAccountResourceId:\s*primaryFoundryAccountResourceId') 'The selected Foundry account ID must reach the runtime.'
$protectedResourceIdsBlock = [regex]::Match($mainSourceText, 'protectedResourceIds:\s*concat\((?<body>[\s\S]*?)\r?\n\s*\)\r?\n\s*keyVaultLifecycle:')
Assert-Iac $protectedResourceIdsBlock.Success 'The ownership inventory must declare protected resource IDs.'
$protectedResourceIds = $protectedResourceIdsBlock.Groups['body'].Value
Assert-Iac ($protectedResourceIds -match '!createFoundry\s*\?') 'Foundry protection must apply only to reused resources, never resources created by fresh mode.'
Assert-Iac (
    $protectedResourceIds.Contains("subscriptionResourceId('Microsoft.Resources/resourceGroups', foundryResourceGroupName)")
) 'The protected Foundry resource group must derive from the external Foundry input, including synthetic external resource groups.'
Assert-Iac (
    $protectedResourceIds -notmatch "subscriptionResourceId\(\s*'Microsoft\.Resources/resourceGroups'\s*,\s*'"
) 'Protected resource-group IDs must use deployment inputs rather than fixed names.'
foreach ($foundryReference in @('existingFoundryAccount.id', 'existingFoundryProject.id', 'existingFoundryDeployment.id')) {
    Assert-Iac ($protectedResourceIds.Contains($foundryReference)) "The ownership inventory must retain protection for $foundryReference."
}

# Creating the resource-level gateway association was observed to write resource links.
# That write belongs to no documented contract, so it is not automated here.
foreach ($bicepFile in $bicepFiles) {
    $text = Get-Content -LiteralPath $bicepFile.FullName -Raw
    Assert-Iac (-not $text.Contains('Microsoft.Resources/links')) "Resource links are not a supported contract: $($bicepFile.Name)"
    # A project connection is an Agent Service integration, not a gateway association.
    # Declaring one without saying so is how the two get reported as the same thing.
    foreach ($match in [regex]::Matches($text, "resource\s+\w+\s+'Microsoft\.CognitiveServices/accounts/projects/connections@")) {
        $preceding = $text.Substring(0, $match.Index)
        Assert-Iac ($preceding -match '(?i)agent service[^\r\n]*\r?\n[^\r\n]*$') "A project connection must be declared as the Agent Service integration it is: $($bicepFile.Name)"
    }
}
Assert-Iac (-not $sourceText.Contains('instrumentationKey: applicationInsights.outputs.instrumentationKey')) 'The APIM logger must not use instrumentation-key-only authentication.'
Assert-Iac ($sourceText.Contains('disableLocalAuth: true')) 'Application Insights local authentication must be disabled.'

$compiledResources = @(Get-CompiledResources -Template $compiledTemplate)
$activeCompiledResourceTypes = @($compiledResources | Where-Object { -not [bool]$_.Resource.existing } | ForEach-Object { $_.Resource.type })
$existingCompiledResourceTypes = @($compiledResources | Where-Object { [bool]$_.Resource.existing } | ForEach-Object { $_.Resource.type })
$initialAuthentication = $compiledTemplate.resources.controlPlaneAuthentication
Assert-Iac ($initialAuthentication.type -eq 'Microsoft.Resources/deployments') 'The first Easy Auth application must compile as its own nested deployment.'
Assert-Iac (@($initialAuthentication.dependsOn) -contains 'controlPlane') 'Easy Auth must not be applied until Function creation completes.'
$compiledAuthenticationResources = @($initialAuthentication.properties.template.resources.PSObject.Properties.Value)
Assert-Iac (@($compiledAuthenticationResources | Where-Object { $_.type -eq 'Microsoft.Web/sites/config' -and $_.name -match 'authsettingsV2' }).Count -eq 1) 'The first authentication deployment must write exactly one authsettingsV2 resource.'
$compiledAuthSettings = @($compiledAuthenticationResources | Where-Object { $_.type -eq 'Microsoft.Web/sites/config' -and $_.name -match 'authsettingsV2' })[0]
$compiledValidation = $compiledAuthSettings.properties.identityProviders.azureActiveDirectory.validation
Assert-Iac ($null -ne $compiledValidation.defaultAuthorizationPolicy) 'The compiled Easy Auth document must carry the neutral authorization policy explicitly.'
Assert-Iac ($null -ne $compiledValidation.defaultAuthorizationPolicy.allowedPrincipals) 'The compiled neutral policy must carry allowedPrincipals.'
Assert-Iac ($null -eq $compiledValidation.defaultAuthorizationPolicy.PSObject.Properties['allowedApplications']) 'The compiled Easy Auth document must omit allowedApplications entirely.'
# Creating the Foundry hierarchy is an option of this template rather than a second
# file, so "must not deploy one" became "must not deploy one unless asked". A rendered
# type cannot tell those apart, because a module declared `= if (...)` is emitted either
# way; what distinguishes them is the condition on the deployment that creates it.
$foundryCreatingDeployments = @(
    $compiledTemplate.resources.PSObject.Properties |
        Where-Object { $_.Value.type -eq 'Microsoft.Resources/deployments' } |
        Where-Object {
            $nested = $_.Value.properties.template.resources
            if ($null -eq $nested) { return $false }
            $items = if ($nested -is [array]) { @($nested) } else { @($nested.PSObject.Properties.Value) }
            @($items | Where-Object { $_.type -in $existingFoundryDeclarations.Keys -and -not [bool]$_.existing }).Count -gt 0
        }
)
Assert-Iac ($foundryCreatingDeployments.Count -gt 0) 'The template must be able to create the Foundry hierarchy, which is the option for a customer who has none.'
# A narrower condition is allowed, because the second account is created only when one is named,
# but ownership must remain a conjunct of it: without that, connecting to a project that already
# exists would create a second one beside it.
foreach ($deployment in $foundryCreatingDeployments) {
    $creationCondition = [string]$deployment.Value.condition
    $ownershipGated = $creationCondition -eq "[parameters('createFoundry')]" -or
        $creationCondition -match "^\[and\(parameters\('createFoundry'\),"
    Assert-Iac $ownershipGated "Deployment '$($deployment.Name)' creates the Foundry hierarchy without the ownership condition, so connecting to a project that already exists would create a second one."
}
foreach ($resourceType in $existingFoundryDeclarations.Keys) {
    Assert-Iac ($existingCompiledResourceTypes -contains $resourceType) "The compiled template must retain an existing reference to $resourceType."
}

$requiredCompiledResources = [ordered]@{
    '$/gateway/apim/service' = 'Microsoft.ApiManagement/service'
    '$/gateway/logAnalytics/logAnalyticsWorkspace' = 'Microsoft.OperationalInsights/workspaces'
    '$/gateway/applicationInsights/appInsights' = 'Microsoft.Insights/components'
    '$/gateway/applicationInsightsPublisherRole' = 'Microsoft.Authorization/roleAssignments'
}
foreach ($requiredResource in $requiredCompiledResources.GetEnumerator()) {
    $match = @($compiledResources | Where-Object Path -eq $requiredResource.Key)
    Assert-Iac ($match.Count -eq 1) "Compiled template is missing active resource $($requiredResource.Key)."
    Assert-Iac ($match[0].Resource.type -eq $requiredResource.Value) "Compiled resource $($requiredResource.Key) has an unexpected type."
}

$foundryAccessAssignments = @($compiledResources | Where-Object {
    $_.Path -like '$/foundryAccess/*' -and $_.Resource.type -eq 'Microsoft.Authorization/roleAssignments'
})
Assert-Iac ($foundryAccessAssignments.Count -eq 1) 'The Foundry access module must render exactly one account-scoped role assignment.'

# REL-003. A pool may only balance across members that serve the same model, so the second
# account is rendered from the same module as the first and what must be asserted is that the
# model it is given is the same one. The grant is separate because it is account-scoped: a
# member the gateway cannot authenticate to fails every request the pool hands it.
$secondaryFoundryDeployment = $compiledTemplate.resources.secondaryFoundry
Assert-Iac ($null -ne $secondaryFoundryDeployment) 'The template must be able to create the second Foundry account the pool balances across.'
Assert-Iac ([string]$secondaryFoundryDeployment.condition -match "not\(empty\(parameters\('secondaryFoundryAccountName'\)\)\)") 'The second Foundry account must be created only when a deployment names one.'
$primaryModelParameters = $compiledTemplate.resources.foundry.properties.parameters
$secondaryModelParameters = $secondaryFoundryDeployment.properties.parameters
foreach ($sharedParameter in @('deploymentName', 'modelName', 'modelVersion', 'modelFormat', 'modelSkuName')) {
    $primaryValue = $primaryModelParameters.$sharedParameter | ConvertTo-Json -Compress -Depth 10
    $secondaryValue = $secondaryModelParameters.$sharedParameter | ConvertTo-Json -Compress -Depth 10
    Assert-Iac ($primaryValue -eq $secondaryValue) "Pool members must agree on $sharedParameter, or the pool balances a request across accounts that do not serve the same model."
}

$secondModelParameter = $compiledTemplate.parameters.secondModelDeployments
Assert-Iac ($secondModelParameter.type -eq 'array') 'The optional second model must be represented as a typed array.'
Assert-Iac ($secondModelParameter.maxLength -eq 1) 'At most one explicit second model may be supplied.'
Assert-Iac (@($secondModelParameter.defaultValue).Count -eq 0) 'The second model must default to disabled without placeholder product values.'
$secondModelDefinitionName = ([string]$secondModelParameter.items.'$ref').Split('/')[-1]
$secondModelItem = $compiledTemplate.definitions.$secondModelDefinitionName
Assert-Iac ($secondModelItem.type -eq 'object') 'Each second-model entry must be a structured object.'
Assert-Iac ($secondModelItem.additionalProperties -eq $false) 'Unknown second-model fields must be rejected.'
$requiredSecondModelFields = @('deploymentName', 'modelName', 'modelVersion', 'modelFormat', 'skuName', 'capacity')
Assert-Iac ((@($secondModelItem.properties.PSObject.Properties.Name | Sort-Object) -join ',') -eq (($requiredSecondModelFields | Sort-Object) -join ',')) 'A second model must provide exactly every identifying and capacity field.'
foreach ($field in @('deploymentName', 'modelName', 'modelVersion', 'modelFormat', 'skuName')) {
    Assert-Iac ($secondModelItem.properties.$field.minLength -eq 1) "Second-model field $field must reject an empty value."
}
Assert-Iac ($secondModelItem.properties.capacity.minValue -eq 1) 'Second-model capacity must be explicit and positive.'

$freshFoundryTemplate = $compiledTemplate.resources.foundry.properties.template
Assert-Iac ([string]$compiledTemplate.resources.foundry.condition -eq "[parameters('createFoundry')]") 'The fresh account and both of its model deployments must remain absent when createFoundry is false.'
$secondFoundryModel = $freshFoundryTemplate.resources.secondFoundryDeployment
Assert-Iac ($secondFoundryModel.type -eq 'Microsoft.CognitiveServices/accounts/deployments') 'Fresh Foundry mode must declare the optional second deployment in the primary account.'
Assert-Iac ($secondFoundryModel.copy.count -match "length\(parameters\('secondModelDeployments'\)\)") 'The second deployment must be absent when its array is empty.'
Assert-Iac ($secondFoundryModel.dependsOn -contains 'foundryAccount') 'The second model must deploy beneath the same newly created Foundry account.'
Assert-Iac ($secondFoundryModel.dependsOn -contains 'foundryDeployment') 'The second model must wait for the primary deployment to avoid concurrent parent-account updates.'
$freshCreatedResourceIds = [string]$freshFoundryTemplate.outputs.createdResourceIds.value
foreach ($resourceType in @(
    'Microsoft.CognitiveServices/accounts',
    'Microsoft.CognitiveServices/accounts/projects',
    'Microsoft.CognitiveServices/accounts/deployments'
)) {
    Assert-Iac ($freshCreatedResourceIds.Contains($resourceType)) "Fresh Foundry ownership must include its $resourceType resource ID."
}
Assert-Iac ($freshCreatedResourceIds.Contains("variables('secondDeploymentResourceIds')")) 'Fresh Foundry ownership must include every optional second-model deployment ID.'
$secondDeploymentOwnership = @($freshFoundryTemplate.variables.copy | Where-Object name -eq 'secondDeploymentResourceIds')
Assert-Iac ($secondDeploymentOwnership.Count -eq 1) 'Optional second-model ownership must be derived exactly once.'
Assert-Iac ([string]$secondDeploymentOwnership[0].count -match "length\(parameters\('secondModelDeployments'\)\)") 'Optional second-model ownership must have the same cardinality as the deployment array.'
Assert-Iac ([string]$secondDeploymentOwnership[0].input -match "secondModelDeployments.*deploymentName") 'Optional second-model ownership must use each actual deployment name.'

$ownershipSeed = $compiledTemplate.outputs.OWNERSHIP_MANIFEST_SEED.value
$seedCreatedResources = [string]$ownershipSeed.createdResourceIds
Assert-Iac ($seedCreatedResources -match "and\(parameters\('createFoundry'\), not\(equals\(toLower\(parameters\('foundryResourceGroupName'\)\), toLower\(parameters\('gatewayResourceGroupName'\)\)\)\)\).*foundryResourceGroupName") 'A distinct fresh Foundry resource group must be owned, while a shared gateway group must not be duplicated.'
Assert-Iac ($seedCreatedResources -match "if\(parameters\('createFoundry'\), reference\('foundry'\)\.outputs\.createdResourceIds\.value, createArray\(\)\)") 'Primary fresh Foundry resources must be created ownership only in fresh mode.'
Assert-Iac ($seedCreatedResources -match "and\(parameters\('createFoundry'\), not\(empty\(parameters\('secondaryFoundryAccountName'\)\)\)\).*reference\('secondaryFoundry'\)\.outputs\.createdResourceIds") 'A configured secondary fresh Foundry account must contribute its complete resource ownership.'
Assert-Iac ($seedCreatedResources -match "and\(parameters\('deployGateway'\), not\(empty\(parameters\('secondaryFoundryAccountName'\)\)\)\).*reference\('secondaryFoundryAccess'\)\.outputs\.createdResourceIds") 'Secondary Foundry access resources must be included when that backend is configured.'
$seedExternalReferences = [string]$ownershipSeed.externalReferences
$seedProtectedResources = [string]$ownershipSeed.protectedResourceIds
Assert-Iac (
    $seedExternalReferences -match "if\(not\(parameters\('createFoundry'\)\)" -and
    $seedExternalReferences.Contains('Microsoft.CognitiveServices/accounts/projects') -and
    $seedExternalReferences.Contains('Microsoft.CognitiveServices/accounts/deployments')
) 'Reused Foundry account, project, and deployment resources must remain external references.'
Assert-Iac ($seedProtectedResources -match "if\(not\(parameters\('createFoundry'\)\).*foundryResourceGroupName") 'The reused Foundry resource group and hierarchy must remain protected.'
Assert-Iac ($seedExternalReferences -match "and\(not\(parameters\('createFoundry'\)\), not\(empty\(parameters\('secondaryFoundryAccountName'\)\)\)\)") 'A reused secondary Foundry account must remain external rather than created ownership.'
Assert-Iac (
    ([regex]::Matches($seedExternalReferences, "secondaryFoundryAccountName")).Count -ge 2 -and
    $seedExternalReferences -match "secondaryFoundryAccountName.*defaultModelDeploymentName"
) 'A reused secondary Foundry account and its served deployment must both remain external references.'
Assert-Iac ($seedProtectedResources -match "secondaryFoundryAccountName.*defaultModelDeploymentName") 'A reused secondary Foundry deployment must remain protected.'
$seedRoleAssignments = [string]$ownershipSeed.createdAzureRoleAssignmentIds
Assert-Iac ($seedRoleAssignments.Contains("reference('secondaryFoundryAccess').outputs.createdResourceIds.value")) 'The secondary Foundry access role assignment must be tracked as created ownership.'
$secondaryFoundryAccessAssignments = @($compiledResources | Where-Object {
    $_.Path -like '$/secondaryFoundryAccess/*' -and $_.Resource.type -eq 'Microsoft.Authorization/roleAssignments'
})
Assert-Iac ($secondaryFoundryAccessAssignments.Count -eq 1) 'The second Foundry account must carry its own account-scoped role assignment.'

$topLevelOutputs = @($compiledTemplate.outputs.PSObject.Properties.Name)
Assert-Iac ($topLevelOutputs -notcontains 'APPLICATIONINSIGHTS_CONNECTION_STRING') 'Application Insights credentials must not be exposed as deployment outputs.'
Assert-Iac (-not ($topLevelOutputs | Where-Object { $_ -match 'KEY|SECRET|TOKEN|PASSWORD|CONNECTION_STRING' })) 'Top-level deployment outputs must not expose credential-bearing values.'

$parametersPath = Join-Path $infraRoot 'main.parameters.json'
$parametersText = Get-Content -LiteralPath $parametersPath -Raw
foreach ($targetParameter in @('FOUNDRY_RESOURCE_GROUP_NAME', 'FOUNDRY_ACCOUNT_NAME', 'FOUNDRY_PROJECT_NAME', 'FOUNDRY_DEFAULT_MODEL_DEPLOYMENT')) {
    Assert-Iac ($parametersText.Contains("`${$targetParameter}")) "The parameter file must resolve $targetParameter from the AZD environment."
}
# Reachable through the product's own deployment path rather than only through a direct
# parameter override, and defaulted to empty so a deployment that names no second account is
# unchanged by their presence.
foreach ($optionalParameter in @('SECONDARY_FOUNDRY_ACCOUNT_NAME', 'POOLED_MODEL_DEPLOYMENTS')) {
    Assert-Iac ($parametersText.Contains("`${$optionalParameter=}")) "The parameter file must resolve $optionalParameter from the AZD environment, defaulting to empty."
}
Assert-Iac ($parametersText.Contains('${APIM_SKU=BasicV2}')) 'The bounded API Management SKU must be reachable through the AZD parameter file with the public default unchanged.'
Assert-Iac ($parametersText.Contains('${FOUNDRY_SECOND_MODEL_DEPLOYMENTS=[]}')) 'The typed second-model array must be reachable through the AZD parameter file and default to disabled.'

# The one secret this product keeps is the pseudonym pepper. It exists only because a
# stable keyed hash has no identity-based equivalent, so it is held to the same posture
# as every durable resource and never written into configuration as a value.
$keyStoreFiles = @('modules\control-plane-key-store.bicep', 'modules\principal-key-store-bootstrap.bicep')
foreach ($keyStoreFile in $keyStoreFiles) {
    $keyStoreText = Get-Content -LiteralPath (Join-Path $infraRoot $keyStoreFile) -Raw
    Assert-Iac ($keyStoreText -match "publicNetworkAccess:\s*'Disabled'") "$keyStoreFile must close the key store to the public network."
    Assert-Iac ($keyStoreText -match "defaultAction:\s*'Deny'") "$keyStoreFile must deny by default."
    Assert-Iac ($keyStoreText.Contains('enableRbacAuthorization: true')) "$keyStoreFile must authorize the key store by role rather than by access policy."
    Assert-Iac ($keyStoreText -match '@secure\(\)\s*\r?\n@minLength\(32\)\s*\r?\nparam derivationSecret') "$keyStoreFile must take the derivation secret as a bounded secure parameter."
}

$directKeyStoreText = Get-Content -LiteralPath (Join-Path $infraRoot 'modules\control-plane-key-store.bicep') -Raw
Assert-Iac ($directKeyStoreText.Contains('4633458b-17de-408a-b874-0445c86b69e6')) 'The direct key-store mode must grant Key Vault Secrets User and nothing wider.'
Assert-Iac ($directKeyStoreText.Contains('privateDnsZoneConfigs')) 'The direct key-store mode must publish the private address.'

$bootstrapKeyStoreText = Get-Content -LiteralPath (Join-Path $infraRoot 'modules\principal-key-store-bootstrap.bicep') -Raw
Assert-Iac ($bootstrapKeyStoreText -match "publicNetworkAccess:\s*'Disabled'") 'The principal key bootstrap vault must be closed from creation.'
Assert-Iac ($bootstrapKeyStoreText -match "defaultAction:\s*'Deny'") 'The principal key bootstrap vault must deny by default.'
Assert-Iac ($bootstrapKeyStoreText -match "bypass:\s*'None'") 'The principal key bootstrap vault must grant no network bypass.'
Assert-Iac ($bootstrapKeyStoreText -match '@secure\(\)\s*\r?\n@minLength\(32\)\s*\r?\nparam derivationSecret') 'The bootstrap secret must be a bounded secure parameter.'
Assert-Iac ($bootstrapKeyStoreText -notmatch 'output\s+\w*(?:secret|value|key)\w*\s+string\s*=\s*derivationSecret') 'The bootstrap deployment must never output the derivation value.'

$existingKeyStoreText = Get-Content -LiteralPath (Join-Path $infraRoot 'modules\existing-control-plane-key-store.bicep') -Raw
Assert-Iac ($existingKeyStoreText -match "resource\s+keyVault\s+'Microsoft\.KeyVault/vaults@[^']+'\s+existing") 'The main deployment must attach the bootstrapped vault rather than recreate it.'
Assert-Iac ($existingKeyStoreText.Contains('4633458b-17de-408a-b874-0445c86b69e6')) 'The attached vault must grant only Key Vault Secrets User to the Function identity.'
Assert-Iac ($existingKeyStoreText -match "groupIds:\s*\[\s*\r?\n\s*'vault'") 'The attached vault must use the vault private-link group.'
Assert-Iac ($existingKeyStoreText.Contains('privateDnsZoneConfigs')) 'The attached vault must publish its private DNS record.'
Assert-Iac ($existingKeyStoreText -match 'output\s+verifiedSecretUri\s+string\s*=\s*secret\.properties\.secretUri') 'The attached-vault deployment must force ARM to resolve the named secret before it succeeds.'

$runtimeText = Get-Content -LiteralPath (Join-Path $infraRoot 'modules\governance-runtime.bicep') -Raw
Assert-Iac ($runtimeText -notmatch 'PRINCIPAL_KEY_SECRET') 'The base Function settings must not reference the key store before RBAC and private DNS exist.'
$principalKeySettingText = Get-Content -LiteralPath (Join-Path $infraRoot 'modules\control-plane-principal-key-setting.bicep') -Raw
Assert-Iac ($principalKeySettingText.Contains('PRINCIPAL_KEY_SECRET: ''@Microsoft.KeyVault(')) 'The late settings module must configure a Key Vault reference, never a value.'
Assert-Iac ($principalKeySettingText -match 'properties:\s*union\(baseAppSettings,') 'The late settings write must preserve the complete base appsettings document.'
Assert-Iac ($principalKeySettingText.Contains('param notificationWebhookSecretName string = ''''')) 'The fixed webhook must be optional and name a secret rather than carry its value.'
Assert-Iac ($principalKeySettingText.Contains('NOTIFICATION_WEBHOOK_ENDPOINT: ''@Microsoft.KeyVault(')) 'The fixed webhook must reach the Function App only through a Key Vault reference.'
Assert-Iac (-not $principalKeySettingText.Contains('param notificationWebhookEndpoint')) 'The fixed webhook endpoint must not become a plaintext deployment parameter.'
Assert-Iac ($mainSourceText.Contains('param notificationWebhookSecretName string = ''''')) 'The root template must expose only the optional webhook secret name.'
Assert-Iac ($mainSourceText -match 'notificationWebhookSecretName:\s*notificationWebhookSecretName') 'Both key-store modes must pass the webhook secret name to the Function App settings module.'
Assert-Iac ($mainSourceText.Contains('param rollupStartedFrom string = ''''')) 'The root template must expose an optional initial rollup boundary.'
Assert-Iac ($mainSourceText -match 'rollupStartedFrom:\s*rollupStartedFrom') 'The selected initial rollup boundary must reach the runtime.'
Assert-Iac ($runtimeText.Contains('ROLLUP_STARTED_FROM: rollupStartedFrom')) 'The runtime must receive the initial rollup boundary as an app setting.'
$secretLiteral = [regex]::Matches($mainSourceText + $runtimeText + $principalKeySettingText, "PRINCIPAL_KEY_SECRET:\s*'(?!@Microsoft\.KeyVault)")
Assert-Iac ($secretLiteral.Count -eq 0) 'No template may assign the derivation secret as a literal.'

# A subscription key must never become a second way into the governed data plane. The
# built-in all-access subscription cannot be removed from an API Management service,
# so what keeps it out is that this API does not accept one at all.
foreach ($gatewayModule in @('modules\gateway.bicep')) {
    $gatewayModuleSource = Get-Content -LiteralPath (Join-Path $infraRoot $gatewayModule) -Raw

    # The gateway refuses a named value with an empty value, and every one of these parameters
    # defaults to empty because being unset is a real state. Writing one straight through fails the
    # whole deployment at the named value, long after the gateway itself has been created, and only
    # on the path whose caller does not supply it -- which is why this survived until a deployment
    # from an empty subscription hit it.
    $emptyDefaults = @([regex]::Matches($gatewayModuleSource, "param\s+(?<name>\w+)\s+string\s*=\s*''") | ForEach-Object { $_.Groups['name'].Value })
    foreach ($emptyDefault in $emptyDefaults) {
        Assert-Iac (-not ($gatewayModuleSource -match "value:\s*$emptyDefault\s*[,\r\n]")) "$gatewayModule writes named value '$emptyDefault' straight from a parameter that defaults to empty, which the gateway refuses."
    }

    Assert-Iac ($gatewayModuleSource -match 'subscriptionRequired:\s*false') "$gatewayModule must not accept a subscription key as a credential."
    Assert-Iac (-not ($gatewayModuleSource -match 'Microsoft\.ApiManagement/service/products')) "$gatewayModule must not place the governed API in a product, which would reintroduce key access."

    # A revocation reaches the gateway only when the cached policy expires, so this
    # value is what bounds AUTH-003's five minutes. Measured 24.7s against a 60s cache.
    $cacheDefault = [regex]::Match($gatewayModuleSource, 'param\s+policyCacheSeconds\s+int\s*=\s*(\d+)')
    Assert-Iac $cacheDefault.Success "$gatewayModule must declare policyCacheSeconds with a default."
    Assert-Iac ([int]$cacheDefault.Groups[1].Value -le 300) "$gatewayModule caches the resolved policy for $($cacheDefault.Groups[1].Value)s, so a revocation could take longer than the five minutes AUTH-003 allows."

    # AUTH-006/AUTH-008: an unconfigured profile must resolve to a value nothing can
    # present, never an absent check. The nil GUID matches no `azp`; the literal
    # `disabled` is what the policy tests for to skip the workload branch entirely.
    Assert-Iac ($gatewayModuleSource.Contains("name: 'entra-developer-client-application-id'")) "$gatewayModule must declare the entra-developer-client-application-id named value."
    Assert-Iac ($gatewayModuleSource.Contains("name: 'entra-workload-app-role'")) "$gatewayModule must declare the entra-workload-app-role named value."
    $developerClientDefault = [regex]::Match($gatewayModuleSource, "param\s+entraDeveloperClientApplicationId\s+string\s*=\s*'([^']*)'")
    Assert-Iac $developerClientDefault.Success "$gatewayModule must declare entraDeveloperClientApplicationId with a default."
    Assert-Iac ($developerClientDefault.Groups[1].Value -eq '00000000-0000-0000-0000-000000000000') "$gatewayModule must default entraDeveloperClientApplicationId to the nil GUID, which no client can present."
    $workloadRoleDefault = [regex]::Match($gatewayModuleSource, "param\s+entraWorkloadAppRole\s+string\s*=\s*'([^']*)'")
    Assert-Iac $workloadRoleDefault.Success "$gatewayModule must declare entraWorkloadAppRole with a default."
    Assert-Iac ($workloadRoleDefault.Groups[1].Value -eq 'disabled') "$gatewayModule must default entraWorkloadAppRole to the literal 'disabled'."

    # AUTH-007: the metadata API sits on its own path with no subscription key. An
    # anonymous operation on `inference` instead would need an operation policy that
    # skips the API policy every other operation on that API relies on.
    $oauthApiBlock = [regex]::Match($gatewayModuleSource, "module oauthProtectedResourceApi[\s\S]*?\r?\n\}")
    Assert-Iac $oauthApiBlock.Success "$gatewayModule must declare the oauth-protected-resource API module."
    Assert-Iac ($oauthApiBlock.Value.Contains("name: 'oauth-protected-resource'")) "$gatewayModule must name the metadata API oauth-protected-resource."
    Assert-Iac ($oauthApiBlock.Value.Contains("path: ''")) "$gatewayModule must use an empty API suffix because the OpenAPI operation owns the complete metadata path."
    Assert-Iac ($oauthApiBlock.Value.Contains('subscriptionRequired: false')) "$gatewayModule oauth-protected-resource API must not require a subscription key."

    # REL-003. A pool may only balance a request across members that all deploy the model it
    # asks for, so the second account and the list of models both accounts serve are separate
    # opt-in settings. The pool itself is declared unconditionally because the policy names it,
    # and a policy referencing a backend that does not exist is not deployable.
    Assert-Iac ($gatewayModuleSource.Contains("var foundryBackendName = 'foundry-account-openai-v1'")) "$gatewayModule must declare the primary backend."
    Assert-Iac ($gatewayModuleSource.Contains("var secondaryBackendName = 'foundry-secondary-openai-v1'")) "$gatewayModule must declare the secondary backend."
    Assert-Iac ($gatewayModuleSource.Contains("var poolBackendName = 'foundry-account-pool'")) "$gatewayModule must declare the pool the policy selects by name."
    $secondaryAccountDefault = [regex]::Match($gatewayModuleSource, "param\s+secondaryFoundryAccountName\s+string\s*=\s*'([^']*)'")
    Assert-Iac $secondaryAccountDefault.Success "$gatewayModule must declare secondaryFoundryAccountName with a default."
    Assert-Iac ($secondaryAccountDefault.Groups[1].Value -eq '') "$gatewayModule must default secondaryFoundryAccountName to empty, so a deployment that has created no second account is unchanged."
    $pooledModelDefault = [regex]::Match($gatewayModuleSource, "param\s+pooledModelDeployments\s+string\s*=\s*'([^']*)'")
    Assert-Iac $pooledModelDefault.Success "$gatewayModule must declare pooledModelDeployments with a default."
    Assert-Iac ($pooledModelDefault.Groups[1].Value -eq '') "$gatewayModule must default pooledModelDeployments to empty, so no model is pooled until a deployment says which."
    Assert-Iac ($gatewayModuleSource.Contains("name: 'pooled-model-deployments'")) "$gatewayModule must declare the pooled-model-deployments named value."
    Assert-Iac ($gatewayModuleSource -match 'value:[^\r\n]*\bpooledModelDeployments\b') "$gatewayModule must fill the pooled-model-deployments named value from its parameter."

    $poolMembersMatch = [regex]::Match($gatewayModuleSource, 'var poolMembers = concat\((?<body>[\s\S]*?)\r?\n\)')
    Assert-Iac $poolMembersMatch.Success "$gatewayModule must derive the pool membership in one place."
    $poolMemberIds = @([regex]::Matches($poolMembersMatch.Groups['body'].Value, "resourceId\('Microsoft\.ApiManagement/service/backends',\s*apimName,\s*(?<backend>\w+)\)"))
    Assert-Iac ($poolMemberIds.Count -eq 2) "$gatewayModule pool must list exactly the two backends it balances."
    $poolMemberNames = @($poolMemberIds | ForEach-Object { $_.Groups['backend'].Value } | Sort-Object) -join ','
    Assert-Iac ($poolMemberNames -eq 'foundryBackendName,secondaryBackendName') "$gatewayModule pool members must be the primary and the secondary backend and nothing else."

    # A run of server errors is a backend failing now. A 429 is a healthy backend refusing one
    # caller, and tripping on it would turn that caller's rate limit into an outage for every
    # other caller of that backend, so no failure condition may cover it.
    $circuitBreakerMatch = [regex]::Match($gatewayModuleSource, 'var backendCircuitBreaker = \{(?<body>[\s\S]*?)\r?\n\}')
    Assert-Iac $circuitBreakerMatch.Success "$gatewayModule must declare a backend circuit breaker."
    $circuitBreakerBlock = $circuitBreakerMatch.Groups['body'].Value
    $breakerRules = @([regex]::Matches($circuitBreakerBlock, "\bname:\s*'[^']+'"))
    Assert-Iac ($breakerRules.Count -ge 1) "$gatewayModule circuit breaker must declare at least one rule."
    $acceptRetryAfter = @([regex]::Matches($circuitBreakerBlock, 'acceptRetryAfter:\s*(?<value>true|false)'))
    Assert-Iac ($acceptRetryAfter.Count -eq $breakerRules.Count) "$gatewayModule must state acceptRetryAfter on every circuit breaker rule."
    Assert-Iac (@($acceptRetryAfter | Where-Object { $_.Groups['value'].Value -ne 'true' }).Count -eq 0) "$gatewayModule must accept a backend's own Retry-After, so a trip lasts as long as the backend said rather than a fixed guess."
    $statusRanges = @([regex]::Matches($gatewayModuleSource, 'min:\s*(?<min>\d+)\s*\r?\n\s*max:\s*(?<max>\d+)'))
    Assert-Iac ($statusRanges.Count -ge 1) "$gatewayModule must state which status codes trip the circuit breaker."
    foreach ($statusRange in $statusRanges) {
        $rangeCoversThrottling = ([int]$statusRange.Groups['min'].Value -le 429) -and ([int]$statusRange.Groups['max'].Value -ge 429)
        Assert-Iac (-not $rangeCoversThrottling) "$gatewayModule trips the circuit breaker on 429. A provider throttling one caller is not a broken backend, and tripping on it removes the backend for every other caller."
    }

    $oauthOpenApi = Get-Content -LiteralPath (Join-Path $infraRoot '..\apim\apis\oauth-protected-resource.openapi.json') -Raw | ConvertFrom-Json
    $oauthOperationPath = '/.well-known/oauth-protected-resource/v1'
    Assert-Iac (@($oauthOpenApi.paths.PSObject.Properties.Name).Count -eq 1) 'The OAuth metadata OpenAPI document must expose exactly one operation path.'
    Assert-Iac ($null -ne $oauthOpenApi.paths.$oauthOperationPath.get) 'The OAuth metadata OpenAPI operation must own the complete RFC 9728 path.'

    # These two consumers are internal gateway-adoption templates that a public snapshot does
    # not carry, so a public run must assert the contract only over the templates it publishes.
    $oauthConsumers = if ($PublicOnly) { @() } else { @('modules\c0-adopted-gateway.bicep', 'c0-policy-upgrade.bicep') }
    foreach ($oauthConsumer in $oauthConsumers) {
        $oauthConsumerText = Get-Content -LiteralPath (Join-Path $infraRoot $oauthConsumer) -Raw
        $oauthApiBlock = [regex]::Match($oauthConsumerText, "(?:module|resource)\s+oauthProtectedResourceApi[\s\S]*?\r?\n\}")
        Assert-Iac $oauthApiBlock.Success "$oauthConsumer must declare the oauth-protected-resource API."
        Assert-Iac ($oauthApiBlock.Value.Contains("path: ''")) "$oauthConsumer must use an empty API suffix because the OpenAPI operation owns the complete metadata path."
        Assert-Iac (-not $oauthApiBlock.Value.Contains("path: '.well-known'")) "$oauthConsumer must not duplicate the OpenAPI metadata path in its API suffix."
    }
    $singleBackendUrls = @([regex]::Matches($gatewayModuleSource, '(?<![A-Za-z])url:\s*(foundryBackendUrl|secondaryBackendUrl)'))
    Assert-Iac ($singleBackendUrls.Count -eq 2) "$gatewayModule must declare exactly the primary and secondary single backends."
    $circuitBreakerUses = @([regex]::Matches($gatewayModuleSource, 'circuitBreaker:\s*backendCircuitBreaker'))
    Assert-Iac ($circuitBreakerUses.Count -eq $singleBackendUrls.Count) "$gatewayModule must protect every single backend with a circuit breaker."
}

# AUTH-007: the metadata document validates nothing and calls no backend, and it must
# not itself become a second way to widen who the gateway accepts.
$repositoryRoot = Split-Path -Parent $infraRoot
$oauthPolicyPath = Join-Path $repositoryRoot 'apim\policies\oauth-protected-resource.xml'
$oauthPolicyText = Get-Content -LiteralPath $oauthPolicyPath -Raw
Assert-Iac (-not $oauthPolicyText.Contains('validate-azure-ad-token')) 'The oauth-protected-resource policy must not validate a token: the document exists so a client can discover how to obtain one.'
Assert-Iac (-not $oauthPolicyText.Contains('<forward-request')) 'The oauth-protected-resource policy must not call a backend.'
Assert-Iac (-not $oauthPolicyText.Contains('client-application-id')) 'The oauth-protected-resource policy must not reference any client application ID.'
Assert-Iac (-not $oauthPolicyText.Contains('entra-client-application-id')) 'The metadata document must not name the interactive client application.'
Assert-Iac (-not $oauthPolicyText.Contains('entra-developer-client-application-id')) 'The metadata document must not name the developer client application.'

# The resource identifier must be byte-identical to where the metadata was fetched
# from, and it must be derived from the same API path the gateway actually serves
# rather than a second literal that can drift from it unnoticed.
$resourceMatch = [regex]::Match($oauthPolicyText, '"resource":"(?<value>[^"]+)"')
Assert-Iac $resourceMatch.Success 'The oauth-protected-resource policy must declare a resource identifier.'
$resourceValue = $resourceMatch.Groups['value'].Value
Assert-Iac ($resourceValue.EndsWith('/v1')) 'The resource identifier must end in the inference API path.'
$inferenceApiPathMatch = [regex]::Match($gatewayModuleText, "path:\s*'([^']+)'")
Assert-Iac $inferenceApiPathMatch.Success 'The standalone gateway module must declare the inference API path.'
Assert-Iac ($resourceValue -eq "https://{{gateway-host}}/$($inferenceApiPathMatch.Groups[1].Value)") 'The resource identifier must equal the gateway host plus the inference API path.'

# A discovery client copies this value into an authorization request. The bare name a token
# carries in `scp` is not a value this identity provider accepts there, so publishing it would
# send every client that trusted the document to a refusal.
$scopeMatch = [regex]::Match($oauthPolicyText, '"scopes_supported":\["(?<value>[^"]+)"\]')
Assert-Iac $scopeMatch.Success 'The oauth-protected-resource policy must publish the scope a client requests.'
Assert-Iac ($scopeMatch.Groups['value'].Value -eq '{{entra-api-audience}}/{{entra-required-scope}}') 'The published scope must be qualified by the resource the token is requested for.'

# A deployment is normally made through the narrow lifecycle template, not the composition
# module, so the two can describe different policies while both look correct on their own. The
# version is how an operator tells which body is applied, and it was three releases stale here
# before anyone noticed, because nothing compared them.
$moduleVersionMatch = [regex]::Match((Get-Content -LiteralPath (Join-Path $repositoryRoot 'infra\modules\gateway.bicep') -Raw), "gateway-policy-version'[\s\S]{0,200}?value: '(?<value>[^']+)'")
Assert-Iac $moduleVersionMatch.Success 'The standalone gateway module must state the policy version it deploys.'
$declaredPolicyVersion = $moduleVersionMatch.Groups['value'].Value
# The D2/C0 Azure preflight and post-adoption scripts used to hand-maintain named-value
# inventories and Create-set counts that silently went stale against these modules
# (17 hardcoded names vs. 23 declared). This is the only local, no-Azure gate that would
# catch that regression before the next deployment attempt, so it asserts the derivation
# itself rather than re-deriving the same numbers a second time.
# The overall Create/what-if counts must track the derived named-value count too, not
# freeze it back into a bare number the way `-eq 26` and `-eq 30` once did.
Assert-Iac (-not ($mainSourceText -match 'param\s+governancePolicyEnabled\b')) 'The entrypoint must not expose governancePolicyEnabled independently from the derivation secret.'
$governanceSwitchAssignments = @([regex]::Matches($mainSourceText, 'governancePolicyEnabled:\s*(?<value>[^\r\n]+)'))
Assert-Iac ($governanceSwitchAssignments.Count -eq 1) "The entrypoint must set governancePolicyEnabled on its supported gateway path; found $($governanceSwitchAssignments.Count)."
foreach ($assignment in $governanceSwitchAssignments) {
    Assert-Iac ($assignment.Groups['value'].Value.Trim() -eq 'principalKeyConfigured') "The entrypoint must derive governancePolicyEnabled from the selected key-store mode, not assign '$($assignment.Groups['value'].Value.Trim())'."
}
Assert-Iac ($mainSourceText -match "module\s+controlPlaneKeyStore\s+'.*?'\s*=\s*if\s*\(directPrincipalKeyMode\)") 'Direct mode must invoke secure-parameter validation even when its value is missing.'
Assert-Iac ($mainSourceText -match "output\s+GOVERNANCE_POLICY_RESOLUTION\s+string\s*=\s*principalKeyConfigured\s*\?\s*'per-caller'") 'Deployment outputs must disclose the applied policy-resolution posture.'
$directKeySetting = $compiledTemplate.resources.directPrincipalKeySetting
$existingKeySetting = $compiledTemplate.resources.existingPrincipalKeySetting
Assert-Iac (@($directKeySetting.dependsOn) -contains 'controlPlaneKeyStore') 'Direct mode must write the Key Vault app setting only after its vault, role, and private DNS exist.'
Assert-Iac (@($existingKeySetting.dependsOn) -contains 'existingControlPlaneKeyStore') 'Existing mode must write the Key Vault app setting only after its role and private DNS exist.'

# P0-1: a key-store wiring error is an unavailable governance state, never permission
# to use the provider's configured default. The product path therefore has no bypass
# parameter and emits an explicit false evaluation-only named value on both gateway types.
Assert-Iac (-not ($mainSourceText -match 'param\s+allowUngovernedEvaluationMode\b')) 'The product deployment must not expose an ungoverned-evaluation escape hatch.'
Assert-Iac ($mainSourceText -match 'var\s+principalKeyConfigured\s*=\s*\(directPrincipalKeyMode\s*&&\s*length\(principalDerivationSecret\)\s*>=\s*32\)\s*\|\|\s*\(existingPrincipalKeyMode\s*&&\s*!empty\(principalKeyStoreName\)\s*&&\s*!empty\(principalKeySecretName\)\)') 'Direct governance must remain disabled unless its derivation secret meets the key-store minimum length.'
foreach ($gatewayModule in @('modules\gateway.bicep')) {
    $gatewayModuleSource = Get-Content -LiteralPath (Join-Path $infraRoot $gatewayModule) -Raw
    Assert-Iac ($gatewayModuleSource.Contains("name: 'allow-ungoverned-evaluation-mode'")) "$gatewayModule must explicitly disable ungoverned evaluation at runtime."
    Assert-Iac ($gatewayModuleSource -match "allow-ungoverned-evaluation-mode'[\s\S]{0,200}?value:\s*'false'") "$gatewayModule must default the ungoverned-evaluation escape hatch to false."
    Assert-Iac ($gatewayModuleSource -match "default-effective-policy'[\s\S]{0,200}?value:\s*'\{\}'") "$gatewayModule must provision only an inert default-policy named value so APIM can compile without a permissive model grant."
    Assert-Iac (-not $gatewayModuleSource.Contains('defaultEffectivePolicy')) "$gatewayModule must not construct a permissive default effective policy."
    Assert-Iac (-not ($gatewayModuleSource -match 'param\s+defaultPolicy(?:TokenQuota|QuotaPeriod)\b')) "$gatewayModule must not expose obsolete permissive-default policy parameters."
}
[pscustomobject]@{
    Template = (Resolve-Path -LiteralPath $TemplatePath).Path
    BicepFiles = $bicepFiles.Count
    PinnedModules = $remoteModules.Count
    CompiledResources = $compiledResources.Count
    ExistingFoundryAccounts = @($existingCompiledResourceTypes | Where-Object { $_ -eq 'Microsoft.CognitiveServices/accounts' }).Count
    BodyLoggingByteSettings = ([regex]::Matches($gatewayModuleText, 'bytes:\s*0')).Count
    GovernanceSwitchAssignments = $governanceSwitchAssignments.Count
    Result = 'Pass'
} | Format-List