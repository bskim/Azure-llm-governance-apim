[CmdletBinding()]
param(
    [string]$ContainerName = 'cosmos-governance-integration',
    [int]$ReadyTimeoutSeconds = 180,
    [int]$RequiredStableDataPlanePolls = 3,
    [string]$DataPlaneEndpoint = 'http://localhost:8081'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$emulatorImage = 'mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-latest'

function Assert-Integration {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Test-EmulatorEndpoint {
    param([string]$Uri)
    try {
        $response = Invoke-WebRequest -Uri $Uri -TimeoutSec 3 -SkipHttpErrorCheck -ErrorAction SilentlyContinue
        return $null -ne $response -and $response.StatusCode -eq 200
    }
    catch { return $false }
}

<#
    A working container command may be provided by a shell wrapper that a script
    cannot rely on, so the runtime is resolved explicitly and never assumed.
#>
function Resolve-ContainerRuntime {
    $native = Get-Command 'docker.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($native) {
        return [pscustomobject]@{ Executable = $native.Source; Prefix = @() }
    }

    $wsl = Get-Command 'wsl.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($wsl) {
        & $wsl.Source -e docker --version 1>$null 2>$null
        if ($LASTEXITCODE -eq 0) {
            return [pscustomobject]@{ Executable = $wsl.Source; Prefix = @('-e', 'docker') }
        }
    }

    throw @'
No scriptable container runtime was found.

The Azure Cosmos DB emulator is required for persistence integration tests.
Install a container runtime that exposes a native `docker` executable on PATH, or
enable Docker inside WSL so that `wsl -e docker` succeeds. A shell alias or
profile function is not sufficient, because it is unavailable to scripts and to
continuous integration.
'@
}

function Invoke-ContainerRuntime {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
    $output = & $script:runtime.Executable @($script:runtime.Prefix + $Arguments) 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output -join "`n") }
}

function Get-ContainerState {
    param([string]$Name)
    $inspect = Invoke-ContainerRuntime 'inspect' '-f' '{{.State.Status}}' $Name
    if ($inspect.ExitCode -ne 0) { return 'absent' }
    return $inspect.Output.Trim()
}

function Get-ContainerDiagnostics {
    param([string]$Name)
    $state = Get-ContainerState -Name $Name
    $logs = Invoke-ContainerRuntime 'logs' '--tail' '20' $Name
    return "container state: $state`n--- container log (last 20 lines) ---`n$($logs.Output)"
}

$script:runtime = Resolve-ContainerRuntime
Write-Verbose "Container runtime: $($script:runtime.Executable) $($script:runtime.Prefix -join ' ')"

$started = $false
try {
    Invoke-ContainerRuntime 'rm' '-f' $ContainerName | Out-Null

    # A removal returns before the name and its port bindings are actually released, and a
    # container started into that window comes up unusable rather than failing to start.
    $removalDeadline = (Get-Date).AddSeconds(30)
    while ((Get-ContainerState -Name $ContainerName) -ne 'absent' -and (Get-Date) -lt $removalDeadline) {
        Start-Sleep -Milliseconds 500
    }
    Assert-Integration ((Get-ContainerState -Name $ContainerName) -eq 'absent') `
        "A previous emulator container named $ContainerName could not be removed."

    $run = Invoke-ContainerRuntime 'run' '-d' '--name' $ContainerName '-p' '8081:8081' '-p' '8080:8080' $emulatorImage
    Assert-Integration ($run.ExitCode -eq 0) "Failed to start the Cosmos emulator: $($run.Output)"
    $started = $true

    # The health probe has been observed reporting ready while the data plane the tests
    # actually use was still refusing connections, so both are gated and the data plane
    # must hold across consecutive polls rather than answer once.
    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
    $healthy = $false
    $stableDataPlanePolls = 0
    $lastObservation = 'no probe completed'
    while ((Get-Date) -lt $deadline) {
        $state = Get-ContainerState -Name $ContainerName
        if ($state -ne 'running') {
            throw "The Cosmos emulator container stopped before it became usable.`n$(Get-ContainerDiagnostics -Name $ContainerName)"
        }
        $health = Test-EmulatorEndpoint -Uri 'http://localhost:8080/ready'
        $dataPlane = Test-EmulatorEndpoint -Uri "$DataPlaneEndpoint/"
        if ($dataPlane) { $stableDataPlanePolls++ } else { $stableDataPlanePolls = 0 }
        $lastObservation = "health probe: $health, data plane: $dataPlane"
        if ($health -and $stableDataPlanePolls -ge $RequiredStableDataPlanePolls) { $healthy = $true; break }
        Start-Sleep -Milliseconds 1500
    }
    if (-not $healthy) {
        throw @"
The Cosmos emulator did not become usable within $ReadyTimeoutSeconds seconds.
Last observation - $lastObservation.
$(Get-ContainerDiagnostics -Name $ContainerName)
"@
    }

    $env:COSMOS_TEST_ENDPOINT = "$DataPlaneEndpoint/"
    # Published, fixed emulator account key. It authenticates nothing outside this
    # throwaway local container.
    $env:COSMOS_TEST_KEY = 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw=='
    $env:COSMOS_TEST_DATABASE = 'governance-integration'

    Push-Location $repositoryRoot
    try {
        # Sequential: both files provision the database they share, and running them
        # together races that creation rather than testing anything.
        & node --test --test-concurrency=1 '.\tests\persistence\cosmos-governance-store.integration.test.mjs' '.\tests\persistence\durability-recovery.test.mjs' '.\tests\persistence\stored-source-durability.test.mjs'
        Assert-Integration ($LASTEXITCODE -eq 0) 'Cosmos governance store integration tests failed.'
    }
    finally {
        Pop-Location
    }
}
finally {
    Remove-Item Env:\COSMOS_TEST_ENDPOINT -ErrorAction SilentlyContinue
    Remove-Item Env:\COSMOS_TEST_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\COSMOS_TEST_DATABASE -ErrorAction SilentlyContinue
    if ($started) { Invoke-ContainerRuntime 'rm' '-f' $ContainerName | Out-Null }
}

[pscustomobject]@{
    Emulator = $emulatorImage
    Runtime = "$($script:runtime.Executable) $($script:runtime.Prefix -join ' ')".Trim()
    Result = 'Pass'
}
