[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'

function Assert-CleanupSafety {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$cleanupPath = Join-Path $RepositoryRoot 'tools\distribution\Remove-Deployment.ps1'
Assert-CleanupSafety (Test-Path -LiteralPath $cleanupPath -PathType Leaf) 'The deployment cleanup wrapper is missing.'
$source = Get-Content -LiteralPath $cleanupPath -Raw

$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    $cleanupPath,
    [ref]$tokens,
    [ref]$parseErrors
)
Assert-CleanupSafety ($parseErrors.Count -eq 0) "The deployment cleanup wrapper has PowerShell parse errors: $($parseErrors.Message -join '; ')"

Assert-CleanupSafety ($source -match "\[CmdletBinding\(DefaultParameterSetName = 'Preview'\)\]") 'Cleanup must default to the preview parameter set.'
foreach ($requiredEvidence in @('ManifestPath', 'StatePath', 'ReadbackPath', 'OutputPath')) {
    $evidencePattern = '\[string\]\${0}\b' -f [regex]::Escape($requiredEvidence)
    Assert-CleanupSafety ($source -match $evidencePattern) "Cleanup must require $requiredEvidence."
}
Assert-CleanupSafety ($source.Contains('[ValidateScript({ -not (Test-Path -LiteralPath $_) })]')) 'Cleanup must refuse to overwrite an existing evidence output.'
$previewParameter = (Get-Command -Name $cleanupPath -CommandType ExternalScript).Parameters['Preview']
Assert-CleanupSafety ($null -ne $previewParameter -and $previewParameter.ParameterType -eq [switch]) 'Cleanup preview must expose an explicit preview switch.'
foreach ($previewSet in @('Preview', 'GeneratedPreview')) {
    Assert-CleanupSafety ($previewParameter.ParameterSets.ContainsKey($previewSet) -and $previewParameter.ParameterSets[$previewSet].IsMandatory) "Cleanup $previewSet must require an explicit preview switch."
}
Assert-CleanupSafety ($source -match "'\.\.\\deployment\\ownership-contract\.mjs'") 'Cleanup must delegate to the offline ownership-contract engine.'

$approvalContracts = [ordered]@{
    ApproveResourceDelete = 'resource-delete'
    ApproveEntraCleanup = 'entra-cleanup'
    ApproveEntraPurge = 'entra-purge'
    ApproveApimPurge = 'apim-purge'
    ApproveKeyVaultPurge = 'key-vault-purge'
}
foreach ($approvalContract in $approvalContracts.GetEnumerator()) {
    Assert-CleanupSafety ($source -match "\[switch\]\`$$([regex]::Escape($approvalContract.Key))\b") "Cleanup must expose the independent $($approvalContract.Key) approval."
    Assert-CleanupSafety ($source -match "'$([regex]::Escape($approvalContract.Value))'") "Cleanup must map $($approvalContract.Key) to $($approvalContract.Value)."
}
Assert-CleanupSafety (([regex]::Matches($source, "\[string\]\`$ApprovalPath\b")).Count -eq 1) 'All mutation phases must use the same mandatory approval evidence shape.'
Assert-CleanupSafety ($source -match "if \(\`$LASTEXITCODE -ne 0\)") 'Cleanup must fail when the ownership-contract engine rejects evidence.'

$commandNames = @(
    $ast.FindAll(
        { param($node) $node -is [Management.Automation.Language.CommandAst] },
        $true
    ) |
        ForEach-Object { $_.GetCommandName() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
$forbiddenCommands = @(
    $commandNames |
        Where-Object {
            $_ -in @('az', 'azd', 'curl', 'Invoke-RestMethod', 'Invoke-WebRequest', 'Start-Process') -or
            $_ -like 'Remove-*'
        } |
        Sort-Object -Unique
)
Assert-CleanupSafety ($forbiddenCommands.Count -eq 0) "Cleanup wrapper must remain local and non-mutating; found: $($forbiddenCommands -join ', ')"

[pscustomobject]@{
    ApprovalPhases = $approvalContracts.Count
    DefaultMode = 'Preview'
    ExternalMutationCommands = $forbiddenCommands.Count
    Result = 'Pass'
} | Format-List
