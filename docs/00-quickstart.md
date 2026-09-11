# PoC Quickstart

This guide takes an Azure customer development team from a clean clone to one governed coding-agent request. It uses Azure services for the hosted path and keeps the first evaluation to one existing Foundry deployment, one new APIM instance, one development-team Entra group, one separate administrator principal, and one logical model name.

Use the [deployment reference](01-deployment.md) if you need to create Foundry, configure private administration ingress, or investigate a failed deployment.

## What This Evaluation Proves

At the end of this guide:

- an allowed OpenAI-compatible request reaches a Foundry model through APIM;
- an unapproved model is refused by gateway policy;
- the caller authenticates with Entra rather than a provider key or APIM subscription key;
- the console shows the active governance revision and usage without message bodies; and
- the deployment can be removed with an environment-scoped cleanup plan.

Only requests sent to the APIM `/v1` endpoint are governed. Direct Foundry account or project traffic remains a separate path.

## Cost and security checkpoint

The evaluation creates billable Azure resources. Basic v2 API Management has a fixed hourly charge; model inference, Flex Consumption, Cosmos DB, Storage, Key Vault, private endpoints, and Log Analytics add usage-dependent charges. Check the Azure pricing calculator for your region and model, and remove the environment when the evaluation is complete.

The default `public-authenticated` posture exposes APIM and the administration surface publicly but requires Microsoft Entra authentication. Durable stores and the principal-key store are private-networked. Do not grant governed callers direct inference access to the Foundry account if the gateway must be the only route. Never paste provider keys or webhook URLs into source control.

## Before You Start

Install Node.js 24 or later, PowerShell 7, Azure CLI, and Azure Developer CLI. Docker is optional for the fast check and required for the full persistence integration check.

The deployment operator needs these capabilities. Organizations may assign them through different built-in or custom roles.

| Task | Azure Permission | Microsoft Entra Permission |
|---|---|---|
| Deploy the PoC | Create resources and assign Azure roles in the target resource groups and Foundry account scope | Create and manage application registrations and service principals; assign the Administration API role |
| Prepare one governed team | None beyond the deployment | Read the group object ID and manage membership in the selected group |
| Publish initial governance | None after deployment | Sign in through the deployed administration client as a member of the configured administrator principal |
| Show the optional Users and Groups roster | None beyond the deployment | A Privileged Role Administrator grants the control-plane identity `GroupMember.Read.All` |

The roster permission is optional. It is not needed for inference policy, token limits, usage, or the other console screens.

## Install And Check The Repository

```powershell
git clone <repository-url>
Set-Location llm-governance-apim
node --version
npm ci
npm test
```

`npm test` is the fast, cross-platform unit gate. To include the Cosmos DB emulator and external OpenAPI lint in the public local gate, start a scriptable Docker runtime and run:

```powershell
pwsh -NoProfile -File tests/Test-Local.ps1 -PublicOnly `
  -IncludePersistenceIntegration `
  -IncludeExternalOpenApiLint
```

The full check accepts native `docker.exe` or Docker inside WSL. It creates only a temporary local emulator container and does not deploy Azure resources.

The OpenAPI lint step is cache-only: it resolves the pinned Redocly CLI offline and never reaches a registry while the gate runs, so a clean machine fails until the package is already cached. Fetch it once, separately, from the registry your organization approves before you use `-IncludeExternalOpenApiLint`:

```powershell
$registry = (npm config get registry).Trim()
npx --yes --registry $registry @redocly/cli@2.39.0 --version
```


## Sign In And Choose The Shortest Mode

This quickstart reuses an existing Foundry account, project, and model deployment, then creates a new APIM instance and the supporting governance resources. Use this path when your organization already has a model it can test.

```powershell
az login --tenant <tenant-id>
az account set --subscription <subscription-id>
azd auth login --tenant-id <tenant-id>
```

Confirm the model deployment and subscription quota before continuing:

```powershell
az cognitiveservices account deployment list `
  --name <foundry-account> `
  --resource-group <foundry-resource-group> `
  --output table

az cognitiveservices usage list --location <region> --output table
```

If no suitable Foundry deployment exists, stop here and use the create-everything mode in the [deployment reference](01-deployment.md#choose-a-deployment-mode).

## Configure One Evaluation Environment

Create an Entra security group for the development team before running these commands. The person who will send the test request must be a member. Use a separate group or user as the governance administrator. The environment name is reused by the key-store bootstrap, which accepts only lowercase letters, digits, and hyphens, up to 20 characters.

```powershell
$environment = '<environment>'

azd env new $environment
azd env select $environment

azd env set AZURE_LOCATION <region> --environment $environment
azd env set AZURE_SUBSCRIPTION_ID <subscription-id> --environment $environment
azd env set GATEWAY_RESOURCE_GROUP_NAME <new-gateway-resource-group> --environment $environment
azd env set ENTRA_APPLICATION_OWNER_OBJECT_ID <operator-object-id> --environment $environment
azd env set GOVERNANCE_ADMINISTRATOR_PRINCIPAL_ID <administrator-user-or-group-object-id> --environment $environment
azd env set FOUNDRY_RESOURCE_GROUP_NAME <foundry-resource-group> --environment $environment
azd env set FOUNDRY_ACCOUNT_NAME <foundry-account> --environment $environment
azd env set FOUNDRY_PROJECT_NAME <foundry-project> --environment $environment
azd env set FOUNDRY_DEFAULT_MODEL_DEPLOYMENT <foundry-deployment> --environment $environment
azd env set GATEWAY_LOGICAL_MODEL_ALIAS coding-primary --environment $environment
azd env set GOVERNANCE_SCOPE_GROUP_ID organization --environment $environment
azd env set GOVERNANCE_KNOWN_TEAM_KEYS engineering --environment $environment
azd env set GOVERNANCE_MEMBERSHIP_GROUP_IDS <engineering-group-object-id> --environment $environment

azd env set CREATE_FOUNDRY false --environment $environment
azd env set DEPLOY_GATEWAY true --environment $environment
```

These names are customer-owned values. Do not copy identifiers from another deployment. The Foundry deployment name is the existing backend resource; `coding-primary` is the logical name coding agents send to this gateway.

## Preview And Deploy

Initialize the stable principal-key store first. Preview it before creating it:

```powershell
pwsh -NoProfile -File tools/distribution/Initialize-PrincipalKeyStore.ps1 `
  -EnvironmentName $environment `
  -Preview

pwsh -NoProfile -File tools/distribution/Initialize-PrincipalKeyStore.ps1 `
  -EnvironmentName $environment
```

Preview the full Azure change and review its target resource groups, creates, modifications, and deletions:

```powershell
azd provision --preview --no-state --environment $environment --no-prompt
```

Provision only after the preview matches the selected environment:

```powershell
azd provision --no-state --environment $environment --no-prompt
```

**Before deploying application code, decide whether to enable the Users and Groups roster.** `GroupMember.Read.All` is **not granted automatically** by the templates or deployment hooks. For the roster, have a Privileged Role Administrator (or Global Administrator) perform the [directory permission grant and readback](01-deployment.md#entra-directory-reading-for-users-and-groups) now, against this environment's control-plane managed identity. The permission is tenant-wide even though the product queries only configured team groups. If you do not approve it, skip the grant; the roster remains unavailable, but gateway policy enforcement does not require it.

**Allow for several hours of permission propagation if this identity already requested a Graph token.** Azure's managed-identity token cache is around **24 hours** per resource URI, not a guaranteed completion deadline. Restarting or redeploying the Function cannot force that cache to refresh. On a fresh environment, granting and verifying the permission between provisioning and the first code deployment reduces this risk; immediate availability is still not guaranteed.

After the root provision succeeds and the chosen permission step is complete, deploy both services:

```powershell
azd deploy --all --environment $environment --no-prompt
```

Wait for the root provision and both application deployments to report success. Do not bootstrap callers from outputs produced while the root deployment is still running.

Read the final outputs and keep these values available for the next steps:

- `API_URL`: the governed `/v1` base URL;
- `ENTRA_API_SCOPE`: the qualified delegated scope used by the bridge;
- `ENTRA_TENANT_ID` and `ENTRA_CLI_APPLICATION_ID`: the tenant and approved public client used for caller sign-in; and
- `ADMIN_INTERFACE_ENDPOINT`: the console URL.

If the output has no `API_URL`, the selected mode did not deploy a gateway. If the root provision succeeded but the application deployment failed, fix that deployment before publishing governance.

For first-install failures, use the [installation troubleshooting procedures](01-deployment.md#troubleshooting), including `AADSTS9002326`, preview group-claim failures, directory permission delays, and incomplete what-if coverage. For rejected ownership inputs, follow [ownership evidence recovery](03-operations.md#first-install-ownership-evidence-failures). Preserve the failed evidence; do not recreate app registrations or broaden permissions simply to make a check pass.

## Publish Minimal Governance

Create `initial-governance.json`. Replace the tenant, group, and Foundry deployment placeholders with the same values used above.

```json
{
  "tenantId": "<tenant-id>",
  "scopeGroupId": "organization",
  "organization": {
    "models": ["coding-primary"],
    "limits": {
      "requestsPerMinute": 60,
      "tokensPerMinute": 300000,
      "tokenQuota": 5000000,
      "quotaPeriod": "Monthly"
    }
  },
  "teams": [
    {
      "teamKey": "engineering",
      "membershipGroupId": "<engineering-group-object-id>",
      "models": ["coding-primary"],
      "limits": {
        "requestsPerMinute": 30,
        "tokensPerMinute": 300000
      }
    }
  ],
  "models": [
    {
      "deploymentName": "<foundry-deployment>",
      "modelKey": "coding-primary"
    }
  ],
  "budgets": [],
  "fallback": null
}
```

The numbers are evaluation settings, not production defaults. Coding agents resend context and tool schemas, so size the real policy from observed agent traffic.

Validate the input without the administrator sign-in or publication. This step still reads the Foundry account and its provider quota through your existing `az login` session:

```powershell
node tools/distribution/Initialize-Governance.mjs `
  --environment $environment `
  --input .\initial-governance.json `
  --dry-run
```

Then publish it:

```powershell
node tools/distribution/Initialize-Governance.mjs `
  --environment $environment `
  --input .\initial-governance.json
```

Open the verification address and enter the device code with an account that has `Governance.Administer`. Success is `outcome: "active"` with exactly five targets marked `verified`.

## Start The Authentication Bridge

Read only the outputs needed by the caller:

```powershell
$apiUrl = azd env get-value API_URL --environment $environment
$tenantId = azd env get-value ENTRA_TENANT_ID --environment $environment
$scope = azd env get-value ENTRA_API_SCOPE --environment $environment
$clientId = azd env get-value ENTRA_CLI_APPLICATION_ID --environment $environment
$gatewayOrigin = ([uri]$apiUrl).GetLeftPart([System.UriPartial]::Authority)
```

In a second terminal, start the existing loopback bridge:

```powershell
node tools/agent-auth-bridge/agent-auth-bridge.mjs `
  --port 8788 `
  --upstream $gatewayOrigin `
  --scope $scope `
  --tenant $tenantId `
  --client $clientId
```

Complete its device-code sign-in with the development-team member assigned to the `engineering` group. The bridge holds the refresh token in memory, replaces incoming credentials, retries once after `401`, and does not retry `403`.

## Send One Allowed And One Denied Request

From the first terminal, send the allowed logical model:

```powershell
$allowedBody = @{
  model = 'coding-primary'
  input = 'Reply with quickstart ok only.'
  max_output_tokens = 16
} | ConvertTo-Json -Compress

$allowed = Invoke-WebRequest `
  -Method Post `
  -Uri 'http://127.0.0.1:8788/v1/responses' `
  -ContentType 'application/json' `
  -Body $allowedBody `
  -SkipHttpErrorCheck

$allowed.StatusCode
$allowed.Headers['x-requested-model']
$allowed.Headers['x-effective-model']
```

Expect `200` and `coding-primary` as the requested model. The effective model header identifies the Foundry deployment selected by governance.

Now request a model the policy does not allow:

```powershell
$deniedBody = @{
  model = 'not-allowed'
  input = 'This request should not reach a model.'
  max_output_tokens = 16
} | ConvertTo-Json -Compress

$denied = Invoke-WebRequest `
  -Method Post `
  -Uri 'http://127.0.0.1:8788/v1/responses' `
  -ContentType 'application/json' `
  -Body $deniedBody `
  -SkipHttpErrorCheck

$denied.StatusCode
$denied.Content
```

Expect `403` with code `model_not_allowed`. Do not retry it; a new token cannot grant a model that policy denies.

If the allowed request returns `503 governance_unavailable`, check that the initializer reported `outcome: "active"` and that the APIM `governance-policy-enabled` output is `true`. A `401` indicates a missing, expired, or malformed token; a body-free `403` from an administration route indicates App Service authentication configuration rather than an inference policy refusal.

## Check The Console

Open the `ADMIN_INTERFACE_ENDPOINT` output and sign in as a governance administrator. Confirm:

- Publishing shows one active revision.
- Models shows `coding-primary` mapped to the selected Foundry deployment.
- Users and Groups shows the `engineering` team after the optional directory reading is configured; policy enforcement itself does not require that roster view.
- Usage shows the allowed request after telemetry ingestion and contains token counts, not prompt or completion text.
- Change History shows the initial publication.

Continue with [Using The Administration Console](02-administration.md) and the policy checks in [Operating And Removing An Evaluation Environment](03-operations.md) before adding more callers or limits.

## Remove The Evaluation

Preview removal first:

```powershell
pwsh -NoProfile -File tools/distribution/Remove-Deployment.ps1 `
  -ManifestPath <ownership-manifest.json> `
  -StatePath <ownership-state.json> `
  -ReadbackPath <fresh-exact-id-readback.json> `
  -Preview `
  -OutputPath <removal-preview.json>
```

This command is local-only. It validates a manifest-bound preview and never calls Azure, Microsoft Graph, or `azd`; it does not delete or purge anything. Each separately approved phase requires its matching `-ApproveResourceDelete`, `-ApproveEntraCleanup`, `-ApproveEntraPurge`, `-ApproveApimPurge`, or `-ApproveKeyVaultPurge` switch, an exact `-ApprovalPath`, and the same manifest, state, readback, and output pattern. A separately approved operator workflow must execute the actual exact-owned deletions or purges using fresh receipts; do not fabricate receipts or treat this validator as an executor.

This repository ships no command that produces those three inputs and no command that performs a deletion. The sealed manifest, the retained ownership state, and the exact-ID readback are your own records of what this environment created. [`tools/deployment/ownership-contract.mjs`](../tools/deployment/ownership-contract.mjs) is the contract they must satisfy, and [`tests/infra/fixtures/ownership-contract-fixture.mjs`](../tests/infra/fixtures/ownership-contract-fixture.mjs) shows the shape of each document.

To stop the evaluation charges, an approved operator deletes only what this environment exclusively owns, through your organization's normal change process and against the exact resource IDs in the readback: the dedicated gateway resource group you named in `GATEWAY_RESOURCE_GROUP_NAME`, and, as separately owned directory objects, the Entra application registrations and service principals this deployment created. Delete the resource group only while it holds nothing you did not create here. Never run a blanket subscription or tenant sweep, and never delete by name pattern alone.

Reuse mode leaves the referenced Foundry resource group, account, project, and model deployment intact, and a pre-existing Entra group is never a removal target. Review each phase separately and preserve the exact ownership boundary.
