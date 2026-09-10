[CmdletBinding()]
param(
    [string]$SpecificationPath = (Join-Path $PSScriptRoot '..\..\apim\apis\inference.openapi.json')
)

$ErrorActionPreference = 'Stop'

function Assert-WireContract {
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

$specification = Get-Content -LiteralPath $SpecificationPath -Raw | ConvertFrom-Json
$operations = @(
    $specification.paths.'/v1/chat/completions'.post
    $specification.paths.'/v1/responses'.post
)

foreach ($operation in $operations) {
    $success = $operation.responses.'200'
    $contentTypes = @($success.content.PSObject.Properties.Name | Sort-Object)
    $statusCodes = @($operation.responses.PSObject.Properties.Name | Sort-Object)

    Assert-WireContract (($contentTypes -join '|') -eq 'application/json|text/event-stream') "Operation $($operation.operationId) must declare JSON and SSE success media types."
    Assert-WireContract ($success.headers.'x-request-id'.'$ref' -eq '#/components/headers/RequestId') "Operation $($operation.operationId) must return x-request-id."
    Assert-WireContract ($success.headers.'x-requested-model'.'$ref' -eq '#/components/headers/RequestedModel') "Operation $($operation.operationId) must expose the requested logical model."
    Assert-WireContract ($success.headers.'x-effective-model'.'$ref' -eq '#/components/headers/EffectiveModel') "Operation $($operation.operationId) must expose the effective model deployment."
    Assert-WireContract ($success.headers.'x-usage-quality'.'$ref' -eq '#/components/headers/UsageQuality') "Operation $($operation.operationId) must expose usage quality."

    foreach ($requiredStatus in @('200', '400', '401', '403', '429', '500', '502', '503')) {
        Assert-WireContract ($statusCodes -contains $requiredStatus) "Operation $($operation.operationId) is missing status $requiredStatus."
    }
}

$chatSchema = $specification.components.schemas.ChatCompletionResponse
$responseSchema = $specification.components.schemas.ResponseObject
$usageSchema = $specification.components.schemas.Usage
$errorSchema = $specification.components.schemas.Error.properties.error

foreach ($requiredField in @('id', 'object', 'created', 'model', 'choices')) {
    Assert-WireContract (@($chatSchema.required) -contains $requiredField) "Chat response is missing required field $requiredField."
}

foreach ($requiredField in @('id', 'object', 'status', 'model', 'output')) {
    Assert-WireContract (@($responseSchema.required) -contains $requiredField) "Responses object is missing required field $requiredField."
}

foreach ($tokenField in @('input_tokens', 'output_tokens', 'total_tokens')) {
    $property = $usageSchema.properties.PSObject.Properties[$tokenField].Value
    Assert-WireContract ($property.type -eq 'integer' -and $property.minimum -eq 0) "Usage field $tokenField must be a non-negative integer."
}

Assert-WireContract ($specification.components.schemas.EventStream.type -eq 'string') 'SSE payloads must be declared as UTF-8 event-stream text.'
Assert-WireContract (@($errorSchema.required) -contains 'message') 'OpenAI-compatible error objects must require a message.'
Assert-WireContract ((@($specification.components.headers.UsageQuality.schema.enum) -join '|') -eq 'reported|estimated|unknown') 'Usage quality must use the reported, estimated, or unknown taxonomy.'

foreach ($errorField in @('message', 'type', 'param', 'code')) {
    Assert-WireContract ($null -ne $errorSchema.properties.PSObject.Properties[$errorField]) "Error schema is missing field $errorField."
}

$sharedResponses = $specification.components.responses
foreach ($responseName in @('BadRequest', 'Unauthorized', 'Forbidden', 'TooManyRequests', 'InternalServerError', 'BadGateway', 'ServiceUnavailable')) {
    $response = $sharedResponses.PSObject.Properties[$responseName].Value
    Assert-WireContract ($response.headers.'x-request-id'.'$ref' -eq '#/components/headers/RequestId') "Shared response $responseName must expose x-request-id."
    Assert-WireContract ($response.content.'application/json'.schema.'$ref' -eq '#/components/schemas/Error') "Shared response $responseName must use the common error schema."
}

Assert-WireContract ($sharedResponses.TooManyRequests.headers.'Retry-After'.schema.type -eq 'integer') '429 responses must declare an integer Retry-After header.'

[pscustomobject]@{
    Specification = (Resolve-Path -LiteralPath $SpecificationPath).Path
    OperationsChecked = $operations.Count
    RequiredStatusesPerOperation = 8
    SuccessMediaTypes = 2
    Result = 'Pass'
} | Format-List