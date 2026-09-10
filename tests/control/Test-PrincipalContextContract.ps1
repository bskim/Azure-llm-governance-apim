[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$schemaPath = Join-Path $repositoryRoot 'app\governance-domain\contracts\v1\principal-context.schema.json'
$fixtureRoot = Join-Path $PSScriptRoot 'fixtures\principal-context'
$evaluationTime = [DateTimeOffset]::Parse('2026-07-24T00:00:00Z')
$safeIdPattern = '^[A-Za-z0-9._:-]{1,128}$'

function Assert-PrincipalContext {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory)][object]$Value,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Required,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Optional,
        [Parameter(Mandatory)][string]$Path
    )

    $actual = @($Value.PSObject.Properties.Name)
    foreach ($name in $Required) {
        Assert-PrincipalContext ($actual -contains $name) "$Path is missing required property '$name'."
    }
    $allowed = @($Required + $Optional)
    foreach ($name in $actual) {
        Assert-PrincipalContext ($allowed -contains $name) "$Path contains forbidden property '$name'."
    }
}

function Assert-SafeId {
    param([string]$Value, [string]$Path)
    Assert-PrincipalContext ($Value -match $safeIdPattern) "$Path is not a bounded safe identifier."
}

function ConvertTo-Time {
    param([object]$Value, [string]$Path)
    try {
        if ($Value -is [DateTime]) {
            return [DateTimeOffset]::new($Value)
        }
        return [DateTimeOffset]::Parse([string]$Value)
    }
    catch {
        throw "$Path is not an RFC 3339 timestamp."
    }
}

function Test-StrictMembershipEligible {
    param([object]$Context)
    $expiresAt = ConvertTo-Time -Value $Context.memberships.expiresAt -Path 'memberships.expiresAt'
    return $Context.memberships.status -in @('complete', 'empty-complete') -and $expiresAt -gt $evaluationTime
}

function Test-PrincipalContextFixture {
    param([Parameter(Mandatory)][object]$Context)

    Assert-ExactProperties -Value $Context `
        -Required @('contractVersion', 'trust', 'subject', 'application', 'memberships', 'correlation') `
        -Optional @() -Path '$'
    Assert-PrincipalContext ($Context.contractVersion -eq 'v1') 'contractVersion must be v1.'

    Assert-ExactProperties -Value $Context.trust `
        -Required @('source', 'validationId', 'validatedAt', 'credentialExpiresAt', 'validationState', 'callerSupplied') `
        -Optional @() -Path 'trust'
    Assert-PrincipalContext ($Context.trust.source -in @('local-deterministic', 'entra-validated')) 'trust.source is unsupported.'
    Assert-SafeId -Value $Context.trust.validationId -Path 'trust.validationId'
    $validatedAt = ConvertTo-Time -Value $Context.trust.validatedAt -Path 'trust.validatedAt'
    $credentialExpiresAt = ConvertTo-Time -Value $Context.trust.credentialExpiresAt -Path 'trust.credentialExpiresAt'
    Assert-PrincipalContext ($validatedAt -lt $credentialExpiresAt) 'Trust validation time must precede credential expiry.'
    Assert-PrincipalContext ($credentialExpiresAt -gt $evaluationTime) 'Credential evidence is expired.'
    Assert-PrincipalContext (-not [bool]$Context.trust.callerSupplied) 'Principal context must not be caller supplied.'
    if ($Context.trust.source -eq 'local-deterministic') {
        Assert-PrincipalContext ($Context.trust.validationState -eq 'local-trusted') 'Local context must declare local-trusted validation state.'
    }
    else {
        Assert-PrincipalContext ($Context.trust.validationState -eq 'validated') 'Entra context must declare validated state.'
    }

    Assert-ExactProperties -Value $Context.subject `
        -Required @('tenantId', 'subjectId', 'principalType') -Optional @() -Path 'subject'
    Assert-SafeId -Value $Context.subject.tenantId -Path 'subject.tenantId'
    Assert-SafeId -Value $Context.subject.subjectId -Path 'subject.subjectId'
    Assert-PrincipalContext ($Context.subject.principalType -in @('user', 'workload')) 'subject.principalType is unsupported.'

    Assert-ExactProperties -Value $Context.application `
        -Required @('applicationId', 'authenticationFlow') -Optional @('applicationInstanceId') -Path 'application'
    Assert-SafeId -Value $Context.application.applicationId -Path 'application.applicationId'
    if ($null -ne $Context.application.applicationInstanceId) {
        Assert-SafeId -Value $Context.application.applicationInstanceId -Path 'application.applicationInstanceId'
    }
    if ($Context.subject.principalType -eq 'user') {
        Assert-PrincipalContext ($Context.application.authenticationFlow -eq 'delegated') 'User principals require delegated authentication.'
    }
    else {
        Assert-PrincipalContext ($Context.application.authenticationFlow -eq 'application') 'Workload principals require application authentication.'
    }

    Assert-ExactProperties -Value $Context.memberships `
        -Required @('snapshotId', 'status', 'source', 'tenantId', 'subjectId', 'resolvedAt', 'expiresAt', 'maxAgeSeconds', 'sourceRevision', 'groups') `
        -Optional @('reason') -Path 'memberships'
    foreach ($propertyName in @('snapshotId', 'tenantId', 'subjectId', 'sourceRevision')) {
        Assert-SafeId -Value $Context.memberships.$propertyName -Path "memberships.$propertyName"
    }
    Assert-PrincipalContext ($Context.memberships.tenantId -ceq $Context.subject.tenantId) 'Membership tenant binding does not match the subject.'
    Assert-PrincipalContext ($Context.memberships.subjectId -ceq $Context.subject.subjectId) 'Membership subject binding does not match the subject.'
    Assert-PrincipalContext ($Context.memberships.status -in @('complete', 'empty-complete', 'unmapped', 'incomplete', 'stale', 'ambiguous', 'source-unavailable')) 'Membership status is unsupported.'
    Assert-PrincipalContext ($Context.memberships.source -in @('local-fixture', 'entra-adapter', 'control-plane', 'directory-claim')) 'Membership source is unsupported.'
    $resolvedAt = ConvertTo-Time -Value $Context.memberships.resolvedAt -Path 'memberships.resolvedAt'
    $expiresAt = ConvertTo-Time -Value $Context.memberships.expiresAt -Path 'memberships.expiresAt'
    Assert-PrincipalContext ($resolvedAt -lt $expiresAt) 'Membership resolution time must precede expiry.'
    Assert-PrincipalContext ($Context.memberships.maxAgeSeconds -is [long] -or $Context.memberships.maxAgeSeconds -is [int]) 'memberships.maxAgeSeconds must be an integer.'
    Assert-PrincipalContext ([int64]$Context.memberships.maxAgeSeconds -ge 0 -and [int64]$Context.memberships.maxAgeSeconds -le 3600) 'memberships.maxAgeSeconds must be between zero and 3600.'
    Assert-PrincipalContext (($expiresAt - $resolvedAt).TotalSeconds -le [int64]$Context.memberships.maxAgeSeconds) 'Membership lifetime exceeds maxAgeSeconds.'
    if ($Context.memberships.status -notin @('complete', 'empty-complete')) {
        Assert-PrincipalContext (-not [string]::IsNullOrWhiteSpace([string]$Context.memberships.reason)) 'Degraded membership status requires a reason.'
    }
    if ($Context.memberships.status -eq 'empty-complete') {
        Assert-PrincipalContext (@($Context.memberships.groups).Count -eq 0) 'empty-complete membership must have no groups.'
    }

    $groupIds = @()
    foreach ($group in @($Context.memberships.groups)) {
        Assert-ExactProperties -Value $group `
            -Required @('groupId', 'membership', 'authorizationRelevant') -Optional @() -Path 'memberships.groups[]'
        Assert-SafeId -Value $group.groupId -Path 'memberships.groups[].groupId'
        Assert-PrincipalContext ($group.membership -in @('direct', 'nested', 'transitive')) 'Group membership type is unsupported.'
        Assert-PrincipalContext ($group.authorizationRelevant -is [bool]) 'Group authorizationRelevant must be boolean.'
        $groupIds += [string]$group.groupId
    }
    Assert-PrincipalContext (@($groupIds | Select-Object -Unique).Count -eq $groupIds.Count) 'Membership groups contain duplicate IDs.'
    Assert-PrincipalContext (($groupIds -join ',') -ceq ((@($groupIds | Sort-Object)) -join ',')) 'Membership groups must be sorted by groupId.'

    Assert-ExactProperties -Value $Context.correlation `
        -Required @('source', 'requestId', 'attempt') -Optional @('traceId', 'parentCorrelationId') -Path 'correlation'
    Assert-PrincipalContext ($Context.correlation.source -eq 'server-generated') 'correlation.source must be server-generated.'
    Assert-SafeId -Value $Context.correlation.requestId -Path 'correlation.requestId'
    foreach ($propertyName in @('traceId', 'parentCorrelationId')) {
        if ($null -ne $Context.correlation.$propertyName) {
            Assert-SafeId -Value $Context.correlation.$propertyName -Path "correlation.$propertyName"
        }
    }
    Assert-PrincipalContext ($Context.correlation.attempt -is [long] -or $Context.correlation.attempt -is [int]) 'correlation.attempt must be an integer.'
    Assert-PrincipalContext ([int64]$Context.correlation.attempt -ge 1) 'correlation.attempt must be at least one.'
}

Assert-PrincipalContext (Test-Path -LiteralPath $schemaPath -PathType Leaf) 'Principal context schema is missing.'
$schemaText = Get-Content -LiteralPath $schemaPath -Raw
$schema = $schemaText | ConvertFrom-Json -Depth 100
Assert-PrincipalContext ($schema.'$schema' -eq 'https://json-schema.org/draft/2020-12/schema') 'Schema must use JSON Schema Draft 2020-12.'
Assert-PrincipalContext (-not [bool]$schema.additionalProperties) 'Top-level schema must reject additional properties.'
Assert-PrincipalContext (-not ($schema.properties.PSObject.Properties.Name -contains 'roles')) 'Principal context must not accept governance roles.'
Assert-PrincipalContext ($schema.'x-contract-direction' -eq 'server-output-only') 'Schema must declare a server-output-only contract direction.'
Assert-PrincipalContext ([bool]$schema.'x-semantic-validation-required') 'Schema must require semantic validation.'

$validFiles = @(
    'valid-user-complete.json',
    'valid-workload-empty-complete.json'
)
$degradedFiles = @(
    'degraded-stale.json',
    'degraded-ambiguous.json'
)
$invalidFiles = @(
    'invalid-role-injection.json',
    'invalid-body-injection.json',
    'invalid-credential-injection.json',
    'invalid-routing-injection.json',
    'invalid-caller-supplied.json',
    'invalid-tenant-binding.json',
    'invalid-duplicate-groups.json'
)

foreach ($fileName in $validFiles) {
    $fixturePath = Join-Path $fixtureRoot $fileName
    Assert-PrincipalContext (Test-Json -LiteralPath $fixturePath -SchemaFile $schemaPath) "Valid fixture '$fileName' failed JSON Schema validation."
    $context = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json -Depth 100
    Test-PrincipalContextFixture -Context $context
    Assert-PrincipalContext (Test-StrictMembershipEligible -Context $context) "Valid fixture '$fileName' is not eligible for strict membership decisions."
}

foreach ($fileName in $degradedFiles) {
    $fixturePath = Join-Path $fixtureRoot $fileName
    Assert-PrincipalContext (Test-Json -LiteralPath $fixturePath -SchemaFile $schemaPath) "Degraded fixture '$fileName' failed JSON Schema validation."
    $context = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json -Depth 100
    Test-PrincipalContextFixture -Context $context
    Assert-PrincipalContext (-not (Test-StrictMembershipEligible -Context $context)) "Degraded fixture '$fileName' must fail closed for strict membership decisions."
}

foreach ($fileName in $invalidFiles) {
    $fixturePath = Join-Path $fixtureRoot $fileName
    $schemaAccepted = Test-Json -LiteralPath $fixturePath -SchemaFile $schemaPath -ErrorAction SilentlyContinue
    $semanticAccepted = $false
    try {
        $context = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json -Depth 100
        Test-PrincipalContextFixture -Context $context
        $semanticAccepted = $true
    }
    catch {
    }
    Assert-PrincipalContext (-not ($schemaAccepted -and $semanticAccepted)) "Invalid fixture '$fileName' was accepted by both validation layers."
}

$validTemplate = Get-Content -LiteralPath (Join-Path $fixtureRoot 'valid-user-complete.json') -Raw | ConvertFrom-Json -Depth 100
$semanticMutations = @(
    [pscustomobject]@{
        Name = 'trust-time-order'
        Apply = { param($value) $value.trust.credentialExpiresAt = '2026-07-23T23:59:00Z' }
    },
    [pscustomobject]@{
        Name = 'trust-source-state'
        Apply = { param($value) $value.trust.validationState = 'validated' }
    },
    [pscustomobject]@{
        Name = 'principal-flow'
        Apply = { param($value) $value.application.authenticationFlow = 'application' }
    },
    [pscustomobject]@{
        Name = 'membership-time-order'
        Apply = { param($value) $value.memberships.expiresAt = '2026-07-23T23:58:00Z' }
    },
    [pscustomobject]@{
        Name = 'membership-ttl'
        Apply = { param($value) $value.memberships.maxAgeSeconds = 10 }
    },
    [pscustomobject]@{
        Name = 'degraded-reason'
        Apply = {
            param($value)
            $value.memberships.status = 'incomplete'
            $value.memberships.PSObject.Properties.Remove('reason')
        }
    },
    [pscustomobject]@{
        Name = 'empty-complete-groups'
        Apply = { param($value) $value.memberships.status = 'empty-complete' }
    },
    [pscustomobject]@{
        Name = 'correlation-source'
        Apply = { param($value) $value.correlation.source = 'caller' }
    },
    [pscustomobject]@{
        Name = 'correlation-attempt'
        Apply = { param($value) $value.correlation.attempt = 0 }
    }
)
foreach ($mutation in $semanticMutations) {
    $candidate = ($validTemplate | ConvertTo-Json -Depth 100) | ConvertFrom-Json -Depth 100
    & $mutation.Apply $candidate
    $rejected = $false
    try {
        Test-PrincipalContextFixture -Context $candidate
    }
    catch {
        $rejected = $true
    }
    Assert-PrincipalContext $rejected "Semantic mutation '$($mutation.Name)' was accepted."
}

$forbiddenPropertyNames = @(
    'roles', 'teamIds', 'body', 'requestBody', 'responseBody', 'prompt', 'completion',
    'input', 'messages', 'output', 'content', 'authorization', 'authorizationHeader',
    'accessToken', 'refreshToken', 'idToken', 'clientSecret', 'apiKey', 'subscriptionKey',
    'providerKey', 'backendToken', 'managedIdentityToken', 'credential', 'endpoint', 'url',
    'host', 'path', 'route', 'backend', 'backendUrl', 'deployment', 'deploymentId',
    'apiVersion', 'model', 'requestedModel', 'effectiveModel', 'provider', 'resourceId'
)
foreach ($fileName in @($validFiles + $degradedFiles)) {
    $text = Get-Content -LiteralPath (Join-Path $fixtureRoot $fileName) -Raw
    foreach ($propertyName in $forbiddenPropertyNames) {
        Assert-PrincipalContext ($text -notmatch "`"$([regex]::Escape($propertyName))`"\s*:") "Fixture '$fileName' contains forbidden property '$propertyName'."
    }
}

[pscustomobject]@{
    Schema = (Resolve-Path -LiteralPath $schemaPath).Path
    ValidFixtures = $validFiles.Count
    DegradedFailClosedFixtures = $degradedFiles.Count
    InvalidFixturesRejected = $invalidFiles.Count
    JsonSchemaValidated = $true
    SemanticInvariantsValidated = $true
    SemanticMutationsRejected = $semanticMutations.Count
    ServerOutputOnly = $true
    GovernanceRolesExcluded = $true
    BodyAndCredentialsExcluded = $true
    Result = 'Pass'
} | Format-List