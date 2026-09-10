[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$schemaRoot = Join-Path $repositoryRoot 'app\governance-domain\contracts\v1'
$fixtureRoot = Join-Path $PSScriptRoot 'fixtures\governance-authorization'
$authorizationSourcePath = Join-Path $repositoryRoot 'app\control-api\admin-read-authorization.mjs'
$serverSourcePath = Join-Path $repositoryRoot 'app\control-api\local-admin-server.mjs'

function Assert-GovernanceAuthorization {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$schemas = @(
    [pscustomobject]@{
        Name = 'assignment'
        File = 'governance-assignment-snapshot.schema.json'
        Direction = 'server-input-only'
    },
    [pscustomobject]@{
        Name = 'entitlement'
        File = 'entitlement-policy-snapshot.schema.json'
        Direction = 'server-input-only'
    },
    [pscustomobject]@{
        Name = 'effective'
        File = 'effective-authorization.schema.json'
        Direction = 'server-output-only'
    }
)

foreach ($contract in $schemas) {
    $path = Join-Path $schemaRoot $contract.File
    Assert-GovernanceAuthorization (Test-Path -LiteralPath $path -PathType Leaf) "$($contract.Name) schema is missing."
    $schema = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 100
    Assert-GovernanceAuthorization ($schema.'$schema' -eq 'https://json-schema.org/draft/2020-12/schema') "$($contract.Name) schema must use Draft 2020-12."
    Assert-GovernanceAuthorization (-not [bool]$schema.additionalProperties) "$($contract.Name) schema must reject additional properties."
    Assert-GovernanceAuthorization ($schema.'x-contract-direction' -eq $contract.Direction) "$($contract.Name) schema direction is incorrect."
    Assert-GovernanceAuthorization ([bool]$schema.'x-semantic-validation-required') "$($contract.Name) schema must require semantic validation."
}

$validFixtures = @(
    [pscustomobject]@{ File = 'valid-assignment-snapshot.json'; Schema = 'governance-assignment-snapshot.schema.json' },
    [pscustomobject]@{ File = 'degraded-assignment-stale.json'; Schema = 'governance-assignment-snapshot.schema.json' },
    [pscustomobject]@{ File = 'valid-entitlement-snapshot.json'; Schema = 'entitlement-policy-snapshot.schema.json' },
    [pscustomobject]@{ File = 'degraded-entitlement-unavailable.json'; Schema = 'entitlement-policy-snapshot.schema.json' },
    [pscustomobject]@{ File = 'valid-effective-authorization.json'; Schema = 'effective-authorization.schema.json' }
)
$invalidFixtures = @(
    [pscustomobject]@{ File = 'invalid-assignment-authority-injection.json'; Schema = 'governance-assignment-snapshot.schema.json' },
    [pscustomobject]@{ File = 'invalid-entitlement-routing-injection.json'; Schema = 'entitlement-policy-snapshot.schema.json' },
    [pscustomobject]@{ File = 'invalid-effective-body-injection.json'; Schema = 'effective-authorization.schema.json' }
)

foreach ($fixture in $validFixtures) {
    $fixturePath = Join-Path $fixtureRoot $fixture.File
    $schemaPath = Join-Path $schemaRoot $fixture.Schema
    Assert-GovernanceAuthorization (Test-Json -LiteralPath $fixturePath -SchemaFile $schemaPath) "Valid fixture '$($fixture.File)' failed JSON Schema validation."
}

$authorizationSource = Get-Content -LiteralPath $authorizationSourcePath -Raw
$serverSource = Get-Content -LiteralPath $serverSourcePath -Raw
Assert-GovernanceAuthorization ($authorizationSource -notmatch 'ROLE_ASSIGNMENTS|resolveRole|group-governance-admin') 'Control API authorization must not derive roles from hard-coded group mappings.'
Assert-GovernanceAuthorization ($serverSource.Contains('evaluateGovernanceAuthorization')) 'Local server must consume the governance authorization evaluator.'
Assert-GovernanceAuthorization ($serverSource.Contains('source.readGovernanceSnapshots(')) 'Local server must obtain governance snapshots through the read source.'
Assert-GovernanceAuthorization ($serverSource.Contains('createLocalGovernanceSource(')) 'Local server must construct its own read source rather than be handed one at request time.'
# The snapshots decide what a caller may do, so the thing that supplies them can never
# come from the request. The overview screen has its own `source` selection parameter,
# which is why this asserts the assignment and not merely the parameter name.
Assert-GovernanceAuthorization ($serverSource -notmatch '(?<![A-Za-z])source\s*=\s*url\.searchParams') 'The read source must never be selected by the caller.'
foreach ($fixture in $invalidFixtures) {
    $fixturePath = Join-Path $fixtureRoot $fixture.File
    $schemaPath = Join-Path $schemaRoot $fixture.Schema
    $accepted = Test-Json -LiteralPath $fixturePath -SchemaFile $schemaPath -ErrorAction SilentlyContinue
    Assert-GovernanceAuthorization (-not $accepted) "Invalid fixture '$($fixture.File)' passed JSON Schema validation."
}

$forbiddenPropertyNames = @(
    'permissions', 'scopeGrant', 'accessToken', 'authorization', 'credential',
    'requestBody', 'responseBody', 'prompt', 'completion', 'messages', 'content',
    'backend', 'backendUrl', 'endpoint', 'url', 'host', 'path', 'route',
    'provider', 'deployment', 'deploymentId', 'resourceId'
)
foreach ($fixture in $validFixtures) {
    $text = Get-Content -LiteralPath (Join-Path $fixtureRoot $fixture.File) -Raw
    foreach ($propertyName in $forbiddenPropertyNames) {
        Assert-GovernanceAuthorization ($text -notmatch "`"$([regex]::Escape($propertyName))`"\s*:") "Fixture '$($fixture.File)' contains forbidden property '$propertyName'."
    }
}

$nodeTestPath = Join-Path $PSScriptRoot 'governance-authorization.test.mjs'
& node --test $nodeTestPath
Assert-GovernanceAuthorization ($LASTEXITCODE -eq 0) 'Governance authorization semantic tests failed.'

[pscustomobject]@{
    Schemas = $schemas.Count
    ValidAndDegradedFixtures = $validFixtures.Count
    InvalidFixturesRejected = $invalidFixtures.Count
    SemanticSuite = 'Pass'
    ServerOwnedInputs = $true
    BodyCredentialsAndRoutingExcluded = $true
    Result = 'Pass'
} | Format-List