# PoC 빠른 시작

Azure 고객사의 개발팀이 새로 복제한 저장소에서 시작해 코딩 에이전트 요청 하나에 거버넌스를 적용하는 방법을 안내합니다. Azure 서비스로 호스팅 경로를 구성하며, 첫 평가는 기존 Foundry 모델 배포 하나, 새 APIM 하나, 개발팀용 Entra 그룹 하나, 별도 관리자 보안 주체 하나, 논리적 모델 이름 하나로 제한합니다.

Foundry 신규 생성, 비공개 관리 수신 경로 구성, 배포 실패 조사 방법은 [배포 참고 문서](01-deployment_ko.md)에서 설명합니다.

## 이 평가에서 확인하는 것

이 문서를 마치면 다음을 확인할 수 있습니다.

- 허용된 OpenAI 호환 요청이 APIM을 거쳐 Foundry 모델에 도달합니다.
- 승인되지 않은 모델은 게이트웨이 정책에서 거부됩니다.
- 호출자는 공급자 키나 APIM 구독 키 대신 Entra로 인증합니다.
- 콘솔에서 메시지 본문 없이 활성 거버넌스 리비전과 사용량을 확인합니다.
- 환경 단위 정리 계획으로 배포를 제거할 수 있습니다.

APIM `/v1` 엔드포인트로 보낸 요청만 거버넌스 대상입니다. Foundry 계정 또는 프로젝트에 직접 보낸 트래픽은 별도 경로입니다.

## 비용 및 보안 확인

이 평가에서는 과금되는 Azure 리소스를 만듭니다. Basic v2 API Management에는 시간당 고정 요금이 있고, 모델 추론, Flex Consumption, Cosmos DB, Storage, Key Vault, 프라이빗 엔드포인트, Log Analytics에도 사용량에 따른 비용이 발생할 수 있습니다. 실제 지역과 모델의 비용은 Azure 가격 계산기에서 확인하며 평가가 끝나면 환경을 제거합니다.

기본 `public-authenticated` 구성은 APIM과 관리 화면을 공개하지만 Microsoft Entra 인증을 요구합니다. 영속 저장소와 주체 키 저장소는 프라이빗 네트워크로 구성됩니다. 게이트웨이가 유일한 경로여야 한다면 거버넌스 적용 호출자에게 Foundry 계정 직접 추론 권한을 부여하지 마십시오. 공급자 키나 webhook URL을 소스 제어에 붙여 넣지 마십시오.

## 시작 전 준비

Node.js 24 이상, PowerShell 7, Azure CLI, Azure Developer CLI를 설치합니다. Docker는 빠른 검사에는 필요하지 않지만 전체 영속성 통합 검사에는 필요합니다.

배포 작업에는 다음 권한이 필요합니다. 조직에 따라 built-in role이나 custom role로 나누어 부여할 수 있습니다.

| 작업 | Azure 권한 | Microsoft Entra 권한 |
|---|---|---|
| PoC 배포 | 대상 리소스 그룹과 Foundry 계정 범위에서 리소스를 만들고 Azure 역할을 할당 | 애플리케이션 등록 및 서비스 주체를 만들고 관리하며 Administration API 역할을 할당 |
| 거버넌스 팀 준비 | 배포 외 추가 Azure 권한 없음 | 선택한 그룹의 개체 ID를 조회하고 구성원을 관리 |
| 초기 거버넌스 게시 | 배포 후 추가 Azure RBAC 없음 | 설정한 관리자 보안 주체의 구성원으로 배포된 관리 클라이언트에 로그인 |
| 선택적 사용자 및 그룹 명단 표시 | 배포 외 추가 Azure RBAC 없음 | Privileged Role Administrator가 제어 영역 관리 ID에 `GroupMember.Read.All`을 부여 |

명단 권한은 선택 사항입니다. 추론 정책, 토큰 제한, 사용량, 나머지 콘솔 화면에는 필요하지 않습니다.

## Repository 설치 및 검사

```powershell
git clone <repository-url>
Set-Location llm-governance-apim
node --version
npm ci
npm test
```

`npm test`는 빠르게 실행되는 크로스 플랫폼 단위 테스트 실행 명령입니다. 공개 로컬 검사에서 Cosmos DB 에뮬레이터와 외부 OpenAPI 린트까지 확인하려면 스크립트에서 호출할 수 있는 Docker 런타임을 시작하고 다음을 실행합니다.

```powershell
pwsh -NoProfile -File tests/Test-Local.ps1 -PublicOnly `
  -IncludePersistenceIntegration `
  -IncludeExternalOpenApiLint
```

전체 검사는 기본 `docker.exe` 또는 WSL의 Docker를 사용할 수 있습니다. 임시 로컬 에뮬레이터 컨테이너만 만들며 Azure 리소스는 배포하지 않습니다.

OpenAPI 린트 단계는 캐시만 사용합니다. 지정된 버전의 Redocly CLI를 오프라인으로 확인하며 검사 중에는 레지스트리에 접근하지 않으므로, 캐시가 없는 새 컴퓨터에서는 이 단계가 실패합니다. `-IncludeExternalOpenApiLint`를 사용하기 전에 조직이 승인한 레지스트리에서 다음과 같이 한 번만 미리 내려받습니다.

```powershell
$registry = (npm config get registry).Trim()
npx --yes --registry $registry @redocly/cli@2.39.0 --version
```


## Sign-in 및 가장 짧은 mode 선택

이 빠른 시작에서는 기존 Foundry 계정, 프로젝트, 모델 배포를 재사용하고 새 APIM과 거버넌스 리소스를 만듭니다. 조직이 보유한 모델로 거버넌스가 적용된 데이터 평면을 평가할 때 사용합니다.

```powershell
az login --tenant <tenant-id>
az account set --subscription <subscription-id>
azd auth login --tenant-id <tenant-id>
```

계속하기 전에 모델 배포와 구독 할당량을 확인합니다.

```powershell
az cognitiveservices account deployment list `
  --name <foundry-account> `
  --resource-group <foundry-resource-group> `
  --output table

az cognitiveservices usage list --location <region> --output table
```

사용할 수 있는 Foundry 모델 배포가 없다면 여기서 중단하고 [배포 참고 문서](01-deployment_ko.md#배포-모드-선택하기)의 모든 항목 생성 모드를 사용합니다.

## 평가 environment 설정

명령을 실행하기 전에 개발팀용 Entra 보안 그룹을 만듭니다. 테스트 요청을 보낼 사람은 이 그룹의 구성원이어야 합니다. 거버넌스 관리자에는 별도 그룹이나 사용자를 사용합니다. 이 environment 이름은 키 저장소 초기화에서도 사용하며, 소문자와 숫자, 하이픈만으로 최대 20자까지 지정할 수 있습니다.

```powershell
$environment = '<environment>'

azd env new $environment
azd env select $environment

azd env set AZURE_LOCATION <region> --environment $environment
azd env set AZURE_SUBSCRIPTION_ID <subscription-id> --environment $environment
azd env set GATEWAY_RESOURCE_GROUP_NAME <new-gateway-resource-group> --environment $environment
azd env set ENTRA_APPLICATION_OWNER_OBJECT_ID <operator-object-id> --environment $environment
azd env set GOVERNANCE_ADMINISTRATOR_PRINCIPAL_ID <administrator-user-or-group-object-id> --environment $environment
azd env set FOUNDRY_RESOURCE_GROUP_NAME <foundry-resource-group> --environment $environment
azd env set FOUNDRY_ACCOUNT_NAME <foundry-account> --environment $environment
azd env set FOUNDRY_PROJECT_NAME <foundry-project> --environment $environment
azd env set FOUNDRY_DEFAULT_MODEL_DEPLOYMENT <foundry-deployment> --environment $environment
azd env set GATEWAY_LOGICAL_MODEL_ALIAS coding-primary --environment $environment
azd env set GOVERNANCE_SCOPE_GROUP_ID organization --environment $environment
azd env set GOVERNANCE_KNOWN_TEAM_KEYS engineering --environment $environment
azd env set GOVERNANCE_MEMBERSHIP_GROUP_IDS <engineering-group-object-id> --environment $environment

azd env set CREATE_FOUNDRY false --environment $environment
azd env set DEPLOY_GATEWAY true --environment $environment
```

위 이름은 고객이 소유한 값입니다. 다른 배포의 식별자는 사용하지 않습니다. Foundry 배포 이름은 기존 백 엔드 리소스이고, `coding-primary`는 코딩 에이전트가 게이트웨이에 보내는 논리적 이름입니다.

## Preview 및 배포

안정적인 주체 키 저장소를 먼저 준비합니다. 만들기 전에 미리 보기를 확인합니다.

```powershell
pwsh -NoProfile -File tools/distribution/Initialize-PrincipalKeyStore.ps1 `
  -EnvironmentName $environment `
  -Preview

pwsh -NoProfile -File tools/distribution/Initialize-PrincipalKeyStore.ps1 `
  -EnvironmentName $environment
```

전체 Azure 변경을 미리 보고 대상 리소스 그룹, 생성, 수정, 삭제 항목을 검토합니다.

```powershell
azd provision --preview --no-state --environment $environment --no-prompt
```

미리 보기가 선택한 환경과 일치할 때만 배포합니다.

```powershell
azd provision --no-state --environment $environment --no-prompt
```

**애플리케이션 코드를 배포하기 전에 사용자 및 그룹 명단을 사용할지 결정합니다.** 템플릿과 배포 후크는 `GroupMember.Read.All`을 **자동으로 부여하지 않습니다**. 명단이 필요하면 Privileged Role Administrator 또는 Global Administrator가 지금 해당 환경의 제어 영역 관리 ID에 [디렉터리 권한을 부여하고 다시 조회](01-deployment_ko.md#entra-users--groups-화면을-위한-디렉터리-읽기-권한)합니다. 제품은 설정된 팀 그룹만 조회하지만 권한 자체는 테넌트 전체에 적용됩니다. 승인하지 않으면 권한 부여를 건너뜁니다. 이 경우 명단은 사용할 수 없지만 게이트웨이 정책 적용에는 해당 권한이 필요하지 않습니다.

**이 ID가 이미 Graph 토큰을 요청했다면 권한 반영에 수 시간이 걸릴 수 있습니다.** Azure 관리 ID 토큰은 리소스 URI별로 **약 24시간** 캐시되며, 이는 반영 완료를 보장하는 기한이 아닙니다. Function을 다시 시작하거나 재배포해도 이 캐시를 강제로 갱신할 수 없습니다. 새 환경에서는 프로비저닝과 최초 코드 배포 사이에 권한을 부여하고 확인하면 위험을 줄일 수 있지만 즉시 사용할 수 있다고 보장하지는 않습니다.

루트 프로비저닝이 성공하고 선택한 권한 단계를 완료한 뒤 두 서비스를 배포합니다.

```powershell
azd deploy --all --environment $environment --no-prompt
```

루트 프로비저닝과 두 애플리케이션 배포가 성공했다고 보고할 때까지 기다립니다. 루트 배포가 실행 중일 때 생성된 출력으로 호출자 초기 설정을 시작하지 않습니다.

최종 출력을 읽고 다음 단계에서 사용할 값을 보관합니다.

- `API_URL`: 거버넌스 대상 `/v1` 기본 URL
- `ENTRA_API_SCOPE`: 브리지가 사용하는 대상 API 식별자가 포함된 위임 범위
- `ENTRA_TENANT_ID`와 `ENTRA_CLI_APPLICATION_ID`: 호출자 로그인에 사용할 테넌트와 승인된 공용 클라이언트
- `ADMIN_INTERFACE_ENDPOINT`: 콘솔 URL

출력에 `API_URL`이 없다면 선택한 모드에서 게이트웨이를 배포하지 않은 것입니다. 루트 프로비저닝은 성공했지만 애플리케이션 배포가 실패했다면 거버넌스를 게시하기 전에 해당 배포를 먼저 수정합니다.

최초 설치에서 오류가 발생하면 `AADSTS9002326`, 미리 보기 그룹 클레임 누락, 디렉터리 권한 반영 지연 및 불완전한 what-if 범위를 설명하는 [설치 문제 해결 절차](01-deployment_ko.md#문제-해결)를 따릅니다. 소유권 입력이 거부되면 [소유권 증거 복구 절차](03-operations_ko.md#최초-설치-소유권-증거-오류)를 확인합니다. 실패한 증거를 보존하고, 검사를 통과시키기 위해 앱 등록을 다시 만들거나 권한을 확대하지 않습니다.

## 최소 governance 게시

`initial-governance.json`을 만듭니다. 테넌트, 그룹, Foundry 배포 자리 표시자를 위에서 사용한 값으로 바꿉니다.

```json
{
  "tenantId": "<tenant-id>",
  "scopeGroupId": "organization",
  "organization": {
    "models": ["coding-primary"],
    "limits": {
      "requestsPerMinute": 60,
      "tokensPerMinute": 300000,
      "tokenQuota": 5000000,
      "quotaPeriod": "Monthly"
    }
  },
  "teams": [
    {
      "teamKey": "engineering",
      "membershipGroupId": "<engineering-group-object-id>",
      "models": ["coding-primary"],
      "limits": {
        "requestsPerMinute": 30,
        "tokensPerMinute": 300000
      }
    }
  ],
  "models": [
    {
      "deploymentName": "<foundry-deployment>",
      "modelKey": "coding-primary"
    }
  ],
  "budgets": [],
  "fallback": null
}
```

위 숫자는 프로덕션 기본값이 아니라 평가용 설정입니다. 코딩 에이전트는 컨텍스트와 도구 스키마를 반복해 보내므로 실제 에이전트 트래픽을 측정해 정책을 조정합니다.

관리자 로그인이나 게시 없이 입력을 검증합니다. 이 단계에서도 기존 `az login` 세션으로 Foundry 계정과 공급자 할당량을 읽습니다.

```powershell
node tools/distribution/Initialize-Governance.mjs `
  --environment $environment `
  --input .\initial-governance.json `
  --dry-run
```

검증이 끝나면 게시합니다.

```powershell
node tools/distribution/Initialize-Governance.mjs `
  --environment $environment `
  --input .\initial-governance.json
```

검증 주소를 열고 `Governance.Administer` 권한이 있는 계정으로 디바이스 코드를 입력합니다. 성공 결과는 `outcome: "active"`이며 정확히 다섯 대상이 `verified`여야 합니다.

## 인증 bridge 시작

호출자에게 필요한 출력만 읽습니다.

```powershell
$apiUrl = azd env get-value API_URL --environment $environment
$tenantId = azd env get-value ENTRA_TENANT_ID --environment $environment
$scope = azd env get-value ENTRA_API_SCOPE --environment $environment
$clientId = azd env get-value ENTRA_CLI_APPLICATION_ID --environment $environment
$gatewayOrigin = ([uri]$apiUrl).GetLeftPart([System.UriPartial]::Authority)
```

두 번째 터미널에서 기존 루프백 브리지를 시작합니다.

```powershell
node tools/agent-auth-bridge/agent-auth-bridge.mjs `
  --port 8788 `
  --upstream $gatewayOrigin `
  --scope $scope `
  --tenant $tenantId `
  --client $clientId
```

`engineering` 그룹에 할당된 개발팀 구성원으로 디바이스 코드 로그인을 완료합니다. 브리지는 새로 고침 토큰을 메모리에 보관하고 들어오는 자격 증명을 교체하며, `401` 뒤 한 번만 재시도하고 `403`은 재시도하지 않습니다.

## 허용 요청과 거부 요청 전송

첫 번째 터미널에서 허용된 논리적 모델로 요청을 보냅니다.

```powershell
$allowedBody = @{
  model = 'coding-primary'
  input = 'Reply with quickstart ok only.'
  max_output_tokens = 16
} | ConvertTo-Json -Compress

$allowed = Invoke-WebRequest `
  -Method Post `
  -Uri 'http://127.0.0.1:8788/v1/responses' `
  -ContentType 'application/json' `
  -Body $allowedBody `
  -SkipHttpErrorCheck

$allowed.StatusCode
$allowed.Headers['x-requested-model']
$allowed.Headers['x-effective-model']
```

`200`과 요청된 모델 `coding-primary`가 표시되어야 합니다. 적용 모델 헤더는 거버넌스가 선택한 Foundry 배포를 나타냅니다.

이번에는 정책이 허용하지 않은 모델로 요청을 보냅니다.

```powershell
$deniedBody = @{
  model = 'not-allowed'
  input = 'This request should not reach a model.'
  max_output_tokens = 16
} | ConvertTo-Json -Compress

$denied = Invoke-WebRequest `
  -Method Post `
  -Uri 'http://127.0.0.1:8788/v1/responses' `
  -ContentType 'application/json' `
  -Body $deniedBody `
  -SkipHttpErrorCheck

$denied.StatusCode
$denied.Content
```

`403`과 코드 `model_not_allowed`가 표시되어야 합니다. 새 토큰을 받아도 정책이 거부한 모델을 사용할 수 없으므로 재시도하지 않습니다.

허용 요청이 `503 governance_unavailable`을 반환하면 초기화 도구가 `outcome: "active"`를 보고했는지, APIM `governance-policy-enabled` 출력이 `true`인지 확인합니다. `401`은 토큰이 없거나 만료되었거나 잘못되었다는 뜻입니다. 관리 경로에서 본문 없는 `403`이 나오면 추론 정책이 아니라 App Service 인증 설정을 확인합니다.

## Console 확인

`ADMIN_INTERFACE_ENDPOINT` 출력을 열고 거버넌스 관리자로 로그인합니다. 다음을 확인합니다.

- 게시 화면에 활성 리비전 한 개가 있습니다.
- 모델 화면에 `coding-primary`와 선택한 Foundry 배포가 표시됩니다.
- 선택적 디렉터리 읽기를 설정했다면 사용자 및 그룹에 `engineering` 팀이 표시됩니다. 정책 적용 자체에는 명단 화면이 필요하지 않습니다.
- 원격 분석을 수집한 뒤 사용량 화면에 허용 요청이 표시되며 토큰 수만 있고 프롬프트와 응답 본문은 없습니다.
- 변경 기록에 최초 게시가 표시됩니다.

호출자와 제한을 더 추가하기 전에 [관리 콘솔 사용](02-administration_ko.md)과 [평가 환경 운영 및 제거](03-operations_ko.md)에 정리된 정책 확인 절차를 살펴봅니다.

## 평가 환경 제거

먼저 제거 대상을 미리 봅니다.

```powershell
pwsh -NoProfile -File tools/distribution/Remove-Deployment.ps1 `
  -ManifestPath <ownership-manifest.json> `
  -StatePath <ownership-state.json> `
  -ReadbackPath <fresh-exact-id-readback.json> `
  -Preview `
  -OutputPath <removal-preview.json>
```

이 명령은 로컬에서만 실행됩니다. 매니페스트에 연결된 미리 보기를 검증하며 Azure, Microsoft Graph 또는 `azd`를 호출하지 않고 아무것도 삭제하거나 영구 삭제하지 않습니다. 별도로 승인된 각 단계에는 같은 매니페스트, 상태, 조회 결과, 출력 형식과 해당 `-ApproveResourceDelete`, `-ApproveEntraCleanup`, `-ApproveEntraPurge`, `-ApproveApimPurge`, `-ApproveKeyVaultPurge` 스위치 및 정확한 `-ApprovalPath`가 필요합니다. 실제 삭제나 영구 삭제는 별도로 승인된 운영자 절차에서 최신 증빙으로 소유권이 확인된 대상에만 수행해야 합니다. 증빙을 임의로 꾸며내거나 이 검증 도구를 삭제 실행 도구로 간주하지 마십시오.

이 저장소에는 위 세 가지 입력을 생성하는 명령도, 삭제를 실행하는 명령도 포함되어 있지 않습니다. 봉인된 매니페스트, 보관된 소유권 상태, 정확한 ID 조회 결과는 이 environment가 무엇을 만들었는지에 대한 고객의 기록입니다. [`tools/deployment/ownership-contract.mjs`](../tools/deployment/ownership-contract.mjs)가 이 문서들이 충족해야 하는 계약이며, [`tests/infra/fixtures/ownership-contract-fixture.mjs`](../tests/infra/fixtures/ownership-contract-fixture.mjs)에서 각 문서의 형태를 확인할 수 있습니다.

평가 비용을 중단하려면 승인된 운영자가 이 environment가 단독으로 소유한 대상만 조직의 정규 변경 절차에 따라 조회 결과의 정확한 리소스 ID를 대상으로 삭제합니다. 그 대상은 `GATEWAY_RESOURCE_GROUP_NAME`에 지정한 전용 게이트웨이 리소스 그룹과, 별도로 소유권을 관리하는 디렉터리 개체인 이 배포가 만든 Entra 애플리케이션 등록 및 서비스 주체입니다. 리소스 그룹은 여기서 만들지 않은 항목이 하나도 없을 때에만 삭제합니다. 구독이나 테넌트 전체를 일괄 삭제하지 말고, 이름 규칙만으로 삭제하지 마십시오.

재사용 모드는 참조한 Foundry 리소스 그룹, 계정, 프로젝트, 모델 배포를 남기며, 기존에 있던 Entra 그룹도 삭제 대상이 아닙니다. 각 단계를 별도로 검토하고 정확한 소유권 경계를 유지합니다.
