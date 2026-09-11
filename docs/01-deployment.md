# Deploying The Gateway

This is the complete deployment reference for development and platform teams operating coding-agent LLM backends on Azure. It covers an empty subscription and organizations that already run Microsoft Foundry models.

For the shortest path, use the [PoC Quickstart](00-quickstart.md). It reuses an existing Foundry deployment, creates a new APIM service, and ends with one allowed request and one policy refusal. Return here for other deployment modes, detailed validation, recovery, and removal.

Connecting a coding agent is a separate workflow. See [Connecting A Coding Agent](04-connection.md). This guide stops when the gateway, administration surface, initial governance, and caller-specific resolution are ready. Once it is running, [Using The Administration Console](02-administration.md) covers the day-to-day screens.

## Architecture Boundary

A governed request goes to API Management deliberately:

```text
client -> API Management /v1 -> Foundry account /openai/v1
          caller Entra token     API Management managed identity
```

API Management validates the caller, applies the route and model allowlists and request and token limits, records body-free telemetry, and calls the Foundry **account** endpoint at `https://<foundry-account>.cognitiveservices.azure.com/openai/v1`. Do not configure the repository API to use a Foundry project endpoint as its backend.

The `/v1` segment is the OpenAI-compatible data-plane contract, not the API Management service tier. The upstream routes implemented here define these operations under `/openai/v1` and do not define `/openai/v2` variants.

The deployment also creates a control plane, governance store, administration console, log workspace, network, and the Microsoft Entra applications used by the gateway and console.

Two boundaries matter:

- **Only traffic reaching API Management is governed.** A caller that retains inference data actions on the Foundry account can bypass this gateway. Remove those direct roles from governed caller identities when bypass must be prevented.
- **Foundry portal association and project enrollment are separate lifecycle actions.** This template performs neither and makes no promotional-allowance claim.

## Cost And Security Checklist

### Cost

The reference topology creates or uses several separately metered services: Basic v2 API Management, Microsoft Foundry model inference, Flex Consumption, serverless Cosmos DB, Storage, Key Vault, private endpoints, and Log Analytics. Charges vary with region, model, capacity, requests, token volume, retention, and whether a secondary Foundry account is configured. A second account can share load but does not add subscription quota. Use the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/) with the actual region and model, set Azure cost alerts outside this repository, and remove an evaluation environment when it is no longer needed.

Gateway token metrics, quotas, budgets, and fallback are operational controls; they are not an invoice or a guarantee of monetary cost. Provider-side billing remains authoritative, and in-flight requests can exceed a best-effort budget.

### Security

- The default `public-authenticated` administration posture and Basic v2 APIM ingress are public endpoints protected by Microsoft Entra authentication. `private-only` administration is provisioned by the templates but has not been validated end to end; publishing then requires a deployment agent with network access to the private endpoint.
- Durable governance storage and the principal-key store use private networking. The principal-key bootstrap creates a closed, RBAC-authorized Key Vault and keeps the generated value out of project files and azd environment state.
- Created Foundry and Cosmos resources disable local/key-based authentication where configured by the templates. The APIM managed identity invokes the Foundry account endpoint.
- The gateway does not make direct Foundry access disappear. Remove direct inference roles from governed identities, and control network reachability, when bypass prevention is required.
- Governance evidence is body-free by default, but request bodies can still exist in provider or platform diagnostics configured outside this repository. Review diagnostic settings and retention before a production deployment.
- Retention is customer-owned. The default governance and rollup containers do not set a TTL, and this PoC does not choose approved retention periods or a deletion-request process for usage, rollups, configuration history, directory readings, or notifications. Define and test those controls before onboarding developers.
- Slack and Teams webhook URLs are credentials. The console stores them without displaying them again; rotate them in the source system if exposed.

## Prerequisites

Install:

- Azure Developer CLI (`azd`)
- Azure CLI (`az`)
- PowerShell 7 (`pwsh`)
- Node.js 24 or later
- Docker, when running the persistence integration check

Install and run the fast local gate before configuring Azure:

```powershell
npm ci
npm test
```

The complete public local gate uses a scriptable Docker runtime for the Cosmos DB emulator:

```powershell
pwsh -NoProfile -File tests/Test-Local.ps1 -PublicOnly `
  -IncludePersistenceIntegration `
  -IncludeExternalOpenApiLint
```

Before installing dependencies or creating a deployment preview, configure the
customer's supply-chain policy:

- Explicitly configure the package registry origins and scopes approved by your
  organization. Do not infer trust from an arbitrary registry.
- Require package integrity to satisfy the configured registry and
  package-manager policy. Reject missing or mismatched integrity.
- Fail closed, or leave validation incomplete, when no approved registry policy
  is available.
- Keep registry governance, license review, SBOM review, artifact signing, and
  release approval in the customer's controlled release process.

Repository-local checks do not grant release approval.

You also need:

- an Azure subscription where you can create resource groups and role assignments;
- permission to create Entra applications, service principals, and app-role assignments;
- permission to assign the gateway managed identity on the Foundry account; and
- a model, version, SKU, and regional quota that accept a new deployment.

Azure and Entra permissions are separate. Assign capabilities through the built-in or custom roles approved by your organization.

| Work | Azure Capability | Entra Capability |
|---|---|---|
| Provision resources | Create resources and role assignments in the target resource groups and Foundry account scope | Create and manage application registrations and service principals |
| Assign a governance administrator | No additional Azure capability | Assign the Administration API role to the selected user or group |
| Prepare a governed team | No additional Azure capability | Read the selected group object ID and manage its membership |
| Enable the optional directory roster | No additional Azure capability | A Privileged Role Administrator grants `GroupMember.Read.All` to the control-plane identity |

Sign in to the intended tenant and subscription:

```powershell
az login --tenant <tenant-id>
az account set --subscription <subscription-id>
azd auth login --tenant-id <tenant-id>
```

For a new Foundry hierarchy, confirm the exact model version and available subscription capacity. A model can continue serving existing deployments while refusing new ones. Model name, version, and format must therefore be reviewed together.

```powershell
az cognitiveservices model list --location <region> --output table
az cognitiveservices usage list --location <region> --output table
```

Quota is subscription-scoped. Creating another Foundry account does not add quota.

For an existing Foundry hierarchy, confirm the deployment to reference:

```powershell
az cognitiveservices account deployment list `
  --name <foundry-account> `
  --resource-group <foundry-resource-group> `
  --output table
```

## Choose A Deployment Mode

| Mode | Use It When | Evaluation Status | `CREATE_FOUNDRY` | `DEPLOY_GATEWAY` |
|---|---|---|---:|---:|
| Reuse Foundry, new gateway | You already have a testable Foundry deployment and want the shortest governed-path evaluation | Recommended | `false` | `true` |
| Create everything | You need an isolated Foundry hierarchy and API Management service | Supported | `true` | `true` |
| Control plane only | You want to inspect the policy model and console without testing inference governance | Limited: no `/v1` inference endpoint | either | `false` |

API Management is the component with a fixed hourly charge. `DEPLOY_GATEWAY=false` does not create it, but also produces no `/v1` inference endpoint.

When Foundry is referenced, removal leaves its resource group untouched. This public PoC always creates its API Management service; it does not modify an existing service.

## Configure An Environment

Create and select a named environment:

```powershell
azd env new <environment>
azd env select <environment>
```

Use `azd env set`; do not edit azd's generated environment state directly.

Values required in every mode:

```powershell
azd env set AZURE_LOCATION <region> --environment <environment>
azd env set AZURE_SUBSCRIPTION_ID <subscription-id> --environment <environment>
azd env set GATEWAY_RESOURCE_GROUP_NAME <gateway-resource-group> --environment <environment>
azd env set ENTRA_APPLICATION_OWNER_OBJECT_ID <owner-object-id> --environment <environment>
azd env set GOVERNANCE_ADMINISTRATOR_PRINCIPAL_ID <administrator-group-object-id> --environment <environment>
azd env set FOUNDRY_RESOURCE_GROUP_NAME <foundry-resource-group> --environment <environment>
azd env set FOUNDRY_ACCOUNT_NAME <foundry-account> --environment <environment>
azd env set FOUNDRY_PROJECT_NAME <foundry-project> --environment <environment>
azd env set FOUNDRY_DEFAULT_MODEL_DEPLOYMENT <model-deployment> --environment <environment>
azd env set GATEWAY_LOGICAL_MODEL_ALIAS <client-model-name> --environment <environment>
azd env set GOVERNANCE_SCOPE_GROUP_ID <organization-key> --environment <environment>
azd env set GOVERNANCE_KNOWN_TEAM_KEYS <sorted-comma-separated-team-keys> --environment <environment>
azd env set GOVERNANCE_MEMBERSHIP_GROUP_IDS <sorted-comma-separated-entra-group-object-ids> --environment <environment>
```

`GOVERNANCE_ADMINISTRATOR_PRINCIPAL_ID` accepts a user or group object ID. Use a group so administrator membership can change without redeploying. The Administration API requires assignment; an unassigned account can be refused before a token is issued.

The Foundry names above are created when `CREATE_FOUNDRY=true` and referenced when it is `false`.

`GOVERNANCE_SCOPE_GROUP_ID` is the durable partition for this deployment. Changing it later does not rename governance; it points every read and write at another partition. `GOVERNANCE_KNOWN_TEAM_KEYS` must be sorted, unique, and match the teams in the initial governance input. `GOVERNANCE_MEMBERSHIP_GROUP_IDS` is the set of Entra groups assigned to the gateway API; it must match the input's `membershipGroupId` set. The group-to-team meaning remains in governance content rather than being duplicated in infrastructure.

Set one mode:

```powershell
# Create everything
azd env set CREATE_FOUNDRY true --environment <environment>
azd env set DEPLOY_GATEWAY true --environment <environment>

# Reuse Foundry and create API Management
azd env set CREATE_FOUNDRY false --environment <environment>
azd env set DEPLOY_GATEWAY true --environment <environment>

# Control plane only
azd env set DEPLOY_GATEWAY false --environment <environment>
```

When creating Foundry, pin the model details you validated:

```powershell
azd env set FOUNDRY_MODEL_NAME <model-name> --environment <environment>
azd env set FOUNDRY_MODEL_VERSION <model-version> --environment <environment>
azd env set FOUNDRY_MODEL_FORMAT <model-format> --environment <environment>
azd env set FOUNDRY_MODEL_SKU <sku> --environment <environment>
azd env set FOUNDRY_MODEL_CAPACITY <capacity> --environment <environment>
```

Optional settings:

| Variable | Default | Effect |
|---|---|---|
| `APIM_SKU` | `BasicV2` | `Developer` is an explicit non-production evaluation option; the default remains unchanged |
| `FOUNDRY_SECOND_MODEL_DEPLOYMENTS` | `[]` | At most one additional model in the same newly created Foundry account; see below |
| `GOVERNANCE_ADMINISTRATION_INGRESS` | `public-authenticated` | Console and control-plane ingress posture |
| `CONTROL_PLANE_ALWAYS_READY_INSTANCES` | `1` | Instances held ready for the control-plane request path |
| `CONTROL_PLANE_MAXIMUM_INSTANCE_COUNT` | `28` | Maximum for each FC1 scale group; deployment input validation enforces the supported range |
| `CONTROL_PLANE_INSTANCE_MEMORY_MB` | `2048` | FC1 memory size used by the deployment |
| `ENTRA_DEVELOPER_CLIENT_APPLICATION_ID` | nil GUID | Additional approved public client; the default admits none |
| `SECONDARY_FOUNDRY_ACCOUNT_NAME` | empty | Optional second backend account; it adds no quota |
| `POOLED_MODEL_DEPLOYMENTS` | empty | Comma-separated deployment names shared by pool members |
| `NOTIFICATION_WEBHOOK_SECRET_NAME` | empty | Non-secret name of a Key Vault secret containing a deployment-owned generic webhook fallback |
| `ROLLUP_STARTED_FROM` | empty | Exact UTC hourly boundary used only when each durable schedule first writes its checkpoint |
| `TEARDOWN_PROTECTED_RESOURCE_GROUPS` | unset | Comma-separated groups the removal tool must refuse to target |

Keep the defaults for an evaluation unless capacity planning and the target
subscription's quota support another accepted value. Input validation checks the
supported configuration range, but it does not establish regional capacity or
authorize provisioning. Confirm current quota before deployment.

Review the API Management publisher organization and contact in `infra/main.parameters.json`; those values are literals rather than environment keys.

### Lower-Cost Evaluation And A Second Model

For a non-production evaluation, explicitly select `APIM_SKU=Developer`. Developer has no production SLA; this option does not establish live policy compatibility or change the default `BasicV2` tier. Review all other metered resources as well, approve the resource lifetime and cleanup scope, and stop on a deployment refusal rather than automatically upgrading the SKU.

`FOUNDRY_SECOND_MODEL_DEPLOYMENTS` accepts a JSON array containing at most one complete object. It defaults to `[]`, preserving the existing single-model deployment. A nonempty array requires `CREATE_FOUNDRY=true`; it does not modify a reused account. This is distinct from `SECONDARY_FOUNDRY_ACCOUNT_NAME`, which configures another backend account.

```powershell
azd env set APIM_SKU Developer --environment <environment>

$secondModels = @(@{
  deploymentName = 'additional-model'
  modelName = '<model-name>'
  modelVersion = '<model-version>'
  modelFormat = '<model-format>'
  skuName = '<model-sku>'
  capacity = 10
})
azd env set FOUNDRY_SECOND_MODEL_DEPLOYMENTS `
  (ConvertTo-Json -InputObject $secondModels -Compress) --environment <environment>
```

Replace every model placeholder and validate the requested capacity against the exact region/model/version/SKU before deployment; `10` is an example, not a capacity guarantee. All six fields are required, capacity must be a positive integer, and unknown fields are rejected. Use a deployment name different from `FOUNDRY_DEFAULT_MODEL_DEPLOYMENT`.

Creating another model does not grant callers access to it. Refresh the provider catalogue and publish explicit logical-model mappings and governance grants. Confirm each model's API and token-parameter compatibility independently; two deployments do not imply compatible fallback. Local template tests are not Azure end-to-end evidence or a hard spending cap.

Do not set `PRINCIPAL_KEY_MODE`, `PRINCIPAL_KEY_STORE_NAME`, or `PRINCIPAL_KEY_SECRET_NAME` by hand for a new deployment. The principal-key bootstrap command sets those non-secret values only after it has created and read back the stable closed vault. `PRINCIPAL_DERIVATION_SECRET` is retained only for upgrades from the earlier direct secure-parameter workflow.

### Optional Fixed Webhook And Initial Rollup Backfill

The console channel remains the usual Slack or Teams configuration. A fixed
fallback is for a deployment-owned **generic** webhook only. It is consulted
only when no console channel is stored, and the stored Slack or Teams channel
always takes precedence.

After the principal-key bootstrap has created the vault, choose a non-secret
secret name and store only that name in azd:

```powershell
azd env set NOTIFICATION_WEBHOOK_SECRET_NAME notification-webhook-endpoint `
  --environment <environment>
```

Using a portal or another approved secret-management workflow, create that
secret in the bootstrapped principal-key vault and paste the webhook URL as its
value. The operator needs permission to create a Key Vault secret and network
access to the vault. Do not put the URL in `azd env`, deployment parameters,
shell history, project files, outputs, or logs. The Function App receives only
a Key Vault reference and its managed identity already has the vault read role.
Before relying on delivery, use the portal's Function App **Configuration**
page to confirm the reference is resolved without displaying its value.

The fixed endpoint must be an external fully qualified `https` host, without
userinfo or a literal IP address. Invalid values stop Function startup instead
of waiting for a due notification. This fallback posts the generic JSON
notification payload: `notificationCode`, `kind`, `severity`, `scopeKind`,
`scopeCode`, `periodStart`, `raisedAt`, `reasonCode`, and `attemptNumber`.
It does **not** send Slack or Teams' `{"text": ...}` body, so do not use a
Slack incoming webhook or Teams Workflows trigger as this fixed fallback.

To seed the first durable schedule checkpoint from an earlier window, set an
ISO-8601 instant on an exact UTC hour before the schedule first runs:

```powershell
azd env set ROLLUP_STARTED_FROM 2026-08-10T00:00:00.000Z `
  --environment <environment>
```

Preprovision validation rejects an invalid or unaligned value. The initial
backfill runs in bounded batches of at most 48 hourly windows. Once a durable
checkpoint exists, it takes precedence over this setting; changing the setting
does not reset a schedule or replay history after a restart.

### Administration Ingress

`GOVERNANCE_ADMINISTRATION_INGRESS` controls the console and control plane together:

- `public-authenticated` exposes both publicly and requires Entra authentication. This is the default mode.
- `private-only` disables public access and provisions private endpoints and DNS. Validate this mode in the target environment before use. Publishing the private Function package requires a deployment agent with network access to it.

Durable storage is private-networked in both modes. Basic v2 API Management ingress is public in the topology described by this guide.

## Preflight And Deploy

Run local validation first:

```powershell
pwsh -NoProfile -File tests/Test-Local.ps1 -PublicOnly `
  -IncludePersistenceIntegration `
  -IncludeExternalOpenApiLint
```

Preview and initialize the stable principal key store before the main deployment:

```powershell
pwsh -NoProfile -File tools/distribution/Initialize-PrincipalKeyStore.ps1 `
  -EnvironmentName <environment> `
  -Preview

pwsh -NoProfile -File tools/distribution/Initialize-PrincipalKeyStore.ps1 `
  -EnvironmentName <environment>
```

The command generates 48 random bytes in memory and passes them as an ARM secure parameter. ARM creates the gateway resource group, a dedicated RBAC Key Vault with public access disabled and default-deny networking, and `principal-key-secret`. The plaintext is never printed, written to the azd environment, or retained in a project file. A rerun reuses the completed deterministic deployment instead of creating a new secret version. The command stores only the non-secret vault and secret names in azd.

An environment named `verification` uses the stricter create-only ownership check. For both bootstrap commands, supply `-OwnershipPreflightPath <preflight.json>` and `-OwnershipPlanPath <approved-plan.md>`. When `CREATE_ONLY_OWNERSHIP_VALIDATION=true` is enabled for deployment-input validation, also supply `OWNERSHIP_PLAN_FILE`, `OWNERSHIP_PREFLIGHT_FILE`, `OWNERSHIP_MANIFEST_FILE`, `OWNERSHIP_STATE_FILE`, and `OWNERSHIP_READBACK_FILE`. These paths refer to your own reviewed plan and matching ownership evidence; the repository does not supply them or infer approval from their presence. Missing or inconsistent evidence stops validation.

The guarded fresh-Foundry mode requires the new account, project and declared model deployments to belong to the same verification resource group. Bind the selected mode and model names into the preflight, then record actual creation receipts and matching readback as resources are created. A proposed resource is not proof of creation. Reused Foundry resources remain external references and must not become removal targets; never rename the environment to bypass a failed ownership check.

For fresh Foundry, set `OWNERSHIP_VALIDATION_STAGE=bootstrap` and use a matching stage-bound preflight before initializing the key store. Before the main deployment, provide the actual RG/Key Vault bootstrap manifest, state and readback: the bootstrap stage does not require Foundry resources that have not been created yet. After the main deployment, use matching `postprovision` stage evidence to validate the complete declared Foundry hierarchy. The default stage is `postprovision`; neither stage authorizes deletion or replaces the separate removal evidence.

Preview the Azure change:

```powershell
azd provision --preview --no-state --environment <environment> --no-prompt
```

Review the target resource groups, mode, creates, modifications, and deletions. Preview output is not a complete inventory of every nested resource, so a shallow summary is not evidence that no nested change exists.

Provision only after reviewing the preview:

```powershell
azd provision --no-state --environment <environment> --no-prompt
```

Wait until the **root provision command reports final success**. Outputs read while the root deployment is still running can belong to an earlier deployment.

**Directory roster checkpoint, before the first code deployment:** the templates and hooks do not grant `GroupMember.Read.All`. If the customer wants Users and Groups membership listings, a Privileged Role Administrator (or Global Administrator) must perform the [grant and readback below](#entra-directory-reading-for-users-and-groups) now. Otherwise explicitly skip the roster; it remains unavailable without this optional tenant-wide permission. An identity that has already requested a Graph token may need **several hours** for a later grant to take effect: the Azure-side cache is around **24 hours**, cannot be forcibly refreshed by restarting or redeploying the Function, and is not a guaranteed propagation deadline.

Read the final outputs, then deploy both services:

```powershell
azd env get-values --environment <environment>
azd deploy --all --environment <environment> --no-prompt
```

The main deployment attaches the Function identity and private endpoint to the existing principal key store and enables caller-specific resolution. Until initial governance is published, inference fails closed with `503 governance_unavailable`; do not onboard a caller before the bootstrap below reports an active revision.

If provisioning fails inside nested deployments, find the first failing resource that is not itself a deployment before editing anything. A field named in an error does not identify which resource rejected it.

## Verify The Deployment

Output, health, and resource readback commands in this section are read-only. Recovery commands are labeled separately and change live resources.

Inspect outputs:

```powershell
azd env get-values --environment <environment>
```

Important outputs:

| Output | Expected meaning |
|---|---|
| `API_URL` | Governed `/v1` base URL; empty when no gateway was deployed |
| `APIM_NAME` | Created service; empty in control-plane-only mode |
| `GATEWAY_DEPLOYED` | Whether an inference gateway exists |
| `APIM_OWNERSHIP` | `created` or `none` |
| `FOUNDRY_OWNERSHIP` | `created` or `existing` |
| `DISTRIBUTION_MODE` | `fresh` or `existing` |
| `ENDPOINT_GOVERNANCE_MODE` | `ExplicitApim`, or `none` when no gateway was deployed |
| `BACKEND_ENDPOINT_CLASS` | `FoundryAccountOpenAIV1`, or `none` when no gateway was deployed |
| `FOUNDRY_ADMIN_ASSOCIATION` | `manual-required` |
| `FOUNDRY_PROJECT_ENROLLMENT` | `manual-required` |
| `CONTROL_PLANE_ENDPOINT` | Control-plane base URL |
| `ADMIN_INTERFACE_ENDPOINT` | Administration console URL |
| `GOVERNANCE_ADMINISTRATION_INGRESS` | Applied administration posture |
| `GOVERNANCE_SCOPE`, `GOVERNANCE_TEAMS` | Applied durable scope and selectable team keys |
| `GOVERNANCE_MEMBERSHIP_GROUPS`, `GOVERNANCE_MEMBERSHIP_SOURCE` | Applied Entra group set and derived membership mode |
| `GOVERNANCE_POLICY_RESOLUTION` | Must be `per-caller`; any other value is a failed installation |
| `ENTRA_TENANT_ID`, `ENTRA_API_AUDIENCE`, `ENTRA_REQUIRED_SCOPE` | Gateway caller contract |
| `ENTRA_ADMIN_API_AUDIENCE`, `ENTRA_ADMIN_API_SCOPE` | Separate administration contract |

Verify health:

```powershell
$controlPlane = '<control-plane-endpoint>'
Invoke-WebRequest -Uri "$controlPlane/api/healthz" -SkipHttpErrorCheck |
  Select-Object StatusCode
```

Expect `200`. The health route is intentionally excluded from authentication.

Verify anonymous administration is refused:

```powershell
Invoke-WebRequest -Uri "$controlPlane/api/v1/admin/overview" -SkipHttpErrorCheck |
  Select-Object StatusCode
```

Expect a body-free `401`.

Open `ADMIN_INTERFACE_ENDPOINT` and sign in as a member of the administrator group. If several work accounts are cached, force account selection or use a fresh browser profile. Validate the resulting token rather than trusting the account label:

- `tid` equals `ENTRA_TENANT_ID`;
- `aud` equals `ENTRA_ADMIN_API_AUDIENCE`;
- `roles` contains `Governance.Administer`; and
- `exp` is in the future.

Never print, paste into a command, or log the token.

The deployment applies the authored Easy Auth document only after Function creation. It explicitly writes a neutral principal policy and omits `allowedApplications`; this is the canonical final shape. A fresh Flex Consumption app can still materialize an empty `allowedApplications` collection on the first apply and deny valid administrator tokens before the request reaches the Function handler.

Deploying through `azd provision` repairs this automatically. A `postprovision` hook reads the Function App's live authentication settings and removes `allowedApplications` only when it is present and empty; a populated or already-absent key is left untouched, so the hook is safe to run after every provision.

If you deploy the Bicep templates without `azd` (for example with `az deployment group create` directly), run the same repair yourself once the Function App exists. This is a mutating recovery command:

```powershell
$env:AZURE_SUBSCRIPTION_ID = '<subscription-id>'
$env:GATEWAY_RESOURCE_GROUP_NAME = '<gateway-resource-group>'
$env:CONTROL_PLANE_FUNCTION_APP = '<function-app-name>'
node tools/distribution/Repair-EasyAuthClientAllowlist.mjs
```

To check without changing anything, read the site's authentication settings and confirm the client allowlist key is absent:

```powershell
az rest --method get `
  --url "https://management.azure.com/subscriptions/<subscription-id>/resourceGroups/<gateway-resource-group>/providers/Microsoft.Web/sites/<function-app-name>/config/authsettingsV2?api-version=2024-04-01" `
  --query "properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy" `
  --output json
```

The result should carry `allowedPrincipals` and no `allowedApplications` key at all. A present and empty `allowedApplications` refuses every otherwise-correct administrator token with a bodyless `403`; a present and non-empty one is a deliberate operator configuration and must not be changed.

The initializer then proves the same Overview route returns a body-free `401` without a token and `200` with the validated administrator token before it can publish. If either check fails, stop without publishing and inspect the authentication nested deployment and live `authsettingsV2` readback. If the authenticated request is a body-free `403` and that readback contains an empty `allowedApplications`, reapply the tracked canonical document as one full resource deployment. This recovery changes the live authentication resource:

```powershell
$resourceGroup = azd env get-value GATEWAY_RESOURCE_GROUP_NAME --environment <environment>
$functionApp = azd env get-value CONTROL_PLANE_FUNCTION_APP --environment <environment>
$tenant = azd env get-value ENTRA_TENANT_ID --environment <environment>
$audience = azd env get-value ENTRA_ADMIN_API_AUDIENCE --environment <environment>

az deployment group create `
  --resource-group $resourceGroup `
  --name llm-governance-auth-confirm-<environment> `
  --template-file infra/modules/control-plane-authentication.bicep `
  --parameters functionAppName=$functionApp entraTenantId=$tenant controlPlaneAudience=$audience `
  --mode Incremental
```

Use a new administrator token and repeat three samples 30 seconds apart. All three must return anonymous `401` with an empty body and authenticated `200` with a nonempty body. Read back only key presence to confirm `allowedApplications` is absent. Do **not** deploy application code after a failed root provision, restart the Function App, add a client allowlist, or manually send a partial document. A partial PUT can silently clear the issuer, client, unauthenticated action, and health exclusion.

Verify the gateway managed identity role at the exact Foundry account scope:

```powershell
$foundryScope = '/subscriptions/<subscription-id>/resourceGroups/<foundry-resource-group>/providers/Microsoft.CognitiveServices/accounts/<foundry-account>'
az role assignment list --scope $foundryScope --output table
```

Verify the API and policy version:

```powershell
az apim api list `
  --resource-group <gateway-resource-group> `
  --service-name <apim-name> `
  --output table

az apim nv show `
  --resource-group <gateway-resource-group> `
  --service-name <apim-name> `
  --named-value-id gateway-policy-version `
  --query value `
  --output tsv
```

API Management reformats policy XML on readback. Do not use byte equality as a runtime verdict; verify expected markers and execute a bounded behavior test.

## Initial Configuration

### Entra: What The Deployment Registers

Four application registrations and their service principals are created in the tenant, named for the environment. They live outside every resource group, which is why removal has its own tool.

| Application | What it is |
|---|---|
| `LLM Governance Gateway API (<environment>)` | The resource an inference token is issued for. Exposes the delegated scope `Gateway.Access`, and carries the group claim so a token names only the governed groups assigned to it. |
| `LLM Governance Gateway CLI (<environment>)` | The public client a caller signs in with to obtain that token. Preauthorized for `Gateway.Access`, so a caller sees no consent prompt. |
| `LLM Governance Administration API (<environment>)` | The resource the console and the bootstrap tool call. Exposes the delegated scope `Governance.Access` and the roles below. |
| `LLM Governance Admin Console (<environment>)` | The single-page-application client for the console. Preauthorized for `Governance.Access`. |

The Administration API declares three roles:

| Role | Held by | Grants |
|---|---|---|
| `Governance.Administer` | users and groups | Reading governance state, and changing budgets, entitlements, and configuration |
| `Governance.Read` | users and groups | Reading governance state, budgets, and usage, and changing nothing |
| `Policy.Resolve` | applications | The gateway's own identity resolving a caller's policy during admission |

Appoint an auditor by assigning `Governance.Read` to a user or group on the Administration API's service principal. Nothing else in the product grants it.

The two APIs treat assignment differently, and the difference is deliberate. The Administration API requires assignment, so an account holding neither role is refused a token before the API is reached. The gateway API does not, so any account in the tenant can obtain a gateway token; what it may then do is decided by governance content, and a caller with no entitlement is refused `principal-not-entitled`.

### Entra: One-Time Actions

The deployment assigns the administration role to the principal you configured. Add or remove administrators through that group's membership. No redeployment is needed.

The first infrastructure pass also assigns every group in `GOVERNANCE_MEMBERSHIP_GROUP_IDS` to the gateway API and configures the gateway token to carry only groups assigned to that application. The gateway maps those group IDs through the team catalogue in the governance set. A user in no governed group can still obtain a gateway token and may be admitted by an explicit subject policy. A workload may likewise be admitted by an explicit application policy. Without a matching subject, application, or governed-team policy, the gateway refuses inference as `principal-not-entitled`.

Access withdrawal is not immediate for an already-issued token. The gateway validates tokens offline, so withdrawal takes effect when the caller next obtains or refreshes a token, or when the existing token expires.

### Entra: Directory Reading For Users And Groups

The Users and Groups screen shows who belongs to each governed team. The control plane asks Microsoft Entra for that membership, and a deployment grants itself no directory permission, so on a new deployment the screen refuses with `503 reading_unavailable / directory-snapshot-absent` until an administrator grants one.

This step is optional. Entitlements, budgets, model allowlists, the gateway, and every other screen work without it. Skip it if you do not need the roster.

Granting a Microsoft Graph application permission requires a **Privileged Role Administrator** or **Global Administrator**. Cloud Application Administrator, Application Administrator, and AI Administrator can consent for other APIs but not for Microsoft Graph app roles, so if you deployed with one of those, this is the step to hand to a directory administrator. Neither the templates nor `azd` hooks perform this grant automatically; the commands below are an explicit, customer-approved directory change, not a read-only check.

The permission is `GroupMember.Read.All`, the least privileged application permission that reads group membership. It is tenant-wide because Microsoft Graph offers no per-group alternative. What narrows it is the product: it asks only about the groups the published governance set names as teams, and every request selects identifiers only, so no display name, principal name, or mail address is read or stored.

Grant it to the control plane's managed identity:

```powershell
$environment = '<environment>'
$subscription = azd env get-value AZURE_SUBSCRIPTION_ID --environment $environment
$tenant = azd env get-value ENTRA_TENANT_ID --environment $environment
$resourceGroup = azd env get-value GATEWAY_RESOURCE_GROUP_NAME --environment $environment
$functionApp = azd env get-value CONTROL_PLANE_FUNCTION_APP --environment $environment
if ((az account show --query tenantId -o tsv) -ne $tenant) {
  throw 'Sign in to the deployment tenant before granting a directory permission.'
}
$identity = az functionapp identity show --subscription $subscription -g $resourceGroup -n $functionApp --query principalId -o tsv

$token = az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv
$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }
$graph = (Invoke-RestMethod -Headers $headers -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'").value[0]
$role = $graph.appRoles | Where-Object { $_.value -eq 'GroupMember.Read.All' -and $_.allowedMemberTypes -contains 'Application' }

$body = @{ principalId = $identity; resourceId = $graph.id; appRoleId = $role.id } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Headers $headers -Body $body `
  -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$identity/appRoleAssignments"
```

Read it back:

```powershell
(Invoke-RestMethod -Headers $headers -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$identity/appRoleAssignments").value |
  Select-Object resourceDisplayName, appRoleId, createdDateTime
```

**Grant and verify this before the first application deployment on a new environment, not after the control plane starts reading the directory.** Azure caches a managed identity's tokens in its own back end, per resource URI, for **around 24 hours**, and Microsoft documents that a permission change can take **several hours** to take effect and that [a managed identity's token cannot be forced to refresh before it expires](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/managed-identity-best-practice-recommendations#limitation-of-using-managed-identities-for-authorization). This installation order reduces the risk of caching a token without the role, but neither assignment readback nor the approximate cache duration guarantees immediate access or a fixed completion time.

Readback proves that the directory assignment exists, not that every Function instance has a token carrying it. Do not repeat the POST if the exact assignment already exists. Confirm runtime readiness with a successful directory projection and a fresh Users and Groups reading after initial governance is published; a successful `azd deploy` alone does not prove roster readiness.

If you grant it afterwards, expect delayed or mixed responses across instances
until cached tokens refresh. Restarting the Function App does not guarantee a
token refresh, and deployment-side actions cannot shorten the Azure-side cache.

The same delay applies in reverse. Removing this permission might not stop
directory reading immediately, so treat withdrawal as eventually consistent.

Do not grant a broader permission because a check still refuses. Confirm the assignment exists, then look at what the projector recorded rather than at the screen:

```powershell
$appId = az resource show -g $resourceGroup -n "appi-ctl-<name>-<environment>-<suffix>" `
  --resource-type microsoft.insights/components --query "properties.AppId" -o tsv
```

Query that component for `Directory reading projected.` and group the results by `customDimensions.HostInstanceId`. An outcome of `projected` proves that at least one instance completed a reading. Other instances may still hold stale tokens; inspect their recorded reasons rather than attributing every refusal to caching. If every instance reports `unavailable`, compare the exact assignment and grant time with the projector's failure reason; this alone does not prove that the assignment is absent.

The projector runs hourly at minute 30. This schedule wait is separate from permission propagation: once access works and initial governance is published, allow the next scheduled run to write a fresh reading. A healthy projection replaces the absent reading without manual intervention.

To remove the permission, delete the assignment by its `id` with `DELETE /v1.0/servicePrincipals/{identity}/appRoleAssignments/{id}`.

### Product: Bootstrap Governance

A fresh deployment contains no customer governance content. Until a complete set is published, authoring can return `503 published-policy-source-incomplete`; a partial set never becomes partially active.

Create a local JSON input. Replace every placeholder; do not commit tenant-specific identifiers to a public repository.

```json
{
  "tenantId": "<tenant-id>",
  "scopeGroupId": "organization",
  "organization": {
    "models": ["coding-primary"],
    "limits": {
      "requestsPerMinute": 80,
      "tokensPerMinute": 80000,
      "tokenQuota": 40000000,
      "quotaPeriod": "Monthly"
    }
  },
  "teams": [
    {
      "teamKey": "engineering",
      "membershipGroupId": "<entra-group-object-id>",
      "models": ["coding-primary"],
      "limits": {
        "requestsPerMinute": 40,
        "tokensPerMinute": 40000
      }
    }
  ],
  "models": [
    {
      "deploymentName": "<foundry-deployment-name>",
      "modelKey": "coding-primary"
    }
  ],
  "applications": [
    {
      "applicationId": "<caller-client-id>",
      "attributionQuality": "generic",
      "displayCode": "application.coding-agent"
    }
  ],
  "budgets": [],
  "fallback": null
}
```

The initializer reads model provider, API-family, lifecycle, and content-safety facts from the Foundry deployment. Those facts are not accepted from this file. Team group IDs must be Entra object IDs, and every narrower model allowlist must be contained by the organization allowlist.

Validate without an administration sign-in or publication:

```powershell
node tools/distribution/Initialize-Governance.mjs `
  --environment <environment> `
  --input .\initial-governance.json `
  --dry-run
```

The dry run performs read-only provider discovery and prints only scope, team/model keys, counts, and expiry. When it is correct, run it without `--dry-run`:

```powershell
node tools/distribution/Initialize-Governance.mjs `
  --environment <environment> `
  --input .\initial-governance.json
```

The tool prints a verification address and a code by default. Open the address on any device (the same machine, a phone, or another computer) and enter the code to select an account carrying `Governance.Administer`. This works from a jump host, a container, or any other environment with no local browser. Pass `--sign-in browser` for the Authorization Code + PKCE flow instead, which opens a native-client loopback redirect on `http://localhost:4173/governance-bootstrap` and requires a browser on the same machine. Its path is distinct from the local console's SPA redirect because Entra ignores localhost ports when matching redirect URIs. Update the deployed identity configuration before using this browser flow with an older deployment. Either way the token remains in memory, is validated for tenant, audience, role, and expiry, and is neither printed nor persisted.

The control plane writes and reads back five targets before the revision becomes active:

- assignments, initially empty because administration authority is Entra-owned;
- entitlements and team catalogue;
- provider-captured model registry and calling applications;
- optional downgrade plans; and
- optional token budgets.

If a first publication was interrupted, fix the failure cause and run `--resume --revision-id revision-0001`. The initializer resumes only the stored revision 1 proposal; it does not read the provider or regenerate replacement content. The stored validated content must be retried and cannot be replaced through this recovery path. Once any governance set is active it refuses to run again; use the console for later changes. If recovery requires abandonment, use the console's service-authorized recovery action only when it exposes one: it refuses any revision with a verified target, and a bootstrap revision requires the elevated recovery authority. A legacy revision with no durable proposal cannot be resumed or replaced; after authorized zero-verified abandonment, create a fresh proposal.

The protected route used by the tool is:

```text
POST <control-plane-endpoint>/api/v1/admin/governance/publish
```

The supported deployed authoring panels become useful only after that first set exists.

### Verify Per-Caller Enforcement

The principal key store initialized before provisioning is durable product state. Replacing `principal-key-secret` changes every pseudonymous subject, application, and notification key and prevents new records from joining to old ones. Treat replacement as a planned identity migration, not ordinary secret rotation.

The gateway enables caller-specific resolution only when the selected key-store mode is configured. If resolution cannot read the secret or a complete valid governance set, inference returns `503 governance_unavailable`; it never substitutes a wider default grant. Verify the Function App's `PRINCIPAL_KEY_SECRET` configuration reference reports `Resolved`, and verify the APIM `governance-policy-enabled` named value is `true`.

Verify the applied named value is `true` and the Models screen reports a current catalogue whose registered deployments match the provider. Then validate one entitled and one unentitled caller through the `/v1` gateway before onboarding more callers.

### Recurring Product Configuration

After bootstrap, use the console to manage:

- governed teams and callers;
- model allowlists and rate or quota limits;
- token budgets; and
- the downgrade plan.

The model registry is valid for 30 days and shows a warning during its final seven days. Use **Refresh catalogue from provider** on the Models screen before expiry. Refresh reads every registered deployment again, publishes the next registry version, and refuses if a registered deployment has disappeared rather than silently dropping it.

A caller may be admitted by a subject policy, an application policy, or the policy of one or more catalogued teams they belong to. Groups not present in the team catalogue are ignored. Multiple governed teams combine as grants; no single team is invented for attribution.

#### How Policies Combine

Policy has separate grant and restriction axes. Do not apply one merge rule to both:

| Policy value | Combination rule | Result |
|---|---|---|
| Model access | **OR across matching subject, application, and governed-team grants** | A model granted by any matching specific policy is available, but only if the organization allowlist also contains it. The organization allowlist is a ceiling, not an admission grant. |
| Rate and token quota limits | **All applicable limits apply; the most restrictive wins** | A request must pass the organization, every matching team, subject, and application limit. For limits with the same period, the smallest value is the practical ceiling. |
| Budgets | **All applicable budgets apply as independent counters** | The first exhausted organization, team, subject, or application budget refuses the request. Budgets with different periods are not added or converted into one number. |
| Downgrade plan | **One plan overrides by specificity** | Application, then subject, then a single attributable team, then organization. This is not an OR or minimum calculation. |

For example, suppose the organization allows models `A`, `B`, and `C`; Team Red grants `A`; Team Blue grants `B`; and the caller's subject policy grants `C`. A caller belonging to both teams may use `A`, `B`, or `C`. Adding `D` to any team or subject grant does not make `D` available until the organization allowlist also contains it.

If the same caller has monthly token budgets of 10 million at organization scope, 4 million on Team Red, 6 million on Team Blue, and 3 million on the subject, all four counters apply and the 3 million subject budget is the first practical ceiling. If the organization budget is monthly while a team budget is daily, both remain active in their own periods; the gateway refuses when either one is exhausted rather than converting or adding them.

With exactly one governed team, team usage and shared team counters use its canonical key. With no team or multiple teams, team attribution is absent and applicable team limits are enforced on the caller's subject counter. A caller with no governed team and no matching subject, application, or team policy is refused.

Operational token metrics use the literal `not-single-team` bucket when no one team is attributable. That value is a metric category, not a team identity; per-request and stored attribution keeps `teamKey` absent while retaining subject and application keys.

For a multi-team caller, no team-specific downgrade plan is selected arbitrarily. Application, subject, and organization plans retain their normal specificity order; team plans apply only when exactly one governed team is attributable.

#### Customizing The Combination Rules

The Admin console configures models, limits, budgets, and downgrade plans inside the rules above. It does not currently let an administrator replace the rules themselves. An organization that needs different combination semantics can maintain them as a code customization at these boundaries:

| Boundary | Change here | Required follow-through |
|---|---|---|
| `app/governance-domain/authorization/governance-authorization-evaluator.mjs` | Which subject, application, and team bindings grant access; how model grants combine under the organization ceiling | Update scope-precedence and authorization tests, including no-grant, single-team, multi-team, subject-only, and application-only cases. |
| `app/governance-domain/policy/effective-policy-composer.mjs` | How applicable rate, quota, and budget limits become gateway counters | Keep every emitted document valid against the schema and test same-period and different-period limits. |
| `app/governance-domain/policy/fallback-plan-compiler.mjs` | Which downgrade plan wins and how fallback edges compile | Preserve cycle rejection, wire-contract compatibility, explicit opt-in, and requested/effective model reporting. |
| `app/governance-domain/contracts/v1/effective-policy-document.schema.json` | The versioned document exchanged between the control plane and API Management | Update the semantic validator, fixtures, persistence tests, and migration/readback behavior together. |
| `apim/policies/inference.xml` | Enforcement of the resolved document | Update `tests/policy/Test-InferencePolicy.ps1`, bump `gateway-policy-version` in every gateway deployment module, and prove the changed branch with an APIM trace. |

Do not implement a new rule only in the Admin UI or only in API Management. The control plane decision, effective-policy contract, gateway enforcement, usage attribution, and Admin read model must produce the same answer. A custom rule must also preserve these invariants unless the organization explicitly redesigns and tests them:

- no model may escape the organization allowlist ceiling;
- no caller is admitted without a matching subject, application, or governed-team grant;
- no request is attributed to a team that cannot be selected unambiguously;
- missing or unreadable entitlement evidence never becomes a grant;
- prompt and completion bodies remain absent from governance evidence; and
- every deployed policy body has a new readable policy version and behavior-scoped test.

**Future work, not currently prioritized:** expose a small set of versioned combination profiles as governance configuration, with an effective-policy preview in the Admin console. This is a roadmap marker, not a promise or a currently supported deployment option. Until that work is implemented and tested, changing the merge operators requires the code-level extension above.

### Notifications

Notifications are optional. Without a channel, findings remain visible in the console but are not pushed elsewhere. See [Sending Governance Notifications to a Chat Channel](05-notifications.md) for how to create the webhook in Slack or Microsoft Teams, what the console shows once one is configured, and how delivery and acknowledgement behave.

## Operating Limitations

- **Budgets are best effort.** Requests already in flight are served, so a cap can be exceeded.
- **Change history records what changed.** It does not detect alteration and is not a tamper-evident ledger.
- **Concurrency is not governed.** There is no per-caller concurrency cap.
- **Requested and effective models can differ.** A downgrade plan may select another model; the response model is not rewritten to hide that decision.
- **Withdrawal follows token refresh or expiry.** Existing tokens are not introspected.
- **Network posture differs by surface.** Durable resources are private-networked. Basic v2 API Management is public, and `public-authenticated` administration is public and Entra-authenticated.
- **Direct Foundry access is separate.** This gateway governs only the requests it receives.
- **The standard membership profile is for interactive users.** Azure-hosted workload identities require the separately configured workload app role and directory membership resolver; that profile is disabled by default.

Policy defined at organization, team, subject, and application scope combines differently on each axis. See the policy checks in [Operating And Removing An Evaluation Environment](03-operations.md) before predicting what a specific caller will get.

## Fresh End-to-End Validation Record

The fresh isolated Azure run completed on 2026-09-09 used APIM Developer, one Foundry account with `gpt-oss-120b` (OpenAI-OSS, version 1, Global Standard) and `gpt-5-nano` (OpenAI, 2025-08-07, Global Standard), plus the Functions and administration SWA. Two separately approved clients used real delegated authentication, one for administration and one for gateway calls. Initial governance verified five publication targets. A script sent non-streaming Chat Completions through APIM: both models returned `200` assistant responses with exact requested and effective model headers; unauthenticated access returned `401`, and a disallowed model returned `403`. The deployed console and usage were verified in a browser. Same-author approval/resume returned `409`, while draft withdrawal preserved the active revision. Body-free hourly usage matched provider accounting at 130 OSS plus 24 nano tokens; the two served requests used those 154 provider tokens and the authenticated refusal used zero.

Treat this as one validation run, not production certification. It does not guarantee capacity, customer permissions, or security for another tenant. A second live identity for approval was waived, so no distinct-approver live test is claimed. Streaming and Responses were not tested. The default Basic v2 tier was not live-validated, so this record makes no all-SKU claim. Regional allocatable quota was unavailable under account-scoped runtime permissions and was not granted in this run; any later subscription read scope must be explicitly approved and bounded. Existing console PNG fixtures remain synthetic and are not Azure evidence. Cleanup used exact ownership receipts, including the evaluation resource boundary and Entra application/service-principal objects; an approved operator workflow performed the actual APIM, Foundry, and Entra cleanup and purges where permitted, not this local-only validator. Key Vault seven-day purge protection was retained and not forced. Soft-delete delay and recoverable directory objects mean active absence alone is not purge proof.

## Removal

Deleting resource groups alone is incomplete. Entra applications and service principals live outside resource groups, and APIM, Foundry, and key-store names can remain held by soft deletion.

Prepare a manifest-bound local preview:

```powershell
pwsh -NoProfile -File tools/distribution/Remove-Deployment.ps1 `
  -ManifestPath <ownership-manifest.json> `
  -StatePath <ownership-state.json> `
  -ReadbackPath <fresh-exact-id-readback.json> `
  -Preview `
  -OutputPath <removal-preview.json>
```

`Remove-Deployment.ps1` and `tools/deployment/ownership-contract.mjs` are local
ownership validators and approval planners, not deletion executors. They call no
Azure, Microsoft Graph, or `azd`, and they never delete or purge. A matching
`-ApproveResourceDelete`, `-ApproveEntraCleanup`, `-ApproveEntraPurge`,
`-ApproveApimPurge`, or `-ApproveKeyVaultPurge` switch with `-ApprovalPath`
emits only phase-specific authorization based on the same manifest, state,
readback, and output inputs.

The repository produces neither a manifest, state, or readback nor a removal
executor. Supply those records from a separately approved operator process. To
stop charges, that process must act only on the exact owned resource IDs in the
dedicated resource group and separately owned Entra applications and service
principals recorded in a fresh exact-ID readback. It must preserve reused Foundry
resources and pre-existing groups, and obtain separate approval for resource
deletion, Entra cleanup, and each purge phase. Do not use `azd down` or a
resource-group sweep, fabricate receipts, or treat phase validation as execution.
Confirm final readback only from the approved operator process. For accepted
record shapes, see
[`tools/deployment/ownership-contract.mjs`](../tools/deployment/ownership-contract.mjs)
and the sanitized
[`tests/infra/fixtures/ownership-contract-fixture.mjs`](../tests/infra/fixtures/ownership-contract-fixture.mjs).

## Rollback

- For an application regression, deploy the previous known-good commit with `azd deploy control-plane --environment <environment>` or `azd deploy admin-console --environment <environment>`.
- For an infrastructure regression, preview and provision the known-good template with `--no-state`.
- For a governance-content regression, publish the prior content as a new verified revision.
- Removing and recreating an environment is not a rollback; it also recreates identities and resource lifecycle state.

## Troubleshooting

### Tell the platform's refusal apart from the product's

Two different layers can answer `403`, and they need opposite investigations.

- **A `403` with an empty body** came from App Service authentication, before any product code ran. Look at the site's authentication settings.
- **A `403` carrying JSON with a `reasonCode`** came from the product, which means authentication succeeded and governance refused. Look at the caller's entitlement.

Check the response body length first. It is the fastest question you can ask, and it halves the search.

### Every administration route answers `403` with an empty body

A newly created deployment can leave an empty client allowlist on the site's authentication settings, and an empty allowlist rejects every caller. Provisioning removes it automatically. If you deployed the templates without that step, or the symptom returns, read the setting and confirm the key is absent:

```powershell
az rest --method get --url "https://management.azure.com/subscriptions/<subscription>/resourceGroups/<resource-group>/providers/Microsoft.Web/sites/<function-app>/config/authsettingsV2?api-version=2024-04-01" --query "properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy"
```

An `allowedApplications` key that is present and empty is the fault. An absent key is correct and applies no client restriction. Do not replace the empty list with a populated one unless you intend to restrict which client applications may call the administration API.

### An authentication change appears to do nothing

Changes to a site's authentication settings take effect after a short delay rather than on the next request. Repeat the request a minute later before concluding that a change had no effect. Measuring immediately after the write is the most common way to reach the wrong conclusion here, in both directions: a fix looks ineffective, and a break looks harmless.

### The Users and Groups screen says it has no reading

`503 reading_unavailable / directory-snapshot-absent` means the control plane has never written a directory reading, not that the governed teams are empty. On a new deployment the usual cause is the missing Microsoft Graph permission described under [Entra: Directory Reading For Users And Groups](#entra-directory-reading-for-users-and-groups). If the permission is already assigned, the assignment may not yet be in the identity's token; that section describes how to tell the two apart from the projector's own record.

### Impact preview reports missing caller evidence

The administration resource API must request `groupMembershipClaims: 'SecurityGroup'`, as the current identity template does. This carries the signed-in user's security-group IDs without granting `GroupMember.Read.All` or enabling the optional directory roster. Do not substitute `ApplicationGroup`: groups assigned only to the gateway would be omitted from the administration token.

An older installation can return `503 preview_unavailable / preview-source-unavailable` because missing group claims reach the policy resolver. Updated code reports the specific `caller-policy-evidence-unavailable` reason instead. Check the administration API registration, not the console client:

```powershell
az ad app show --id <administration-api-client-id> --query groupMembershipClaims
```

If the value is absent or different, apply the updated identity template to the same environment through the documented provisioning procedure, retaining the existing application IDs and role assignments. Then deploy the updated control plane and console. Open a new blank tab, enter the console URL, and sign in again for a new token; duplicating or reloading an existing tab may retain an unexpired token in session storage. Preview an unapproved saved draft. Reading the registration alone does not verify runtime success; confirm the preview result and that the active revision is unchanged. If testing a disposable draft, withdraw it without publishing.

Token group overage also omits the group list. It remains explicitly unavailable, not an empty membership or a reason to grant directory permissions automatically. Never paste tokens into diagnostics or documentation. This token-refresh issue is separate from managed-identity Graph permission propagation and the directory projector schedule.

### Initial governance sign-in fails with AADSTS9002326

The initializer uses native PKCE, not a browser-origin SPA token exchange. Older registrations can collide between the SPA redirect `http://localhost:4173` and the native redirect `http://localhost`, because Entra ignores the port when matching localhost redirects. The current template separates the native path as `http://localhost/governance-bootstrap`; the initializer listens at `http://localhost:4173/governance-bootstrap` and redeems the code without an `Origin` header.

Apply the updated identity template to the same environment, preserving the console application's ID, SPA redirects, and roles, and use the matching updated initializer. Verify both native and SPA redirect registrations before retrying initialization. Do not enable implicit flow, add a client secret, or remove the deployed console's SPA redirect to work around this error. Confirm the initial revision is active and all five publication targets are verified; a successful sign-in alone is not a successful initialization.

### The bootstrap tool asks for a sign-in that never completes

The device code is valid for about fifteen minutes from the moment it is printed, and the tool waits for that whole window. If it expires, rerun the command for a new code. Nothing is published unless the sign-in succeeds and the administration route answers.

### What-if reports no changes alongside coverage warnings

`ExtensibleResourceNotSupported` means what-if did not evaluate a Microsoft Graph resource. `NestedDeploymentShortCircuited` means a nested deployment could not be expanded. A successful command or an empty changes list does not prove there are no identity or nested-resource changes. Retain the warnings, review the intended template and parameter changes, and verify exact application IDs, role assignments and resource state after deployment. For an upgrade, preserve the environment's naming inputs and compare against the prior deployed template; do not delete and recreate app registrations to work around incomplete preview coverage.

### A channel change is refused

The refusal names the rule rather than repeating the address, because the address is a credential. `channel-kind-unsupported` means the channel type is not one this deployment sends to; `endpoint-refused` means the address itself is not acceptable, and it must be an `https` address of a channel outside this deployment.

## Official References

- [Azure Developer CLI reference](https://learn.microsoft.com/azure/developer/azure-developer-cli/reference)
- [AI gateway capabilities in API Management](https://learn.microsoft.com/azure/api-management/genai-gateway-capabilities)
- [`llm-token-limit` policy](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy)
- [`llm-emit-token-metric` policy](https://learn.microsoft.com/azure/api-management/llm-emit-token-metric-policy)
- [`validate-azure-ad-token` policy](https://learn.microsoft.com/azure/api-management/validate-azure-ad-token-policy)
- [Logging large language model requests](https://learn.microsoft.com/azure/api-management/api-management-howto-llm-logs)
- [Managed identities in API Management](https://learn.microsoft.com/azure/api-management/api-management-howto-use-managed-service-identity)
- [Microsoft Foundry documentation](https://learn.microsoft.com/azure/ai-foundry/)
- [Azure AI authentication](https://learn.microsoft.com/azure/ai-services/authentication)
- [Application roles in Microsoft Entra ID](https://learn.microsoft.com/entra/identity-platform/howto-add-app-roles-in-azure-ad-apps)
- [Azure Functions Flex Consumption](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan)
- [Azure Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/)
- [Azure Architecture Center guidance for AI gateways](https://learn.microsoft.com/azure/architecture/ai-ml/guide/azure-openai-gateway-guide)

The `Azure-Samples/AI-Gateway` and `Azure-Samples/APIM-Unified-AI-Gateway-Sample` repositories provide Microsoft-published reference implementations. This guide does not copy their deployment topology or use subscription-key examples.