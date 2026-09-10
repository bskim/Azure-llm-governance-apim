[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'

function Assert-ProviderWiring {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Get-ModuleBlock {
    param([string]$Source, [string]$ModuleName)

    $match = [regex]::Match(
        $Source,
        "(?ms)^module\s+$([regex]::Escape($ModuleName))\s+'[^']+'\s*=\s*\{.*?^\}"
    )
    return $match.Value
}

$mainPath = Join-Path $RepositoryRoot 'infra\main.bicep'
$runtimePath = Join-Path $RepositoryRoot 'infra\modules\governance-runtime.bicep'
$accessPath = Join-Path $RepositoryRoot 'infra\modules\foundry-provider-reader-access.bicep'

$main = Get-Content -LiteralPath $mainPath -Raw
$runtime = Get-Content -LiteralPath $runtimePath -Raw

Assert-ProviderWiring ($runtime -match '(?m)^param providerAccountResourceId string\b') 'The runtime must take the selected Foundry account resource ID.'
Assert-ProviderWiring ($runtime -match 'PROVIDER_ACCOUNT_RESOURCE_ID:\s*providerAccountResourceId') 'The runtime must configure PROVIDER_ACCOUNT_RESOURCE_ID from its resource-ID input.'

$controlPlane = Get-ModuleBlock -Source $main -ModuleName 'controlPlane'
Assert-ProviderWiring (-not [string]::IsNullOrWhiteSpace($controlPlane)) 'The product template must declare the control-plane runtime module.'
Assert-ProviderWiring ($controlPlane -match 'providerAccountResourceId:\s*primaryFoundryAccountResourceId') 'The product template must pass its selected Foundry account ID to the runtime.'
Assert-ProviderWiring ($main -match "var primaryFoundryAccountResourceId = createFoundry \? foundry!\.outputs\.accountResourceId : existingFoundryAccount\.id") 'The primary Foundry account ID must select the created or existing account.'

Assert-ProviderWiring (Test-Path -LiteralPath $accessPath -PathType Leaf) 'The account-scoped provider reader role module is missing.'
$access = Get-Content -LiteralPath $accessPath -Raw
Assert-ProviderWiring ($access -match "'43d0d8ad-25c7-4714-9337-8ba259a9fe05'") 'Provider reads must use the built-in Monitoring Reader role.'
Assert-ProviderWiring ($access -match 'scope:\s*foundryAccount') 'Provider reads must be scoped to the selected Foundry account.'
Assert-ProviderWiring ($access -match "principalType:\s*'ServicePrincipal'") 'The provider-reader assignment must target a managed identity service principal.'
Assert-ProviderWiring ($access -notmatch 'scope:\s*subscription\(\)') 'Provider reads must not receive subscription-wide access.'

$providerAccess = Get-ModuleBlock -Source $main -ModuleName 'foundryProviderReaderAccess'
Assert-ProviderWiring (-not [string]::IsNullOrWhiteSpace($providerAccess)) 'The product template must declare the provider-reader role assignment.'
Assert-ProviderWiring ($providerAccess -match "'\./modules/foundry-provider-reader-access\.bicep'") 'The product template must use the provider-reader role module.'
Assert-ProviderWiring ($providerAccess -match 'readerPrincipalId:\s*controlPlane\.outputs\.functionAppPrincipalId') 'The provider-reader assignment must target the Function identity.'
Assert-ProviderWiring ($providerAccess -match 'foundryAccountName:\s*foundryAccountName') 'The provider-reader assignment must target the primary Foundry account.'

[pscustomobject]@{
    Role = 'Monitoring Reader (43d0d8ad-25c7-4714-9337-8ba259a9fe05)'
    Scope = 'Primary Foundry account'
    Result = 'Pass'
} | Format-List
