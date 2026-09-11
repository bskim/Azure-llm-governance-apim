<#
.SYNOPSIS
Validates a manifest-bound removal preview or one independently approved removal phase.

.DESCRIPTION
This command is intentionally local-only. It never calls Azure, Microsoft Graph, or azd and it
contains no deletion or purge implementation. The caller must provide either a generated evidence
bundle or a sealed ownership manifest, retained ownership state, and fresh exact-ID readback
captured by a separately approved workflow. The contract engine rejects missing, stale, duplicate,
ambiguous, contradictory, or protected evidence before it emits either a dry-run preview or a
phase-specific authorization.

An authorization proves only that local evidence and one fresh approval agree. It does not perform
or imply any mutation. Resource deletion, Entra cleanup, Entra recycle-bin purge, APIM purge, and
Key Vault purge are separate parameter sets and therefore cannot share one aggregate approval.
#>
[CmdletBinding(DefaultParameterSetName = 'Preview')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Preview')]
    [Parameter(Mandatory, ParameterSetName = 'ResourceDelete')]
    [Parameter(Mandatory, ParameterSetName = 'EntraCleanup')]
    [Parameter(Mandatory, ParameterSetName = 'EntraPurge')]
    [Parameter(Mandatory, ParameterSetName = 'ApimPurge')]
    [Parameter(Mandatory, ParameterSetName = 'KeyVaultPurge')]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$ManifestPath,

    [Parameter(Mandatory, ParameterSetName = 'GeneratedPreview')]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$EvidenceBundlePath,

    [Parameter(Mandatory, ParameterSetName = 'Preview')]
    [Parameter(Mandatory, ParameterSetName = 'ResourceDelete')]
    [Parameter(Mandatory, ParameterSetName = 'EntraCleanup')]
    [Parameter(Mandatory, ParameterSetName = 'EntraPurge')]
    [Parameter(Mandatory, ParameterSetName = 'ApimPurge')]
    [Parameter(Mandatory, ParameterSetName = 'KeyVaultPurge')]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$StatePath,

    [Parameter(Mandatory, ParameterSetName = 'Preview')]
    [Parameter(Mandatory, ParameterSetName = 'ResourceDelete')]
    [Parameter(Mandatory, ParameterSetName = 'EntraCleanup')]
    [Parameter(Mandatory, ParameterSetName = 'EntraPurge')]
    [Parameter(Mandatory, ParameterSetName = 'ApimPurge')]
    [Parameter(Mandatory, ParameterSetName = 'KeyVaultPurge')]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$ReadbackPath,

    [Parameter(Mandatory, ParameterSetName = 'Preview')]
    [Parameter(Mandatory, ParameterSetName = 'GeneratedPreview')]
    [switch]$Preview,

    [Parameter(Mandatory, ParameterSetName = 'ResourceDelete')]
    [switch]$ApproveResourceDelete,

    [Parameter(Mandatory, ParameterSetName = 'EntraCleanup')]
    [switch]$ApproveEntraCleanup,

    [Parameter(Mandatory, ParameterSetName = 'EntraPurge')]
    [switch]$ApproveEntraPurge,

    [Parameter(Mandatory, ParameterSetName = 'ApimPurge')]
    [switch]$ApproveApimPurge,

    [Parameter(Mandatory, ParameterSetName = 'KeyVaultPurge')]
    [switch]$ApproveKeyVaultPurge,

    [Parameter(Mandatory, ParameterSetName = 'SelfTest')]
    [switch]$SelfTest,

    [Parameter(Mandatory, ParameterSetName = 'ResourceDelete')]
    [Parameter(Mandatory, ParameterSetName = 'EntraCleanup')]
    [Parameter(Mandatory, ParameterSetName = 'EntraPurge')]
    [Parameter(Mandatory, ParameterSetName = 'ApimPurge')]
    [Parameter(Mandatory, ParameterSetName = 'KeyVaultPurge')]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$ApprovalPath,

    [Parameter(Mandatory, ParameterSetName = 'Preview')]
    [Parameter(Mandatory, ParameterSetName = 'ResourceDelete')]
    [Parameter(Mandatory, ParameterSetName = 'EntraCleanup')]
    [Parameter(Mandatory, ParameterSetName = 'EntraPurge')]
    [Parameter(Mandatory, ParameterSetName = 'ApimPurge')]
    [Parameter(Mandatory, ParameterSetName = 'KeyVaultPurge')]
    [Parameter(Mandatory, ParameterSetName = 'GeneratedPreview')]
    [ValidateScript({ -not (Test-Path -LiteralPath $_) })]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$enginePath = Join-Path $PSScriptRoot '..\deployment\ownership-contract.mjs'
if (-not (Test-Path -LiteralPath $enginePath -PathType Leaf)) {
    throw "Ownership contract engine not found: $enginePath"
}

if ($SelfTest) {
    & node $enginePath self-test
    if ($LASTEXITCODE -ne 0) { throw 'The removal ownership-contract self-test failed.' }
    return
}

$arguments = if ($PSCmdlet.ParameterSetName -eq 'GeneratedPreview') {
    @(
        $enginePath
        'preview-bundle'
        '--bundle'
        (Resolve-Path -LiteralPath $EvidenceBundlePath).Path
        '--output'
        [IO.Path]::GetFullPath($OutputPath)
    )
} else {
    @(
        $enginePath
        'preview'
        '--manifest'
        (Resolve-Path -LiteralPath $ManifestPath).Path
        '--state'
        (Resolve-Path -LiteralPath $StatePath).Path
        '--readback'
        (Resolve-Path -LiteralPath $ReadbackPath).Path
        '--output'
        [IO.Path]::GetFullPath($OutputPath)
    )
}

$phase = switch ($PSCmdlet.ParameterSetName) {
    'Preview' { $null }
    'GeneratedPreview' { $null }
    'ResourceDelete' { 'resource-delete' }
    'EntraCleanup' { 'entra-cleanup' }
    'EntraPurge' { 'entra-purge' }
    'ApimPurge' { 'apim-purge' }
    'KeyVaultPurge' { 'key-vault-purge' }
    default { throw "Unsupported removal parameter set: $($PSCmdlet.ParameterSetName)" }
}

if ($null -ne $phase) {
    $arguments[1] = 'authorize'
    $arguments += @(
        '--phase'
        $phase
        '--approval'
        (Resolve-Path -LiteralPath $ApprovalPath).Path
    )
}

& node @arguments
if ($LASTEXITCODE -ne 0) {
    throw "The fail-closed ownership contract rejected removal phase '$($phase ?? 'preview')'."
}

Get-Content -LiteralPath $OutputPath -Raw
