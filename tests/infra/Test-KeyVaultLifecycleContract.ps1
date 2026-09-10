[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$modulePaths = @(
    'infra\modules\control-plane-key-store.bicep',
    'infra\modules\principal-key-store-bootstrap.bicep'
)

function Assert-KeyVaultLifecycle {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

foreach ($relativePath in $modulePaths) {
    $path = Join-Path $repositoryRoot $relativePath
    Assert-KeyVaultLifecycle (Test-Path -LiteralPath $path -PathType Leaf) "Key Vault module is missing: $relativePath"
    $source = Get-Content -LiteralPath $path -Raw
    Assert-KeyVaultLifecycle ($source -match 'enablePurgeProtection:\s*true') "$relativePath must enable immutable Key Vault purge protection."
    Assert-KeyVaultLifecycle ($source -match 'softDeleteRetentionInDays:\s*7') "$relativePath must use exactly seven days of soft-delete retention."
    Assert-KeyVaultLifecycle (-not ($source -match 'param\s+\w*(?:purgeProtection|softDeleteRetention)\w*\b')) "$relativePath must not expose a parameter that weakens purge protection or retention."
}

[pscustomobject]@{
    Modules = $modulePaths.Count
    PurgeProtection = 'Enabled'
    SoftDeleteRetentionDays = 7
    Result = 'Pass'
} | Format-List
