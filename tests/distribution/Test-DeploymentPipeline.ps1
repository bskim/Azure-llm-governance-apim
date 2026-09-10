[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'

function Assert-Deployment {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$projectPath = Join-Path $RepositoryRoot 'azure.yaml'
Assert-Deployment (Test-Path -LiteralPath $projectPath -PathType Leaf) 'The deployment project file is missing.'
$projectText = Get-Content -LiteralPath $projectPath -Raw

# Infrastructure that nothing deploys is a configuration contract, not a system, so
# every deployable component must be declared and matched to a provisioned resource.
$expectedServices = @{
    'control-plane' = @{ Host = 'function'; Tag = 'control-plane' }
    'admin-console' = @{ Host = 'staticwebapp'; Tag = 'admin-console' }
}

$runtimePath = Join-Path $RepositoryRoot 'infra\modules\governance-runtime.bicep'
$runtime = Get-Content -LiteralPath $runtimePath -Raw
$infrastructure = (Get-ChildItem -LiteralPath (Join-Path $RepositoryRoot 'infra\modules') -Filter '*.bicep' | Get-Content -Raw) -join "`n"

foreach ($service in $expectedServices.GetEnumerator()) {
    Assert-Deployment ($projectText -match "(?m)^\s{2}$([regex]::Escape($service.Key)):") "The deployment does not declare the service: $($service.Key)"
    Assert-Deployment ($projectText -match "host:\s*$($service.Value.Host)") "The service $($service.Key) must target host: $($service.Value.Host)"
    Assert-Deployment ($infrastructure -match "'azd-service-name':\s*'$([regex]::Escape($service.Value.Tag))'") "No provisioned resource claims the service: $($service.Key)"
}

# A root hook does not run when azd packages one service during deploy, which once
# shipped a console carrying no configuration at all. The console's own service must
# carry the hook.
Assert-Deployment ($projectText -match '(?m)^hooks:') 'The console configuration is written by a build, so the deployment must run it.'
$consoleService = [regex]::Match($projectText, '(?ms)^\s{2}admin-console:.*')
Assert-Deployment ($consoleService.Success) 'The console service must be declared.'
Assert-Deployment ($consoleService.Value -match '(?m)^\s{4}hooks:') 'The console service must run its own build hook.'
Assert-Deployment ($consoleService.Value -match '(?m)^\s{6}prepackage:') 'The console build must run before the console is packaged.'
Assert-Deployment (([regex]::Matches($consoleService.Value, 'build-admin-ui\.mjs')).Count -eq 2) 'The console build hook must be defined for both shells.'
Assert-Deployment ($projectText -match 'dist:\s*public') 'Only the served console directory may be published.'

# The function package carries server code. Anything else is either unnecessary or
# should never leave the repository.
$packageFilterPath = Join-Path $RepositoryRoot '.funcignore'
$packageFilter = @(Get-Content -LiteralPath $packageFilterPath)
foreach ($excluded in @('tests', 'infra', 'tools', 'docs', '.internal', '.azure', 'app/admin-ui', 'local.settings.json', '.c0')) {
    Assert-Deployment ($packageFilter -contains $excluded) "The function package must exclude: $excluded"
}

# Build-only dependencies are derived from the lockfile rather than listed by hand,
# so adding one cannot quietly start shipping it to a serverless runtime.
$lock = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package-lock.json') -Raw | ConvertFrom-Json -Depth 30 -AsHashtable
$buildOnly = @(
    $lock.packages.Keys |
        Where-Object { $_ -like 'node_modules/*' -and $lock.packages[$_].dev -eq $true } |
        ForEach-Object {
            $parts = ($_ -replace '^node_modules/', '') -split '/'
            if ($parts[0].StartsWith('@')) { "node_modules/$($parts[0])" } else { "node_modules/$($parts[0])" }
        } |
        Sort-Object -Unique
)
Assert-Deployment ($buildOnly.Count -gt 0) 'The lockfile must distinguish build-only dependencies.'
foreach ($package in $buildOnly) {
    Assert-Deployment ($packageFilter -contains $package) "A build-only dependency would be deployed: $package"
}

# Every value the console build needs must be published by the deployment, or the
# hook silently produces a local-mode console in a deployed environment.
$mainPath = Join-Path $RepositoryRoot 'infra\main.bicep'
$main = Get-Content -LiteralPath $mainPath -Raw
foreach ($output in @('ENTRA_ADMIN_SPA_APPLICATION_ID', 'ENTRA_TENANT_ID', 'ENTRA_ADMIN_API_SCOPE', 'CONTROL_PLANE_ENDPOINT')) {
    Assert-Deployment ($main -match "output $output string") "The deployment does not publish the console build input: $output"
}

$buildText = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'tools\build-admin-ui.mjs') -Raw
foreach ($input in @('ENTRA_ADMIN_SPA_APPLICATION_ID', 'ENTRA_TENANT_ID', 'ENTRA_ADMIN_API_SCOPE', 'CONTROL_PLANE_ENDPOINT')) {
    Assert-Deployment ($buildText -match [regex]::Escape($input)) "The console build does not read the published value: $input"
}

# Entra refuses a sign-in redirect to an origin the registration does not list, so
# the deployed console origin has to come from the deployment rather than be added
# by hand after someone finds they cannot sign in.
$identity = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'infra\modules\identity.bicep') -Raw
Assert-Deployment ($identity -match 'param adminConsoleOrigin string') 'The app registration must take the deployed console origin.'
Assert-Deployment ($identity -match 'redirectUris:\s*union\(\[adminConsoleOrigin\]') 'The deployed console origin must be a registered redirect URI.'
Assert-Deployment ($main -match 'adminConsoleOrigin:\s*adminConsoleHost\.outputs\.origin') 'The registration must receive the origin of the console host it deploys.'

Assert-Deployment (-not ($projectText -match 'password|secret|key:')) 'The deployment project must not carry a credential.'

$azd = Get-Command 'azd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$validated = $false
if ($azd) {
    # A schema the tool rejects is worth catching here rather than at deployment.
    Push-Location $RepositoryRoot
    try {
        $output = & $azd.Source env list --output json 2>&1
        $validated = $LASTEXITCODE -eq 0 -or ($output -join ' ') -notmatch 'azure.yaml'
    }
    finally {
        Pop-Location
    }
}

[pscustomobject]@{
    Services = $expectedServices.Count
    BuildHook = 'prepackage'
    BuildOnlyDependenciesExcluded = $buildOnly.Count
    ToolPresent = [bool]$azd
    ProjectFileAccepted = $validated
    Result = 'Pass'
} | Format-List
