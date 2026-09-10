[CmdletBinding()]
param(
    [string]$SpecificationPath = (Join-Path $PSScriptRoot '..\..\apim\apis\inference.openapi.json'),
    [string]$CasesPath = (Join-Path $PSScriptRoot 'cases.json')
)

$ErrorActionPreference = 'Stop'

function Assert-Contract {
    param(
        [Parameter(Mandatory)]
        [bool]$Condition,

        [Parameter(Mandatory)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

$specification = Get-Content -LiteralPath $SpecificationPath -Raw | ConvertFrom-Json
$cases = Get-Content -LiteralPath $CasesPath -Raw | ConvertFrom-Json

$expectedOperations = [ordered]@{
    '/v1/chat/completions' = 'createChatCompletion'
    '/v1/responses' = 'createResponse'
}

$actualPaths = @($specification.paths.PSObject.Properties.Name | Sort-Object)
$expectedPaths = @($expectedOperations.Keys | Sort-Object)

Assert-Contract ($specification.openapi -eq '3.0.3') 'The API contract must use OpenAPI 3.0.3.'
Assert-Contract (($actualPaths -join '|') -eq ($expectedPaths -join '|')) 'The API must expose only the explicit Chat Completions and Responses paths.'
Assert-Contract (-not ($actualPaths | Where-Object { $_ -match '[*{}]' })) 'Wildcard and path-parameter operations are not allowed in the MVP API surface.'

foreach ($entry in $expectedOperations.GetEnumerator()) {
    $pathItem = $specification.paths.PSObject.Properties[$entry.Key].Value
    $methods = @($pathItem.PSObject.Properties.Name | Where-Object { $_ -in @('get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace') })

    Assert-Contract (($methods -join '|') -eq 'post') "Operation $($entry.Key) must allow POST only."
    Assert-Contract ($pathItem.post.operationId -eq $entry.Value) "Operation $($entry.Key) has an unexpected operationId."
    Assert-Contract ($pathItem.post.'x-governance-policy' -eq 'inference') "Operation $($entry.Key) must opt into the inference governance policy."
}

$securityScheme = $specification.components.securitySchemes.entraBearer
Assert-Contract ($securityScheme.type -eq 'http' -and $securityScheme.scheme -eq 'bearer' -and $securityScheme.bearerFormat -eq 'JWT') 'The public contract must require a bearer JWT access token.'

$governance = $specification.'x-governance-contract'
Assert-Contract ($governance.denyUndeclaredOperations -eq $true) 'Undeclared operations must be denied.'
Assert-Contract ($governance.backendSelection -eq 'server') 'Backend selection must remain server controlled.'
Assert-Contract (@($governance.allowedClientRoutingHeaders).Count -eq 0) 'Client routing headers must not be part of the public contract.'
Assert-Contract ($governance.requestBodyLogging -eq $false -and $governance.responseBodyLogging -eq $false) 'Request and response body logging must be disabled by default.'

$positiveCases = @($cases.positive)
$negativeCases = @($cases.negative)

Assert-Contract ($positiveCases.Count -eq 2) 'The contract suite must contain one positive case for each declared operation.'

$positiveSurface = @($positiveCases | ForEach-Object { "$($_.method.ToUpperInvariant()) $($_.path)" } | Sort-Object)
$expectedSurface = @($expectedPaths | ForEach-Object { "POST $_" } | Sort-Object)
Assert-Contract (($positiveSurface -join '|') -eq ($expectedSurface -join '|')) 'Positive cases must match the complete declared API surface.'

$requiredNegativeCategories = @(
    'authentication',
    'client-routing-input',
    'credential-injection',
    'encoded-path',
    'invalid-body',
    'model-entitlement',
    'path-traversal',
    'undeclared-method',
    'undeclared-route'
)
$actualNegativeCategories = @($negativeCases.category | Sort-Object -Unique)

foreach ($category in $requiredNegativeCategories) {
    Assert-Contract ($actualNegativeCategories -contains $category) "Missing required negative contract category: $category"
}

foreach ($case in $negativeCases) {
    Assert-Contract ($case.backendCallExpectation -eq 'zero') "Negative case $($case.id) must expect zero backend calls."
    Assert-Contract ($case.expectedStatus -or $case.expectedStatusClass -eq '4xx') "Negative case $($case.id) must define a rejection status."
}

$duplicateIds = @(
    @($positiveCases.id) + @($negativeCases.id) |
        Group-Object |
        Where-Object Count -gt 1
)
Assert-Contract ($duplicateIds.Count -eq 0) 'Contract case IDs must be unique.'

[pscustomobject]@{
    Specification = (Resolve-Path -LiteralPath $SpecificationPath).Path
    DeclaredOperations = $actualPaths.Count
    PositiveCases = $positiveCases.Count
    NegativeCases = $negativeCases.Count
    Result = 'Pass'
} | Format-List