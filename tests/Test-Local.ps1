[CmdletBinding()]
param(
    [switch]$IncludeExternalOpenApiLint,
    [switch]$IncludePersistenceIntegration,
    [switch]$PublicOnly,
    [switch]$ListSuites,

    # Pin the registry the external lint may reach. Empty accepts whatever npm is
    # configured with, which is what an outside contributor wants.
    [string]$RequiredNpmRegistry = $env:LLM_GOVERNANCE_NPM_REGISTRY
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot

Push-Location $repositoryRoot
try {
    $powerShellTests = @(
        '.\tests\infra\Test-IacContract.ps1',
        '.\tests\infra\Test-GovernanceInfrastructure.ps1',
        '.\tests\infra\Test-FunctionHostContract.ps1',
        '.\tests\infra\Test-ProviderRuntimeWiring.ps1',
        '.\tests\infra\Test-AzurePreflight.ps1',
        '.\tests\infra\Test-KeyVaultLifecycleContract.ps1',
        '.\tests\infra\Test-DeploymentCleanupSafety.ps1',
        '.\tests\distribution\Test-DistributionModes.ps1',
        '.\tests\distribution\Test-DistributionParameters.ps1',
        '.\tests\distribution\Test-SupplyChain.ps1',
        '.\tests\c0\Test-C0AdoptionIac.ps1',
        '.\tests\c0\Test-C0PortalDiscovery.ps1',
        '.\tests\c0\Test-C0Pagination.ps1',
        '.\tests\c0\Test-C0EndpointSafety.ps1',
        '.\tests\c0\Test-C0GeneratedPolicyExport.ps1',
        '.\tests\c0\Test-C0GeneratedBackendTlsContract.ps1',
        '.\tests\c0\Test-C0FoundryIntegratedReadbackContract.ps1',
        '.\tests\c0\Test-C0RoutingCanaryMetricContract.ps1',
        '.\tests\c0\Test-C0StaleLifecycleCleanupContract.ps1',
        '.\tests\c0\Test-C0CleanupContract.ps1',
        '.\tests\c0\Test-C0MetricReconciliation.ps1',
        '.\tests\c0\Test-C0OperationalSafety.ps1',
        '.\tests\policy\Test-InferencePolicy.ps1',
        '.\tests\contract\Test-OpenApiValidity.ps1',
        '.\tests\contract\Test-ApiSurface.ps1',
        '.\tests\contract\Test-OpenAIWireContract.ps1',
        '.\tests\routing\Test-ExplicitApimBaseline.ps1',
        '.\tests\routing\Test-ExistingToolCompatibility.ps1',
        '.\tests\routing\Test-RoutingCanaryRunner.ps1',
        '.\tests\identity\Test-EntraIac.ps1',
        '.\tests\identity\Test-AccessTokenClaims.Tests.ps1',
        '.\tests\control\Test-PrincipalContextContract.ps1',
        '.\tests\control\Test-GovernanceAuthorizationContract.ps1',
        '.\tests\persistence\Test-PersistenceContract.ps1',
        '.\tests\distribution\Test-DeploymentPipeline.ps1',
        '.\tests\ui\Test-AdminUiBuild.ps1'
    )

    if ($PublicOnly) {
        $publicExcludedPowerShellTests = @(
            '.\tests\routing\Test-ExistingToolCompatibility.ps1',
            '.\tests\routing\Test-RoutingCanaryRunner.ps1'
        )
        $powerShellTests = @($powerShellTests | Where-Object {
            -not $_.Contains('\tests\c0\') -and $_ -notin $publicExcludedPowerShellTests
        })
    } elseif (-not (Test-Path -LiteralPath '.\tests\c0' -PathType Container)) {
        throw 'Internal C0 suites are unavailable. Use -PublicOnly for a public snapshot.'
    }

    $openCodexLauncher = $env:OPENCODEX_LAUNCHER
    $openCodexIntegrationSuite = '.\tests\contract\opencodex-auth-bridge.integration.test.mjs'
    $skippedNodeSuites = 0

    # Declared rather than invoked one by one, so the reported suite count is derived
    # from what actually ran instead of a number kept in step by hand.
    $nodeSuites = [ordered]@{
        '.\tests\mock\foundry-mock.test.mjs'                    = 'The deterministic mock backend tests failed.'
        '.\tests\evaluation\evaluation-runner.test.mjs'        = 'The bounded local evaluation scenarios failed.'
        '.\tests\c0\c0-runtime.test.mjs'                        = 'The C0 transactional allowance proxy tests failed.'
        '.\tests\c0\c0-shared-accounting.test.mjs'              = 'The C0 shared accounting projection tests failed.'
        '.\tests\control\principal-context-factory.test.mjs'    = 'The PrincipalContext factory tests failed.'
        '.\tests\control\governance-authorization.test.mjs'     = 'The governance authorization domain tests failed.'
        '.\tests\control\model-registry-snapshot.test.mjs'      = 'The model registry snapshot tests failed.'
        '.\tests\control\model-capture.test.mjs'                = 'The model registry capture tests failed.'
        '.\tests\control\initial-governance-set.test.mjs'      = 'The initial governance set builder tests failed.'
    '.\tests\control\team-catalog-edit.test.mjs'            = 'The team catalogue edit tests failed.'
    '.\tests\control\authored-policy-retention.test.mjs'    = 'An authored-policy edit sets a retention window of its own.'
    '.\tests\control\entitlement-binding-add.test.mjs'      = 'The entitlement binding creation tests failed.'
        '.\tests\control\admin-role-authorization.test.mjs'     = 'The governance application role tests failed.'
        '.\tests\control\admin-overview-handler.test.mjs'       = 'The governance overview endpoint tests failed.'
        '.\tests\control\configuration-summary-reader.test.mjs' = 'The configuration summary reader tests failed.'
        '.\tests\control\directory-snapshot.test.mjs'           = 'The directory snapshot projection tests failed.'
        '.\tests\control\configuration-lifecycle.test.mjs'      = 'The configuration lifecycle state machine tests failed.'
        '.\tests\control\configuration-conflict.test.mjs'       = 'The configuration conflict comparison tests failed.'
        '.\tests\control\configuration-writer.test.mjs'         = 'The configuration write path tests failed.'
        '.\tests\control\schedule-recovery.test.mjs'            = 'The schedule recovery and lease tests failed.'
        '.\tests\control\schedule-runner.test.mjs'              = 'The schedule runner recovery tests failed.'
        '.\tests\control\governance-outage.test.mjs'            = 'The governance outage tests failed.'
        '.\tests\control\governance-snapshot-document.test.mjs' = 'The governance snapshot document tests failed.'
        '.\tests\control\published-policy-source.test.mjs'      = 'The published policy source tests failed.'
        '.\tests\control\deployed-principal-resolution.test.mjs' = 'The deployed identity and membership tests failed.'
        '.\tests\control\token-claims-membership-resolver.test.mjs' = 'The token-claim membership tests failed.'
        '.\tests\control\deployed-policy-resolver.test.mjs'     = 'The deployed policy resolver tests failed.'
        '.\tests\control\governance-publisher.test.mjs'         = 'The governance publication tests failed.'
        '.\tests\control\governance-set-edit.test.mjs'          = 'The entitlement and assignment edit tests failed.'
        '.\tests\control\governance-set-authoring.test.mjs'     = 'The budget and fallback authoring tests failed.'
        '.\tests\control\no-reservation-architecture.test.mjs'  = 'The no-reservation architecture tests failed.'
        '.\tests\control\publish-governance-handler.test.mjs'   = 'The governance publication endpoint tests failed.'
        '.\tests\control\admin-access-handlers.test.mjs'         = 'The deployed access authoring endpoint tests failed.'
        '.\tests\control\admin-model-edit.test.mjs'              = 'The deployed model capture endpoint tests failed.'
        '.\tests\control\admin-model-prices.test.mjs'            = 'The reference price endpoint tests failed.'
        '.\tests\control\price-reference.test.mjs'               = 'The published price reference tests failed.'
        '.\tests\control\directory-reading.test.mjs'              = 'The directory reading tests failed.'
        '.\tests\control\admin-screen-handlers.test.mjs'          = 'The deployed screen endpoint tests failed.'
        '.\tests\control\schedule-hosting.test.mjs'             = 'The schedule hosting configuration tests failed.'
        '.\tests\control\scheduled-budget-notifications.test.mjs' = 'The scheduled budget comparison tests failed.'
        '.\tests\identity\principal-key-derivation.test.mjs'    = 'The principal key derivation tests failed.'
        '.\tests\identity\gateway-token-helper.test.mjs'        = 'The gateway token helper tests failed.'
        '.\tests\identity\client-integration-profiles.test.mjs' = 'The coding client profile tests failed.'
        '.\tests\contract\gateway-mock.test.mjs'                = 'The gateway mock contract tests failed.'
        '.\tests\contract\agent-auth-bridge.test.mjs'           = 'The coding agent authentication bridge tests failed.'
        '.\tests\policy\effective-policy-composer.test.mjs'     = 'The effective policy composition tests failed.'
        '.\tests\policy\fallback-plan-compiler.test.mjs'        = 'The fallback plan compilation tests failed.'
        '.\tests\policy\scope-precedence.test.mjs'              = 'The scope precedence tests failed.'
        '.\tests\routing\endpoint-fingerprint.test.mjs'         = 'The endpoint governance fingerprint tests failed.'
        '.\tests\routing\direct-path-probe.test.mjs'            = 'The direct-path probe classification tests failed.'
        '.\tests\policy\effective-model-selector.test.mjs'      = 'The effective model selection parity tests failed.'
        '.\tests\policy\model-selection-decision.test.mjs'      = 'The model selection decision record tests failed.'
        '.\tests\policy\budget-publication.test.mjs'            = 'The budget publication tests failed.'
        '.\tests\policy\budget-edit.test.mjs'                   = 'The budget edit tests failed.'
        '.\tests\ui\budgets-read-model-projector.test.mjs'      = 'The budget read model projection tests failed.'
        '.\tests\policy\policy-resolution-endpoint.test.mjs'    = 'The policy resolution endpoint tests failed.'
        '.\tests\control\policy-resolution-route.test.mjs'      = 'The policy resolution route tests failed.'
        '.\tests\control\effective-policy-handler.test.mjs'     = 'The effective policy function handler tests failed.'
        '.\tests\usage\usage-rollup-projector.test.mjs'         = 'The usage rollup projection tests failed.'
        '.\tests\usage\usage-record-projector.test.mjs'         = 'The usage record projection tests failed.'
        '.\tests\usage\budget-notification-planner.test.mjs'    = 'The budget notification planning tests failed.'
        '.\tests\usage\notification-delivery.test.mjs'          = 'The notification delivery record tests failed.'
        '.\tests\usage\notification-ledger.test.mjs'            = 'The notification ledger tests failed.'
        '.\tests\usage\notifications-read-model.test.mjs'       = 'The notifications read model tests failed.'
        '.\tests\usage\governance-event-notifications.test.mjs' = 'The publish and drift notification tests failed.'
        '.\tests\usage\notification-dispatcher.test.mjs'        = 'The notification dispatch tests failed.'
        '.\tests\usage\webhook-notification-channel.test.mjs'   = 'The webhook notification channel tests failed.'
        '.\tests\usage\scheduled-drift-detector.test.mjs'       = 'The scheduled drift detection tests failed.'
        '.\tests\usage\publish-failure-sweep.test.mjs'          = 'The publish failure sweep tests failed.'
        '.\tests\usage\period-consumption.test.mjs'             = 'The period consumption observation tests failed.'
        '.\tests\usage\budget-notification-sweep.test.mjs'      = 'The budget notification sweep tests failed.'
        '.\tests\usage\notification-retention.test.mjs'         = 'The notification retention policy tests failed.'
        '.\tests\usage\notification-retention-sweep.test.mjs'   = 'The notification retention sweep tests failed.'
        '.\tests\usage\drift-detector.test.mjs'                 = 'The usage drift detection tests failed.'
        '.\tests\usage\rollup-projector-schedule.test.mjs'      = 'The scheduled rollup projector tests failed.'
        '.\tests\usage\rollup-projector-recovery.test.mjs'      = 'The rollup projector recovery tests failed.'
        '.\tests\usage\log-analytics-usage-query.test.mjs'      = 'The Log Analytics usage query tests failed.'
        '.\tests\usage\azure-monitor-provider-usage.test.mjs'   = 'The provider usage meter tests failed.'
        '.\tests\usage\notification-channel.test.mjs'           = 'The notification channel tests failed.'
        '.\tests\identity\client-principal.test.mjs'            = 'The verified caller tests failed.'
        '.\tests\usage\foundry-quota-query.test.mjs'            = 'The provider quota reader tests failed.'
        '.\tests\usage\foundry-price-query.test.mjs'            = 'The retail price reader tests failed.'
        '.\tests\usage\rollup-projector-records.test.mjs'       = 'The per-request usage record tests failed.'
        '.\tests\distribution\public-boundary-scan.test.mjs'    = 'The public boundary scan reported publishable material it must not.'
        '.\tests\distribution\public-snapshot.test.mjs'        = 'The public snapshot included local-only repository context.'
        '.\tests\distribution\publication-docs.test.mjs'      = 'The public Markdown documentation failed its parity, link, or prose contract.'
        '.\tests\distribution\quickstart-guide.test.mjs'      = 'The public quickstart guide contract tests failed.'
        '.\tests\distribution\opencodex-docs.test.mjs'        = 'The optional OpenCodex documentation drifted from the executed configuration.'
        '.\tests\contract\opencodex-auth-bridge.integration.test.mjs' = 'The optional OpenCodex and authentication-bridge integration contract failed.'
        '.\tests\control\configuration-draft-document.test.mjs' = 'The configuration draft document tests failed.'
        '.\tests\control\directory-membership-resolver.test.mjs' = 'The directory membership resolver tests failed.'
        '.\tests\control\admin-notifications-handler.test.mjs' = 'The deployed notifications route tests failed.'
        '.\tests\control\draft-authoring.test.mjs'              = 'The proposal authoring tests failed.'
        '.\tests\control\proposal-publication.test.mjs'         = 'The proposal publication tests failed.'
        '.\tests\control\policy-impact-preview.test.mjs'       = 'The read-only policy impact comparison tests failed.'
        '.\tests\control\policy-impact-preview-handler.test.mjs' = 'The authenticated policy impact preview tests failed.'
        '.\tests\persistence\persistence-contract.test.mjs'     = 'The persistence document contract tests failed.'
        '.\tests\persistence\in-memory-governance-store.test.mjs' = 'The in-memory governance store contract tests failed.'
        '.\tests\distribution\suite-coverage.test.mjs'          = 'A test file exists that no suite runs.'
        '.\tests\distribution\easy-auth-client-allowlist.test.mjs' = 'The Easy Auth client allowlist repair tests failed.'
        '.\tests\distribution\initialize-governance.test.mjs'   = 'The public governance initializer tests failed.'
        '.\tests\distribution\deployment-inputs.test.mjs'      = 'The deployment input and principal key bootstrap tests failed.'
        '.\tests\distribution\supply-chain-evidence.test.mjs'  = 'The local supply-chain evidence contract tests failed.'
        '.\tests\infra\ownership-contract.test.mjs'             = 'The offline deployment ownership and cleanup safety contracts failed.'
        '.\tests\distribution\deployment-guide.test.mjs'        = 'The public deployment guide contract tests failed.'
        '.\tests\ui\*.test.mjs'                                 = 'The local Admin UI tests failed.'
    }

    if ($PublicOnly) {
        foreach ($internalSuite in @($nodeSuites.Keys | Where-Object { $_.Contains('\tests\c0\') })) {
            $nodeSuites.Remove($internalSuite)
        }
    }

    if ($ListSuites) {
        $listedNodeSuites = @()
        foreach ($suitePath in $nodeSuites.Keys) {
            $relativePath = $suitePath -replace '^\.[\\/]', ''
            if ($relativePath -match '[*?]') {
                $listedNodeSuites += @(Get-ChildItem -Path $relativePath -File | ForEach-Object {
                    $_.FullName.Substring($repositoryRoot.Length).TrimStart('\')
                })
            } else {
                $listedNodeSuites += $relativePath
            }
        }
        [pscustomobject]@{
            powerShell = @($powerShellTests | ForEach-Object { $_ -replace '^\.[\\/]', '' })
            node = $listedNodeSuites
        } | ConvertTo-Json -Compress
        return
    }

    foreach ($testPath in $powerShellTests) {
        if ($PublicOnly -and $testPath -eq '.\tests\infra\Test-IacContract.ps1') {
            & $testPath -PublicOnly
        } else {
            & $testPath
        }
    }

    foreach ($suite in $nodeSuites.GetEnumerator()) {
        if ($suite.Key -eq $openCodexIntegrationSuite -and [string]::IsNullOrWhiteSpace($openCodexLauncher)) {
            Write-Host "SKIP $openCodexIntegrationSuite (set OPENCODEX_LAUNCHER to a pinned installation to run it)"
            $skippedNodeSuites += 1
            continue
        }
        node --test $suite.Key
        if ($LASTEXITCODE -ne 0) {
            throw $suite.Value
        }
    }

    if ($IncludePersistenceIntegration) {
        $integration = @(& '.\tests\persistence\Test-CosmosIntegration.ps1')
        $integrationResult = $integration | Where-Object { $_.PSObject.Properties.Name -contains 'Result' } | Select-Object -Last 1
        if ($null -eq $integrationResult -or $integrationResult.Result -ne 'Pass') {
            throw 'The persistence integration suite did not report a pass.'
        }
    }

    if ($IncludeExternalOpenApiLint) {
        $registry = (npm config get registry).Trim()
        # An organization that pins a registry supplies it here. Nothing about which
        # registry that is belongs in a published repository.
        if ($RequiredNpmRegistry) {
            $registryOrigin = ([uri]$registry).GetLeftPart([System.UriPartial]::Authority)
            $requiredOrigin = ([uri]$RequiredNpmRegistry).GetLeftPart([System.UriPartial]::Authority)
            if ($registryOrigin -ne $requiredOrigin) {
                throw "Blocked npm registry origin: $registryOrigin"
            }
        }

        # Release validation is cache-only: it must never fetch a package while
        # validating the candidate or bypass the configured registry boundary.
        npx --yes --offline --registry $registry @redocly/cli@2.39.0 lint '.\apim\apis\inference.openapi.json' --format stylish
        if ($LASTEXITCODE -ne 0) {
            throw 'Redocly OpenAPI validation failed.'
        }
    }

    [pscustomobject]@{
        PowerShellSuites = $powerShellTests.Count
        NodeSuites = $nodeSuites.Count - $skippedNodeSuites
        ExternalNodeSuitesSkipped = $skippedNodeSuites
        OpenCodexIntegration = if ($skippedNodeSuites -eq 0) { 'Pass' } else { 'Skipped' }
        PersistenceIntegration = [bool]$IncludePersistenceIntegration
        ExternalOpenApiLint = [bool]$IncludeExternalOpenApiLint
        Result = 'Pass'
    } | Format-List
}
finally {
    Pop-Location
}
