[CmdletBinding()]
param(
    [string]$TemplatePath = (Join-Path $PSScriptRoot '..\..\infra\main.bicep'),
    [string]$IdentityTemplatePath = (Join-Path $PSScriptRoot '..\..\infra\modules\identity.bicep'),
    [string]$BicepConfigPath = (Join-Path $PSScriptRoot '..\..\infra\bicepconfig.json'),
    [string]$ParametersPath = (Join-Path $PSScriptRoot '..\..\infra\main.parameters.json'),
    [string]$InitializerPath = (Join-Path $PSScriptRoot '..\..\tools\distribution\Initialize-Governance.mjs')
)

$ErrorActionPreference = 'Stop'

function Assert-EntraIac {
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

$template = Get-Content -LiteralPath $TemplatePath -Raw
$identityTemplate = Get-Content -LiteralPath $IdentityTemplatePath -Raw
$configuration = Get-Content -LiteralPath $BicepConfigPath -Raw | ConvertFrom-Json
$parameters = Get-Content -LiteralPath $ParametersPath -Raw | ConvertFrom-Json
$initializer = Get-Content -LiteralPath $InitializerPath -Raw

Assert-EntraIac ($configuration.extensions.microsoftGraphV1 -eq 'br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:1.0.0') 'Microsoft Graph Bicep must use the pinned v1.0 extension.'
Assert-EntraIac ($identityTemplate.Contains('extension microsoftGraphV1')) 'The identity module must enable the Microsoft Graph extension.'
Assert-EntraIac (([regex]::Matches($identityTemplate, "Microsoft.Graph/applications@v1.0")).Count -eq 4) 'The template must create an inference API with its public client and an administration API with its console client.'
Assert-EntraIac (([regex]::Matches($identityTemplate, "Microsoft.Graph/servicePrincipals@v1.0")).Count -eq 4) 'The template must create a service principal for each app registration.'
Assert-EntraIac (([regex]::Matches($identityTemplate, "signInAudience: 'AzureADMyOrg'")).Count -eq 4) 'Every app registration must be single tenant.'
Assert-EntraIac (([regex]::Matches($identityTemplate, 'requestedAccessTokenVersion: 2')).Count -eq 2) 'Both resource APIs must issue v2 access tokens.'
Assert-EntraIac ($identityTemplate.Contains("var gatewayAccessScope = 'Gateway.Access'")) 'The gateway must expose the Gateway.Access delegated scope.'
Assert-EntraIac ($identityTemplate.Contains("var gatewayApiIdentifierUri = 'api://`${tenant().tenantId}/`${gatewayApiUniqueName}'")) 'The identifier URI must use the supported tenant-scoped api URI format.'
Assert-EntraIac ($identityTemplate.Contains('var gatewayAccessScopeId = guid(')) 'The delegated scope ID must be deterministic.'
Assert-EntraIac ($identityTemplate.Contains("name: 'acct'")) 'The API registration must request the acct optional access-token claim.'
Assert-EntraIac ($identityTemplate.Contains('accessToken: [')) 'The acct claim must be configured for access tokens.'
Assert-EntraIac ($identityTemplate -match "publicClient:\s*\{[\s\S]*?redirectUris:\s*\[\s*'http://localhost'\s*\]") 'The public client must use the loopback PKCE redirect URI.'
Assert-EntraIac (-not $identityTemplate.Contains('passwordCredentials:')) 'The gateway app registrations must not create client secrets.'
Assert-EntraIac (-not $identityTemplate.Contains('keyCredentials:')) 'The public client and resource API do not require certificates in the MVP.'
Assert-EntraIac ($identityTemplate.Contains('isFallbackPublicClient: true')) 'The CLI registration must be explicitly marked as a public client.'
Assert-EntraIac ($identityTemplate.Contains('preAuthorizedApplications: [')) 'The resource API must preauthorize the first-party public client.'
Assert-EntraIac ($identityTemplate.Contains('appId: gatewayCliApplication.appId')) 'Preauthorization must target the generated public client app ID.'
Assert-EntraIac (([regex]::Matches($identityTemplate, "groupMembershipClaims: 'ApplicationGroup'")).Count -eq 1) 'Only the gateway API must request groups assigned to the application.'
Assert-EntraIac (([regex]::Matches($identityTemplate, "groupMembershipClaims: 'SecurityGroup'")).Count -eq 1) 'Only the administration API must request security-group evidence for impact preview.'
Assert-EntraIac ($identityTemplate -match "resource adminApiApplication[\s\S]*?groupMembershipClaims: 'SecurityGroup'[\s\S]*?identifierUris:\s*\[\s*adminApiIdentifierUri") 'Preview group claims must belong to the administration resource API.'
Assert-EntraIac ($identityTemplate.Contains("resource governedTeamGroupGrants 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [for groupId in governedMembershipGroupIds:")) 'Each governed group must be assigned to the gateway API.'
Assert-EntraIac ($identityTemplate -match "governedTeamGroupGrants[\s\S]*?appRoleId:\s*'00000000-0000-0000-0000-000000000000'") 'Governed groups must use the gateway API default-access assignment.'
Assert-EntraIac ($identityTemplate -match 'governedTeamGroupGrants[\s\S]*?resourceId:\s*gatewayApiServicePrincipal\.id') 'Governed groups must be assigned to the gateway API service principal, not the administration API.'
Assert-EntraIac (([regex]::Matches($identityTemplate, 'appRoleAssignmentRequired: true')).Count -eq 1) 'Only the administration API must require an app-role assignment.'
Assert-EntraIac ($template.Contains('entraClientApplicationId: identity.outputs.cliApplicationId')) 'APIM must validate the generated public client app ID.'
Assert-EntraIac ($template.Contains('entraApiAudience: identity.outputs.apiAudience')) 'APIM must validate the v2 access-token audience using the generated API app ID.'
Assert-EntraIac ($template.Contains('entraRequiredScope: identity.outputs.requiredScope')) 'APIM must validate the generated delegated scope.'
Assert-EntraIac (([regex]::Matches($identityTemplate, 'relationships:\s*\[\s*entraApplicationOwnerObjectId\s*\]')).Count -eq 4) 'Every app registration must retain the approved owner object ID.'

# --- Governance administration identity -------------------------------------
# Administration is a separate resource from inference, so an inference token can
# never be replayed against it.
Assert-EntraIac ($identityTemplate.Contains("var adminApiIdentifierUri = 'api://`${tenant().tenantId}/`${adminApiUniqueName}'")) 'The administration API must have its own identifier URI.'
Assert-EntraIac ($identityTemplate.Contains("var administerRole = 'Governance.Administer'")) 'The administration API must expose the administrator role.'
Assert-EntraIac ($identityTemplate.Contains("var readRole = 'Governance.Read'")) 'The administration API must expose the read-only role.'
Assert-EntraIac ($identityTemplate.Contains('appRoles: [')) 'Administration access must be granted through Entra application roles.'
Assert-EntraIac (([regex]::Matches($identityTemplate, "allowedMemberTypes: \[\s*'User'")).Count -eq 2) 'Both governance roles must be assignable to users and groups.'
Assert-EntraIac (([regex]::Matches($identityTemplate, "allowedMemberTypes: \[\s*'Application'")).Count -eq 1) 'The gateway must hold a machine role rather than a human one.'
Assert-EntraIac ($identityTemplate.Contains("var resolvePolicyRole = 'Policy.Resolve'")) 'Policy resolution must be a role the gateway holds, not an implicit trust.'
Assert-EntraIac ($identityTemplate.Contains('appRoleAssignmentRequired: true')) 'A caller without a governance role assignment must be refused a token by Entra.'
Assert-EntraIac ($identityTemplate.Contains("var adminAccessScopeId = guid(")) 'The administration delegated scope ID must be deterministic.'
Assert-EntraIac ($identityTemplate.Contains("var administerRoleId = guid(") -and $identityTemplate.Contains("var readRoleId = guid(")) 'Governance role IDs must be deterministic.'
Assert-EntraIac ($identityTemplate.Contains("type: 'Admin'")) 'The administration scope must require administrator consent.'
Assert-EntraIac ($identityTemplate.Contains('appId: adminSpaApplication.appId')) 'The administration API must preauthorize only its own console client.'
Assert-EntraIac ($identityTemplate -match "spa:\s*\{[\s\S]*?redirectUris:") 'The administration console must be registered as a single-page client.'
Assert-EntraIac ($identityTemplate.Contains("param adminConsoleDevelopmentOrigin string = 'http://localhost:4173'")) 'The administration SPA must retain the local console origin.'

# The assertions above (and the CLI's own isFallbackPublicClient/publicClient checks
# further up this file) are satisfied by ANY app registration in this template, so
# they cannot prove the admin console client specifically allows device-code sign-in.
# Scope to the adminSpaApplication resource's own body before asserting on it.
$adminSpaResourceMatch = [regex]::Match($identityTemplate, "resource adminSpaApplication 'Microsoft\.Graph/applications@v1\.0' = \{([\s\S]*?)\r?\n\}")
Assert-EntraIac $adminSpaResourceMatch.Success 'The adminSpaApplication resource must be present to scope assertions to it.'
$adminSpaBody = $adminSpaResourceMatch.Groups[1].Value
Assert-EntraIac ($adminSpaBody.Contains('isFallbackPublicClient: true')) 'The administration console client must allow public client flows so the bootstrap initializer can sign in by device code.'
Assert-EntraIac ($adminSpaBody -match "publicClient:\s*\{[\s\S]*?redirectUris:\s*\[\s*'http://localhost/governance-bootstrap'\s*\]") 'The initializer native redirect must use a distinct path from the local SPA; Entra ignores localhost ports.'
Assert-EntraIac ($adminSpaBody -match "spa:\s*\{[\s\S]*?redirectUris:\s*union\(") 'The administration console client must keep its SPA redirect for the browser sign-in path.'
Assert-EntraIac ($initializer.Contains("const REDIRECT_URI = 'http://localhost:4173/governance-bootstrap';")) 'The initializer redirect must match its native public-client registration.'
Assert-EntraIac ($identityTemplate.Contains('output adminApiAudience string')) 'The administration audience must be published for the API to validate.'

# --- Bootstrap administrator -------------------------------------------------
# Governance configuration is authored through the console, so a deployment with no
# administrator would stand up a system nobody is permitted to configure.
Assert-EntraIac ($identityTemplate.Contains('param governanceAdministratorPrincipalId string')) 'The deployment must name a governance administrator.'
Assert-EntraIac ($identityTemplate -notmatch 'param governanceAdministratorPrincipalId string\s*=') 'The governance administrator must be required rather than defaulted.'
Assert-EntraIac ($template -notmatch 'param governanceAdministratorPrincipalId string\s*=') 'The governance administrator must be required at the deployment entry point.'
Assert-EntraIac ($identityTemplate.Contains("resource governanceAdministratorGrant 'Microsoft.Graph/appRoleAssignedTo@v1.0'")) 'The deployment must grant the first administrator.'
Assert-EntraIac ($identityTemplate -match 'governanceAdministratorGrant[\s\S]*?appRoleId:\s*administerRoleId') 'The bootstrap grant must be the administrator role, not the read-only one.'
Assert-EntraIac ($identityTemplate -match 'governanceAdministratorGrant[\s\S]*?principalId:\s*governanceAdministratorPrincipalId') 'The bootstrap grant must go to the named principal.'
Assert-EntraIac ($template.Contains('governanceAdministratorPrincipalId: governanceAdministratorPrincipalId')) 'The administrator must be passed through from the deployment entry point.'
Assert-EntraIac ($parameters.parameters.governanceAdministratorPrincipalId.value -eq '${GOVERNANCE_ADMINISTRATOR_PRINCIPAL_ID}') 'The administrator must come from the deployment environment rather than a literal.'
Assert-EntraIac ($parameters.parameters.governanceMembershipGroupIds.value -eq '${GOVERNANCE_MEMBERSHIP_GROUP_IDS=}') 'Governed team group IDs must come from the deployment environment with no invented default.'

$topLevelOutputs = @(
    'ENTRA_API_APPLICATION_ID',
    'ENTRA_API_AUDIENCE',
    'ENTRA_API_SCOPE',
    'ENTRA_CLI_APPLICATION_ID',
    'ENTRA_REQUIRED_SCOPE',
    'ENTRA_TENANT_ID',
    'ENTRA_ADMIN_API_AUDIENCE',
    'ENTRA_ADMIN_API_SCOPE',
    'ENTRA_ADMIN_SPA_APPLICATION_ID'
)
foreach ($outputName in $topLevelOutputs) {
    Assert-EntraIac ($template.Contains("output $outputName string")) "Missing non-secret Entra deployment output: $outputName"
}

Assert-EntraIac ($parameters.parameters.entraApplicationOwnerObjectId.value -eq '${ENTRA_APPLICATION_OWNER_OBJECT_ID}') 'The Entra owner object ID must come from the AZD environment.'
foreach ($removedParameter in @('entraTenantId', 'entraApiAudience', 'entraClientApplicationId', 'entraRequiredScope')) {
    Assert-EntraIac ($null -eq $parameters.parameters.PSObject.Properties[$removedParameter]) "Identity drift risk: obsolete manual parameter remains: $removedParameter"
}

$compiled = & bicep build $IdentityTemplatePath --stdout 2>&1
Assert-EntraIac ($LASTEXITCODE -eq 0) 'Graph and Azure Bicep compilation failed.'
Assert-EntraIac (-not ($compiled | Where-Object { $_ -match 'Warning|Error BCP' })) 'Graph and Azure Bicep compilation emitted diagnostics.'
$compiledTemplate = ($compiled -join [Environment]::NewLine) | ConvertFrom-Json
$compiledTopLevelResources = @($compiledTemplate.resources.PSObject.Properties.Value)
Assert-EntraIac (@($compiledTopLevelResources | Where-Object type -eq 'Microsoft.Graph/applications@v1.0').Count -eq 4) 'The compiled template must render four Graph applications.'
Assert-EntraIac (@($compiledTopLevelResources | Where-Object type -eq 'Microsoft.Graph/servicePrincipals@v1.0').Count -eq 4) 'The compiled template must render four Graph service principals.'

$mainCompilation = & bicep build $TemplatePath --stdout 2>&1
Assert-EntraIac ($LASTEXITCODE -eq 0) 'The composed Graph and Azure Bicep template failed to compile.'
Assert-EntraIac (-not ($mainCompilation | Where-Object { $_ -match 'Warning|Error BCP' })) 'The composed Graph and Azure Bicep template emitted diagnostics.'

[pscustomobject]@{
    GraphExtension = $configuration.extensions.microsoftGraphV1
    Applications = @($compiledTopLevelResources | Where-Object type -eq 'Microsoft.Graph/applications@v1.0').Count
    ServicePrincipals = @($compiledTopLevelResources | Where-Object type -eq 'Microsoft.Graph/servicePrincipals@v1.0').Count
    DelegatedScopes = ([regex]::Matches($identityTemplate, 'oauth2PermissionScopes: \[')).Count
    ApplicationRoles = ([regex]::Matches($identityTemplate, "allowedMemberTypes: \[")).Count
    OptionalAccessTokenClaims = ([regex]::Matches($identityTemplate, 'accessToken: \[')).Count
    ClientSecrets = ([regex]::Matches($identityTemplate, 'passwordCredentials:')).Count
    Result = 'Pass'
} | Format-List