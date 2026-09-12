[CmdletBinding()]
param(
    [string]$PolicyPath = (Join-Path $PSScriptRoot '..\..\apim\policies\inference.xml'),
    [string]$InfrastructurePath = (Join-Path $PSScriptRoot '..\..\infra\modules\gateway.bicep')
)

$ErrorActionPreference = 'Stop'

function Assert-Policy {
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

$policyText = Get-Content -LiteralPath $PolicyPath -Raw
$policy = [xml]$policyText
$infrastructure = Get-Content -LiteralPath $InfrastructurePath -Raw

Assert-Policy ($policy.DocumentElement.Name -eq 'policies') 'The policy document must have a policies root.'
foreach ($section in @('inbound', 'backend', 'outbound', 'on-error')) {
    Assert-Policy ($null -ne $policy.SelectSingleNode("/policies/$section")) "Missing policy section: $section"
}

# --- Caller authentication -------------------------------------------------
# Two token shapes reach this gateway. A person presents a delegated scope and a member-account
# claim; an unattended workload presents an application role and neither. One validator cannot
# require both sets, so each branch is checked here for what only it can be asked to prove.
$entraValidation = $policy.SelectSingleNode("//validate-azure-ad-token[@id='entra-token-validation']")
Assert-Policy ($null -ne $entraValidation) 'Microsoft Entra token validation is required.'
Assert-Policy ($entraValidation.'tenant-id' -eq '{{entra-tenant-id}}') 'The tenant must come from the controlled named value.'
$allowedClients = @($entraValidation.SelectNodes('client-application-ids/application-id') | ForEach-Object { $_.'#text' })
foreach ($allowedClient in @('{{entra-client-application-id}}', '{{entra-developer-client-application-id}}')) {
    Assert-Policy ($allowedClients -contains $allowedClient) "The allowed client application must be explicit: $allowedClient"
}
Assert-Policy ($entraValidation.SelectSingleNode('audiences/audience').'#text' -eq '{{entra-api-audience}}') 'The API audience must be explicit.'

$requiredClaims = @($entraValidation.SelectNodes('required-claims/claim'))
foreach ($claimName in @('azp', 'scp', 'acct')) {
    Assert-Policy (($requiredClaims | Where-Object name -eq $claimName).Count -eq 1) "Required Entra claim is missing: $claimName"
}
Assert-Policy (($requiredClaims | Where-Object name -eq 'acct').value -eq '0') 'Guest callers must fail closed by requiring the member account claim.'

# Two accepted clients cannot both be required at once. `all` would demand a token carry both
# application identifiers, which no token can, so the delegated branch would refuse everyone.
$azpClaim = $requiredClaims | Where-Object name -eq 'azp'
Assert-Policy ($azpClaim.match -eq 'any') 'A list of accepted clients must be satisfied by any one of them.'
$acceptedAzp = @($azpClaim.SelectNodes('value') | ForEach-Object { $_.'#text' })
foreach ($allowedClient in @('{{entra-client-application-id}}', '{{entra-developer-client-application-id}}')) {
    Assert-Policy ($acceptedAzp -contains $allowedClient) "The accepted authorized-party list must name the client: $allowedClient"
}

$workloadValidation = $policy.SelectSingleNode("//validate-azure-ad-token[@id='entra-workload-token-validation']")
Assert-Policy ($null -ne $workloadValidation) 'An Azure-hosted workload must have its own validation path.'
Assert-Policy ($workloadValidation.'tenant-id' -eq '{{entra-tenant-id}}') 'The workload tenant must come from the controlled named value.'
Assert-Policy ($workloadValidation.SelectSingleNode('audiences/audience').'#text' -eq '{{entra-api-audience}}') 'The workload audience must be explicit.'
$workloadClaims = @($workloadValidation.SelectNodes('required-claims/claim'))
$roleClaim = $workloadClaims | Where-Object name -eq 'roles'
Assert-Policy ($null -ne $roleClaim) 'A workload token must be required to carry an application role.'
Assert-Policy ($roleClaim.SelectSingleNode('value').'#text' -eq '{{entra-workload-app-role}}') 'The accepted application role must come from the controlled named value.'
# An app-only token carries neither of these, so requiring one here would refuse every workload
# while looking stricter. The role assignment is what admits the caller.
foreach ($delegatedOnlyClaim in @('scp', 'acct')) {
    Assert-Policy (($workloadClaims | Where-Object name -eq $delegatedOnlyClaim).Count -eq 0) "A delegated-only claim cannot be required of a workload token: $delegatedOnlyClaim"
}
Assert-Policy ($null -eq $workloadValidation.SelectSingleNode('client-application-ids')) 'The workload allowlist is the role assignment, not a second roster of client identifiers.'

# The branch is chosen from an unverified read of the presented token, which is safe only
# because the chosen branch then validates it in full and because a delegated token, which
# always carries a scope, can never be steered into the branch that does not check one.
$workloadBranch = $policy.SelectSingleNode("/policies/inbound/choose/when[contains(@condition, 'entra-workload-app-role')]")
Assert-Policy ($null -ne $workloadBranch) 'The workload branch must be selected explicitly rather than inferred.'
Assert-Policy ($workloadBranch.condition.Contains('"disabled"')) 'An unconfigured workload role must disable the branch outright.'
Assert-Policy ($workloadBranch.condition.Contains('ContainsKey("roles")')) 'The workload branch must require the role claim to be present.'
Assert-Policy ($workloadBranch.condition.Contains('!unverified.Claims.ContainsKey("scp")')) 'A delegated token must not be able to reach the workload branch.'

# One value names the calling application on both paths. The two token shapes carry it under
# different claim names, and every later use -- the cache key, the resolution request, the
# usage record -- has to name the same one or attribution splits in two.
$applicationIdentity = $policy.SelectSingleNode("/policies/inbound/set-variable[@name='callerApplicationId']")
Assert-Policy ($null -ne $applicationIdentity) 'The calling application must be read once and reused.'
foreach ($claimName in @('azp', 'appid')) {
    Assert-Policy ($applicationIdentity.value.Contains("ContainsKey(`"$claimName`")")) "The calling application must be recoverable from the claim the token uses: $claimName"
}
$unattributableRefusal = $policy.SelectSingleNode("/policies/inbound/choose/when[contains(@condition, 'callerApplicationId')]")
Assert-Policy ($null -ne $unattributableRefusal) 'A token naming no calling application must be refused, not served unattributed.'
Assert-Policy ($unattributableRefusal.SelectSingleNode('.//set-status').code -eq '403') 'An unattributable caller must be refused with 403.'
Assert-Policy ($policyText.Contains('application_not_identifiable')) 'The unattributable refusal must expose a stable error code.'
# Reading the claim again anywhere else would reintroduce the split the single derivation exists
# to prevent, because only one of the two token shapes carries it.
$directClaimReads = ([regex]::Matches($policyText, [regex]::Escape('Claims["azp"]'))).Count
Assert-Policy ($directClaimReads -eq 1) 'Only the derivation may read the authorized party claim.'
Assert-Policy ($applicationIdentity.value.Contains('Claims["azp"][0]')) 'The single read of the authorized party claim must be the derivation.'
$cacheKey = $policy.SelectSingleNode("/policies/inbound/set-variable[@name='policyCacheKey']").value
Assert-Policy ($cacheKey.Contains('callerApplicationId')) 'The policy cache must be keyed by the derived calling application.'
Assert-Policy ($policyText.Contains('new JProperty("applicationId", (string)context.Variables["callerApplicationId"])')) 'The control plane must be told the derived calling application.'

# Which validator accepted the token decides whether the caller is a person or a workload, and
# the control plane cannot tell them apart from the claims alone.
foreach ($flow in @('application', 'delegated')) {
    Assert-Policy ($null -ne $policy.SelectSingleNode("//set-variable[@name='authenticationFlow' and @value='$flow']")) "The accepted token shape must be stated: $flow"
}
Assert-Policy ($policyText.Contains('new JProperty("authenticationFlow"')) 'The accepted token shape must reach the control plane.'

# --- Preserved request hardening -------------------------------------------
$c0ProxyGuard = $policy.SelectSingleNode("/policies/inbound/choose/when[contains(@condition, 'x-c0-proxy-key')]")
Assert-Policy ($null -ne $c0ProxyGuard) 'C0 must require traffic to pass through the allowance proxy when its secret named value is enabled.'
Assert-Policy ($c0ProxyGuard.SelectSingleNode('.//set-status').code -eq '403') 'C0 direct APIM bypass must return 403.'
Assert-Policy ($policyText.Contains('c0_proxy_required')) 'C0 direct APIM bypass must expose a stable error code.'
$c0ProxyHeaderDelete = $policy.SelectSingleNode("/policies/inbound/set-header[@name='x-c0-proxy-key']")
Assert-Policy ($c0ProxyHeaderDelete.'exists-action' -eq 'delete') 'The C0 proxy key must be removed before Foundry invocation.'
$c0OperationHeaderDelete = $policy.SelectSingleNode("/policies/inbound/set-header[@name='x-c0-operation-id']")
Assert-Policy ($c0OperationHeaderDelete.'exists-action' -eq 'delete') 'The C0 operation ID must be removed before Foundry invocation.'

foreach ($operationId in @('createResponse', 'createChatCompletion')) {
    Assert-Policy ($policyText.Contains($operationId)) "Policy does not bind the declared operation: $operationId"
}
foreach ($canonicalPath in @('/v1/responses', '/v1/chat/completions')) {
    Assert-Policy ($policyText.Contains($canonicalPath)) "Policy does not enforce canonical path: $canonicalPath"
}
foreach ($untrustedInput in @('api-key', 'Ocp-Apim-Subscription-Key', 'x-backend-url', 'x-deployment-id', 'api_version', 'backend_url')) {
    Assert-Policy ($policyText.Contains($untrustedInput)) "Policy does not reject client routing or credential input: $untrustedInput"
}
foreach ($untrustedHeader in @('Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Original-Host', 'X-Original-URL', 'X-Rewrite-URL', 'X-HTTP-Method-Override', 'X-Method-Override')) {
    Assert-Policy ($policyText.Contains($untrustedHeader)) "Policy does not reject forwarding or method-override header: $untrustedHeader"
}
$routingHeaderDenial = $policy.SelectSingleNode("/policies/inbound/choose/when[contains(.//set-body, 'routing_input_not_allowed') and contains(.//set-body, 'Client credentials')]")

# Claude Code's apiKeyHelper copies the value it is given into an API-key header as well as
# Authorization. Refusing that request would make the client unusable, and accepting the header
# as a credential would let a caller smuggle a provider key past Bearer validation. The gateway
# therefore refuses an API-key header only when it carries something other than the token that
# was already validated, and removes it either way before the backend is called.
foreach ($duplicatedHeader in @('api-key', 'x-api-key')) {
    Assert-Policy ($routingHeaderDenial.condition.Contains($duplicatedHeader)) "The credential refusal must consider the duplicated API-key header: $duplicatedHeader"
    $duplicateDeletion = $policy.SelectSingleNode("/policies/inbound/set-header[@name='$duplicatedHeader']")
    Assert-Policy ($null -ne $duplicateDeletion -and $duplicateDeletion.'exists-action' -eq 'delete') "A duplicated API-key header must be removed before backend dispatch: $duplicatedHeader"
}
Assert-Policy ($routingHeaderDenial.condition.Contains('StringComparison.Ordinal')) 'The duplicated-credential comparison must be an exact ordinal match.'
foreach ($duplicatedHeader in @('api-key', 'x-api-key')) {
    $exemption = "context.Request.Headers.GetValueOrDefault(`"$duplicatedHeader`", `"`")"
    Assert-Policy ($routingHeaderDenial.condition.Contains($exemption)) "The refusal must compare the API-key header value rather than only its presence: $duplicatedHeader"
}
Assert-Policy ($routingHeaderDenial.condition.Contains('bearerToken')) 'A duplicated API-key header must be compared against the validated Bearer token.'
$bearerExtraction = $policy.SelectSingleNode("/policies/inbound/set-variable[@name='bearerToken']")
Assert-Policy ($null -ne $bearerExtraction) 'The policy must isolate the validated Bearer token for the duplicate-header comparison.'
Assert-Policy (-not $policyText.Contains('trace') -or $policyText.IndexOf('bearerToken') -lt 0 -or -not ($policy.SelectNodes("//trace[contains(., 'bearerToken')]").Count -gt 0)) 'The Bearer token must never reach a trace.'
$bearerOrder = $policyText.IndexOf("name=`"bearerToken`"")
$validationOrder = $policyText.IndexOf('entra-token-validation')
Assert-Policy ($validationOrder -lt $bearerOrder) 'The Bearer token must be validated before it is used to excuse a duplicated header.'
Assert-Policy ($policyText.IndexOf('entra-workload-token-validation') -lt $bearerOrder) 'A workload token must be validated before it is used to excuse a duplicated header.'

foreach ($platformHeader in @('Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Original-Host', 'X-Original-URL', 'X-Rewrite-URL')) {
    Assert-Policy (-not $routingHeaderDenial.condition.Contains($platformHeader)) "APIM-managed header must not reject every request: $platformHeader"
    $deletion = $policy.SelectSingleNode("/policies/inbound/set-header[@name='$platformHeader']")
    Assert-Policy ($deletion.'exists-action' -eq 'delete') "APIM-managed forwarding header must be stripped before backend dispatch: $platformHeader"
}
Assert-Policy ($policyText.Contains('{{gateway-host}}')) 'The public gateway host must be validated against server-owned configuration.'

$contentValidation = $policy.SelectSingleNode('//validate-content')
Assert-Policy ($null -ne $contentValidation) 'Request content validation is required before body parsing.'
Assert-Policy ($contentValidation.id -eq 'request-content-validation') 'Content validation must have a stable error-routing policy ID.'
Assert-Policy ($contentValidation.'unspecified-content-type-action' -eq 'prevent') 'Unknown content types must be rejected.'
Assert-Policy ($contentValidation.'size-exceeded-action' -eq 'prevent') 'Oversized request bodies must be rejected.'
Assert-Policy ($contentValidation.SelectSingleNode('content').'validate-as' -eq 'json') 'Request bodies must be schema-validated as JSON.'

# --- Effective policy resolution -------------------------------------------
$cacheLookups = @($policy.SelectNodes('/policies/inbound//cache-lookup-value'))
Assert-Policy ($cacheLookups.Count -eq 1) 'The caller policy must be resolved with exactly one cache lookup per section.'
Assert-Policy ($cacheLookups[0].'variable-name' -eq 'effectivePolicyRaw') 'The cache lookup must populate the effective policy variable.'
Assert-Policy ($null -ne $policy.SelectSingleNode('/policies/inbound//cache-store-value')) 'A resolved policy must be cached for reuse.'
Assert-Policy ($policyText.Contains('{{policy-cache-seconds}}')) 'The cache expiry must come from server-owned configuration.'

$sendRequests = @($policy.SelectNodes('//send-request'))
Assert-Policy ($sendRequests.Count -eq 1) 'Exactly one side call is permitted, and only to resolve caller policy.'
Assert-Policy ($sendRequests[0].SelectSingleNode('set-url').'#text' -eq '{{governance-policy-endpoint}}') 'The policy resolution call must target the server-owned governance endpoint.'
Assert-Policy ($sendRequests[0].'ignore-error' -eq 'true') 'A policy resolution failure must be handled by the explicit governance-unavailable response rather than a gateway expression failure.'
# An ignored error leaves the response variable present but null, so a reader that only asks
# whether the gateway made the call will dereference nothing and fail the request it was
# supposed to protect. Every use of the response must test the value, not just the key.
$responseReaders = @($policy.SelectNodes('//when[contains(@condition, "policyResponse")]'))
Assert-Policy ($responseReaders.Count -ge 1) 'The policy-resolution response must be read somewhere.'
foreach ($reader in $responseReaders) {
    Assert-Policy (-not $reader.condition.Contains('(IResponse)') -or $reader.condition.Contains('context.Variables["policyResponse"] != null')) 'A policy-resolution response may only be dereferenced after a null check, because ignore-error leaves an unreachable control plane as a null value under an existing key.'
}
Assert-Policy ($null -ne $sendRequests[0].SelectSingleNode('authentication-managed-identity')) 'The policy resolution call must authenticate with a managed identity.'
Assert-Policy ($policyText.Contains('{{governance-policy-timeout-seconds}}')) 'The policy resolution call must be bounded by a configured timeout.'
$sendRequestBodyAt = $sendRequests[0].OuterXml.IndexOf('<set-body>', [StringComparison]::Ordinal)
$sendRequestIdentityAt = $sendRequests[0].OuterXml.IndexOf('<authentication-managed-identity', [StringComparison]::Ordinal)
Assert-Policy ($sendRequestBodyAt -ge 0 -and $sendRequestBodyAt -lt $sendRequestIdentityAt) 'send-request must construct its body before applying managed-identity authentication.'
$sendRequestParent = $sendRequests[0].ParentNode
Assert-Policy ($sendRequestParent.Name -eq 'when' -and $sendRequestParent.condition.Contains('!context.Variables.ContainsKey("effectivePolicyRaw")')) 'The policy resolution call must only run on a cache miss.'
Assert-Policy ($sendRequestParent.condition.Contains('{{governance-policy-enabled}}')) 'The unavailable policy source must be bypassed unless explicitly enabled.'
Assert-Policy ($sendRequestParent.condition.Contains('StringComparison.OrdinalIgnoreCase')) 'The policy-resolution feature flag comparison must be explicit and case-insensitive.'
Assert-Policy ($policyText.Contains('envelope?["document"] as JObject')) 'The gateway must select only the effective-policy document nested inside the control-plane response envelope.'
Assert-Policy ($policyText.Contains('document == null ||')) 'A missing effective-policy document must be unavailable rather than receive a model.'
Assert-Policy ($policyText.Contains('catch')) 'Malformed policy-resolution JSON must be unavailable rather than receive a model.'
Assert-Policy ($policyText.Contains('string.Equals((string)document["resolution"], "resolved", StringComparison.Ordinal)')) 'Only an actively resolved policy document may admit a request.'
foreach ($requiredActivePolicyMember in @(
    'document["contractVersion"]',
    'document["documentType"]',
    'document?["allowedModels"]',
    'document?["modelDeployments"]',
    'document?["limits"]',
    'document?["attribution"]'
)) {
    Assert-Policy ($policyText.Contains($requiredActivePolicyMember)) "The gateway must reject an incomplete effective policy missing $requiredActivePolicyMember."
}
Assert-Policy ($policyText.Contains('!string.IsNullOrEmpty((string)context.Variables["policyDocumentCandidate"])')) 'Only a complete active policy document may be cached.'
Assert-Policy (([regex]::Matches($policyText, [regex]::Escape('{{default-effective-policy}}'))).Count -eq 1) 'The permissive default policy may appear only in the explicit evaluation escape hatch.'

# The only retained default-policy path is a deliberately named compatibility escape
# hatch for isolated evaluation. Its named value defaults false in every gateway module.
$evaluationAssignments = @($policy.SelectNodes('//set-variable[@name="effectivePolicyRaw" and @value="{{default-effective-policy}}"]'))
Assert-Policy ($evaluationAssignments.Count -eq 1) 'The explicit evaluation escape hatch must be the only path that can install a default policy.'
$evaluationBranch = $evaluationAssignments[0].ParentNode
Assert-Policy ($evaluationBranch.Name -eq 'when') 'The evaluation default must be installed under an explicit condition.'
Assert-Policy ($evaluationBranch.condition.Contains('{{allow-ungoverned-evaluation-mode}}')) 'The evaluation default must require the conspicuous ungoverned-evaluation opt-in.'
Assert-Policy ($evaluationBranch.condition.Contains('StringComparison.OrdinalIgnoreCase')) 'The ungoverned-evaluation opt-in comparison must be explicit and case-insensitive.'
Assert-Policy ($evaluationBranch.condition.Contains('!context.Variables.ContainsKey("effectivePolicyRaw")')) 'The evaluation default must never overwrite a resolved or cached policy.'

$unresolvedBranch = $evaluationBranch.NextSibling
while ($null -ne $unresolvedBranch -and $unresolvedBranch.NodeType -ne [System.Xml.XmlNodeType]::Element) {
    $unresolvedBranch = $unresolvedBranch.NextSibling
}
Assert-Policy ($null -ne $unresolvedBranch -and $unresolvedBranch.Name -eq 'when') 'Missing governance state must have its own branch beside the evaluation-only escape hatch.'
Assert-Policy ($unresolvedBranch.condition.Contains('!context.Variables.ContainsKey("effectivePolicyRaw")')) 'The refusal branch must key on the absence of a document.'
Assert-Policy (-not $unresolvedBranch.condition.Contains('governance-policy-enabled')) 'The refusal must catch disabled, unavailable, and incomplete governance alike.'
Assert-Policy ($null -eq $evaluationBranch.ParentNode.SelectSingleNode('otherwise')) 'The two outcomes must be the whole decision, so no third path can install a document.'

$unresolvedResponse = $unresolvedBranch.SelectSingleNode('return-response')
Assert-Policy ($null -ne $unresolvedResponse) 'A deployment that resolves and could not must refuse rather than serve a document it did not obtain.'
Assert-Policy ([int]$unresolvedResponse.SelectSingleNode('set-status').code -eq 503) 'An unobtainable governance decision must answer 503: nobody established that this caller is not permitted, so 403 would be a false statement.'
Assert-Policy ($unresolvedBranch.OuterXml.Contains('governance_unavailable')) 'The refusal must expose a stable error code.'
Assert-Policy ($null -ne $unresolvedResponse.SelectSingleNode("set-header[@name='x-request-id']")) 'The refusal must carry the request identifier the other refusals carry.'
$unresolvedRetry = $unresolvedResponse.SelectSingleNode("set-header[@name='Retry-After']")
Assert-Policy ($null -ne $unresolvedRetry) 'A refusal that may succeed on a retry must say when to retry.'
Assert-Policy ([int]$unresolvedRetry.SelectSingleNode('value').'#text' -ge 10) 'The retry interval must exceed the time a cold control plane needs, or every caller returns while it is still starting.'
Assert-Policy (-not ($unresolvedBranch.OuterXml -match 'cache-store-value')) 'A refusal must not be stored under the resolved-policy cache key.'
Assert-Policy ($unresolvedBranch.OuterXml -match 'PolicyResolution') 'The refusal must be traceable, because it returns before attribution runs.'
foreach ($absentHeader in @('x-effective-model', 'x-usage-quality', 'x-model-fallback-applied')) {
    Assert-Policy (-not ($unresolvedBranch.OuterXml -match [regex]::Escape($absentHeader))) "An unresolved refusal must not claim $absentHeader, because no model was selected."
}

# Ordering is what makes an incomplete policy fail closed: policy resolution must run
# before evaluation-only default selection, and either outcome must happen before parse.
$defaultAt = $policyText.IndexOf('{{default-effective-policy}}', [StringComparison]::Ordinal)
$sendRequestAt = $policyText.IndexOf('<send-request', [StringComparison]::Ordinal)
$parseAt = $policyText.IndexOf('JObject.Parse((string)context.Variables["effectivePolicyRaw"])', [StringComparison]::Ordinal)
Assert-Policy ($sendRequestAt -ge 0 -and $defaultAt -gt $sendRequestAt) 'The evaluation-only default must be considered after the resolution attempt, not instead of it.'
Assert-Policy ($parseAt -ge 0 -and $defaultAt -lt $parseAt) 'The evaluation-only default must be selected or governance refused before the document is parsed.'

# A refusal has to be decided before the fallback, or the caller has already been given
# a document by the time it is read.
$refusalAt = $policyText.IndexOf('admissionRefusal', [StringComparison]::Ordinal)
Assert-Policy ($refusalAt -ge 0 -and $refusalAt -lt $defaultAt) 'An admission refusal must be decided before the evaluation-only default is considered.'

# The control plane host answers 403 for a rejected gateway token and for a missing
# resolution role as well as for a governance refusal, so status alone must never block.
$refusalBranch = [regex]::Match(
    $policyText,
    '(?s)<when condition=''[^'']*StatusCode == 403[^'']*''>(.*?)</when>\s*</choose>')
Assert-Policy $refusalBranch.Success 'The policy must carry a branch for a control-plane refusal.'
$refusalBody = $refusalBranch.Groups[1].Value
Assert-Policy ($refusalBody -match 'Property\("document"\)' -and $refusalBody -match 'JTokenType\.Null') 'A refusal must require the response to carry a null document, not merely the status.'
Assert-Policy ($refusalBody -match '"membership-evidence-unmapped"') 'A refusal must match a closed list of reason codes.'
Assert-Policy (-not ($refusalBody -match 'cache-store-value')) 'A refusal must not be stored under the resolved-policy cache key.'
Assert-Policy ($refusalBody -match 'PolicyResolution') 'A refusal must be traceable, because it returns before attribution runs.'
foreach ($absentHeader in @('x-effective-model', 'x-usage-quality', 'x-model-fallback-applied')) {
    Assert-Policy (-not ($refusalBody -match [regex]::Escape($absentHeader))) "A refusal must not claim $absentHeader, because no model was selected."
}

# --- Model entitlement ------------------------------------------------------
Assert-Policy ($policyText.Contains('["allowedModels"]')) 'The requested model must be checked against the resolved allowlist.'
Assert-Policy ($policyText.Contains('model_not_allowed')) 'A model outside the allowlist must produce a stable denial code.'
Assert-Policy (-not $policyText.Contains('{{default-model-alias}}')) 'A single hard-coded model alias must not gate entitlement.'
Assert-Policy (-not $policyText.Contains('{{default-model-deployment}}')) 'A single hard-coded deployment must not be forced onto every request.'

# A refusal names what the caller may use, which it is already entitled to know, and
# never distinguishes an unregistered model from an unentitled one, which it is not.
$refusalAt = $policyText.IndexOf('model_not_allowed')
$refusalBody = $policyText.Substring($policyText.LastIndexOf('<set-body>', $refusalAt), $refusalAt - $policyText.LastIndexOf('<set-body>', $refusalAt) + 400)
Assert-Policy ($refusalBody.Contains('allowed_models')) 'A refused model must be answered with the models the caller may use.'
foreach ($disclosure in @('model_not_found', 'unknown_model', 'not_registered')) {
    Assert-Policy (-not $policyText.Contains($disclosure)) "A refusal must not distinguish an unregistered model from an unentitled one: $disclosure"
}

# --- Hierarchical counters --------------------------------------------------
$tokenLimits = @($policy.SelectNodes('//llm-token-limit'))
Assert-Policy ($tokenLimits.Count -ge 4) 'Hierarchical token governance requires a counter per applicable scope.'
Assert-Policy (-not $policyText.Contains("token-quota='@((int)")) 'APIM token-quota policy expressions must not return System.Int32.'
# A context variable is boxed as System.Object, and the expression language refuses member
# calls on it. The gateway rejects the whole policy, so this is a deployment failure rather
# than a runtime one.
Assert-Policy (-not [regex]::IsMatch($policyText, 'context\.Variables\[[^\]]+\]\.ToString\(\)')) 'A boxed context variable must be converted with Convert, not by calling a member on it.'
$quotaCarrying = @($tokenLimits | Where-Object { -not [string]::IsNullOrEmpty($_.'token-quota') })
Assert-Policy (([regex]::Matches($policyText, "token-quota='@\(Convert\.ToInt64\(")).Count -eq $quotaCarrying.Count) 'Every APIM token-quota expression must safely convert boxed values to System.Int64.'

$expectedCounterKeys = @{
    'organization-token-quota'       = 'quotaOrgAllBudgetSuffix'
    'team-token-limit'               = 'quotaTeamAllBudgetSuffix'
    'subject-token-limit'            = 'quotaSubjectAllBudgetSuffix'
    'application-token-limit'        = 'quotaApplicationAllBudgetSuffix'
    'organization-model-token-limit' = 'quotaOrgModelBudgetSuffix'
    'team-model-token-limit'         = 'quotaTeamModelBudgetSuffix'
}
foreach ($limitId in $expectedCounterKeys.Keys) {
    $limit = $policy.SelectSingleNode("//llm-token-limit[@id='$limitId']")
    Assert-Policy ($null -ne $limit) "Missing token counter: $limitId"
    Assert-Policy ($limit.'counter-key'.Contains($expectedCounterKeys[$limitId])) "Counter key composition must preserve budget identity for: $limitId"
    Assert-Policy ($limit.'estimate-prompt-tokens' -eq 'true') "Prompt estimation must be enabled for: $limitId"
    Assert-Policy (-not [string]::IsNullOrEmpty($limit.'token-quota')) "A token volume cap is required for: $limitId"
    Assert-Policy (-not [string]::IsNullOrEmpty($limit.'token-quota-period')) "A quota period is required for: $limitId"
    # The two axes are indistinguishable by error source and reason, so a quota breach can
    # only announce itself by recording its own retry interval.
    Assert-Policy ($limit.'retry-after-variable-name' -eq 'quotaRetryAfter') "A quota counter must record that it was the quota: $limitId"
}
Assert-Policy ($policyText.Contains('limit["budgetId"]') -and $policyText.Contains('limit["budgetVersion"]')) 'Quota counter keys must preserve the authored budget identity and version.'
Assert-Policy ($policyText.Contains('"org|quota"') -and $policyText.Contains('"throttle:org:all:b:"')) 'Quota and throttle budgets at the same coverage must use disjoint APIM counter namespaces.'

# One counter key must carry exactly one rate value, so the per-minute axis is a policy of
# its own with its own key. Sharing a key with a quota-only instance is documented as
# unpredictable on the v2 tiers.
$rateCarrying = @($tokenLimits | Where-Object { -not [string]::IsNullOrEmpty($_.'tokens-per-minute') })
Assert-Policy ($rateCarrying.Count -eq 1) 'Exactly one counter may declare a per-minute token rate.'
Assert-Policy ($rateCarrying[0].id -eq 'organization-token-rate') 'The per-minute token rate belongs to the organization-wide rate counter.'
Assert-Policy ($rateCarrying[0].'counter-key' -eq 'org|rate') 'The rate axis needs a key of its own.'
Assert-Policy ([string]::IsNullOrEmpty($rateCarrying[0].'token-quota')) 'The rate counter must not also carry a quota, or neither can be told apart.'
Assert-Policy ($rateCarrying[0].'retry-after-variable-name' -eq 'rateRetryAfter') 'The rate counter must record that it was the rate.'
$tokenKeys = @($tokenLimits | ForEach-Object { $_.'counter-key' })
Assert-Policy ($tokenKeys.Count -eq ($tokenKeys | Select-Object -Unique).Count) 'Two token counters share a key, so one scope silently consumes the other.'
Assert-Policy ($policyText.IndexOf('id="organization-token-quota"') -lt $policyText.IndexOf('id="organization-token-rate"')) 'The quota must be evaluated first, so a breach that cannot recover this period is never reported as a momentary one.'

$rateLimit = $policy.SelectSingleNode("//rate-limit-by-key[@id='subject-request-limit']")
Assert-Policy ($rateLimit.'counter-key' -eq '@("user:" + (string)context.Variables["subjectKey"])') 'Request rate limits must be keyed by the pseudonymous subject.'
Assert-Policy (-not $policyText.Contains('context.Request.IpAddress')) 'Caller limits must not be keyed by a mutable source IP.'

# Every governed scope must be able to cap a request rate, and each needs its own
# counter: one key is one counter, so a shared key would merge two scopes into one
# budget instead of applying both.
$scopeRateLimits = @{
    'organization-request-limit'      = 'rpm:org'
    'team-request-limit'              = 'rpm:team:'
    'subject-configured-request-limit' = 'rpm:user:'
    'application-request-limit'       = 'rpm:app:'
}
foreach ($id in $scopeRateLimits.Keys) {
    $node = $policy.SelectSingleNode("//rate-limit-by-key[@id='$id']")
    Assert-Policy ($null -ne $node) "A governed scope has no request rate counter: $id"
    Assert-Policy ($node.'counter-key'.Contains($scopeRateLimits[$id])) "Rate counter key is not scoped: $id"
    Assert-Policy ($node.calls.StartsWith('@(')) "A configured rate must come from the resolved document, not a literal: $id"
    Assert-Policy ($node.'renewal-period' -eq '60') "A per-minute rate must renew every 60 seconds: $id"
}
$rateKeys = @($policy.SelectNodes('//rate-limit-by-key') | ForEach-Object { $_.'counter-key' })
Assert-Policy ($rateKeys.Count -eq ($rateKeys | Select-Object -Unique).Count) 'Two rate counters share a key, so one scope silently consumes the other.'

# --- Fallback ordering ------------------------------------------------------
$modelAgnosticAt = $policyText.IndexOf('id="organization-token-quota"')
$rewriteAt = $policyText.IndexOf('body["model"] = (string)context.Variables["providerDeploymentName"]')
$modelSpecificAt = $policyText.IndexOf('id="organization-model-token-limit"')
Assert-Policy ($modelAgnosticAt -gt 0 -and $rewriteAt -gt 0 -and $modelSpecificAt -gt 0) 'Fallback ordering markers are missing.'
Assert-Policy ($modelAgnosticAt -lt $rewriteAt) 'Model-agnostic counters must run before the fallback decision.'
Assert-Policy ($rewriteAt -lt $modelSpecificAt) 'Model-specific counters must run after the effective model is chosen.'
Assert-Policy ($policyText.Contains('warnThresholdPercent')) 'Fallback must be gated by the configured threshold.'
Assert-Policy ($policyText.Contains('allowed.Contains(next)')) 'A fallback target must be inside the caller allowlist.'
Assert-Policy ($policyText.Contains('depth &lt; maxDepth')) 'Fallback traversal must be depth bounded.'
Assert-Policy ($null -eq $policy.SelectSingleNode('//set-backend-service[@base-url]')) 'Fallback must not route to an alternate backend.'

# The caller's model is a governed request, so substitution is opt-in and the returned
# body keeps the model that actually answered.
Assert-Policy ($policyText.Contains('intent != "preferred"')) 'A substitute must be opted into, not opted out of.'
Assert-Policy ($policyText.Contains('modelSelectionIntent"] == null ? "pinned"')) 'An unstated intent must pin the requested model.'
Assert-Policy ($policyText.IndexOf('modelSelectionIntent') -lt $rewriteAt) 'The intent must be read before the request body is rewritten.'
$outbound = $policy.SelectSingleNode('//outbound')
Assert-Policy (@($outbound.SelectNodes('.//set-body')).Count -le 1) 'The response body may be rewritten at most once, and only to add the substitution notice.'

# A streamed response the client abandons produces no usage log, but the quota was
# already debited. The gateway must report what it charged, on both the completed and
# the failed path, or that budget is spent invisibly.
$orgLimit = $policy.SelectSingleNode("//llm-token-limit[@id='organization-token-rate']")
Assert-Policy ($orgLimit.'tokens-consumed-variable-name' -eq 'consumedTokens') 'The gateway must expose the token count it charged.'
foreach ($section in @('outbound', 'on-error')) {
    $completion = $policy.SelectSingleNode("/policies/$section/trace[@source='llm-governance-completion']")
    Assert-Policy ($null -ne $completion) "The consumed-token record is missing from: $section"
    foreach ($required in @('ConsumedTokens', 'Streaming', 'Completed')) {
        Assert-Policy ((@($completion.SelectNodes('metadata')) | Where-Object name -eq $required).Count -eq 1) "Completion record is missing metadata: $required in $section"
    }
}

# --- Attribution and telemetry ---------------------------------------------
$traces = @($policy.SelectNodes('/policies/inbound/trace'))
Assert-Policy ($traces.Count -eq 2) 'Governed requests must emit an admission record and a dispatch record.'

$admission = $policy.SelectSingleNode("/policies/inbound/trace[@source='llm-governance-admission']")
$dispatch = $policy.SelectSingleNode("/policies/inbound/trace[@source='llm-governance-dispatch']")
Assert-Policy ($null -ne $admission) 'Attribution must be emitted when the caller is admitted.'
Assert-Policy ($null -ne $dispatch) 'Attribution must be emitted when the request is dispatched to a model.'

# The admission record has to precede every denial, or a refused request carries no
# attribution and a refusal count can only ever report zero.
$admissionAt = $policyText.IndexOf('llm-governance-admission')
foreach ($denial in @('model_not_allowed', 'id="organization-token-quota"', 'id="subject-request-limit"')) {
    $denialAt = $policyText.IndexOf($denial)
    Assert-Policy ($denialAt -gt 0) "Denial marker is missing: $denial"
    Assert-Policy ($admissionAt -lt $denialAt) "Admission attribution must precede the denial: $denial"
}
Assert-Policy ($admissionAt -lt $policyText.IndexOf('llm-governance-dispatch')) 'Admission must precede dispatch.'

foreach ($required in @('SubjectKey', 'ApplicationKey', 'TeamKey', 'RequestedModel', 'PolicyResolution', 'ConfigVersion', 'UsageQuality')) {
    Assert-Policy ((@($admission.SelectNodes('metadata')) | Where-Object name -eq $required).Count -eq 1) "Admission attribution is missing metadata: $required"
}

Assert-Policy ($policyText.Contains('return team == null || team.Type == JTokenType.Null ? "" : (string)team;')) 'Nullable team attribution must become an empty internal value rather than an invented team.'
Assert-Policy ($policyText.Contains('? "not-single-team" : (string)context.Variables["teamKey"]')) 'The operational team metric must use a nonempty non-team bucket when no single team is attributable.'
Assert-Policy ($policyText.Contains('<dimension name="Team" value=''@((string)context.Variables["teamMetricKey"])'' />')) 'The team metric dimension must use the nonempty metric bucket rather than nullable attribution.'
Assert-Policy (([regex]::Matches($policyText, '<metadata name="TeamKey" value=''@\(\(string\)context\.Variables\["teamMetricKey"\]\)'' />')).Count -eq 2) 'Both attribution traces must use the nonempty team bucket because APIM refuses empty metadata values.'
Assert-Policy (-not $policyText.Contains('<metadata name="TeamKey" value=''@((string)context.Variables["teamKey"])'' />')) 'Nullable team attribution must never be emitted as an empty APIM trace metadata value.'
Assert-Policy ($policyText.Contains('limit == null || limit["tokenQuota"] == null ? 0L : Convert.ToInt64(limit["tokenQuota"])')) 'Quota extraction must guard a missing quota without narrowing a valid quota to Int32.'
Assert-Policy (-not $policyText.Contains('(int)limit["budgetVersion"]')) 'Quota counter keys must not narrow a valid budget version to Int32.'
Assert-Policy (-not $policyText.Contains('(int)tier["budgetVersion"]')) 'Throttle counter keys must not narrow a valid budget version to Int32.'
Assert-Policy (([regex]::Matches($policyText, 'Convert\.ToInt64\([^)]+\["budgetVersion"\]\)')).Count -eq 12) 'All quota and throttle counter keys must format budget versions as Int64 values.'
$largeBudgetVersion = [Int64]2147483648
Assert-Policy ($largeBudgetVersion.ToString([System.Globalization.CultureInfo]::InvariantCulture) -eq '2147483648') 'The policy contract must preserve a budget version above Int32.MaxValue in a counter key.'
Assert-Policy ($policyText.Contains('code == "principal-not-entitled"')) 'A determined absence of subject, application, or team grants must reach the closed admission refusal.'
Assert-Policy (-not $policyText.Contains('principal-not-in-governed-team')) 'The gateway must not retain the superseded group-only admission rule.'
foreach ($teamLimit in @('rateTeamAll')) {
    Assert-Policy ($policyText -match "!string\.IsNullOrEmpty\(\(string\)context\.Variables\[`"teamKey`"\]\) &amp;&amp; \(int\)context\.Variables\[`"$teamLimit`"\] &gt; 0") "The $teamLimit counter must be skipped when no single team is attributable."
}
foreach ($teamQuota in @('quotaTeamAll', 'quotaTeamModel')) {
    Assert-Policy ($policyText -match "!string\.IsNullOrEmpty\(\(string\)context\.Variables\[`"teamKey`"\]\) &amp;&amp; Convert\.ToInt64\(context\.Variables\[`"$teamQuota`"\]\) &gt; 0") "The $teamQuota counter must preserve an Int64 quota when a team is attributable."
}
$quotaPeriods = [ordered]@{
    'organization-token-quota'       = 'quotaPeriodOrgAll'
    'team-token-limit'                = 'quotaPeriodTeamAll'
    'subject-token-limit'             = 'quotaPeriodSubjectAll'
    'application-token-limit'         = 'quotaPeriodApplicationAll'
    'organization-model-token-limit' = 'quotaPeriodOrgModel'
    'team-model-token-limit'          = 'quotaPeriodTeamModel'
}
foreach ($entry in $quotaPeriods.GetEnumerator()) {
    $node = @($policy.SelectNodes("//llm-token-limit[@id='$($entry.Key)']"))
    Assert-Policy ($node.Count -eq 1) "Quota policy is missing or duplicated: $($entry.Key)"
    Assert-Policy ($node[0].'token-quota-period'.Contains($entry.Value)) "$($entry.Key) must use its own period variable $($entry.Value)."
}
# The model decision is not known at admission, so only the dispatch record may claim it.
foreach ($required in @('SubjectKey', 'ApplicationKey', 'TeamKey', 'RequestedModel', 'EffectiveModel', 'FallbackApplied', 'PolicyResolution', 'UsageQuality')) {
    Assert-Policy ((@($dispatch.SelectNodes('metadata')) | Where-Object name -eq $required).Count -eq 1) "Dispatch attribution is missing metadata: $required"
}
Assert-Policy ((@($admission.SelectNodes('metadata')) | Where-Object name -eq 'EffectiveModel').Count -eq 0) 'Admission must not claim a model decision that has not been made.'

foreach ($trace in $traces) {
    Assert-Policy ($trace.severity -eq 'information') "Attribution must be emitted at the verbosity the diagnostic admits: $($trace.source)"
    foreach ($metadata in @($trace.SelectNodes('metadata'))) {
        Assert-Policy (-not $metadata.value.Contains('jwt')) "Attribution metadata must not read raw token claims: $($metadata.name)"
        Assert-Policy (-not $metadata.value.Contains('.Subject')) "Attribution metadata must not emit a raw subject: $($metadata.name)"
    }
    Assert-Policy (-not $trace.OuterXml.Contains('requestBody')) 'Attribution must never carry the request body.'
}

$metric = $policy.SelectSingleNode('//llm-emit-token-metric')
$metricDimensions = @($metric.SelectNodes('dimension'))
Assert-Policy ($metricDimensions.Count -le 5) 'Token metrics support at most five custom dimensions.'
foreach ($highCardinalityDimension in @('User ID', 'Request ID', 'Subject', 'SubjectKey', 'ApplicationKey')) {
    Assert-Policy (-not ($metricDimensions | Where-Object name -eq $highCardinalityDimension)) "High-cardinality metric dimension is prohibited: $highCardinalityDimension"
}
foreach ($requiredDimension in @('Team', 'Effective Model', 'Policy Resolution', 'Usage Quality')) {
    Assert-Policy (($metricDimensions | Where-Object name -eq $requiredDimension).Count -eq 1) "Token metrics are missing dimension: $requiredDimension"
}
Assert-Policy ($policyText.Contains('streamOptions["include_usage"] = true')) 'Chat streaming must request provider usage when available.'
Assert-Policy ($policyText.Contains('(bool)context.Variables["streaming"] ? "estimated" : "reported"')) 'Usage quality must distinguish streaming estimates from provider-reported non-streaming usage.'

# --- Inline substitution notice ---------------------------------------------
# The notice is prose prepended to text the caller reads. Every condition below is a
# case where prepending would corrupt something the caller parses, so each one must
# leave the body untouched and let the headers carry the substitution alone.
$noticeStart = $policyText.IndexOf('substitutionNotice"], "inline"')
Assert-Policy ($noticeStart -ge 0) 'An inline notice must be gated on the resolved policy opting into it.'
$noticeBlock = $policyText.Substring($noticeStart)
Assert-Policy ($noticeStart -gt $policyText.IndexOf('<outbound>')) 'The notice belongs to the response, not the request.'
Assert-Policy ($noticeBlock.Contains('!(bool)context.Variables["streaming"]')) 'A streamed response must never be buffered to add a notice.'
Assert-Policy ($noticeBlock.Contains('context.Response.StatusCode == 200')) 'An error body must not be rewritten.'
Assert-Policy ($noticeBlock.Contains('{{substitution-notice-text}}')) 'The notice wording must be owned by the deployment, not the policy body.'
foreach ($refusal in @('tool_calls', 'function_call', 'response_format', 'JTokenType.String', 'choices.Count != 1')) {
    Assert-Policy ($noticeBlock.Contains($refusal)) "The notice must refuse to rewrite a body it could corrupt: $refusal"
}
Assert-Policy (([regex]::Matches($noticeBlock, 'return unchanged;')).Count -ge 8) 'Every refusal must return the body unchanged rather than a partial rewrite.'
Assert-Policy (-not $noticeBlock.Contains('requestedModel')) 'The notice must name the model that answered, never the one that did not.'
Assert-Policy ($null -eq $policy.SelectSingleNode('//forward-request[@buffer-response="true"]')) 'Streaming responses must not be buffered.'

foreach ($responseHeader in @('x-requested-model', 'x-effective-model', 'x-model-fallback-applied', 'x-policy-resolution', 'x-usage-quality')) {
    Assert-Policy ($null -ne $policy.SelectSingleNode("/policies/outbound/set-header[@name='$responseHeader']")) "Outbound response is missing governance header: $responseHeader"
}

# --- Backend wiring ---------------------------------------------------------
# REL-003. Two accounts can only share load for a model both of them deploy, so the pool is
# entered from a declared list of such models and every other request keeps the one backend
# that is known to serve it.
$backendSelections = @($policy.SelectNodes('//set-backend-service'))
$rewrite = $policy.SelectSingleNode('//rewrite-uri')
$managedIdentity = $policy.SelectSingleNode("//authentication-managed-identity[@id='foundry-managed-identity']")
Assert-Policy ($backendSelections.Count -eq 2) 'Backend selection must offer exactly the pool and the primary backend.'
foreach ($selection in $backendSelections) {
    Assert-Policy ([string]::IsNullOrEmpty($selection.'base-url')) 'The policy must not derive a backend URL at runtime.'
}
$poolChoose = $policy.SelectSingleNode("//choose[when/set-backend-service/@backend-id='foundry-account-pool']")
Assert-Policy ($null -ne $poolChoose) 'The pooled backend must be reached through a branch, never selected unconditionally.'
$poolBranch = $poolChoose.SelectSingleNode('when')
$primaryBranch = $poolChoose.SelectSingleNode('otherwise')
Assert-Policy ($null -ne $primaryBranch) 'A request that is not pooled must still have a backend.'
Assert-Policy ($primaryBranch.SelectSingleNode('set-backend-service').'backend-id' -eq 'foundry-account-openai-v1') 'Every request that is not pooled must keep the fixed account OpenAI v1 backend entity.'
Assert-Policy ($poolBranch.condition.Contains('{{pooled-model-deployments}}')) 'The set of pooled models must be deployment configuration, not a literal in the policy body.'
Assert-Policy ($poolBranch.condition.Contains('IsNullOrWhiteSpace')) 'An unconfigured pooled-model list must fall to the primary backend, so an empty list has to be refused explicitly.'
# Routing on the requested name would send a downgraded request to a pool chosen for a model it
# is no longer using, and a request downgraded into a pooled model to a backend that may not
# deploy it. Only the model that will be dispatched describes what the backend must serve.
Assert-Policy ($poolBranch.condition.Contains('context.Variables["effectiveModel"]')) 'The pool must be chosen from the model that will be dispatched.'
Assert-Policy (-not $poolBranch.condition.Contains('requestedModel')) 'The pool must not be chosen from the model the caller asked for.'
$poolSelectionAt = $policyText.IndexOf('backend-id="foundry-account-pool"')
Assert-Policy ($poolSelectionAt -gt 0) 'The pooled backend selection marker is missing.'
$modelRewriteAt = $policyText.IndexOf('body["model"] = (string)context.Variables["providerDeploymentName"]')
Assert-Policy ($policyText.Contains('policy["modelDeployments"] as JArray')) 'Backend dispatch must read the logical-model to provider-deployment map.'
Assert-Policy ($policyText.Contains('entry["modelKey"] == effective')) 'Backend dispatch must select the provider deployment for the effective logical model.'
Assert-Policy ($policyText.Contains('effective-policy|v2|')) 'The cache key must isolate mapping-aware documents from older cached policy shapes.'
$mappingGuardAt = $policyText.IndexOf('string.IsNullOrEmpty((string)context.Variables["providerDeploymentName"])')
Assert-Policy ($mappingGuardAt -gt 0 -and $mappingGuardAt -lt $modelRewriteAt) 'A resolved model without a provider deployment must be refused before the backend body is written.'
Assert-Policy ($policyText.Contains('string.Equals((string)policy["resolution"], "default"')) 'Only a default deployment document may use identity mapping without modelDeployments.'
Assert-Policy ($modelRewriteAt -gt 0) 'The dispatched-model rewrite marker is missing.'
Assert-Policy ($modelRewriteAt -lt $poolSelectionAt) 'The dispatched model must be settled before it decides the backend.'
# One authentication element after the choice, so the two paths cannot be authenticated
# differently and a second account cannot quietly acquire its own credential.
Assert-Policy (@($policy.SelectNodes("//authentication-managed-identity[@id='foundry-managed-identity']")).Count -eq 1) 'Both backend paths must share one managed-identity authentication.'
Assert-Policy ($policyText.IndexOf('id="foundry-managed-identity"') -gt $poolSelectionAt) 'Managed-identity authentication must apply after either backend has been selected.'
Assert-Policy ($rewrite.'copy-unmatched-params' -eq 'false') 'Client query parameters must not be copied to Foundry.'
Assert-Policy ($managedIdentity.resource -eq 'https://cognitiveservices.azure.com') 'Foundry authentication must use the Cognitive Services audience.'
Assert-Policy ($managedIdentity.'ignore-error' -eq 'false') 'Managed identity failure must fail closed.'
Assert-Policy (-not $policyText.Contains('/api/projects/')) 'The governed API must never call a Foundry project endpoint.'

# --- Error contract ---------------------------------------------------------
$errorStatusCodes = @($policy.SelectNodes('/policies/on-error//set-status') | ForEach-Object { [int]$_.code })
foreach ($requiredStatus in @(400, 401, 403, 404, 429, 500, 502, 503)) {
    Assert-Policy ($errorStatusCodes -contains $requiredStatus) "The on-error contract must produce status $requiredStatus."
}

# A URI matching no operation is a routing refusal. Reaching the catch-all reports it as
# a gateway fault, which is what the deployed v0.2.0 policy did.
$routeBranch = $policy.SelectSingleNode('/policies/on-error//when[contains(.//set-body, "route_not_supported")]')
Assert-Policy ($null -ne $routeBranch) 'An unmatched operation must be refused as a route, not as a gateway failure.'
Assert-Policy ($routeBranch.condition.Contains('context.LastError.Reason == "OperationNotFound"')) 'The route refusal must key off the documented OperationNotFound reason.'
Assert-Policy ([int]$routeBranch.SelectSingleNode('.//set-status').code -eq 404) 'An unmatched operation must return 404.'
$errorBranches = @($policy.SelectNodes('/policies/on-error/choose/when'))
Assert-Policy ($errorBranches[0].condition.Contains('OperationNotFound')) 'The route refusal must precede every branch that assumes the pipeline ran.'
$routeBody = $routeBranch.SelectSingleNode('.//set-body').InnerText
foreach ($disclosure in @('responses', 'chat/completions', 'embeddings', 'allowed_routes')) {
    Assert-Policy (-not $routeBody.Contains($disclosure)) "A route refusal must not enumerate routes: $disclosure"
}

Assert-Policy ($policyText.Contains('context.LastError.PolicyId == "entra-token-validation"')) 'Authentication errors must retain a 401 branch.'
# A second validator that no branch names would fail as an unclassified gateway error, which is
# the shape that turned a routing refusal into a 500 twice before.
Assert-Policy ($policyText.Contains('context.LastError.PolicyId == "entra-workload-token-validation"')) 'A workload authentication failure must reach the same 401 branch.'
$challenge = $policy.SelectSingleNode("/policies/on-error/choose/when/return-response/set-header[@name='WWW-Authenticate']/value").'#text'
Assert-Policy ($challenge.Contains('resource_metadata="https://{{gateway-host}}/.well-known/oauth-protected-resource/v1"')) 'A refused caller must be pointed at the metadata that describes how to authenticate.'
Assert-Policy ($challenge.StartsWith('Bearer ')) 'The challenge must name the bearer scheme it is refusing.'
Assert-Policy ($policyText.Contains('context.LastError.PolicyId == "request-content-validation"')) 'Request validation errors must retain a 400 branch.'
Assert-Policy ($policyText.Contains('token_quota_exceeded')) 'An exhausted token budget must expose a stable error code.'
Assert-Policy ($policyText.Contains('context.LastError.Reason == "BackendConnectionFailure"')) 'Backend connection failures must retain a 502 branch.'
Assert-Policy ($policyText.Contains('context.LastError.PolicyId == "foundry-managed-identity"')) 'Managed identity failures must retain a 503 branch.'

# REL-003 no-backend behaviour. A pool every member of which has tripped leaves nothing to try.
# The documented client-visible outcome is a 503; the reason code is not documented, so the
# branch keys on the status API Management itself produced. Reaching the catch-all would report
# a backend that is merely unavailable as a failure of this gateway.
$unavailableBranch = $policy.SelectSingleNode('/policies/on-error//when[contains(.//set-body, "service_unavailable")]')
Assert-Policy ($null -ne $unavailableBranch) 'An unavailable backend must be refused as unavailable, not as a gateway failure.'
Assert-Policy ($unavailableBranch.condition.Contains('context.Response.StatusCode == 503')) 'A tripped backend produces a 503, and that status must reach a 503-class refusal rather than the catch-all.'
Assert-Policy ([int]$unavailableBranch.SelectSingleNode('.//set-status').code -eq 503) 'The unavailable-backend branch must answer 503.'
$onErrorAt = $policyText.IndexOf('<on-error>', [StringComparison]::Ordinal)
$catchAllAt = $policyText.IndexOf('<otherwise>', $onErrorAt, [StringComparison]::Ordinal)
Assert-Policy ($catchAllAt -gt $onErrorAt) 'The error contract must end in a catch-all.'
Assert-Policy ($policyText.IndexOf('context.Response.StatusCode == 503', $onErrorAt, [StringComparison]::Ordinal) -lt $catchAllAt) 'The unavailable-backend branch must be evaluated before the catch-all.'

# The status clause above only helps when a response exists to read. The section is what the
# gateway knows in every case, so an undocumented backend failure lands as a backend failure
# rather than depending on a reason code nobody has published.
$backendSectionBranch = $policy.SelectSingleNode('/policies/on-error//when[contains(@condition, "context.LastError.Section")]')
Assert-Policy ($null -ne $backendSectionBranch) 'A failure that happened while talking to the backend must be classified by where it happened, not only by a reason code.'
Assert-Policy ($backendSectionBranch.condition.Contains('context.LastError.Section == "backend"')) 'The section branch must name the backend section.'
Assert-Policy ([int]$backendSectionBranch.SelectSingleNode('.//set-status').code -eq 503) 'A backend-section failure must answer 503.'
# Our own broken expression in the backend section is a gateway fault, and reporting it as an
# unavailable backend would hide it behind something an operator would wait out.
Assert-Policy ($backendSectionBranch.condition.Contains('context.LastError.Reason != "ExpressionValueEvaluationFailure"')) 'A gateway expression defect must not be reported as an unavailable backend.'
Assert-Policy ($policyText.IndexOf('context.LastError.Section == "backend"', $onErrorAt, [StringComparison]::Ordinal) -lt $catchAllAt) 'The backend-section branch must be evaluated before the catch-all.'
$quotaErrorBranch = $policy.SelectSingleNode('/policies/on-error//when[contains(.//set-body, "token_quota_exceeded")]')
Assert-Policy ($quotaErrorBranch.condition.Contains('context.LastError.Reason != "ExpressionValueEvaluationFailure"')) 'Unexpected quota expression failures must fall through to the generic gateway error rather than being mislabeled as exhausted quotas.'
foreach ($limitId in $expectedCounterKeys.Keys) {
    Assert-Policy ($policyText.Contains("context.LastError.PolicyId == `"$limitId`"")) "The on-error contract must route the counter: $limitId"
}

# A token limit refusing a request is the product working. APIM attributes that refusal
# to its own internal handler rather than to the policy id, so a branch that keys only on
# the id never matches and the catch-all reports the enforcement as a gateway fault. A
# real coding agent hit this and retried a request that could never succeed.
$rateErrorBranch = $policy.SelectSingleNode('/policies/on-error//when[contains(.//set-body, "rate_limit_exceeded")]')
Assert-Policy ($null -ne $rateErrorBranch) 'A protective limit must have a 429 branch.'
Assert-Policy ($rateErrorBranch.condition.Contains('StartsWith("TokenLimitExceeded")')) 'A token-limit refusal must be classified by its reason, because the policy id is not attributed on that path.'
Assert-Policy ($rateErrorBranch.condition.Contains('context.LastError.Reason != "ExpressionValueEvaluationFailure"')) 'A token-limit expression failure must not be reported as a rate limit.'
Assert-Policy ($quotaErrorBranch.condition.Contains('Contains("Quota")')) 'An exhausted quota must be recognised by its reason as well as by the policy id.'
# The reason and source are identical on both axes, so the retry interval each counter
# records is the only thing that names which one refused.
Assert-Policy ($quotaErrorBranch.condition.Contains('context.Variables.ContainsKey("quotaRetryAfter")')) 'A quota breach must be recognised by the counter that recorded it.'
$quotaRetryHeader = $quotaErrorBranch.SelectSingleNode(".//set-header[@name='Retry-After']")
Assert-Policy ($null -ne $quotaRetryHeader) 'A caller told to come back later must be told when.'
$quotaBody = $quotaErrorBranch.SelectSingleNode('.//set-body').InnerText
Assert-Policy ($quotaBody.Contains('cannot succeed')) 'An exhausted budget must say that retrying will not help, or a client will retry until the period rolls.'
$branchOrder = @($errorBranches | ForEach-Object { $_.condition })
$quotaIndex = [array]::IndexOf($branchOrder, $quotaErrorBranch.condition)
$rateIndex = [array]::IndexOf($branchOrder, $rateErrorBranch.condition)
Assert-Policy ($quotaIndex -ge 0 -and $rateIndex -gt $quotaIndex) 'The quota branch must be evaluated before the generic token-limit branch, or an exhausted budget reads as a transient throttle.'

# --- Throttle tier selection ------------------------------------------------
$throttleStart = $policyText.IndexOf('<set-variable name="throttleTier"')
Assert-Policy ($throttleStart -ge 0) 'The policy must select a throttle tier.'
# Anchored on the body rewrite that follows it, because earlier denial branches also
# contain a set-body element.
$throttleEnd = $policyText.IndexOf('<set-body>@{', $throttleStart)
Assert-Policy ($throttleEnd -gt $throttleStart) 'The tier selection must precede the request body rewrite.'
$throttleBlock = $policyText.Substring($throttleStart, $throttleEnd - $throttleStart)
Assert-Policy ($throttleStart -gt $policyText.IndexOf('name="effectiveModel"')) 'The tier must be chosen after the effective model, so the reduction applies to the model that will serve.'
Assert-Policy ($throttleStart -lt $policyText.IndexOf('<set-backend-service')) 'The tier must be chosen before the backend is selected.'
Assert-Policy ($throttleBlock.Contains('throttleTiers')) 'The tier must be read from the effective policy document rather than hard coded.'
Assert-Policy (-not $throttleBlock.Contains('send-request')) 'Tier selection must not call out to another service.'
foreach ($budgetField in @('budgetId', 'budgetVersion', 'modelScope', 'modelKey', 'accountingBasis', 'againstTokenQuota')) {
    Assert-Policy ($policyText.Contains("tier[`"$budgetField`"]")) "Throttle enforcement must use the authored $budgetField rather than an unrelated policy limit."
}
Assert-Policy ($policyText.Contains('["quotaPeriod"]')) 'Throttle measurement counters must use the authored quota period.'
Assert-Policy ($throttleBlock.Contains('throttleMeasurementQuota')) 'Throttle evaluation must use its dedicated measurement counters.'
Assert-Policy (-not $throttleBlock.Contains('var limits = (JArray)policy["limits"];')) 'Throttle evaluation must not infer budget consumption from an unrelated enforcement quota.'
Assert-Policy ($throttleBlock.Contains('Convert.ToInt64(context.Variables["throttleMeasurementQuota"]) - Convert.ToInt64(context.Variables[name])')) 'Throttle evaluation must subtract APIM token counters as Int64 values before computing a ratio.'
Assert-Policy ($throttleBlock.Contains('((decimal)used / (decimal)quota) * 10000m')) 'Throttle evaluation must convert to decimal only after precise token subtraction.'
Assert-Policy (-not $throttleBlock.Contains('Convert.ToDouble(context.Variables["throttleMeasurementQuota"])')) 'Throttle evaluation must not lose small token consumption through a double near Int64.MaxValue.'
Assert-Policy ($throttleBlock.Contains('var consumedBasisPoints = ((decimal)used / (decimal)quota) * 10000m;')) 'Throttle evaluation must retain basis points as decimal values instead of overflowing an integer.'
Assert-Policy ($throttleBlock.Contains('var severity = tierCode == "tier-minimal" ? 2 : tierCode == "tier-reduced" ? 1 : 0;')) 'Throttle selection must encode the deployment rate severity independently from a budget-local threshold.'
Assert-Policy ($throttleBlock.Contains('severity &gt; selectedSeverity')) 'The strongest crossed tier must win across independent budgets.'
Assert-Policy (-not $throttleBlock.Contains('at &gt; selectedAt')) 'A larger threshold in another budget must not override a stronger crossed throttle rate.'
$measurementQuotaNode = $policy.SelectSingleNode('/policies/inbound/set-variable[@name="throttleMeasurementQuota"]')
Assert-Policy ($null -ne $measurementQuotaNode) 'Throttle measurement must declare its shared finite quota.'
$measurementQuota = [Int64]$measurementQuotaNode.value
Assert-Policy ($measurementQuota -eq ([Int64]::MaxValue - 1)) 'Throttle measurement must use the verified finite quota below Int64.MaxValue, not the maximum that failed live tier selection.'
$remainingAfterFiveTokens = $measurementQuota - 5
$consumedBasisPoints = [int](([decimal]($measurementQuota - $remainingAfterFiveTokens) / [decimal]10) * 10000)
Assert-Policy ($consumedBasisPoints -eq 5000) 'A five-token consumption against a ten-token budget must select a 5000-basis-point threshold exactly.'
$remainingAfterOneToken = $measurementQuota - 1
$smallConsumedBasisPoints = [int](([decimal]($measurementQuota - $remainingAfterOneToken) / [decimal]100) * 10000)
Assert-Policy ($smallConsumedBasisPoints -eq 100) 'A one-token consumption must remain visible at a 100-basis-point threshold.'
$overflowBasisPoints = (([decimal]([Int64]::MaxValue - 1) / [decimal]1) * 10000)
Assert-Policy ($overflowBasisPoints -gt [Int32]::MaxValue) 'A high-consumption, one-token budget must prove the policy comparison does not depend on an Int32 basis-point cast.'
foreach ($measurement in @(
    'throttle-organization-all-models-measurement',
    'throttle-team-all-models-measurement',
    'throttle-subject-all-models-measurement',
    'throttle-application-all-models-measurement',
    'throttle-organization-per-model-measurement',
    'throttle-team-per-model-measurement'
)) {
    $measurementPolicy = $policy.SelectSingleNode("//llm-token-limit[@id='$measurement']")
    Assert-Policy ($null -ne $measurementPolicy) "The authored throttle budget needs an independent APIM counter: $measurement"
    Assert-Policy ($measurementPolicy.'token-quota' -eq '@(Convert.ToInt64(context.Variables["throttleMeasurementQuota"]))') "Every throttle counter must use the verified shared finite quota: $measurement"
}
Assert-Policy ($policyText.Contains('":b:" + (string)tier["budgetId"]')) 'Throttle counter identities must include the authored budget ID.'
# Each tier keeps its own counter key, because the platform documents unpredictable
# behaviour when one key is declared with two different rates.
Assert-Policy ($throttleBlock.Contains('"throttle:reduced:"')) 'The reduced tier must use its own counter key.'
Assert-Policy ($throttleBlock.Contains('"throttle:minimal:"')) 'The minimal tier must use its own counter key.'
foreach ($tierRate in @('{{throttle-tier-reduced-calls}}', '{{throttle-tier-minimal-calls}}')) {
    Assert-Policy ($throttleBlock.Contains("calls=`"$tierRate`"")) "The tier rate $tierRate must be a deployment-time literal."
}

# --- Deployment contract ----------------------------------------------------
# Every named value the policy substitutes must be provisioned by the supported
# new-gateway module, or the policy deploys with unresolved tokens.
$referencedNamedValues = @(([regex]::Matches($policyText, '\{\{([a-z0-9-]+)\}\}')) | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
Assert-Policy ($referencedNamedValues.Count -gt 0) 'The policy must substitute server-owned named values.'
foreach ($namedValue in $referencedNamedValues) {
    Assert-Policy ($infrastructure.Contains("name: '$namedValue'")) "The gateway module does not provision named value: $namedValue"
}
foreach ($gatewayModule in @{ 'created gateway' = $infrastructure }.GetEnumerator()) {
    Assert-Policy ($gatewayModule.Value -match "default-effective-policy'[\s\S]{0,200}?value:\s*'\{\}'") "The $($gatewayModule.Key) must keep the policy token inert rather than deploy a permissive default policy."
}
foreach ($deploymentModule in @{ 'created gateway' = $infrastructure }.GetEnumerator()) {
    Assert-Policy ($deploymentModule.Value.Contains('servers: []')) "The $($deploymentModule.Key) OpenAPI import must not derive serviceUrl implicitly."
    Assert-Policy ($deploymentModule.Value.Contains('serviceUrl: foundryBackendUrl')) "The $($deploymentModule.Key) must pass a valid API serviceUrl instead of the AVM empty-string default."
}

# The version a deployment publishes is how an operator tells which policy is live, so
# the supported module must state a version for operators to identify.
$declaredVersions = @($infrastructure) | ForEach-Object {
    ([regex]::Match($_, "name: 'gateway-policy-version'[\s\S]{0,80}?value: '([0-9]+\.[0-9]+\.[0-9]+)(-c0)?'")).Groups[1].Value
}
Assert-Policy ($declaredVersions -notcontains '') 'Every gateway module must declare a policy version.'
Assert-Policy (@($declaredVersions | Sort-Object -Unique).Count -eq 1) "The supported gateway must declare one policy version: $($declaredVersions -join ', ')"

Assert-Policy ($infrastructure.Contains("path: 'v1'")) 'The API suffix must be v1.'
Assert-Policy ($infrastructure.Contains("'/responses': publicApiDefinition.paths['/v1/responses']")) 'Responses must be imported relative to the API suffix.'
Assert-Policy ($infrastructure.Contains("'/chat/completions': publicApiDefinition.paths['/v1/chat/completions']")) 'Chat must be imported relative to the API suffix.'
Assert-Policy ($infrastructure.Contains("format: 'openapi+json'")) 'APIM must import the path-transformed OpenAPI definition.'
Assert-Policy ($infrastructure.Contains('var apimApiDefinition = shallowMerge([')) 'The deployment contract must replace nested paths rather than retain public prefixed paths.'
Assert-Policy ($infrastructure.Contains('servers: []')) 'The OpenAPI document must not implicitly derive APIM serviceUrl.'
Assert-Policy (-not $infrastructure.Contains('union(publicApiDefinition')) 'Recursive OpenAPI path merging is prohibited.'
Assert-Policy (([regex]::Matches($infrastructure, 'bytes:\s*(\d+)')).Count -gt 0) 'API diagnostics must declare body byte settings.'
foreach ($bodyBytes in [regex]::Matches($infrastructure, 'bytes:\s*(\d+)')) {
    Assert-Policy ($bodyBytes.Groups[1].Value -eq '0') 'All API diagnostic body byte settings must be zero.'
}
Assert-Policy (-not $infrastructure.Contains("headers: ['Authorization'")) 'Authorization headers must not be selected for diagnostics.'
Assert-Policy ($infrastructure.Contains("identityClientId: 'systemAssigned'")) 'Application Insights logging must use the APIM system-assigned identity.'
Assert-Policy ($infrastructure.Contains('3913510d-42f4-4e42-8a64-420c390055eb')) 'Application Insights publishing must use the minimum Monitoring Metrics Publisher role.'

# Trace records only reach a destination whose verbosity is at or below the trace
# severity, so attribution requires a native Azure Monitor diagnostic that avoids
# the Application Insights-only defaults injected by the AVM diagnostic module.
Assert-Policy ($infrastructure.Contains("type: 'azureMonitor'")) 'The gateway must provision an Azure Monitor logger for resource-log attribution.'
$azureMonitorDiagnosticAt = $infrastructure.IndexOf("resource inferenceAzureMonitorDiagnostic", [StringComparison]::Ordinal)
Assert-Policy ($azureMonitorDiagnosticAt -gt 0) 'The governed API must have a native Azure Monitor diagnostic.'
$azureMonitorDiagnosticEnd = $infrastructure.IndexOf("output apimName", $azureMonitorDiagnosticAt, [StringComparison]::Ordinal)
$azureMonitorDiagnosticBlock = $infrastructure.Substring($azureMonitorDiagnosticAt, $azureMonitorDiagnosticEnd - $azureMonitorDiagnosticAt)
Assert-Policy ($azureMonitorDiagnosticBlock.Contains('loggerId: createdAzureMonitorLogger.id')) 'The native diagnostic must reference the Azure Monitor logger by resource ID.'
Assert-Policy ($azureMonitorDiagnosticBlock.Contains("verbosity: 'information'")) 'The Azure Monitor diagnostic must admit information-severity traces.'
Assert-Policy (-not $azureMonitorDiagnosticBlock.Contains('httpCorrelationProtocol')) 'Azure Monitor diagnostics must not use the Application Insights-only correlation setting.'
Assert-Policy (-not $azureMonitorDiagnosticBlock.Contains('operationNameFormat')) 'Azure Monitor diagnostics must not use the Application Insights-only operation-name setting.'
Assert-Policy ($infrastructure.Contains('metrics: false')) 'Custom metric emission belongs to the Application Insights diagnostic only.'
Assert-Policy (-not $infrastructure.Contains('instrumentationKey: applicationInsights.outputs.instrumentationKey')) 'Instrumentation-key-only logging is prohibited.'

[pscustomobject]@{
    Policy = (Resolve-Path -LiteralPath $PolicyPath).Path
    RequiredClaims = $requiredClaims.Count
    TokenCounters = $tokenLimits.Count
    TraceMetadata = ($traces | ForEach-Object { @($_.SelectNodes('metadata')).Count }) -join '+'
    MetricDimensions = $metricDimensions.Count
    NamedValues = $referencedNamedValues.Count
    ErrorStatuses = ($errorStatusCodes | Sort-Object -Unique) -join ','
    Result = 'Pass'
} | Format-List
