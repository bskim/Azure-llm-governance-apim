[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Assert-Host {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

# The compute decision rests on local development running the same host that runs
# when deployed. That claim is only true while these artifacts agree with it, so
# it is asserted rather than assumed.

$hostConfigPath = Join-Path $repositoryRoot 'host.json'
Assert-Host (Test-Path -LiteralPath $hostConfigPath -PathType Leaf) 'host.json must sit at the deployment root.'
$hostConfig = Get-Content -LiteralPath $hostConfigPath -Raw | ConvertFrom-Json
Assert-Host ($hostConfig.version -eq '2.0') 'The host configuration must target runtime version 2.0 or later.'
Assert-Host ($hostConfig.extensionBundle.version -eq '[4.0.0, 5.0.0)') 'Flex Consumption requires extension bundle 4.x.'

$packagePath = Join-Path $repositoryRoot 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
Assert-Host ($package.main -eq 'app/functions/index.mjs') 'The package entry point must name the function registrations.'
Assert-Host ($package.type -eq 'module') 'The registrations use module syntax, so the package must declare it.'
$declaredNode = [regex]::Match($package.engines.node, '\d+').Value
Assert-Host ($declaredNode -in @('22', '24')) "Flex Consumption does not offer Node $declaredNode."

$runtimePath = Join-Path $repositoryRoot 'infra\modules\governance-runtime.bicep'
$runtime = Get-Content -LiteralPath $runtimePath -Raw
$deployedNode = [regex]::Match($runtime, "param nodeVersion string = '(?<value>\d+)'").Groups['value'].Value
Assert-Host ($deployedNode -eq $declaredNode) "The deployed runtime is Node $deployedNode but the project declares Node $declaredNode."
$maximumInstanceCount = [int][regex]::Match($runtime, 'param maximumInstanceCount int = (?<value>\d+)').Groups['value'].Value
$instanceMemoryMB = [int][regex]::Match($runtime, 'param instanceMemoryMB int = (?<value>\d+)').Groups['value'].Value
Assert-Host ($maximumInstanceCount -eq 28) 'The repository-local FC1 maximum must default to 28.'
Assert-Host ($runtime -match '@maxValue\(28\)\s*\r?\nparam maximumInstanceCount int = 28') 'Unapproved FC1 values above 28 must fail in Bicep, even when azd preprovision is bypassed.'
Assert-Host ($instanceMemoryMB -eq 2048) 'The FC1 budget proof must stay pinned to 2,048 MB.'
Assert-Host ($runtime -match '@allowed\(\[2048\]\)\s*\r?\nparam instanceMemoryMB int = 2048') 'A 4,096 MB input must not bypass the verified FC1 budget.'

# A registration file that reaches into behaviour cannot be exercised without the
# host, which would put the gateway contract outside the ordinary test run.
$registrations = Get-Content -LiteralPath (Join-Path $repositoryRoot 'app\functions\index.mjs') -Raw
$httpTriggerCount = [regex]::Matches($registrations, 'app\.http\(').Count
$timerTriggerCount = [regex]::Matches($registrations, 'app\.timer\(').Count
$scaleGroupCount = 1 + $timerTriggerCount
$worstCaseCores = 1 + ($scaleGroupCount * $maximumInstanceCount)
Assert-Host ($httpTriggerCount -eq 22) 'The FC1 inventory must account for exactly 22 HTTP functions sharing one HTTP scale group.'
Assert-Host ($timerTriggerCount -eq 6) 'The FC1 inventory must conservatively treat exactly six timer functions as six scale groups.'
Assert-Host ($scaleGroupCount -eq 7) 'The FC1 budget must cover seven total scale groups.'
Assert-Host ($worstCaseCores -eq 197) 'The FC1 budget formula 1 + (7 * 28) must equal 197 cores.'
Assert-Host ((250 - $worstCaseCores) -eq 53) 'The FC1 default must retain 53 cores below the documented 250-core regional default.'
Assert-Host ($registrations -match "app\.http\('effectivePolicy'") 'The policy resolution route must be registered.'
Assert-Host ($registrations -match "route:\s*'v1/internal/effective-policy'") 'The policy resolution route path must match the gateway contract.'
Assert-Host ($registrations -notmatch 'CosmosClient|createPolicyResolver\(|composeEffectivePolicy|createGovernancePublisher\(|createPublishGovernanceHandler\(') 'Registrations must declare routes only, never build behaviour.'
Assert-Host ($registrations -notmatch 'createPersonaScopedResolver|isKnownPersona|personaGuard') 'The deployed Functions host must never serve deterministic persona policy as caller-specific governance.'
Assert-Host ($registrations -match 'createDeployedPolicyResolver') 'The deployed host must build policy resolution from published governance.'
Assert-Host ($registrations -match "route:\s*'v1/admin/governance/publish'") 'The publication route must be registered, because a closed store can only be written from inside the network.'

# A finding nobody can read is a finding nobody acts on, and the store is closed to
# the public network, so the ledger needs a route of its own.
Assert-Host ($registrations -match "route:\s*'v1/admin/notifications'") 'The notifications route must be registered.'
Assert-Host ($registrations -match "route:\s*'v1/admin/notifications/acknowledge'") 'The acknowledgement route must be registered.'
$consoleScreens = Get-Content -LiteralPath (Join-Path $repositoryRoot 'tools/build-admin-ui.mjs') -Raw
Assert-Host ($consoleScreens -match "screens:\s*\[[^\]]*'notifications'") 'A route the deployment serves must be offered by the console, or nobody can reach it.'
Assert-Host ($registrations -match 'if \(publishGovernance !== null\)') 'A deployment with no store must not offer a publication route it cannot serve.'

# Publishing a set could be done and composing one could not, so a deployment could be
# bootstrapped and then never changed. These two are the surface that changes it.
Assert-Host ($registrations -match "route:\s*'v1/admin/access-options'") 'The access options route must be registered, or nothing can name what an entitlement change may choose from.'
Assert-Host ($registrations -match "route:\s*'v1/admin/entitlements'") 'The entitlement change route must be registered, or a published set can never be changed in place.'
Assert-Host ($registrations -match 'if \(accessAuthoring !== null\)') 'A deployment with no store must not offer authoring routes it cannot serve.'

# Entitlements was the narrowest useful slice of "nothing can change a published set".
# Budgets, the downgrade plan, and role assignments are the rest of what the local
# development server could already author, and each needs the same POST route,
# inside the same guard, or a deployment can read them but never change them.
$authoringBlockMatch = [regex]::Match($registrations, '(?s)if \(accessAuthoring !== null\) \{(?<body>.*?)\r?\n\}')
Assert-Host ($authoringBlockMatch.Success) 'The authoring routes must sit inside a single "accessAuthoring !== null" guard.'
$authoringBlock = $authoringBlockMatch.Groups['body'].Value
foreach ($registration in @(
        @{ Route = 'v1/admin/budgets'; Function = 'changeBudget' },
        @{ Route = 'v1/admin/fallback'; Function = 'changeFallbackPlan' },
        @{ Route = 'v1/admin/assignments'; Function = 'changeAssignment' },
        # Which directory group is which governed team. Without it a team can only be
        # introduced by publishing a whole set from a script, which is a developer task
        # rather than an administrative one.
        @{ Route = 'v1/admin/teams'; Function = 'changeTeam' },
        @{ Route = 'v1/admin/models'; Function = 'changeModel' })) {
    $functionMatch = [regex]::Match(
        $registrations,
        "app\.http\('$($registration.Function)',\s*\{(?<body>.*?)\r?\n\s*\}\);",
        [System.Text.RegularExpressions.RegexOptions]::Singleline)
    Assert-Host ($functionMatch.Success) "The $($registration.Function) route must be registered."
    $functionBody = $functionMatch.Groups['body'].Value
    Assert-Host ($functionBody -match "route:\s*'$($registration.Route)'") "$($registration.Function) must register route $($registration.Route)."
    Assert-Host ($functionBody -match "methods:\s*\['POST'\]") "$($registration.Function) must be a POST, so it cannot collide with the screen's GET reading of the same path."
    Assert-Host ($authoringBlock.Contains("app.http('$($registration.Function)'")) "$($registration.Function) must sit inside the 'accessAuthoring !== null' guard."
}
# Capturing a model needs the provider's own answer about the deployment, which a
# deployment with no account configured cannot get, so this one route carries its own
# inner guard rather than being offered and failing every request.
Assert-Host ($authoringBlock -match 'if \(accessAuthoring\.changeModel !== null\)') 'The model capture route must not be offered when the deployment cannot read the provider.'
Assert-Host ($authoringBlock -match 'if \(accessAuthoring\.modelPrices !== null\)') 'The reference price route must not be offered when the deployment cannot read the provider.'

# The remaining five screens had a reading, a projector, a local route, and tests, and
# no deployed route at all. Each must be registered, and each must sit inside the same
# "screens !== null" guard as users-groups and models, or a deployment with no read
# source would offer a route that fails on every request.
$screensBlockMatch = [regex]::Match($registrations, '(?s)if \(screens !== null\) \{(?<body>.*?)\r?\n\}')
Assert-Host ($screensBlockMatch.Success) 'The screen routes must sit inside a single "screens !== null" guard.'
$screensBlock = $screensBlockMatch.Groups['body'].Value
foreach ($route in @(
        'v1/admin/budgets',
        'v1/admin/usage',
        'v1/admin/fallback',
        'v1/admin/lifecycle',
        'v1/admin/audit')) {
    $routeLiteral = "route: '$route'"
    Assert-Host ($registrations.Contains($routeLiteral)) "The $route route must be registered."
    Assert-Host ($screensBlock.Contains($routeLiteral)) "The $route route must sit inside the 'screens !== null' guard."
}
# The change log needs the durable notification ledger, which not every deployment
# has, so its route carries its own inner guard rather than always being offered.
Assert-Host ($screensBlock -match 'if \(screens\.audit !== null\)') 'The change log route must not be offered when the deployment has no notification ledger.'

# The published resolver replaced the one that always reported unavailable, so the rule
# that mattered is now about where its evidence comes from rather than that it refuses.
$compositionRoot = Get-Content -LiteralPath (Join-Path $repositoryRoot 'app\functions\composition-root.mjs') -Raw
Assert-Host ($compositionRoot -match 'createUnavailablePolicyResolver') 'An unconfigured deployment must still have a resolver that reports unavailable.'
foreach ($module in @(
        'app\control-api\published-policy-source.mjs',
        'app\control-api\stored-membership-resolver.mjs',
        'app\control-api\gateway-identity.mjs')) {
    $source = Get-Content -LiteralPath (Join-Path $repositoryRoot $module) -Raw
    Assert-Host ($source -notmatch 'local-adapters') "$module must not read deterministic development data."
}

# The scheduled projector produces the rollups the dashboards read. Its listener
# needs the platform storage account, which is why the storage emulator is a
# local prerequisite rather than an optional convenience.
Assert-Host ($registrations -match "app\.timer\('rollupProjector'") 'The scheduled rollup projector must be registered.'
$schedule = [regex]::Match($registrations, "schedule:\s*'(?<value>[^']+)'")
Assert-Host ($schedule.Success) 'The scheduled projector must declare a schedule.'
Assert-Host ($schedule.Groups['value'].Value.Split(' ').Count -eq 6) 'The schedule must be a six-field expression including seconds.'

# Delivery is what makes the five-minute promise true, so the timer that does it is
# part of the host contract rather than an optional extra. Its cron expression is
# derived from the interval constant, and a value that is not a whole number of
# minutes dividing an hour produces an expression the host rejects at startup — a
# configuration mistake that would take the whole registration file down with it.
Assert-Host ($registrations -match "app\.timer\('notificationDispatcher'") 'The notification dispatcher must be registered.'
$dispatchInterval = [regex]::Match(
    (Get-Content -LiteralPath (Join-Path $repositoryRoot 'app/functions/composition-root.mjs') -Raw),
    'NOTIFICATION_DISPATCH_INTERVAL_SECONDS\s*=\s*(?<value>\d+)')
Assert-Host ($dispatchInterval.Success) 'The dispatch interval must be declared as a constant.'
$intervalSeconds = [int]$dispatchInterval.Groups['value'].Value
Assert-Host ($intervalSeconds -le 300) 'The dispatch interval cannot exceed the five-minute delay the product promises.'
Assert-Host ($intervalSeconds % 60 -eq 0) 'The dispatch interval must be a whole number of minutes to express as cron.'
Assert-Host (60 % ($intervalSeconds / 60) -eq 0) 'The dispatch interval must divide an hour, or the last run of each hour is short.'

# Drift detection is the only thing that can tell an administrator the picture is
# wrong, so a build where it exists but nothing runs it looks identical to one where
# it works. It must read after the aggregation it compares against, never beside it.
Assert-Host ($registrations -match "app\.timer\('driftDetector'") 'The drift comparison must be registered.'
$driftSchedule = [regex]::Match(
    $registrations,
    "app\.timer\('driftDetector',\s*\{\s*schedule:\s*'(?<value>[^']+)'")
Assert-Host ($driftSchedule.Success) 'The drift comparison must declare a schedule.'
$driftFields = $driftSchedule.Groups['value'].Value.Split(' ')
Assert-Host ($driftFields.Count -eq 6) 'The drift schedule must be a six-field expression including seconds.'
$rollupMatch = [regex]::Match($registrations, "app\.timer\('rollupProjector',\s*\{\s*schedule:\s*'\d+ (?<value>\d+)")
# A failed match would leave the minute at zero and pass this comparison against
# anything, which is the shape of a check that cannot fail.
Assert-Host ($rollupMatch.Success) 'The aggregation schedule must be readable to order the comparison after it.'
Assert-Host ([int]$driftFields[1] -gt [int]$rollupMatch.Groups['value'].Value) 'The drift comparison must run after the aggregation it reads, not before it.'

# The budget comparison is the only thing that raises a budget warning. It was built,
# tested, and registered nowhere, so every deployment reported a period that earned no
# warnings. Like the drift comparison it reads the aggregates and must follow them.
Assert-Host ($registrations -match "app\.timer\('budgetNotifications'") 'The budget comparison must be registered, or no budget warning is ever raised.'
$budgetSchedule = [regex]::Match(
    $registrations,
    "app\.timer\('budgetNotifications',\s*\{\s*schedule:\s*'(?<value>[^']+)'")
Assert-Host ($budgetSchedule.Success) 'The budget comparison must declare a schedule.'
$budgetFields = $budgetSchedule.Groups['value'].Value.Split(' ')
Assert-Host ($budgetFields.Count -eq 6) 'The budget schedule must be a six-field expression including seconds.'
Assert-Host ([int]$budgetFields[1] -gt [int]$rollupMatch.Groups['value'].Value) 'The budget comparison must run after the aggregation it reads, not before it.'

# The users-and-groups screen reads a stored roster, and until this timer existed
# nothing wrote one, so a deployment could only ever answer that it had no reading.
Assert-Host ($registrations -match "app\.timer\('directoryProjector'") 'The directory reading must be registered, or the users and groups screen has nothing to read.'
Assert-Host ($registrations -match 'if \(directoryProjector !== null\)') 'A deployment without a store, a pseudonym secret, or a tenant must not register a reading it cannot take.'
$directorySchedule = [regex]::Match(
    $registrations,
    "app\.timer\('directoryProjector',\s*\{\s*schedule:\s*'(?<value>[^']+)'")
Assert-Host ($directorySchedule.Success) 'The directory reading must declare a schedule.'
Assert-Host ($directorySchedule.Groups['value'].Value.Split(' ').Count -eq 6) 'The directory schedule must be a six-field expression including seconds.'

$funcIgnorePath = Join-Path $repositoryRoot '.funcignore'
Assert-Host (Test-Path -LiteralPath $funcIgnorePath -PathType Leaf) 'A deployment package filter must exist.'
$funcIgnore = @(Get-Content -LiteralPath $funcIgnorePath | Where-Object { $_.Trim().Length -gt 0 })
foreach ($excluded in @('tests', 'infra', 'docs', '.internal', 'local.settings.json')) {
    Assert-Host ($funcIgnore -contains $excluded) "The deployment package must exclude: $excluded"
}

$coreTools = Get-Command func -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

[pscustomobject]@{
    DeploymentRoot = 'repository root'
    EntryPoint     = $package.main
    NodeVersion    = $declaredNode
    ExtensionBundle = $hostConfig.extensionBundle.version
    CoreToolsPresent = [bool]$coreTools
    CoreToolsPath = if ($coreTools) { $coreTools.Source } else { $null }
    Result         = 'Pass'
} | Format-List
