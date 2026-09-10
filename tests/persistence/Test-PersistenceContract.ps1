[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$schemaRoot = Join-Path $repositoryRoot 'app\governance-domain\contracts\v1'
$fixtureRoot = Join-Path $PSScriptRoot 'fixtures\effective-policy'
$persistenceRoot = Join-Path $repositoryRoot 'app\persistence'
$topologyPath = Join-Path $persistenceRoot 'container-topology.mjs'

function Assert-Persistence {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$schemaFile = 'effective-policy-document.schema.json'
$schemaPath = Join-Path $schemaRoot $schemaFile
Assert-Persistence (Test-Path -LiteralPath $schemaPath -PathType Leaf) 'Effective policy document schema is missing.'

$schema = Get-Content -LiteralPath $schemaPath -Raw | ConvertFrom-Json -Depth 100
Assert-Persistence ($schema.'$schema' -eq 'https://json-schema.org/draft/2020-12/schema') 'Effective policy schema must use Draft 2020-12.'
Assert-Persistence (-not [bool]$schema.additionalProperties) 'Effective policy schema must reject additional properties.'
Assert-Persistence ($schema.'x-contract-direction' -eq 'server-output-only') 'Effective policy schema direction is incorrect.'
Assert-Persistence ([bool]$schema.'x-semantic-validation-required') 'Effective policy schema must require semantic validation.'

$validFixtures = @('valid-resolved.json', 'valid-degraded-default.json')
$invalidFixtures = @(
    'invalid-additional-property.json',
    'invalid-fractional-quota.json',
    'invalid-empty-allowlist.json',
    'invalid-degraded-with-fallback.json'
)

foreach ($fixture in $validFixtures) {
    $fixturePath = Join-Path $fixtureRoot $fixture
    Assert-Persistence (Test-Json -LiteralPath $fixturePath -SchemaFile $schemaPath) "Valid fixture '$fixture' failed JSON Schema validation."
}

foreach ($fixture in $invalidFixtures) {
    $fixturePath = Join-Path $fixtureRoot $fixture
    $accepted = Test-Json -LiteralPath $fixturePath -SchemaFile $schemaPath -ErrorAction SilentlyContinue
    Assert-Persistence (-not $accepted) "Invalid fixture '$fixture' passed JSON Schema validation."
}

$forbiddenPropertyNames = @(
    'accessToken', 'authorization', 'credential', 'connectionString', 'key',
    'requestBody', 'responseBody', 'prompt', 'completion', 'messages', 'content',
    'backend', 'backendUrl', 'endpoint', 'url', 'host', 'route',
    'subjectId', 'tenantId', 'groupId', 'applicationId', 'resourceId', 'deploymentId'
)
foreach ($fixture in $validFixtures) {
    $text = Get-Content -LiteralPath (Join-Path $fixtureRoot $fixture) -Raw
    foreach ($propertyName in $forbiddenPropertyNames) {
        Assert-Persistence ($text -notmatch "`"$([regex]::Escape($propertyName))`"\s*:") "Fixture '$fixture' contains forbidden property '$propertyName'."
    }
}

Assert-Persistence (Test-Path -LiteralPath $topologyPath -PathType Leaf) 'Container topology declaration is missing.'
$topologySource = Get-Content -LiteralPath $topologyPath -Raw

# Creating databases or containers is not an allowed data-plane operation for the
# gateway identity, so no persistence source may attempt it.
$runtimeCreationPattern = 'createIfNotExists|createDatabase|containers\.create|databases\.create'
foreach ($sourceFile in Get-ChildItem -LiteralPath $persistenceRoot -Filter '*.mjs' -Recurse) {
    $source = Get-Content -LiteralPath $sourceFile.FullName -Raw
    Assert-Persistence ($source -notmatch $runtimeCreationPattern) "Persistence source '$($sourceFile.Name)' must not create databases or containers at runtime."
}

Assert-Persistence ($topologySource -match "id:\s*'leases'") 'Topology must declare the change feed lease container.'
Assert-Persistence ($topologySource -match "'/scopeGroupId',\s*'/dateBucket'") 'Usage events must use a hierarchical partition key.'

$nodeTestPath = Join-Path $PSScriptRoot 'persistence-contract.test.mjs'
$storeTestPath = Join-Path $PSScriptRoot 'in-memory-governance-store.test.mjs'
& node --test $nodeTestPath $storeTestPath
Assert-Persistence ($LASTEXITCODE -eq 0) 'Persistence contract semantic tests failed.'

[pscustomobject]@{
    Schemas = 1
    ValidFixtures = $validFixtures.Count
    InvalidFixturesRejected = $invalidFixtures.Count
    ForbiddenPropertyNames = $forbiddenPropertyNames.Count
    Result = 'Pass'
} | Format-List
