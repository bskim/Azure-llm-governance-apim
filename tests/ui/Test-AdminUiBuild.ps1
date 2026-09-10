[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'

function Assert-Build {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

Push-Location $RepositoryRoot
try {
    $bundlePath = Join-Path $RepositoryRoot 'app\admin-ui\public\vendor\entra-session.js'
    $noticePath = Join-Path $RepositoryRoot 'app\admin-ui\public\vendor\THIRD-PARTY-NOTICES.txt'
    Remove-Item -LiteralPath $bundlePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $noticePath -Force -ErrorAction SilentlyContinue
    $vendorDirectory = Split-Path -Parent $bundlePath
    if (Test-Path -LiteralPath $vendorDirectory) {
        [System.IO.Directory]::Delete($vendorDirectory)
    }

    # The bundle is a build artifact rather than a committed file, so the build itself
    # is what has to keep working.
    Push-Location (Join-Path $RepositoryRoot 'tests')
    try {
        & node (Join-Path $RepositoryRoot 'tools\build-admin-ui.mjs') | Out-Null
    }
    finally {
        Pop-Location
    }
    Assert-Build ($LASTEXITCODE -eq 0) 'The administration console bundle failed to build.'
    Assert-Build (Test-Path -LiteralPath $bundlePath -PathType Leaf) 'The build did not produce the session bundle.'
    Assert-Build (Test-Path -LiteralPath $noticePath -PathType Leaf) 'The build did not produce third-party notices for the bundle.'

    $bundle = Get-Content -LiteralPath $bundlePath -Raw
    $notices = Get-Content -LiteralPath $noticePath -Raw
    Assert-Build ($bundle.Contains('createEntraSession')) 'The bundle must export the session factory the console loads.'
    Assert-Build ($bundle -notmatch 'sourceMappingURL') 'A browser bundle must not ship a source map reference.'
    foreach ($package in @(
        @{ Name = '@azure/msal-browser'; Version = '5.17.1' },
        @{ Name = '@azure/msal-common'; Version = '16.11.2' }
    )) {
        $licensePath = Join-Path $RepositoryRoot "node_modules\$($package.Name)\LICENSE"
        $license = Get-Content -LiteralPath $licensePath -Raw
        Assert-Build ($notices.Contains("Package: $($package.Name)")) "The notice must identify $($package.Name)."
        Assert-Build ($notices.Contains("Version: $($package.Version)")) "The notice must identify the bundled $($package.Name) version."
        Assert-Build ($notices.Contains($license)) "The notice must preserve the full upstream license text for $($package.Name)."
    }
    Assert-Build ($notices -notmatch '(?m)^Package: esbuild$') 'The notice must cover bundled packages, not the build tool.'
    $firstNoticeHash = (Get-FileHash -LiteralPath $noticePath -Algorithm SHA256).Hash

    # The library supports several caches, so what matters is which one this source
    # selects: a token must not outlive the browser session or reach another tab.
    $source = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'app\admin-ui\src\entra-session.mjs') -Raw
    Assert-Build ($source -match "cacheLocation:\s*'sessionStorage'") 'The session must not persist a token beyond the browser session.'
    Assert-Build ($source -notmatch 'localStorage') 'The session must not select a cache shared across tabs.'
    Assert-Build ($source -notmatch 'console\.log|document\.cookie') 'A token must never be logged or written to a cookie.'

    # Only this module and its generated notice are bundled. Everything a reviewer
    # reads on a screen is served as written, so hidden behaviour cannot arrive through
    # the build.
    $vendorFiles = @(Get-ChildItem -LiteralPath (Split-Path -Parent $bundlePath) -File)
    Assert-Build ($vendorFiles.Count -eq 2) 'The build must produce exactly one bundled module and its notice.'
    Assert-Build (@($vendorFiles.Name | Sort-Object) -join ',' -eq 'entra-session.js,THIRD-PARTY-NOTICES.txt') 'The vendor directory must contain only the bundle and its notice.'

    $ignored = & git check-ignore -q 'app/admin-ui/public/vendor/entra-session.js'
    Assert-Build ($LASTEXITCODE -eq 0) 'The build artifact must not be tracked in version control.'
    $ignored = & git check-ignore -q 'app/admin-ui/public/vendor/THIRD-PARTY-NOTICES.txt'
    Assert-Build ($LASTEXITCODE -eq 0) 'The generated third-party notice must not be tracked in version control.'

    $tracked = @(& git ls-files 'app/admin-ui/public/vendor')
    Assert-Build ($tracked.Count -eq 0) 'No build output may be committed.'

    $manifest = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json
    Assert-Build ($null -ne $manifest.devDependencies.'@azure/msal-browser') 'The console authentication library must be a build input, not a runtime dependency.'
    Assert-Build ($null -ne $manifest.devDependencies.esbuild) 'The bundler must be a development dependency.'
    Assert-Build ($null -eq $manifest.dependencies.'@azure/msal-browser') 'The deployed function package must not carry a browser library.'

    # A partially configured console would sign a caller in and then fail every
    # request, so the configuration is all-or-nothing.
    $configPath = Join-Path $RepositoryRoot 'app\admin-ui\public\admin-config.json'
    Assert-Build (-not (Test-Path -LiteralPath $configPath)) 'An unconfigured build must not leave deployment configuration behind.'

    $env:ENTRA_ADMIN_SPA_APPLICATION_ID = 'spa-contract'
    $env:ENTRA_TENANT_ID = 'tenant-contract'
    $env:ENTRA_ADMIN_API_SCOPE = 'api://resource/Governance.Access'
    $env:CONTROL_PLANE_ENDPOINT = 'https://control-plane.example.invalid'
    try {
        & node (Join-Path $RepositoryRoot 'tools\build-admin-ui.mjs') | Out-Null
        Assert-Build (Test-Path -LiteralPath $configPath) 'A fully configured build must write the console configuration.'
        Assert-Build ((Get-FileHash -LiteralPath $noticePath -Algorithm SHA256).Hash -eq $firstNoticeHash) 'Consecutive builds must produce deterministic third-party notices.'
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        Assert-Build ($config.mode -eq 'entra') 'A configured console must select the identity provider explicitly.'
        Assert-Build ($config.authority -eq 'https://login.microsoftonline.com/tenant-contract') 'The authority must be derived from the deployment tenant.'
        Assert-Build ($config.apiBaseUrl -eq 'https://control-plane.example.invalid') 'The console must be told which API to call.'
        Assert-Build ($config.capabilities.modelAuthoring -eq $false) 'Model authoring must be hidden when the provider route is absent.'
        Assert-Build ($config.capabilities.modelPrices -eq $false) 'Model prices must be hidden when the provider route is absent.'
        Assert-Build ($null -eq $config.clientSecret -and $config.PSObject.Properties.Name -notcontains 'secret') 'Console configuration must never carry a secret.'

        $env:FOUNDRY_ACCOUNT_RESOURCE_ID = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/foundry'
        & node (Join-Path $RepositoryRoot 'tools\build-admin-ui.mjs') | Out-Null
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        Assert-Build ($config.capabilities.modelAuthoring -eq $true) 'Model authoring must be shown when its provider-backed route is registered.'
        Assert-Build ($config.capabilities.modelPrices -eq $true) 'Model prices must be shown when its provider-backed route is registered.'

        Remove-Item Env:\ENTRA_ADMIN_SPA_APPLICATION_ID
        & node (Join-Path $RepositoryRoot 'tools\build-admin-ui.mjs') | Out-Null
        Assert-Build (-not (Test-Path -LiteralPath $configPath)) 'A build missing one value must remove the configuration rather than write a partial one.'
    }
    finally {
        foreach ($name in @('ENTRA_ADMIN_SPA_APPLICATION_ID', 'ENTRA_TENANT_ID', 'ENTRA_ADMIN_API_SCOPE', 'CONTROL_PLANE_ENDPOINT', 'FOUNDRY_ACCOUNT_RESOURCE_ID')) {
            Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
    }

    [pscustomobject]@{
        Bundle = 'app/admin-ui/public/vendor/entra-session.js'
        Notice = 'app/admin-ui/public/vendor/THIRD-PARTY-NOTICES.txt'
        BundleKilobytes = [math]::Round((Get-Item -LiteralPath $bundlePath).Length / 1KB, 1)
        VendorFiles = $vendorFiles.Count
        Tracked = $false
        Result = 'Pass'
    } | Format-List
}
finally {
    Pop-Location
}
