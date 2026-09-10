[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$preflightPath = Join-Path $repositoryRoot 'tools\distribution\Test-DistributionParameters.ps1'

function Assert-DistributionParameterTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-DistributionParameterThrows {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][string]$ExpectedMessage
    )

    $thrown = $false
    try {
        & $Action | Out-Null
    }
    catch {
        $thrown = $true
        Assert-DistributionParameterTest ($_.Exception.Message -match $ExpectedMessage) "Unexpected validation message: $($_.Exception.Message)"
    }
    Assert-DistributionParameterTest $thrown "Expected validation failure matching '$ExpectedMessage'."
}

Assert-DistributionParameterTest (Test-Path -LiteralPath $preflightPath -PathType Leaf) 'Distribution parameter preflight is missing.'

$fresh = & $preflightPath `
    -Mode fresh `
    -FoundryResourceGroupName 'rg-foundry-synthetic' `
    -GatewayResourceGroupName 'rg-gateway-synthetic' `
    -PrincipalDerivationSecret ('x' * 32) |
    Out-String
Assert-DistributionParameterTest ($fresh -match 'Result\s+: Pass') 'Fresh parameter preflight did not pass.'

$existingCreate = & $preflightPath `
    -Mode existing-create `
    -FoundryResourceGroupName 'rg-foundry-synthetic' `
    -GatewayResourceGroupName 'rg-gateway-synthetic' `
    -PrincipalDerivationSecret ('x' * 32) |
    Out-String
Assert-DistributionParameterTest ($existingCreate -match 'Result\s+: Pass') 'Existing-create parameter preflight did not pass.'

foreach ($mode in @('fresh', 'existing-create')) {
    Assert-DistributionParameterThrows `
        -Action {
            & $preflightPath `
                -Mode $mode `
                -FoundryResourceGroupName 'rg-shared-synthetic' `
                -GatewayResourceGroupName 'RG-SHARED-SYNTHETIC' `
                -PrincipalDerivationSecret ('x' * 32)
        } `
        -ExpectedMessage 'separate resource groups'
}

foreach ($invalidKeyConfiguration in @(
    @{ Mode = 'direct'; Secret = ''; Store = ''; Name = ''; Message = 'derivation secret is required' },
    @{ Mode = 'direct'; Secret = ('x' * 31); Store = ''; Name = ''; Message = 'at least 32' },
    @{ Mode = 'existing'; Secret = ''; Store = ''; Name = 'synthetic-key-secret'; Message = 'key-store name is required' },
    @{ Mode = 'existing'; Secret = ''; Store = 'synthetic-key-store'; Name = ''; Message = 'secret name is required' }
)) {
    Assert-DistributionParameterThrows `
    -Action {
        & $preflightPath `
            -Mode fresh `
            -FoundryResourceGroupName 'rg-foundry-synthetic' `
            -GatewayResourceGroupName 'rg-gateway-synthetic' `
            -PrincipalKeyMode $invalidKeyConfiguration.Mode `
            -PrincipalDerivationSecret $invalidKeyConfiguration.Secret `
            -PrincipalKeyStoreName $invalidKeyConfiguration.Store `
            -PrincipalKeySecretName $invalidKeyConfiguration.Name
    } `
    -ExpectedMessage $invalidKeyConfiguration.Message
}

[pscustomobject]@{
    ValidModes = 2
    ResourceGroupCollisionCases = 2
    InvalidPrincipalKeyConfigurations = 4
    AzureResourcesChanged = $false
    Result = 'Pass'
} | Format-List