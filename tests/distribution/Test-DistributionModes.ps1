[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$infraRoot = Join-Path $repositoryRoot 'infra'
$mainPath = Join-Path $infraRoot 'main.bicep'

function Assert-Distribution {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

Assert-Distribution (Test-Path -LiteralPath $mainPath -PathType Leaf) 'The supported product entrypoint is missing.'
foreach ($removedPath in @(
    'existing-adopt.bicep',
    'modules\adopted-gateway.bicep',
    'modules\adopted-gateway-composition.bicep',
    'modules\adopted-gateway-observability.bicep'
)) {
    Assert-Distribution (-not (Test-Path -LiteralPath (Join-Path $infraRoot $removedPath))) "Unsupported existing-APIM adoption artifact remains: $removedPath"
}

$main = Get-Content -LiteralPath $mainPath -Raw
$compiledLines = @(& bicep build $mainPath --stdout)
Assert-Distribution ($LASTEXITCODE -eq 0) 'The supported product entrypoint failed to compile.'
$compiled = ($compiledLines -join [Environment]::NewLine) | ConvertFrom-Json
$outputs = @($compiled.outputs.PSObject.Properties.Name)

Assert-Distribution ($main -match 'param\s+createFoundry\s+bool\s*=\s*false') 'The product template must retain existing-Foundry reuse.'
Assert-Distribution ($main -match "module\s+\w+\s+'\./modules/fresh-foundry\.bicep'\s*=\s*if\s*\(createFoundry\)") 'The product template must retain create-everything mode.'
Assert-Distribution ($main -match 'module gateway.*?=\s*if \(deployGateway\)') 'The product template must create a gateway only when requested.'
Assert-Distribution ($main -notmatch 'reuseExistingGateway|existingApim|adoptedGateway') 'The public deployment must not expose existing-APIM adoption.'
Assert-Distribution ($main.Contains("output APIM_OWNERSHIP string = !deployGateway ? 'none' : 'created'")) 'The deployment must report that its only gateway mode is created.'

foreach ($outputName in @(
    'API_URL',
    'GATEWAY_DEPLOYED',
    'FOUNDRY_ACCOUNT_RESOURCE_ID',
    'FOUNDRY_PROJECT_RESOURCE_ID',
    'FOUNDRY_MODEL_DEPLOYMENT_RESOURCE_ID'
)) {
    Assert-Distribution ($outputs -contains $outputName) "The product template is missing output $outputName."
}

[pscustomobject]@{
    Entrypoints = 1
    ApimMode = 'created-only'
    FoundryModes = 'existing-or-created'
    Result = 'Pass'
} | Format-List
