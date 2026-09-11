# Operating And Removing An Evaluation Environment

This runbook describes environment-neutral operation and cleanup for a customer-managed evaluation. It defines safety boundaries and approval points; it does not authorize access to any environment.

## What This Runbook Covers

Use a dedicated, customer-chosen environment and resource boundary for each evaluation. Record its identifiers in the customer's controlled operating system, not in public documentation.

This runbook covers:

- repository-local preparation;
- separately authorized validation, deployment, operation, and cleanup;
- runtime policy checks; and
- ownership-aware removal.

## Authorization And Phase Boundaries

Repository-local checks establish only local consistency. They do not establish cloud readiness, access authorization, deployment success, data-plane behavior, or cleanup ownership.

Keep each phase separately authorized:

| Phase | Customer decision |
|---|---|
| Local preparation | Which source revision and checks are accepted |
| Validation | Which target and read-only operations may be inspected |
| Provisioning and deployment | Which resources and artifacts may be created or updated |
| Operation | Which callers, endpoints, models, and telemetry may be tested |
| Cleanup | Which owned resources may be deleted or purged |

An authorization applies only to its named action, target, identity, and time window. Do not infer a later authorization from an earlier sign-in, role, or successful check.

## Define The Evaluation Boundary

Before provisioning, record:

- the selected environment name and subscription;
- the resource groups the evaluation owns;
- reused resources that remain external dependencies;
- pre-existing resources that must not change; and
- the identities and directory objects created specifically for the evaluation.

Names, prefixes, resource-group membership, and configuration references do not prove ownership. Reusing an endpoint, deployment, identity, or group never transfers deletion ownership.

## Repository-Local Preparation

Use the repository's documented local checks after configuring the organization's approved package registry policy. Package integrity must satisfy that registry and package-manager policy; missing or mismatched integrity must be rejected. If no approved policy is available, fail closed or leave validation incomplete.

Customers own registry governance, license review, SBOM review, signing, and release approval. Local checks do not grant any of those approvals.

Record the tested source revision, commands, exit status, skipped checks, and unresolved failures in the customer's controlled system. Do not publish environment-specific records or internal review material in customer documentation.

### Repeatable Local Evaluation

Run the bounded local scenarios from the repository root:

```powershell
node tools/evaluation/run-local-evaluation.mjs
node --test tests/evaluation/*.test.mjs
```

The scenarios cover an allowed model, a denied model, HARD exhaustion, SOFT grace, THROTTLE, and fallback. They use synthetic identities, fixed policy inputs, and a loopback mock rather than an Azure endpoint. Each scenario compares expected values with observations from the component it actually exercises. A failed comparison produces a nonzero exit status.

Interpret the evidence at its actual level:

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| Reference calculation | The resolver, budget publication, or model-selection reference produces the expected policy result | APIM executed that result or a real request was admitted or blocked |
| Loopback mock | The local backend received the selected model and returned deterministic usage within the scenario bounds | Azure provider behavior, authentication, billing, or gateway enforcement |
| Static policy checks | The APIM policy source satisfies the repository's structural contracts | Live counter values, distributed throttling, or deployment success |

The report's `static-smoke` evidence only checks for selected policy text. Run `pwsh -NoProfile -File tests/policy/Test-InferencePolicy.ps1` separately for the existing static APIM contract checks. Keep that result separate from reference and mock observations. The local administration server is not an APIM emulator; a local reference decision is not an observed gateway HTTP response.

HARD, SOFT, and THROTTLE observations compare published quotas, warning percentages, and tier boundaries, not live enforcement. Boundary positions are arithmetic over the published thresholds. Model selection alone does not enforce HARD quotas, so the HARD scenario can still invoke the local mock; this is not evidence that an exhausted gateway budget allows a request. Each scenario permits at most one mock request with fixed usage of three input and two output tokens; the full matrix uses five requests and 25 mock tokens, with no Azure token cost.

The scenarios do not provide a live mode. Actual Azure evaluation requires separate approval of callers, endpoints, models, request and token budgets, permitted changes, and cleanup. A passing local report does not authorize that next phase.

## Validate And Deploy

Before each cloud action, confirm the active authentication context and target boundary. Review previews for creates, updates, deletions, external dependencies, and protected resources.

Provision or deploy only after the customer approves the exact target and action. A deployment preview is not permission to provision, and deployment permission is not permission to run data-plane tests or cleanup.

## Operate The Evaluation

### Start-Up Checks

Before sending a governed request:

- confirm the active environment and resource boundary;
- confirm reused dependencies are marked reference-only;
- confirm the administration and gateway endpoints came from this deployment;
- confirm the active governance revision and provider mapping are complete; and
- stop if any target resolves to a protected or unowned resource.

### Interpret Runtime Results

- `200` from `/api/healthz` establishes control-plane reachability only.
- `403 model_not_allowed` is a policy refusal and should not be retried as a transient failure.
- `503 governance_unavailable` means complete governance data is unavailable; it is not a caller denial.
- Usage records should contain token counts rather than prompt or completion bodies.
- When fallback changes the requested model, record the effective model.

Direct requests to Foundry bypass this gateway's policy and telemetry. They do not validate gateway operation.

### Stop Conditions

Stop and obtain a new decision when:

- the target differs from the approved boundary;
- a plan includes a protected or unowned resource;
- ownership records are missing or contradictory;
- one command combines separately authorized phases; or
- a result is partial, unavailable, or inconsistent with the expected boundary.

Do not broaden the target to make an operation succeed. Preserve the last known-good active governance revision.

## Cleanup Decision Gate

Cleanup requires explicit approval naming the environment, intended targets, and authorized phase. A standing explicit approval may already cover that phase; do not repeat a blanket decision when its scope remains valid. Review a removal preview before any delete or purge action.

The exact-ID ownership readback used by a removal preview is valid for at most 30 minutes. Refresh and reseal the readback before each separately authorized delete or purge phase. A standing approval does not extend that evidence lifetime: authorization fails if the readback is invalid, from the future, older than 30 minutes, predates the ownership manifest, or has expired when the phase is authorized.

For every candidate, confirm:

- its complete resource or directory-object identifier;
- its type and containing resource group, when applicable;
- a customer-controlled creation or ownership record;
- whether it existed before the evaluation; and
- whether deletion could affect a reused or protected dependency.

Exclude ambiguous candidates. Delete only approved, evaluation-owned resources whose identifiers still match. Do not substitute a similarly named resource after identifier drift.

Keep these actions separate:

- previewing removal;
- deleting cloud resources;
- deleting directory objects;
- purging soft-deleted API Management resources; and
- purging soft-deleted Key Vault resources.

Deletion does not prove that a name is reusable, a directory object is absent, or a soft-deleted resource was purged. Service retention and the operator's permissions determine whether purge is available.

### Generate An Offline Ownership Preview

The [ownership contract tool](../tools/deployment/ownership-contract.mjs) can generate a sealed evidence bundle from separately captured deployment inputs, an output seed, exact-ID creation receipts, and authoritative resource readback. Outputs alone do not prove that a resource was created by this deployment. Existing resource groups, reused Foundry resources, and external references must retain their protected classifications.

Prepare the input and output directory outside the repository. The generation input uses `llm-governance-ownership-generation-input/v1`; its receipts use `llm-governance-creation-receipt/v1`, and its captured readback uses `llm-governance-authoritative-readback/v1`. Keep the source commit, artifact and approved-plan digests, deployment identity, creation operation, exact resource IDs, preexisting resources, and readback timestamps together. Missing, conflicting, or stale evidence blocks generation; do not manufacture a receipt to make validation pass.

Both the main deployment and standalone stable-key bootstrap seed shapes are supported. Preserve the emitted seed exactly, including the bootstrap's `keyVaultLifecycle.resourceId`; do not add main-only fields. Bootstrap evidence covers only that prerequisite, not resources added by later deployments.

The main seed lists role assignments in both `createdResourceIds` and `createdAzureRoleAssignmentIds`. Keep both lists intact. The generator uses the more specific role-assignment kind once per ID, but still requires an exact creation receipt and authoritative principal and role-definition metadata. This overlap does not override preexisting or protected-target checks.

Protected targets remain fail-closed by default. A narrow `deploymentInputs.protectedRoleAssignmentExceptions` opt-in can include an environment-created role assignment on the **exact protected Cognitive Services account** in a removal preview. Each entry must bind `roleAssignmentId`, exact account `scope`, `principalId`, `roleDefinitionId`, and `principalResourceId`. The role and its Functions or API Management managed-identity resource must both be newly created by this deployment, have exact-ID creation receipts, and agree with fresh authoritative readback. Subscription/resource-group grants, model/project descendants, reused or foreign principals, unsupported identity owners, and account/model deletion are never enabled by this exception. The exception list and digest are rechecked in the manifest, state, readback, bundle, and preview. Omit the field unless this explicit evidence is available.

Capture the emitted seed through the direct ARM deployment response and retain that raw object. Azure CLI can decorate objects containing ARM IDs, for example by adding a derived `resourceGroup` member to `externalReferences`, even when that member was not emitted by the Bicep output. Such decorated JSON fails the strict seed schema and must not be silently rewritten or described as raw output. Preserve it separately as CLI-derived evidence, capture the direct ARM output, and document the comparison.

The following pattern keeps the ARM token in memory and writes only the raw seed to a private path. Replace the placeholders with the exact authorized deployment identifiers. Do not log `$token` or `$headers`.

```powershell
$token = (az account get-access-token --resource https://management.azure.com/ -o json |
  ConvertFrom-Json).accessToken
$headers = @{ Authorization = "Bearer $token" }
$uri = "https://management.azure.com/subscriptions/<subscription-id>/providers/Microsoft.Resources/deployments/<deployment-name>"
$deployment = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -Body @{ 'api-version' = '2025-04-01' }
$seed = ($deployment.properties.outputs.PSObject.Properties |
  Where-Object Name -ieq 'OWNERSHIP_MANIFEST_SEED').Value.value
$seed | ConvertTo-Json -Depth 20 | Set-Content ..\private-evidence\raw-ownership-seed.json
Remove-Variable token, headers
```

#### First-install ownership evidence failures

Do not omit an ownership error merely because application deployment succeeded. Treat the following first-install symptoms as evidence failures and preserve the rejected input and original deployment output:

| Symptom | Meaning | Provenance-preserving recovery |
|---|---|---|
| `contract-unknown-field`, a missing main-only array, or `generation-key-vault-resource-id-mismatch` | A standalone bootstrap seed was treated as a main seed, a main seed was treated as bootstrap evidence, or fields were added to make the shapes match. | Capture the exact deployment and output again. Keep `keyVaultLifecycle.resourceId` only for the bootstrap variant. Keep the main role, directory, Graph assignment, protected-resource, and recursive-readback fields only on the main variant. Never copy fields between variants. |
| `generation-created-kind-conflict` for an unrelated ID | One ID was claimed as incompatible resource kinds. | Correct the producer or evidence source. Do not choose a kind manually. The intentional main-seed overlap between `createdResourceIds` and `createdAzureRoleAssignmentIds` is supported only for the same role-assignment ID and resolves to `azure-role-assignment`; retain both emitted lists. |
| `contract-unknown-field: outputSeed.externalReferences[].resourceGroup` | Azure CLI decorated an ARM-ID object with a derived resource-group field that Bicep did not emit. | Retain the CLI-derived file as historical evidence. Capture the seed from the direct ARM deployment response, compare the two records, and use the unmodified direct ARM seed. Do not silently strip the field from the historical file. |
| `generation-created-target-is-protected` | A claimed created target is the same as, or a descendant of, a protected shared parent. | Keep the shared account, project, models, resource group, and preexisting permissions protected. By default no descendant is removable. Use the narrow role exception only for a newly created `Microsoft.Authorization/roleAssignments` resource whose scope is the exact protected Cognitive Services account. Other protected-parent grants remain blocked. |

Each protected-account role exception must name the exact role-assignment ID, account scope, principal ID, role-definition ID, and owning Functions or API Management resource ID. Fresh authoritative readback must reproduce those values. Both the grant and owning managed-identity resource need exact-ID creation receipts from this deployment. A reused grant, reused or foreign principal, unsupported owner, broader subscription or resource-group scope, project/model descendant, changed role, missing receipt, stale readback, or tampered digest fails closed. The exception never permits deletion of the shared account or model.

The same exception list has one additional Key Vault case: the exact built-in **Key Vault Secrets User** role (`4633458b-17de-408a-b874-0445c86b69e6`) on the exact protected vault may be previewed only when assigned to a newly created Function managed identity with matching receipts and fresh readback. The authoritative owner entry must include the ARM `kind` value as `resourceKind`; it must contain the exact comma-delimited token `functionapp`. This value is carried into the inventory and rechecked through seal, verification, state, readback, and preview, so an ordinary `Microsoft.Web/sites` web app is not treated as a Function. API Management owners, missing or changed kind evidence, other Key Vault roles, vault-secret descendants, subscription/resource-group scopes, reused grants, and preexisting principals remain denied. The vault, its secrets, and all existing grants remain protected. A first-install `generation-created-target-is-protected` for such a grant is recovered by adding only this exact evidence-bound exception; never reclassify or remove the vault from `protectedTargets`.

After recovery, generate the bundle and run `Remove-Deployment.ps1 -Preview`. Verify that the bundle regenerates without disagreement, the preview is `ready`, both exception and protected-target digests agree through manifest/state/readback/preview, intended grants appear only under `delete.resources`, protected parents appear under `preserve`, and `mutationImplemented` is `false`. A `blocked`, missing, unknown, stale, or failed result is not a successful preview.

The repository tests exercise bootstrap/main separation, intentional role-list overlap, raw-seed strictness, exact protected-account exceptions, principal ownership, tampering, freshness, and zero-mutation preview behavior with deterministic fixtures. Those tests validate contract behavior, not ownership of a customer's live resources. Deployment-specific evidence is verified only when its exact receipts and fresh readback produce a sealed `ready` preview. If another protected-parent target remains blocked after the approved Cognitive Services exceptions, report that target as a remaining blocker rather than broadening the exception or describing the installation as fully verified.

```powershell
node tools/deployment/ownership-contract.mjs generate --input ..\private-evidence\generation-input.json --output ..\private-evidence\ownership-bundle.json
pwsh -NoProfile -File tools/distribution/Remove-Deployment.ps1 -EvidenceBundlePath ..\private-evidence\ownership-bundle.json -Preview -OutputPath ..\private-evidence\removal-preview.json
```

The generated `llm-governance-ownership-evidence-bundle/v1` contains the sealed manifest, retained state, bound readback, and removal preview. Previewing the bundle rechecks the evidence and its freshness; an old bundle is not a standing approval. Use new output paths rather than overwriting retained evidence, and keep all environment-specific files out of public commits.

Postprovision generation is opt-in: set both `OWNERSHIP_GENERATION_INPUT_FILE` and `OWNERSHIP_EVIDENCE_BUNDLE_FILE` to the prepared private paths before an already authorized deployment. With neither set, the hook does not generate evidence; setting only one is an error. The hook does not capture cloud receipts or readback for you, and its input must describe the actual completed operation.

This pipeline validates agreement between supplied records, not their independent authenticity or live cloud state. It performs no Azure or Microsoft Graph calls and no deletion or purge. A ready preview remains a local plan; every later mutation still needs separately verified ownership and explicit phase authorization.

### Soft Delete And Name Reuse

- Key Vault purge protection remains enabled with the configured soft-delete retention period. A protected vault cannot be purged before retention expires.
- API Management deletion and purge are separate operations with separate permission boundaries.
- Entra directory-object deletion is separate from resource-group deletion and service principals may remain as recoverable deleted items. Active absence is not purge proof.

After cleanup, record deleted, retained, unchecked, and soft-deleted targets in the customer's controlled system, matching each action to the exact ownership receipt. Do not perform blanket tenant purges. Report partial completion as partial completion.

## Policy Checks During Operation

### Model Access

The organization model list is a ceiling, not a grant. Applicable team, subject, and application grants combine by union, and the organization ceiling then filters the result.

Every caller needs at least one applicable team, subject, or application grant. A grant outside the organization ceiling produces no allowed model and never widens the ceiling.

### Refused Versus Unavailable

- `403` means the gateway established caller policy and refused the request.
- `503` with `Retry-After` means complete identity or policy data was unavailable.

Keep these outcomes distinct because they require different investigations.

### Limits, Budgets, And Fallback

- Per-minute request and token limits are independent; the lowest applicable value wins for each counter.
- Quotas are compared using normalized hourly rates, while the selected quota retains its authored amount and period.
- Every applicable budget keeps an independent counter, and any exhausted budget can stop a request.
- `HARD_BLOCK` blocks at the token limit; `SOFT_WARNING` warns at the limit and blocks after its grace allowance; `THROTTLE` applies request-rate tiers without a hard quota of its own. Configuration and a no-fallback blocking example are in [Budget actions](02-administration.md#budget-actions).
- Budgets are best effort because in-flight requests may complete.
- Exactly one fallback plan applies, selected by specificity: application, subject, team, then organization.
- A more specific fallback plan replaces the less specific plan instead of merging with it.
- Fallback uses at most one model connection per request. With no permitted connection, the requested model remains subject to its quotas and budgets; the reference-only `onExhausted: deny` setting is not a deployed APIM control. See [Editing an existing fallback plan](02-administration.md#editing-an-existing-fallback-plan).

Measure representative coding-agent traffic before setting limits because agents resend conversation and workspace context.

## Related Guides

- [PoC Quickstart](00-quickstart.md) gives the shortest evaluation path.
- [Deploying The Gateway](01-deployment.md) is the deployment and troubleshooting reference.
- [Using The Administration Console](02-administration.md) explains revisions, models, budgets, usage, and notifications.
- [Connecting A Coding Agent](04-connection.md) explains the client contract.
- [Sending Governance Notifications to a Chat Channel](05-notifications.md) explains optional notification delivery.
