[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('fresh', 'existing-create')]
    [string]$Mode,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$FoundryResourceGroupName,

    [ValidateNotNullOrEmpty()]
    [string]$GatewayResourceGroupName,

    [ValidateSet('direct', 'existing')]
    [string]$PrincipalKeyMode = 'direct',

    [string]$PrincipalDerivationSecret,

    [string]$PrincipalKeyStoreName,

    [string]$PrincipalKeySecretName
)

$ErrorActionPreference = 'Stop'

function Assert-DistributionParameter {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Test-DifferentResourceGroup {
    param([string]$GatewayGroup)

    Assert-DistributionParameter (-not [string]::IsNullOrWhiteSpace($GatewayGroup)) 'A gateway resource group is required for create modes.'
    Assert-DistributionParameter (
        -not [string]::Equals(
            $FoundryResourceGroupName.Trim(),
            $GatewayGroup.Trim(),
            [StringComparison]::OrdinalIgnoreCase
        )
    ) 'Foundry and gateway-owned resources must use separate resource groups.'
}

function Test-PrincipalKeyConfiguration {
    if ($PrincipalKeyMode -eq 'direct') {
        Assert-DistributionParameter (-not [string]::IsNullOrWhiteSpace($PrincipalDerivationSecret)) 'A principal derivation secret is required for direct principal-key mode.'
        Assert-DistributionParameter ($PrincipalDerivationSecret.Trim().Length -ge 32) 'The principal derivation secret must be at least 32 characters for direct principal-key mode.'
        return
    }

    Assert-DistributionParameter (-not [string]::IsNullOrWhiteSpace($PrincipalKeyStoreName)) 'A principal key-store name is required for existing principal-key mode.'
    Assert-DistributionParameter (-not [string]::IsNullOrWhiteSpace($PrincipalKeySecretName)) 'A principal key secret name is required for existing principal-key mode.'
}

Test-PrincipalKeyConfiguration

switch ($Mode) {
    'fresh' {
        Test-DifferentResourceGroup -GatewayGroup $GatewayResourceGroupName
    }
    'existing-create' {
        Test-DifferentResourceGroup -GatewayGroup $GatewayResourceGroupName
    }
}

[pscustomobject]@{
    Mode = $Mode
    FoundryResourceGroupName = $FoundryResourceGroupName.Trim()
    GatewayResourceGroupName = if ([string]::IsNullOrWhiteSpace($GatewayResourceGroupName)) { $null } else { $GatewayResourceGroupName.Trim() }
    PrincipalKeyMode = $PrincipalKeyMode
    GovernancePolicyResolution = 'required'
    AzureResourcesChanged = $false
    Result = 'Pass'
} | Format-List