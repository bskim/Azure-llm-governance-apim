[CmdletBinding()]
param(
    [string]$AccessToken = $env:GATEWAY_ACCESS_TOKEN,
    [string]$ExpectedTenantId = $env:AZURE_TENANT_ID,
    [string]$ExpectedAudience = $env:ENTRA_API_AUDIENCE,
    [string]$ExpectedClientApplicationId = $env:ENTRA_CLIENT_APPLICATION_ID,
    [string]$ExpectedScope = $env:ENTRA_REQUIRED_SCOPE,
    [int]$MinimumRemainingLifetimeSeconds = 60
)

$ErrorActionPreference = 'Stop'

function Assert-TokenClaim {
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

function ConvertFrom-Base64Url {
    param(
        [Parameter(Mandatory)]
        [string]$Value
    )

    $base64 = $Value.Replace('-', '+').Replace('_', '/')
    $padding = (4 - ($base64.Length % 4)) % 4
    $base64 += '=' * $padding
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base64))
}

Assert-TokenClaim (-not [string]::IsNullOrWhiteSpace($AccessToken)) 'GATEWAY_ACCESS_TOKEN is required.'
foreach ($requiredValue in ([ordered]@{
    AZURE_TENANT_ID = $ExpectedTenantId
    ENTRA_API_AUDIENCE = $ExpectedAudience
    ENTRA_CLIENT_APPLICATION_ID = $ExpectedClientApplicationId
    ENTRA_REQUIRED_SCOPE = $ExpectedScope
}).GetEnumerator()) {
    Assert-TokenClaim (-not [string]::IsNullOrWhiteSpace($requiredValue.Value)) "$($requiredValue.Key) is required."
}

$parts = $AccessToken.Split('.')
Assert-TokenClaim ($parts.Count -eq 3) 'The supplied value is not a compact JWT.'

try {
    $payload = ConvertFrom-Base64Url -Value $parts[1] | ConvertFrom-Json
}
catch {
    throw 'The access-token payload is not valid base64url JSON.'
}

$audiences = @($payload.aud)
$scopes = @([string]$payload.scp -split ' ' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$expectedIssuer = "https://login.microsoftonline.com/$ExpectedTenantId/v2.0"

Assert-TokenClaim ($payload.ver -eq '2.0') 'The gateway requires a Microsoft Entra v2 access token.'
Assert-TokenClaim ($payload.tid -eq $ExpectedTenantId) 'The token tenant does not match AZURE_TENANT_ID.'
Assert-TokenClaim ($payload.iss -eq $expectedIssuer) 'The token issuer does not match the single-tenant v2 issuer.'
Assert-TokenClaim ($audiences -contains $ExpectedAudience) 'The token audience does not match ENTRA_API_AUDIENCE.'
Assert-TokenClaim ($payload.azp -eq $ExpectedClientApplicationId) 'The authorized party does not match ENTRA_CLIENT_APPLICATION_ID.'
Assert-TokenClaim ($scopes -contains $ExpectedScope) 'The delegated token does not contain ENTRA_REQUIRED_SCOPE.'
Assert-TokenClaim ($payload.acct -eq '0') 'The token must contain the optional acct claim with member value 0.'
Assert-TokenClaim (-not [string]::IsNullOrWhiteSpace([string]$payload.sub)) 'The delegated token must contain a subject.'
Assert-TokenClaim ($null -ne $payload.exp) 'The token must contain an expiration time.'
Assert-TokenClaim ([int64]$payload.exp -gt ($now + $MinimumRemainingLifetimeSeconds)) 'The token is expired or too close to expiration.'
if ($null -ne $payload.nbf) {
    Assert-TokenClaim ([int64]$payload.nbf -le ($now + 300)) 'The token is not valid yet.'
}

[pscustomobject]@{
    TokenVersion = $payload.ver
    TenantMatch = $true
    IssuerMatch = $true
    AudienceMatch = $true
    AuthorizedPartyMatch = $true
    RequiredScopeMatch = $true
    MemberClaimMatch = $true
    SignatureValidated = $false
    Result = 'ShapePass'
} | Format-List