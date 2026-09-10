[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$gatewayPath = Join-Path $repositoryRoot 'infra\modules\gateway.bicep'
$policyPath = Join-Path $repositoryRoot 'apim\policies\inference.xml'

function Assert-ExplicitApimBaseline {
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

$gateway = Get-Content -LiteralPath $gatewayPath -Raw
$policyText = Get-Content -LiteralPath $policyPath -Raw
$policy = [xml]$policyText
$modules = @($gateway)

foreach ($module in $modules) {
    Assert-ExplicitApimBaseline ($module.Contains("var foundryBackendName = 'foundry-account-openai-v1'")) 'Explicit APIM must use the fixed account backend name.'
    Assert-ExplicitApimBaseline ($module.Contains("var foundryBackendUrl = 'https://`${foundryAccountName}.cognitiveservices.azure.com/openai/v1'")) 'Explicit APIM must use the account OpenAI v1 endpoint.'
    Assert-ExplicitApimBaseline (-not $module.Contains('/api/projects/')) 'Explicit APIM must not call a Foundry project endpoint.'
    Assert-ExplicitApimBaseline (-not $module.Contains('param foundryProjectName')) 'The explicit APIM backend module must not accept a project routing input.'
    Assert-ExplicitApimBaseline ($module.Contains("apiUrl string = 'https://`${")) 'The governed client contract must expose an explicit APIM URL.'
}

Assert-ExplicitApimBaseline ($gateway -match "@allowed\(\[\s*'BasicV2'\s*'Developer'\s*\]\)\s*param apimSku string = 'BasicV2'") 'The project baseline must remain Basic v2, with Developer as its only opt-in alternative.'
Assert-ExplicitApimBaseline ($gateway.Contains('sku: apimSku')) 'The gateway must use the explicitly selected SKU.'
Assert-ExplicitApimBaseline (-not $gateway.Contains("sku: 'StandardV2'")) 'Standard v2 must not be introduced without a separate escalation decision.'
# Every backend this policy can select must be account-class. The pool exists so two accounts
# can share a model they both deploy; what must never appear is a project endpoint or a URL
# derived at runtime, either of which would take the request outside the governed route.
$backends = @($policy.SelectNodes('//set-backend-service'))
$managedIdentity = $policy.SelectSingleNode("//authentication-managed-identity[@id='foundry-managed-identity']")
Assert-ExplicitApimBaseline ($backends.Count -ge 1) 'The policy must select a backend.'
$accountClassBackends = @('foundry-account-openai-v1', 'foundry-account-pool')
foreach ($backend in $backends) {
    Assert-ExplicitApimBaseline ($accountClassBackends -contains $backend.'backend-id') "The policy must select an account-class backend: $($backend.'backend-id')"
    Assert-ExplicitApimBaseline ([string]::IsNullOrEmpty($backend.'base-url')) 'The policy must not accept or derive a runtime backend URL.'
}
Assert-ExplicitApimBaseline (@($backends | Where-Object { $_.'backend-id' -eq 'foundry-account-openai-v1' }).Count -eq 1) 'The policy must select the fixed account OpenAI v1 backend.'
Assert-ExplicitApimBaseline ($managedIdentity.resource -eq 'https://cognitiveservices.azure.com') 'The account OpenAI v1 backend must use the Cognitive Services managed-identity audience.'

# One declared side call is permitted, and only to resolve caller policy on a cache
# miss. The data plane still must not become a general proxy.
$sideCalls = @($policy.SelectNodes('//send-request'))
Assert-ExplicitApimBaseline ($sideCalls.Count -le 1) 'The Basic v2 data plane must not add undeclared proxy side calls.'
foreach ($sideCall in $sideCalls) {
    Assert-ExplicitApimBaseline ($sideCall.SelectSingleNode('set-url').'#text' -eq '{{governance-policy-endpoint}}') 'Any side call must target the server-owned governance endpoint.'
    Assert-ExplicitApimBaseline ($sideCall.'ignore-error' -eq 'true') 'A side call must not be able to fail an inference request.'
}

[pscustomobject]@{
    BaselineTier = 'BasicV2'
    GovernedMode = 'ExplicitApim'
    BackendClass = 'FoundryAccountOpenAIV1'
    GeneratedApiMutation = $false
    ProjectEndpointBackend = $false
    Result = 'Pass'
} | Format-List