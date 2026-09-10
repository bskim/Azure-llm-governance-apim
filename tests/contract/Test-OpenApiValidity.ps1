[CmdletBinding()]
param(
    # Every document this gateway publishes, not one named default: a document added later
    # would otherwise arrive with nothing checking it and nothing saying so.
    [string[]]$SpecificationPath = @(
        Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '..\..\apim\apis') -Filter '*.openapi.json' |
            ForEach-Object { $_.FullName }
    )
)

$ErrorActionPreference = 'Stop'

function Assert-OpenApi {
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

function Find-InvalidTypeArrays {
    param(
        [Parameter(Mandatory)]
        [object]$Node,

        [string]$Path = '$'
    )

    $results = @()
    if ($null -eq $Node) {
        return $results
    }

    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        foreach ($property in $Node.PSObject.Properties) {
            if ($property.Name -eq 'type' -and $property.Value -is [array]) {
                $results += "$Path.type"
            }
            $results += Find-InvalidTypeArrays -Node $property.Value -Path "$Path.$($property.Name)"
        }
    }
    elseif ($Node -is [array]) {
        for ($index = 0; $index -lt $Node.Count; $index++) {
            $results += Find-InvalidTypeArrays -Node $Node[$index] -Path "$Path[$index]"
        }
    }

    return $results
}

Assert-OpenApi ($SpecificationPath.Count -ge 1) 'No published API document was found to validate.'

$report = foreach ($path in $SpecificationPath) {
$specification = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$invalidTypeArrays = @(Find-InvalidTypeArrays -Node $specification)

Assert-OpenApi ($specification.openapi -eq '3.0.3') 'This validator is scoped to the OpenAPI 3.0.3 contract.'
Assert-OpenApi ($invalidTypeArrays.Count -eq 0) "OpenAPI 3.0.3 does not allow array-valued schema types: $($invalidTypeArrays -join ', ')"

# Not every document this validator is pointed at declares an error body. The metadata
# document answers one anonymous GET and has no failure shape of its own, so the error
# contract is checked where it exists rather than demanded of every document.
$errorSchema = $specification.components.schemas.PSObject.Properties['Error']
if ($null -ne $errorSchema) {
    foreach ($fieldName in @('param', 'code')) {
        $field = $errorSchema.Value.properties.error.properties.PSObject.Properties[$fieldName].Value
        Assert-OpenApi ($field.type -eq 'string' -and $field.nullable -eq $true) "Error.$fieldName must be a nullable OpenAPI 3.0 string."
    }
}

$document = $specification | ConvertTo-Json -Depth 100
$references = @([regex]::Matches($document, '"\$ref"\s*:\s*"(?<value>#[^"]+)"'))
foreach ($reference in $references) {
    $segments = $reference.Groups['value'].Value.Substring(2).Split('/') | ForEach-Object {
        $_.Replace('~1', '/').Replace('~0', '~')
    }
    $current = $specification
    foreach ($segment in $segments) {
        $property = $current.PSObject.Properties[$segment]
        Assert-OpenApi ($null -ne $property) "Unresolved local OpenAPI reference: $($reference.Groups['value'].Value)"
        $current = $property.Value
    }
}

[pscustomobject]@{
    Specification = Split-Path -Leaf $path
    LocalReferences = $references.Count
    InvalidTypeArrays = $invalidTypeArrays.Count
    Result = 'Pass'
}
}

$report | Format-List