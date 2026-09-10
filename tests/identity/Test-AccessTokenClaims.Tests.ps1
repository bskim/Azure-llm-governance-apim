[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function ConvertTo-Base64Url {
    param(
        [Parameter(Mandatory)]
        [string]$Value
    )

    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-SyntheticToken {
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload
    )

    $header = ConvertTo-Base64Url -Value (@{ alg = 'none'; typ = 'JWT' } | ConvertTo-Json -Compress)
    $body = ConvertTo-Base64Url -Value ($Payload | ConvertTo-Json -Compress)
    return "$header.$body.synthetic-signature"
}

function Invoke-ShapeValidation {
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload
    )

    & (Join-Path $PSScriptRoot 'Test-AccessTokenClaims.ps1') `
        -AccessToken (New-SyntheticToken -Payload $Payload) `
        -ExpectedTenantId $tenantId `
        -ExpectedAudience $audience `
        -ExpectedClientApplicationId $clientApplicationId `
        -ExpectedScope $requiredScope `
        -MinimumRemainingLifetimeSeconds 0 | Out-Null
}

function Assert-Rejected {
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload,

        [Parameter(Mandatory)]
        [string]$ExpectedMessage
    )

    $caught = $null
    try {
        Invoke-ShapeValidation -Payload $Payload
    }
    catch {
        $caught = $_
    }

    if ($null -eq $caught) {
        throw "Expected token shape rejection: $ExpectedMessage"
    }
    if (-not $caught.Exception.Message.Contains($ExpectedMessage)) {
        throw "Unexpected rejection. Expected '$ExpectedMessage', got '$($caught.Exception.Message)'."
    }
}

$tenantId = '11111111-1111-1111-1111-111111111111'
$audience = '22222222-2222-2222-2222-222222222222'
$clientApplicationId = '33333333-3333-3333-3333-333333333333'
$requiredScope = 'Gateway.Access'
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$validPayload = @{
    ver = '2.0'
    tid = $tenantId
    iss = "https://login.microsoftonline.com/$tenantId/v2.0"
    aud = $audience
    azp = $clientApplicationId
    scp = "openid profile $requiredScope"
    acct = '0'
    sub = 'synthetic-subject'
    nbf = $now - 60
    exp = $now + 3600
}

Invoke-ShapeValidation -Payload $validPayload

$cases = @(
    @{ Name = 'guest'; Change = @{ acct = '1' }; Error = 'optional acct claim with member value 0' },
    @{ Name = 'missing-acct'; Remove = 'acct'; Error = 'optional acct claim with member value 0' },
    @{ Name = 'wrong-audience'; Change = @{ aud = 'wrong-audience' }; Error = 'audience does not match' },
    @{ Name = 'wrong-client'; Change = @{ azp = 'wrong-client' }; Error = 'authorized party does not match' },
    @{ Name = 'missing-scope'; Change = @{ scp = 'openid profile' }; Error = 'does not contain ENTRA_REQUIRED_SCOPE' },
    @{ Name = 'wrong-tenant'; Change = @{ tid = '44444444-4444-4444-4444-444444444444' }; Error = 'tenant does not match' },
    @{ Name = 'wrong-issuer'; Change = @{ iss = 'https://login.microsoftonline.com/common/v2.0' }; Error = 'issuer does not match' },
    @{ Name = 'expired'; Change = @{ exp = $now - 1 }; Error = 'expired or too close to expiration' }
)

foreach ($case in $cases) {
    $payload = $validPayload.Clone()
    if ($case.Remove) {
        $payload.Remove($case.Remove)
    }
    if ($case.Change) {
        foreach ($change in $case.Change.GetEnumerator()) {
            $payload[$change.Key] = $change.Value
        }
    }
    Assert-Rejected -Payload $payload -ExpectedMessage $case.Error
}

[pscustomobject]@{
    ValidMemberCases = 1
    RejectedCases = $cases.Count
    SignatureValidationDelegatedToApim = $true
    Result = 'Pass'
} | Format-List