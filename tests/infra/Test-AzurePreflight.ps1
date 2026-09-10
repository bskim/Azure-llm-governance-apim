[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'

function Assert-Preflight {
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

function Get-ParameterValue {
    param(
        [Parameter(Mandatory)]
        [hashtable]$ParameterDocument,

        [Parameter(Mandatory)]
        [string]$Name
    )

    Assert-Preflight ($ParameterDocument.parameters.ContainsKey($Name)) "The composed parameter file is missing '$Name'."
    return [string]$ParameterDocument.parameters[$Name].value
}

$fixturePath = Join-Path $PSScriptRoot 'fixtures\verification-deployment-inputs.json'
$mainPath = Join-Path $RepositoryRoot 'infra\main.bicep'
$parametersPath = Join-Path $RepositoryRoot 'infra\main.parameters.json'
$azureYamlPath = Join-Path $RepositoryRoot 'azure.yaml'
$validatorPath = Join-Path $RepositoryRoot 'tools\distribution\Validate-DeploymentInputs.mjs'

foreach ($requiredPath in @($fixturePath, $mainPath, $parametersPath, $azureYamlPath, $validatorPath)) {
    Assert-Preflight (Test-Path -LiteralPath $requiredPath -PathType Leaf) "Required local preflight input is missing: $requiredPath"
}

$fixture = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json -AsHashtable
$mainSource = Get-Content -LiteralPath $mainPath -Raw
$parameterDocument = Get-Content -LiteralPath $parametersPath -Raw | ConvertFrom-Json -AsHashtable
$azureYaml = Get-Content -LiteralPath $azureYamlPath -Raw

Assert-Preflight ($fixture.environmentName -ceq 'verification') "The synthetic deployment fixture environment must be 'verification'."
Assert-Preflight ($fixture.gatewayResourceGroupName -ceq 'rg-test-verification') "The synthetic gateway resource group must be 'rg-test-verification'."
Assert-Preflight ($fixture.principalKey.mode -ceq 'existing') 'The composed verification deployment must use the bootstrapped principal-key store.'
Assert-Preflight (-not [bool]$fixture.principalKey.directSecretPresent) 'Existing principal-key mode must not carry a direct derivation secret.'
Assert-Preflight (-not [string]::IsNullOrWhiteSpace([string]$fixture.principalKey.storeName)) 'Existing principal-key mode requires a vault name.'
Assert-Preflight (-not [string]::IsNullOrWhiteSpace([string]$fixture.principalKey.secretName)) 'Existing principal-key mode requires a secret name.'

Assert-Preflight (-not [bool]$fixture.foundry.create) 'Verification must reuse the external Foundry hierarchy.'
Assert-Preflight ($fixture.foundry.ownership -ceq 'external-reference') 'The reused Foundry hierarchy must remain externally owned.'
foreach ($expectedFoundryIdentifier in @{
    resourceGroupName = 'rg-test-foundry'
    accountName = 'test-foundry-account'
    projectName = 'test-project'
    deploymentName = 'test-model'
}.GetEnumerator()) {
    Assert-Preflight (
        [string]$fixture.foundry[$expectedFoundryIdentifier.Key] -ceq $expectedFoundryIdentifier.Value
    ) "The synthetic Foundry '$($expectedFoundryIdentifier.Key)' must be '$($expectedFoundryIdentifier.Value)'."
}
Assert-Preflight ($fixture.gatewayResourceGroupName -cne $fixture.foundry.resourceGroupName) 'Gateway-owned and external Foundry resources must use separate resource groups.'
Assert-Preflight ([int]$fixture.fc1.instanceMemoryMB -eq 2048) 'The verification FC1 budget must stay pinned to 2,048 MB.'
Assert-Preflight ([int]$fixture.fc1.maximumInstanceCount -eq 28) 'The verification FC1 maximum must default to 28.'
$fc1ScaleGroups = [int]$fixture.fc1.httpScaleGroups + [int]$fixture.fc1.timerScaleGroups
$fc1WorstCaseCores = [int]$fixture.fc1.alwaysReadyReserve + ($fc1ScaleGroups * [int]$fixture.fc1.maximumInstanceCount)
Assert-Preflight ($fc1ScaleGroups -eq 7) 'The FC1 budget must cover one HTTP and six timer scale groups.'
Assert-Preflight ($fc1WorstCaseCores -eq 197) 'The verification FC1 worst-case budget must be 197 cores.'
Assert-Preflight ((250 - $fc1WorstCaseCores) -eq 53) 'The verification FC1 budget must retain a 53-core regional-default margin.'

$expectedMappings = [ordered]@{
    environmentName = '${AZURE_ENV_NAME}'
    gatewayResourceGroupName = '${GATEWAY_RESOURCE_GROUP_NAME}'
    principalDerivationSecret = '${PRINCIPAL_DERIVATION_SECRET=}'
    principalKeyMode = '${PRINCIPAL_KEY_MODE=direct}'
    principalKeyStoreName = '${PRINCIPAL_KEY_STORE_NAME=}'
    principalKeySecretName = '${PRINCIPAL_KEY_SECRET_NAME=}'
    foundryResourceGroupName = '${FOUNDRY_RESOURCE_GROUP_NAME}'
    foundryAccountName = '${FOUNDRY_ACCOUNT_NAME}'
    foundryProjectName = '${FOUNDRY_PROJECT_NAME}'
    defaultModelDeploymentName = '${FOUNDRY_DEFAULT_MODEL_DEPLOYMENT}'
    deployGateway = '${DEPLOY_GATEWAY=true}'
    createFoundry = '${CREATE_FOUNDRY=false}'
    controlPlaneMaximumInstanceCount = '${CONTROL_PLANE_MAXIMUM_INSTANCE_COUNT=28}'
    controlPlaneInstanceMemoryMB = '${CONTROL_PLANE_INSTANCE_MEMORY_MB=2048}'
}
foreach ($mapping in $expectedMappings.GetEnumerator()) {
    $actual = Get-ParameterValue -ParameterDocument $parameterDocument -Name $mapping.Key
    Assert-Preflight ($actual -ceq $mapping.Value) "The composed mapping for '$($mapping.Key)' must be '$($mapping.Value)', not '$actual'."
}

$declaredParameters = @(
    [regex]::Matches($mainSource, '(?m)^param\s+(?<name>[A-Za-z][A-Za-z0-9_]*)\s+') |
        ForEach-Object { $_.Groups['name'].Value }
)
foreach ($configuredParameter in $parameterDocument.parameters.Keys) {
    Assert-Preflight ($declaredParameters -ccontains $configuredParameter) "The composed parameter file passes removed or unknown input '$configuredParameter'."
}

Assert-Preflight ($mainSource -match '(?m)^param\s+createFoundry\s+bool\s*=\s*false\s*$') 'The composed template must default to external Foundry reuse.'
Assert-Preflight ($mainSource -match "(?m)^resource\s+existingFoundryAccount\s+'Microsoft\.CognitiveServices/accounts@[^']+'\s+existing\s*=") 'The composed template must reference the external Foundry account as existing.'
Assert-Preflight ($mainSource -match "(?m)^resource\s+existingFoundryProject\s+'Microsoft\.CognitiveServices/accounts/projects@[^']+'\s+existing\s*=") 'The composed template must reference the external Foundry project as existing.'
Assert-Preflight ($mainSource -match "(?m)^resource\s+existingFoundryDeployment\s+'Microsoft\.CognitiveServices/accounts/deployments@[^']+'\s+existing\s*=") 'The composed template must reference the external Foundry deployment as existing.'
Assert-Preflight ($mainSource -match "(?m)^output\s+FOUNDRY_OWNERSHIP\s+string\s*=\s*createFoundry\s*\?\s*'created'\s*:\s*'existing'\s*$") 'The deployment output must distinguish created Foundry from external reuse.'
Assert-Preflight ($mainSource -match "(?m)^output\s+APIM_OWNERSHIP\s+string\s*=\s*!deployGateway\s*\?\s*'none'\s*:\s*'created'\s*$") 'The verification gateway must remain deployment-owned.'
Assert-Preflight ($mainSource -match "(?m)^param\s+principalKeyMode\s+string\s*=\s*'direct'\s*$") 'The composed template must expose the principal-key mode.'
Assert-Preflight ($mainSource -match "(?m)^param\s+principalKeyStoreName\s+string\s*=\s*''\s*$") 'The composed template must expose the existing principal-key store name.'
Assert-Preflight ($mainSource -match "(?m)^param\s+principalKeySecretName\s+string\s*=\s*''\s*$") 'The composed template must expose the existing principal-key secret name.'
Assert-Preflight ($mainSource -match '(?m)^param\s+controlPlaneMaximumInstanceCount\s+int\s*=\s*28\s*$') 'The root template must default the control-plane FC1 maximum to 28.'
Assert-Preflight ($mainSource -match '(?m)^param\s+controlPlaneInstanceMemoryMB\s+int\s*=\s*2048\s*$') 'The root template must pin the control-plane FC1 memory contract to 2,048 MB.'
Assert-Preflight ($mainSource -match '(?m)^\s*maximumInstanceCount:\s*controlPlaneMaximumInstanceCount\s*$') 'The root FC1 maximum must reach the runtime module.'
Assert-Preflight ($mainSource -match '(?m)^\s*instanceMemoryMB:\s*controlPlaneInstanceMemoryMB\s*$') 'The root FC1 memory size must reach the runtime module.'

$validatorCommand = [regex]::Escape('node tools/distribution/Validate-DeploymentInputs.mjs')
Assert-Preflight (([regex]::Matches($azureYaml, $validatorCommand)).Count -eq 2) 'Both azd preprovision shells must execute the local deployment-input validator.'

$tokens = $null
$parseErrors = $null
$preflightAst = [Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$parseErrors)
Assert-Preflight ($parseErrors.Count -eq 0) 'The local preflight must parse as valid PowerShell.'
$forbiddenCommands = @('az', 'azd', 'Invoke-AzJson', 'Invoke-RestMethod', 'Invoke-WebRequest')
$invokedCommands = @(
    $preflightAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.CommandAst]
    }, $true) |
        ForEach-Object { $_.GetCommandName() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
foreach ($forbiddenCommand in $forbiddenCommands) {
    Assert-Preflight ($invokedCommands -cnotcontains $forbiddenCommand) "The local preflight must never invoke '$forbiddenCommand'."
}

[pscustomobject]@{
    Environment = $fixture.environmentName
    GatewayResourceGroup = $fixture.gatewayResourceGroupName
    PrincipalKeyMode = $fixture.principalKey.mode
    FoundryOwnership = $fixture.foundry.ownership
    FoundryTuple = "$($fixture.foundry.accountName)/$($fixture.foundry.projectName)/$($fixture.foundry.deploymentName)"
    ComposedInputs = $parameterDocument.parameters.Count
    AzureCommandsInvoked = 0
    Result = 'Pass'
} | Format-List
