[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Run')]
    [ValidatePattern('^[a-z0-9-]{1,20}$')]
    [string]$EnvironmentName,

    [Parameter(ParameterSetName = 'Run')]
    [switch]$Preview,

    [Parameter(ParameterSetName = 'Run')]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$OwnershipPreflightPath,

    [Parameter(ParameterSetName = 'Run')]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$OwnershipPlanPath,

    [Parameter(Mandatory, ParameterSetName = 'SelfTest')]
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:AzdEnvironmentValues = $null

function Get-AzdEnvironmentValues {
    if ($null -ne $script:AzdEnvironmentValues) { return $script:AzdEnvironmentValues }
    $raw = @(& azd env get-values --output json --environment $EnvironmentName 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw 'The azd environment values could not be read.'
    }
    try {
        $values = ([string]::Join("`n", $raw) | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        throw 'The azd environment values were not valid JSON.'
    }
    if ($null -eq $values -or $values -is [array]) {
        throw 'The azd environment values were not a JSON object.'
    }
    $script:AzdEnvironmentValues = $values
    return $script:AzdEnvironmentValues
}

function Read-AzdValue([string]$name) {
    $property = (Get-AzdEnvironmentValues).PSObject.Properties[$name]
    $value = if ($null -eq $property) { '' } else { [string]$property.Value }
    if ([string]::IsNullOrWhiteSpace($value)) { throw "The azd environment value $name is required." }
    return $value.Trim()
}

function Read-OptionalAzdValue([string]$name) {
    $property = (Get-AzdEnvironmentValues).PSObject.Properties[$name]
    if ($null -eq $property) { return '' }
    return ([string]$property.Value).Trim()
}

function Resolve-ExistingDeployment([string]$json) {
    if ([string]::IsNullOrWhiteSpace($json)) { return $null }
    $raw = $json | ConvertFrom-Json
    $candidate = if ($null -ne $raw.PSObject.Properties['properties']) {
        [pscustomobject]@{
            state = [string]$raw.properties.provisioningState
            vault = [string]$raw.properties.outputs.PRINCIPAL_KEY_STORE_NAME.value
            secret = [string]$raw.properties.outputs.PRINCIPAL_KEY_SECRET_NAME.value
        }
    } else {
        $raw
    }
    if ($candidate.state -eq 'Running') {
        throw 'The principal key-store deployment is still running; no concurrent deployment was started.'
    }
    if ($candidate.state -ne 'Succeeded') { return $null }
    if ([string]::IsNullOrWhiteSpace([string]$candidate.vault) -or
        [string]::IsNullOrWhiteSpace([string]$candidate.secret)) {
        throw 'The completed principal key-store deployment has incomplete outputs.'
    }
    return $candidate
}

function Assert-ClosedVault([object]$vault) {
    if ($null -eq $vault -or
        $vault.properties.publicNetworkAccess -ne 'Disabled' -or
        $vault.properties.networkAcls.defaultAction -ne 'Deny' -or
        $vault.properties.networkAcls.bypass -ne 'None' -or
        -not $vault.properties.enableRbacAuthorization -or
        -not $vault.properties.enablePurgeProtection -or
        $vault.properties.softDeleteRetentionInDays -ne 7) {
        throw 'The principal key store does not match the required closed RBAC and seven-day purge-protected posture.'
    }
}

function Remove-SecureParameterFile([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return }
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $path) { throw 'The temporary secure parameter file could not be removed.' }
}

function Invoke-SelfTest {
    $EnvironmentName = 'self-test'
    function global:azd { '{"REQUIRED":"value"}' }
    cmd /c exit 0
    if ((Read-AzdValue 'REQUIRED') -ne 'value' -or (Read-OptionalAzdValue 'ABSENT') -ne '') {
        throw 'The azd environment reader did not preserve absent optional values.'
    }
    $script:AzdEnvironmentValues = $null
    function global:azd { '{"OWNERSHIP_VALIDATION_STAGE":"bootstrap","FOUNDRY_SECOND_MODEL_DEPLOYMENTS":"[]"}' }
    cmd /c exit 0
    if ((Read-OptionalAzdValue 'OWNERSHIP_VALIDATION_STAGE') -ne 'bootstrap' -or
        (Read-OptionalAzdValue 'FOUNDRY_SECOND_MODEL_DEPLOYMENTS') -ne '[]') {
        throw 'The azd environment reader did not preserve explicit optional values.'
    }
    $script:AzdEnvironmentValues = $null
    function global:azd { cmd /c exit 1 }
    try {
        Get-AzdEnvironmentValues | Out-Null
        throw 'Expected azd environment transport failure did not run.'
    } catch {
        if ($_.Exception.Message -eq 'Expected azd environment transport failure did not run.') { throw }
        if ($_.Exception.Message -ne 'The azd environment values could not be read.') { throw }
    }
    Remove-Item function:\global:azd -ErrorAction SilentlyContinue
    if ($null -ne (Resolve-ExistingDeployment '')) { throw 'Absent deployment did not resolve to null.' }
    if ($null -ne (Resolve-ExistingDeployment '{"state":"Failed"}')) { throw 'Failed deployment did not become retryable.' }
    $succeeded = Resolve-ExistingDeployment '{"state":"Succeeded","vault":"example-vault","secret":"example-item"}'
    if ($succeeded.vault -ne 'example-vault') { throw 'Succeeded deployment was not retained.' }
    foreach ($fixture in @(
        '{"state":"Running"}',
        '{"state":"Succeeded","vault":"","secret":"example-item"}'
    )) {
        try { Resolve-ExistingDeployment $fixture | Out-Null; throw 'Expected deployment-state refusal did not run.' }
        catch { if ($_.Exception.Message -eq 'Expected deployment-state refusal did not run.') { throw } }
    }
    $closedVault = [pscustomobject]@{ properties = [pscustomobject]@{
        publicNetworkAccess = 'Disabled'
        networkAcls = [pscustomobject]@{ defaultAction = 'Deny'; bypass = 'None' }
        enableRbacAuthorization = $true
        enablePurgeProtection = $true
        softDeleteRetentionInDays = 7
    } }
    Assert-ClosedVault $closedVault
    try {
        Assert-ClosedVault ([pscustomobject]@{ properties = [pscustomobject]@{
            publicNetworkAccess = 'Enabled'
            networkAcls = [pscustomobject]@{ defaultAction = 'Deny'; bypass = 'None' }
            enableRbacAuthorization = $true
            enablePurgeProtection = $true
            softDeleteRetentionInDays = 7
        } })
        throw 'Expected vault-posture refusal did not run.'
    } catch { if ($_.Exception.Message -eq 'Expected vault-posture refusal did not run.') { throw } }
    $temporary = [IO.Path]::GetTempFileName()
    Remove-SecureParameterFile $temporary
    if (Test-Path $temporary) { throw 'Temporary file survived cleanup.' }
    [pscustomobject]@{ Result = 'Pass'; DeploymentBranches = 5; VaultBranches = 2; CleanupBranches = 2; EnvironmentReaderBranches = 3 } | Format-List
}

if ($SelfTest) {
    Invoke-SelfTest
    exit 0
}

$subscriptionId = Read-AzdValue 'AZURE_SUBSCRIPTION_ID'
$location = Read-AzdValue 'AZURE_LOCATION'
$resourceGroupName = Read-AzdValue 'GATEWAY_RESOURCE_GROUP_NAME'
$deploymentName = "principal-key-store-$EnvironmentName"

if ($EnvironmentName -eq 'verification') {
    if ([string]::IsNullOrWhiteSpace($OwnershipPreflightPath) -or
        [string]::IsNullOrWhiteSpace($OwnershipPlanPath)) {
        throw 'The verification bootstrap requires -OwnershipPreflightPath and -OwnershipPlanPath and never adopts an unproven resource group.'
    }
    $preflightEnvironmentPath = [IO.Path]::GetTempFileName()
    try {
        $preflightEnvironment = [ordered]@{
            AZURE_TENANT_ID = Read-AzdValue 'AZURE_TENANT_ID'
            AZURE_SUBSCRIPTION_ID = $subscriptionId
            AZURE_ENV_NAME = $EnvironmentName
            AZURE_LOCATION = $location
            GATEWAY_RESOURCE_GROUP_NAME = $resourceGroupName
            OWNERSHIP_VALIDATION_STAGE = Read-OptionalAzdValue 'OWNERSHIP_VALIDATION_STAGE'
            CREATE_FOUNDRY = Read-AzdValue 'CREATE_FOUNDRY'
            FOUNDRY_RESOURCE_GROUP_NAME = Read-AzdValue 'FOUNDRY_RESOURCE_GROUP_NAME'
            FOUNDRY_ACCOUNT_NAME = Read-AzdValue 'FOUNDRY_ACCOUNT_NAME'
            FOUNDRY_PROJECT_NAME = Read-AzdValue 'FOUNDRY_PROJECT_NAME'
            FOUNDRY_DEFAULT_MODEL_DEPLOYMENT = Read-AzdValue 'FOUNDRY_DEFAULT_MODEL_DEPLOYMENT'
            FOUNDRY_SECOND_MODEL_DEPLOYMENTS = Read-OptionalAzdValue 'FOUNDRY_SECOND_MODEL_DEPLOYMENTS'
        }
        $preflightEnvironment | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $preflightEnvironmentPath -Encoding utf8NoBOM
        $contractEngine = Join-Path $PSScriptRoot '..\deployment\ownership-contract.mjs'
        & node $contractEngine validate-preflight `
            --preflight (Resolve-Path -LiteralPath $OwnershipPreflightPath).Path `
            --environment $preflightEnvironmentPath `
            --plan (Resolve-Path -LiteralPath $OwnershipPlanPath).Path | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'The verification create-only preflight evidence was rejected.' }
    } finally {
        Remove-SecureParameterFile $preflightEnvironmentPath
    }
}

$account = az account show -o json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $account.id -ne $subscriptionId -or [string]::IsNullOrWhiteSpace([string]$account.tenantId)) {
    throw 'Azure CLI is not on the azd environment subscription or has no tenant context.'
}

if ($EnvironmentName -eq 'verification') {
    $groupExists = [string](az group exists --subscription $subscriptionId --name $resourceGroupName)
    if ($LASTEXITCODE -ne 0 -or $groupExists.Trim() -ne 'false') {
        throw 'The verification resource group is present or its absence could not be proved; bootstrap refuses adoption.'
    }
    $deploymentRecords = az deployment sub list `
        --subscription $subscriptionId `
        --query "[?name=='$deploymentName']" `
        --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'The verification bootstrap deployment inventory could not be read.' }
    if (@($deploymentRecords).Count -ne 0) {
        throw 'A verification bootstrap deployment record already exists; recovery requires separately reviewed ownership evidence.'
    }
    $existingDeployment = ''
} else {
    $existingDeployment = az deployment sub show `
        --subscription $subscriptionId `
        --name $deploymentName `
        --output json 2>$null
}

$deployment = Resolve-ExistingDeployment ([string]$existingDeployment)

$parameterPath = $null
$bytes = [byte[]]::new(48)
$secret = $null
$result = $null
try {
    if ($null -eq $deployment) {
        if ($Preview) {
            $secret = 'preview-only-not-a-secret-000000000000'
        } else {
            [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
            $secret = [Convert]::ToBase64String($bytes)
        }
        $parameterPath = [IO.Path]::GetTempFileName()
        $parameters = [ordered]@{
            '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
            contentVersion = '1.0.0.0'
            parameters = [ordered]@{
                environmentName = @{ value = $EnvironmentName }
                location = @{ value = $location }
                gatewayResourceGroupName = @{ value = $resourceGroupName }
                derivationSecret = @{ value = $secret }
            }
        }
        $parameters | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $parameterPath -Encoding utf8NoBOM

        if ($Preview) {
            az deployment sub what-if `
                --subscription $subscriptionId `
                --location $location `
                --name $deploymentName `
                --template-file (Join-Path $PSScriptRoot '..\..\infra\principal-key-store-bootstrap.bicep') `
                --parameters "@$parameterPath"
            if ($LASTEXITCODE -ne 0) { throw 'The principal key-store preview failed.' }
            $result = [pscustomobject]@{
                Outcome = 'previewed'
                AzureMutations = 0
                SecretValuePrinted = $false
            }
        } else {
            $deploymentJson = az deployment sub create `
                --subscription $subscriptionId `
                --location $location `
                --name $deploymentName `
                --template-file (Join-Path $PSScriptRoot '..\..\infra\principal-key-store-bootstrap.bicep') `
                --parameters "@$parameterPath" `
                --output json
            if ($LASTEXITCODE -ne 0) { throw 'The principal key-store deployment failed.' }
            $deployment = Resolve-ExistingDeployment ([string]$deploymentJson)
        }
    }

    if ($null -ne $deployment) {
        $vault = az keyvault show `
            --subscription $subscriptionId `
            --resource-group $resourceGroupName `
            --name $deployment.vault `
            --output json | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'The completed principal key-store deployment references an absent vault.' }
        Assert-ClosedVault $vault

        if ($Preview) {
            $result = [pscustomobject]@{
                Outcome = 'already-present'
                AzureMutations = 0
                EnvironmentMutations = 0
                SecretValuePrinted = $false
            }
        } else {
            azd env set PRINCIPAL_DERIVATION_SECRET '' --environment $EnvironmentName | Out-Null
            azd env set PRINCIPAL_KEY_MODE existing --environment $EnvironmentName | Out-Null
            azd env set PRINCIPAL_KEY_STORE_NAME $deployment.vault --environment $EnvironmentName | Out-Null
            azd env set PRINCIPAL_KEY_SECRET_NAME $deployment.secret --environment $EnvironmentName | Out-Null

            $result = [pscustomobject]@{
                Outcome = 'ready'
                DeploymentState = $deployment.state
                PublicNetworkAccess = $vault.properties.publicNetworkAccess
                DefaultAction = $vault.properties.networkAcls.defaultAction
                Bypass = $vault.properties.networkAcls.bypass
                RbacAuthorization = [bool]$vault.properties.enableRbacAuthorization
                SecretValuePrinted = $false
            }
        }
    }
} finally {
    Remove-SecureParameterFile $parameterPath
    [Array]::Clear($bytes, 0, $bytes.Length)
    $secret = $null
}

if ($null -eq $result) {
    throw 'The principal key-store command completed without establishing a preview or ready result.'
}
$result | Add-Member -NotePropertyName SecretValueRetainedLocally -NotePropertyValue $false
$result | Format-List