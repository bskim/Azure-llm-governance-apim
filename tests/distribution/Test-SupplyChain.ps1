[CmdletBinding()]
param(
    [switch]$ReleaseReadiness,
    [string]$RegistryPolicyPath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Assert-SupplyChain {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Test-SubresourceIntegrity {
    param([string]$Integrity)

    $match = [regex]::Match(
        $Integrity,
        '^(?<algorithm>sha1|sha256|sha384|sha512)-(?<digest>[A-Za-z0-9+/]+={0,2})$'
    )
    if (-not $match.Success) { return $false }

    $expectedBytes = @{
        sha1 = 20
        sha256 = 32
        sha384 = 48
        sha512 = 64
    }
    try {
        $digestBytes = [Convert]::FromBase64String($match.Groups['digest'].Value)
    }
    catch [FormatException] {
        return $false
    }
    return $digestBytes.Length -eq $expectedBytes[$match.Groups['algorithm'].Value]
}

Push-Location $repositoryRoot
try {
    $manifestPath = Join-Path $repositoryRoot 'package.json'
    $lockPath = Join-Path $repositoryRoot 'package-lock.json'
    Assert-SupplyChain (Test-Path -LiteralPath $manifestPath -PathType Leaf) 'The package manifest is missing.'
    Assert-SupplyChain (Test-Path -LiteralPath $lockPath -PathType Leaf) 'The dependency lockfile is missing, so installs are not reproducible.'

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -Depth 20
    Assert-SupplyChain ($manifest.private -eq $true) 'The package must stay private so it cannot be published accidentally.'
    Assert-SupplyChain ($manifest.type -eq 'module') 'The package must declare ES module semantics.'

    $lockText = Get-Content -LiteralPath $lockPath -Raw
    $lock = $lockText | ConvertFrom-Json -AsHashtable -Depth 100
    Assert-SupplyChain ($lock.lockfileVersion -eq 3) 'The dependency lockfile must use lockfile version 3.'
    Assert-SupplyChain ($lock.packages.ContainsKey('')) 'The dependency lockfile is missing its root package entry.'
    Assert-SupplyChain ($lock.packages[''].name -eq $manifest.name) 'The lockfile root package name does not match package.json.'
    Assert-SupplyChain ($lock.packages[''].version -eq $manifest.version) 'The lockfile root package version does not match package.json.'

    $resolvedPackages = @(
        $lock.packages.GetEnumerator() |
            Where-Object { $_.Value.ContainsKey('resolved') }
    )
    Assert-SupplyChain ($resolvedPackages.Count -gt 0) 'The lockfile has no resolved package entries.'
    $weakerIntegrityPackages = @()
    $integrityAlgorithms = @{}
    $versionRows = @()
    foreach ($resolvedPackage in $resolvedPackages) {
        $resolved = [uri]$resolvedPackage.Value.resolved
        Assert-SupplyChain ($resolved.Scheme -eq 'https') "The lockfile uses a non-HTTPS package source: $($resolvedPackage.Key)"
        Assert-SupplyChain (
            [string]$resolvedPackage.Value.version -match '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$'
        ) "The lockfile entry for $($resolvedPackage.Key) must use an exact version."
        Assert-SupplyChain ($resolvedPackage.Value.ContainsKey('integrity')) "The lockfile entry for $($resolvedPackage.Key) has no integrity hash."
        $integrity = [string]$resolvedPackage.Value.integrity
        Assert-SupplyChain (Test-SubresourceIntegrity $integrity) "The lockfile entry for $($resolvedPackage.Key) must use valid SRI."
        $algorithm = $integrity.Split('-', 2)[0]
        $integrityAlgorithms[$algorithm] = 1 + [int]($integrityAlgorithms[$algorithm] ?? 0)
        $versionRows += "$($resolvedPackage.Key)|$($resolvedPackage.Value.version)"
        if (-not $integrity.StartsWith('sha512-', [StringComparison]::Ordinal)) {
            $weakerIntegrityPackages += $resolvedPackage.Key
        }
    }
    $integrityCount = ([regex]::Matches($lockText, '"integrity"')).Count
    Assert-SupplyChain ($integrityCount -eq $resolvedPackages.Count) 'Every resolved package, and only a resolved package, must carry one integrity hash.'
    if ($ReleaseReadiness) {
        Assert-SupplyChain (-not [string]::IsNullOrWhiteSpace($RegistryPolicyPath)) 'Release readiness requires explicit registry-policy evidence.'
        Assert-SupplyChain (Test-Path -LiteralPath $RegistryPolicyPath -PathType Leaf) 'Registry-policy evidence is missing.'
        $policy = Get-Content -LiteralPath $RegistryPolicyPath -Raw | ConvertFrom-Json -AsHashtable -Depth 100
        $lockSha256 = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $inventoryText = (@($versionRows | Sort-Object) -join "`n")
        $inventorySha256 = [Convert]::ToHexString(
            [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($inventoryText))
        ).ToLowerInvariant()
        Assert-SupplyChain ($policy.schemaVersion -eq 1) 'Registry policy has an unsupported schema.'
        Assert-SupplyChain ($policy.lockfileSha256 -eq $lockSha256) 'Registry policy is not bound to the current lockfile.'
        Assert-SupplyChain ($policy.versionInventorySha256 -eq $inventorySha256) 'Registry policy is not bound to the current exact-version inventory.'
        $effectiveOrigin = ([uri][string]$policy.effectiveRegistryOrigin).GetLeftPart([System.UriPartial]::Authority)
        Assert-SupplyChain (
            $effectiveOrigin -eq $policy.effectiveRegistryOrigin -and
            ([uri]$policy.effectiveRegistryOrigin).Scheme -eq 'https' -and
            @($policy.approvedRegistryOrigins).Count -gt 0 -and
            @($policy.approvedRegistryOrigins) -contains $policy.effectiveRegistryOrigin
        ) 'The effective registry origin is not explicitly approved by customer policy.'
        foreach ($origin in @($policy.approvedRegistryOrigins)) {
            $uri = [uri][string]$origin
            Assert-SupplyChain (
                $uri.Scheme -eq 'https' -and
                $uri.GetLeftPart([System.UriPartial]::Authority) -eq $origin
            ) 'Every approved registry must be an HTTPS origin without path or credentials.'
        }
        Assert-SupplyChain (
            $policy.exactVersionsRequired -eq $true -and
            $policy.integrityRequired -eq $true -and
            $policy.packageManagerIntegrityEnforced -eq $true
        ) 'Exact-version and package-manager integrity enforcement policy is incomplete.'
        $allowedAlgorithms = @($policy.allowedIntegrityAlgorithms)
        Assert-SupplyChain (
            $allowedAlgorithms.Count -gt 0 -and
            @($integrityAlgorithms.Keys | Where-Object { $_ -notin $allowedAlgorithms }).Count -eq 0
        ) 'A lockfile integrity algorithm is not allowed by customer policy.'
    }

    foreach ($ignored in @('node_modules', '.npmrc')) {
        & git check-ignore -q $ignored
        Assert-SupplyChain ($LASTEXITCODE -eq 0) "$ignored must be excluded from version control."
    }

    $tracked = @(& git ls-files)
    foreach ($forbidden in @('.npmrc', 'node_modules')) {
        Assert-SupplyChain (-not ($tracked | Where-Object { $_ -like "$forbidden*" })) "$forbidden must not be tracked."
    }
}
finally {
    Pop-Location
}

[pscustomobject]@{
    LockfileVersion = $lock.lockfileVersion
    ResolvedPackages = $resolvedPackages.Count
    IntegrityHashes = $integrityCount
    IntegrityAlgorithms = (($integrityAlgorithms.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ',')
    WeakerIntegrityHashes = $weakerIntegrityPackages.Count
    ValidationMode = if ($ReleaseReadiness) { 'ReleaseReadiness' } else { 'StructuralIncomplete' }
    Result = 'Pass'
} | Format-List
