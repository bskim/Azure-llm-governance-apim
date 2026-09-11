# 게이트웨이 배포하기

Azure에서 코딩 에이전트용 LLM 백엔드를 운영하는 개발팀과 플랫폼팀을 위한 상세 배포 문서입니다. 비어 있는 구독부터 Microsoft Foundry 모델을 이미 운영하는 조직까지 모두 다룹니다.

가장 빠른 배포 절차는 [PoC 빠른 시작](00-quickstart_ko.md)에서 설명합니다. 기존 Foundry 배포를 재사용하고 새 APIM을 만든 뒤, 허용되는 요청 한 건과 정책에 따라 거부되는 요청 한 건까지 확인합니다. 다른 배포 모드나 상세 검증, 복구, 제거 절차는 이 문서에서 설명합니다.

코딩 에이전트 연결은 별도의 작업이며, 상세 절차는 [코딩 에이전트 연결하기](04-connection_ko.md)에서 설명합니다. 이 안내서는 게이트웨이, 관리 화면, 초기 거버넌스, 호출자별 정책 해석을 준비하는 과정까지 다룹니다. 배포를 마친 뒤의 일상적인 화면 사용법은 [관리 콘솔 사용하기](02-administration_ko.md)에서 설명합니다.

## 아키텍처 경계

거버넌스 대상 요청은 의도적으로 API Management를 거치도록 구성합니다.

```text
client -> API Management /v1 -> Foundry account /openai/v1
          caller Entra token     API Management managed identity
```

API Management는 호출자를 검증하고, 경로와 모델 허용 목록, 요청 및 토큰 한도를 적용하며, 본문을 제외한 원격 분석 데이터를 기록합니다. 그런 다음 `https://<foundry-account>.cognitiveservices.azure.com/openai/v1`에 있는 Foundry **계정** 엔드포인트를 호출합니다. 이 저장소의 API는 Foundry 프로젝트 엔드포인트를 백엔드로 사용하지 않습니다.

`/v1`은 OpenAI 호환 데이터 평면 계약이며 API Management 서비스 계층을 뜻하지 않습니다. 여기에서 구현하는 업스트림 경로는 이 작업을 `/openai/v1` 아래에 정의하며 `/openai/v2` 변형은 정의하지 않습니다.

이 배포에서는 컨트롤 플레인(거버넌스를 제어하는 API 계층), 거버넌스 저장소, 관리 콘솔, 로그 작업 영역, 네트워크, 게이트웨이와 콘솔에서 사용하는 Microsoft Entra 애플리케이션도 함께 만듭니다.

다음 두 가지 경계를 유의해야 합니다.

- **API Management에 도달하는 트래픽만 거버넌스 대상입니다.** Foundry 계정에 대한 추론 데이터 작업 권한을 그대로 보유한 호출자는 이 게이트웨이를 우회할 수 있습니다. 우회를 막아야 한다면 거버넌스 대상 호출자 ID에서 해당 직접 역할을 제거하십시오.
- **Foundry 포털 연결(association)과 프로젝트 등록은 서로 다른 수명 주기 작업입니다.** 이 템플릿은 두 작업 모두 수행하지 않으며 프로모션 허용 여부도 보장하지 않습니다.

## 비용 및 보안 체크리스트

### 비용

참조 토폴로지에서는 Basic v2 API Management, Microsoft Foundry 모델 추론, Flex Consumption, 서버리스 Cosmos DB, Storage, Key Vault, 프라이빗 엔드포인트, Log Analytics처럼 각각 별도로 과금될 수 있는 서비스를 만들거나 사용합니다. 비용은 지역, 모델, 용량, 요청 수, 토큰 사용량, 보존 기간, 보조 Foundry 계정 설정 여부에 따라 달라집니다. 두 번째 계정으로 부하를 분산할 수는 있지만 구독 할당량이 늘어나지는 않습니다. 실제 지역과 모델은 [Azure 가격 계산기](https://azure.microsoft.com/pricing/calculator/)에서 확인합니다. 이 저장소 외부에서 Azure 비용 경고를 설정하고, 더 이상 필요하지 않은 평가 환경은 제거합니다.

게이트웨이 토큰 메트릭, 할당량, 예산, 대체 경로는 운영 제어 수단일 뿐 청구서나 금액을 보장하지 않습니다. 공급자 청구 내역이 기준이며, `best effort` 방식의 예산 제한은 처리 중인 요청으로 인해 초과될 수 있습니다.

### 보안

- 기본 `public-authenticated` 관리 방식과 Basic v2 APIM 인그레스는 공개 엔드포인트이며 Microsoft Entra 인증으로 보호됩니다. `private-only` 관리 방식은 템플릿에 정의되어 있지만 엔드투엔드 검증을 마치지 않았습니다. 이 경우 프라이빗 엔드포인트에 접근할 수 있는 배포 에이전트가 게시를 수행해야 합니다.
- 영구 거버넌스 저장소와 보안 주체 키 저장소는 프라이빗 네트워크를 사용합니다. 보안 주체 키 부트스트랩은 닫힌 RBAC 기반 Key Vault를 만들며, 생성된 값을 프로젝트 파일이나 azd 환경 상태에 저장하지 않습니다.
- 생성되는 Foundry 및 Cosmos 리소스는 템플릿에서 설정하는 범위 내에서 로컬 인증과 키 기반 인증을 비활성화합니다. APIM 관리 ID가 Foundry 계정 엔드포인트를 호출합니다.
- 게이트웨이가 Foundry 직접 접근 권한을 자동으로 없애지는 않습니다. 우회를 막아야 한다면 거버넌스 대상 ID의 직접 추론 역할과 네트워크 연결 가능성을 관리해야 합니다.
- 거버넌스 증거에는 기본적으로 본문이 포함되지 않지만, 이 저장소 외부에서 구성한 공급자 또는 플랫폼 진단에는 요청과 응답 본문이 남을 수 있습니다. 프로덕션에 배포하기 전에 진단 설정과 보존 기간을 검토해야 합니다.
- 보존 정책은 고객 조직에서 결정해야 합니다. 기본 거버넌스 및 롤업 컨테이너에는 TTL이 설정되지 않으며, 이 PoC는 사용량, 롤업, 구성 이력, 디렉터리 읽기, 알림에 대해 승인된 보존 기간이나 삭제 요청 절차를 정하지 않습니다. 개발자를 온보딩하기 전에 이러한 제어 수단을 정의하고 검증해야 합니다.
- Slack과 Teams 웹후크 URL은 자격 증명입니다. 콘솔에서는 저장한 URL을 다시 표시하지 않으므로, URL이 노출되었다면 원본 시스템에서 교체해야 합니다.

## 사전 준비

다음을 설치합니다.

- Azure Developer CLI (`azd`)
- Azure CLI (`az`)
- PowerShell 7 (`pwsh`)
- Node.js 24 이상
- 영속성 통합 검사를 실행할 때 필요한 Docker

Azure를 설정하기 전에 종속성을 설치하고 빠른 로컬 검사를 실행합니다.

```powershell
npm ci
npm test
```

전체 공개 로컬 검사는 스크립트에서 호출할 수 있는 Docker 런타임으로 Cosmos DB 에뮬레이터를 실행합니다.

```powershell
pwsh -NoProfile -File tests/Test-Local.ps1 -PublicOnly `
  -IncludePersistenceIntegration `
  -IncludeExternalOpenApiLint
```

종속성을 설치하거나 배포 미리 보기를 만들기 전에 고객의
공급망 정책을 구성합니다.

- 조직이 승인한 패키지 레지스트리 원본과 범위를 명시적으로 구성합니다.
  임의의 레지스트리를 신뢰할 수 있다고 가정하지 마십시오.
- 패키지 무결성이 구성된 레지스트리 및 패키지 관리자 정책을
  충족하도록 요구합니다. 무결성 정보가 없거나 일치하지 않으면 거부합니다.
- 승인된 레지스트리 정책이 없으면 닫힌 상태로 실패 처리하거나 검증을 완료하지
  않은 상태로 둡니다.
- 레지스트리 거버넌스, 라이선스 검토, SBOM 검토, 아티팩트 서명, 릴리스
  승인은 고객이 통제하는 릴리스 절차에서 수행합니다.

저장소의 로컬 검사는 릴리스 승인을 부여하지 않습니다.

다음 항목도 필요합니다.

- resource group과 role assignment를 만들 수 있는 Azure subscription
- Entra 애플리케이션, service principal, app-role assignment를 만들 수 있는 권한
- Foundry account에 게이트웨이 managed identity를 할당할 수 있는 권한
- 새 배포를 받아들이는 모델, version, SKU, 지역 할당량

Azure 권한과 Entra 권한은 별개입니다. 조직이 승인한 기본 제공 역할 또는 사용자 지정 역할로 다음 기능을 부여합니다.

| 작업 | Azure capability | Entra capability |
|---|---|---|
| 리소스 프로비저닝 | 대상 리소스 그룹과 Foundry 계정 범위에서 리소스와 역할 할당 생성 | 애플리케이션 등록과 서비스 주체 생성 및 관리 |
| 거버넌스 관리자 지정 | 추가 Azure 기능 없음 | 선택한 사용자 또는 그룹에 관리 API 역할 할당 |
| 거버넌스 팀 준비 | 추가 Azure 기능 없음 | 선택한 그룹 개체 ID 조회 및 멤버 자격 관리 |
| 선택적 디렉터리 명단 사용 | 추가 Azure 기능 없음 | Privileged Role Administrator가 컨트롤 플레인 ID에 `GroupMember.Read.All` 부여 |

대상 테넌트와 구독으로 로그인합니다.

```powershell
az login --tenant <tenant-id>
az account set --subscription <subscription-id>
azd auth login --tenant-id <tenant-id>
```

새 Foundry 계층 구조를 만드는 경우 정확한 모델 버전과 사용 가능한 구독 용량을 확인합니다. 기존 배포에서 계속 제공되는 모델이라도 새 배포는 거부될 수 있습니다. 따라서 모델 이름, 버전, 형식을 함께 검토해야 합니다.

```powershell
az cognitiveservices model list --location <region> --output table
az cognitiveservices usage list --location <region> --output table
```

할당량은 구독 단위입니다. Foundry 계정을 하나 더 만들어도 할당량은 늘어나지 않습니다.

기존 Foundry 계층 구조를 사용하는 경우 참조할 배포를 확인합니다.

```powershell
az cognitiveservices account deployment list `
  --name <foundry-account> `
  --resource-group <foundry-resource-group> `
  --output table
```

## 배포 모드 선택하기

| Mode | 사용 조건 | 평가 상태 | `CREATE_FOUNDRY` | `DEPLOY_GATEWAY` |
|---|---|---|---:|---:|
| Foundry 재사용, 새 게이트웨이 | 테스트 가능한 Foundry 배포가 있고 가장 짧은 거버넌스 경로 평가를 원할 때 | 권장 | `false` | `true` |
| 전체 생성 | 격리된 Foundry 계층과 API Management service가 필요할 때 | 지원 | `true` | `true` |
| 컨트롤 플레인 전용 | 추론 거버넌스 없이 정책 모델과 콘솔만 확인할 때 | 제한: `/v1` 추론 엔드포인트 없음 | 무관 | `false` |

API Management는 시간당 고정 요금이 부과되는 구성 요소입니다. `DEPLOY_GATEWAY=false`로 설정하면 이 구성 요소를 만들지 않지만 `/v1` 추론 엔드포인트도 만들어지지 않습니다.

Foundry를 참조하는 경우 이 배포를 제거해도 해당 리소스 그룹은 그대로 남습니다. 이 공개 PoC는 항상 새 API Management 서비스를 만들며 기존 서비스는 변경하지 않습니다.

## 환경 구성하기

이름이 지정된 환경을 만들고 선택합니다.

```powershell
azd env new <environment>
azd env select <environment>
```

`azd env set`을 사용합니다. azd가 생성한 환경 상태는 직접 편집하지 마십시오.

모든 모드에서 필요한 값:

```powershell
azd env set AZURE_LOCATION <region> --environment <environment>
azd env set AZURE_SUBSCRIPTION_ID <subscription-id> --environment <environment>
azd env set GATEWAY_RESOURCE_GROUP_NAME <gateway-resource-group> --environment <environment>
azd env set ENTRA_APPLICATION_OWNER_OBJECT_ID <owner-object-id> --environment <environment>
azd env set GOVERNANCE_ADMINISTRATOR_PRINCIPAL_ID <administrator-group-object-id> --environment <environment>
azd env set FOUNDRY_RESOURCE_GROUP_NAME <foundry-resource-group> --environment <environment>
azd env set FOUNDRY_ACCOUNT_NAME <foundry-account> --environment <environment>
azd env set FOUNDRY_PROJECT_NAME <foundry-project> --environment <environment>
azd env set FOUNDRY_DEFAULT_MODEL_DEPLOYMENT <model-deployment> --environment <environment>
azd env set GATEWAY_LOGICAL_MODEL_ALIAS <client-model-name> --environment <environment>
azd env set GOVERNANCE_SCOPE_GROUP_ID <organization-key> --environment <environment>
azd env set GOVERNANCE_KNOWN_TEAM_KEYS <sorted-comma-separated-team-keys> --environment <environment>
azd env set GOVERNANCE_MEMBERSHIP_GROUP_IDS <sorted-comma-separated-entra-group-object-ids> --environment <environment>
```

`GOVERNANCE_ADMINISTRATOR_PRINCIPAL_ID`에는 사용자 또는 그룹 개체 ID를 입력합니다. 재배포하지 않고 관리자 구성원을 바꿀 수 있도록 그룹을 사용합니다. 관리 API는 역할 할당을 요구하며, 할당이 없는 계정은 토큰이 발급되기 전에 거부될 수 있습니다.

위의 Foundry 이름은 `CREATE_FOUNDRY=true`일 때 생성되고, `false`일 때는 참조됩니다.

`GOVERNANCE_SCOPE_GROUP_ID`는 이 배포에서 사용하는 영구 파티션입니다. 나중에 이 값을 바꾸면 거버넌스의 이름만 바뀌는 것이 아니라 모든 읽기와 쓰기가 다른 파티션을 향하게 됩니다. `GOVERNANCE_KNOWN_TEAM_KEYS`는 정렬되어 있고 중복이 없어야 하며 초기 거버넌스 입력의 팀과 일치해야 합니다. `GOVERNANCE_MEMBERSHIP_GROUP_IDS`는 게이트웨이 API에 할당된 Entra 그룹 집합이며, 입력의 `membershipGroupId` 집합과 일치해야 합니다. 그룹과 팀의 대응 관계는 인프라에 중복 저장되지 않고 거버넌스 콘텐츠에만 남습니다.

다음 중 한 가지 모드를 설정합니다.

```powershell
# 전체 생성
azd env set CREATE_FOUNDRY true --environment <environment>
azd env set DEPLOY_GATEWAY true --environment <environment>

# Foundry 재사용, API Management 생성
azd env set CREATE_FOUNDRY false --environment <environment>
azd env set DEPLOY_GATEWAY true --environment <environment>

# control plane만
azd env set DEPLOY_GATEWAY false --environment <environment>
```

Foundry를 생성할 때는 검증한 모델 세부 정보를 그대로 고정합니다.

```powershell
azd env set FOUNDRY_MODEL_NAME <model-name> --environment <environment>
azd env set FOUNDRY_MODEL_VERSION <model-version> --environment <environment>
azd env set FOUNDRY_MODEL_FORMAT <model-format> --environment <environment>
azd env set FOUNDRY_MODEL_SKU <sku> --environment <environment>
azd env set FOUNDRY_MODEL_CAPACITY <capacity> --environment <environment>
```

선택적 설정:

| 변수 | 기본값 | 효과 |
|---|---|---|
| `APIM_SKU` | `BasicV2` | 비운영 평가에서는 `Developer`를 명시적으로 선택할 수 있으며 기본값은 그대로 유지됩니다. |
| `FOUNDRY_SECOND_MODEL_DEPLOYMENTS` | `[]` | 새로 생성하는 동일 Foundry account에 추가할 모델 최대 하나. 아래 설명 참고 |
| `GOVERNANCE_ADMINISTRATION_INGRESS` | `public-authenticated` | 콘솔과 control plane의 인그레스 방식 |
| `CONTROL_PLANE_ALWAYS_READY_INSTANCES` | `1` | control plane 요청 경로를 위해 항상 준비 상태로 두는 instance 수 |
| `CONTROL_PLANE_MAXIMUM_INSTANCE_COUNT` | `28` | 각 FC1 스케일 그룹의 최댓값입니다. 배포 입력 검증에서 지원 범위를 강제합니다. |
| `CONTROL_PLANE_INSTANCE_MEMORY_MB` | `2048` | 배포에서 사용하는 FC1 memory 크기 |
| `ENTRA_DEVELOPER_CLIENT_APPLICATION_ID` | nil GUID | 추가로 승인할 공개 클라이언트입니다. 기본값은 아무것도 허용하지 않습니다. |
| `SECONDARY_FOUNDRY_ACCOUNT_NAME` | 빈 값 | 선택적인 두 번째 백엔드 계정입니다. 할당량은 추가되지 않습니다. |
| `POOLED_MODEL_DEPLOYMENTS` | 빈 값 | pool 구성원이 공유하는, 쉼표로 구분한 배포 이름 |
| `NOTIFICATION_WEBHOOK_SECRET_NAME` | 빈 값 | 배포 소유 generic webhook 대체 대상 URL을 담은 Key Vault 비밀의 비밀이 아닌 이름 |
| `ROLLUP_STARTED_FROM` | 빈 값 | 각 영구 스케줄이 checkpoint를 처음 기록할 때만 사용하는 정확한 UTC 시간 단위 경계 |
| `TEARDOWN_PROTECTED_RESOURCE_GROUPS` | 미설정 | 제거 도구에서 대상으로 삼지 않아야 할 그룹을 쉼표로 구분한 값입니다. |

평가에는 기본값을 유지하되 용량 계획과 대상 구독 할당량이
다른 허용 값을 뒷받침할 때만 변경합니다. 입력값 검증에서는 지원되는 구성
범위를 확인하지만 지역별 용량을 확정하거나 프로비저닝을 승인하지
않습니다. 배포 전에 현재 할당량을 확인합니다.

API Management 게시자 조직과 연락처는 `infra/main.parameters.json`에서 검토합니다. 이 값은 환경 키가 아니라 리터럴 값입니다.

### 저비용 평가와 두 번째 모델

비운영 평가에서는 `APIM_SKU=Developer`를 명시적으로 선택합니다. Developer에는 운영 SLA가 없으며, 이 옵션만으로 실제 정책 호환성이 검증되거나 기본 `BasicV2` 계층이 바뀌지는 않습니다. 다른 유료 리소스도 함께 검토하고 유지 시간과 정리 범위를 승인합니다. 배포가 거부되면 SKU를 자동으로 올리지 않고 중단합니다.

`FOUNDRY_SECOND_MODEL_DEPLOYMENTS`에는 완전한 개체를 최대 하나 포함하는 JSON 배열을 입력합니다. 기본값 `[]`는 기존 단일 모델 배포를 유지합니다. 비어 있지 않은 배열에는 `CREATE_FOUNDRY=true`가 필요하며, 재사용하는 계정은 변경하지 않습니다. 다른 백엔드 계정을 구성하는 `SECONDARY_FOUNDRY_ACCOUNT_NAME`과는 별개입니다.

```powershell
azd env set APIM_SKU Developer --environment <environment>

$secondModels = @(@{
  deploymentName = 'additional-model'
  modelName = '<model-name>'
  modelVersion = '<model-version>'
  modelFormat = '<model-format>'
  skuName = '<model-sku>'
  capacity = 10
})
azd env set FOUNDRY_SECOND_MODEL_DEPLOYMENTS `
  (ConvertTo-Json -InputObject $secondModels -Compress) --environment <environment>
```

모든 모델 자리 표시자를 바꾸고 정확한 지역, 모델, 버전, SKU에 대해 요청 용량을 배포 전에 검증합니다. `10`은 예시일 뿐 용량을 보장하지 않습니다. 여섯 필드는 모두 필수이고 용량은 양의 정수여야 하며 알 수 없는 필드는 거부됩니다. 배포 이름은 `FOUNDRY_DEFAULT_MODEL_DEPLOYMENT`와 다르게 지정합니다.

모델을 하나 더 생성해도 호출자에게 접근 권한이 자동으로 부여되지는 않습니다. 공급자 카탈로그를 새로 읽고 명시적인 논리 모델 매핑과 거버넌스 권한을 게시합니다. 각 모델의 API 및 토큰 매개 변수 호환성은 별도로 확인합니다. 두 배포가 모두 존재하더라도 대체 경로가 호환된다는 의미는 아닙니다. 로컬 템플릿 테스트는 Azure 엔드투엔드 증거나 과금 강제 상한이 아닙니다.

새 배포에서는 `PRINCIPAL_KEY_MODE`, `PRINCIPAL_KEY_STORE_NAME`, `PRINCIPAL_KEY_SECRET_NAME`을 직접 설정하지 마십시오. 보안 주체 키 부트스트랩 명령은 안정적인 폐쇄형 자격 증명 모음을 만들고 다시 읽은 뒤에만 이러한 비밀이 아닌 값을 설정합니다. `PRINCIPAL_DERIVATION_SECRET`은 이전의 직접 보안 매개 변수 방식에서 업그레이드하는 경우에만 남겨 둡니다.

### 선택적 고정 Webhook 및 초기 Rollup Backfill

콘솔 채널은 일반적인 Slack 또는 Teams 구성으로 유지됩니다. 고정 대체 대상은
배포 소유의 **generic** webhook 전용입니다. 콘솔 채널이 저장되지 않은 경우에만
사용하며, 저장된 Slack 또는 Teams 채널이 항상 우선합니다.

보안 주체 키 부트스트랩으로 자격 증명 모음이 생성된 뒤, 비밀이 아닌 비밀 이름을
선택하고 azd에는 그 이름만 저장합니다.

```powershell
azd env set NOTIFICATION_WEBHOOK_SECRET_NAME notification-webhook-endpoint `
  --environment <environment>
```

포털 또는 승인된 다른 비밀 관리 절차를 사용하여 부트스트랩한 보안 주체 키 자격
증명 모음에 해당 비밀을 만들고 webhook URL을 값으로 붙여넣습니다. 운영자에게는
Key Vault 비밀을 만들 권한과 자격 증명 모음의 네트워크 경로가 필요합니다. URL을
`azd env`, 배포 매개 변수, 셸 기록, 프로젝트 파일, 출력 또는 로그에 넣지
마십시오. Function App에는 Key Vault 참조만 전달되며, 관리형 ID에는 이미 자격
증명 모음 읽기 역할이 있습니다. 전달에 의존하기 전에 값을 표시하지 않고 포털의
Function App **Configuration** 페이지에서 참조가 해결되었는지 확인합니다.

고정 endpoint는 사용자 정보나 리터럴 IP 주소 없이 외부의 정규화된 `https` 호스트여야
합니다. 잘못된 값은 알림이 전달될 때까지 기다리지 않고 Function 시작을 중단합니다.
이 대체 대상은 `notificationCode`, `kind`, `severity`, `scopeKind`, `scopeCode`,
`periodStart`, `raisedAt`, `reasonCode`, `attemptNumber`의 generic JSON 알림
payload를 POST합니다. Slack 또는 Teams의 `{"text": ...}` 본문은 보내지 않으므로,
Slack incoming webhook이나 Teams Workflows trigger를 이 고정 대체 대상으로 사용하지
마십시오.

첫 영구 스케줄 checkpoint를 더 이른 window에서 시작하려면, 스케줄이 처음 실행되기
전에 정확한 UTC 시간 경계의 ISO-8601 instant를 설정합니다.

```powershell
azd env set ROLLUP_STARTED_FROM 2026-08-10T00:00:00.000Z `
  --environment <environment>
```

사전 프로비저닝 검증은 잘못되었거나 정렬되지 않은 값을 거부합니다. 초기 backfill은
한 번에 최대 48개의 시간 단위 window로 제한됩니다. 영구 checkpoint가 생긴 뒤에는
그 checkpoint가 이 설정보다 우선하므로, 설정을 바꾸어도 스케줄을 초기화하거나
재시작 뒤의 기록을 다시 재생하지 않습니다.

### 관리 인그레스

`GOVERNANCE_ADMINISTRATION_INGRESS`는 콘솔과 컨트롤 플레인의 인그레스를 함께 제어합니다.

- `public-authenticated`는 둘 다 공개하고 Entra 인증을 요구합니다. 이 모드가 기본값입니다.
- `private-only`는 공개 접근을 막고 프라이빗 엔드포인트와 DNS를 프로비저닝합니다. 사용하기 전에 대상 환경에서 이 모드를 검증합니다. 프라이빗 Function 패키지를 배포하려면 해당 네트워크에 접근할 수 있는 배포 에이전트가 필요합니다.

영구 저장소는 두 모드 모두에서 프라이빗 네트워크로 구성됩니다. 이 안내서에서 설명하는 토폴로지에서는 Basic v2 API Management 인그레스가 공개되어 있습니다.

## 사전 점검과 배포

먼저 로컬 검증을 실행합니다.

```powershell
pwsh -NoProfile -File tests/Test-Local.ps1 -PublicOnly `
  -IncludePersistenceIntegration `
  -IncludeExternalOpenApiLint
```

주 배포에 앞서 안정적인 보안 주체 키 저장소를 미리 확인하고 초기화합니다.

```powershell
pwsh -NoProfile -File tools/distribution/Initialize-PrincipalKeyStore.ps1 `
  -EnvironmentName <environment> `
  -Preview

pwsh -NoProfile -File tools/distribution/Initialize-PrincipalKeyStore.ps1 `
  -EnvironmentName <environment>
```

이 명령은 메모리에서 48바이트 난수를 생성하여 ARM 보안 매개 변수로 전달합니다. ARM은 게이트웨이 리소스 그룹에 전용 RBAC Key Vault와 `principal-key-secret`을 만듭니다. 이 Key Vault는 공개 접근이 비활성화되어 있고 기본 거부 네트워킹이 적용됩니다. 일반 텍스트 값은 출력되거나 azd 환경에 기록되지 않으며 프로젝트 파일에도 남지 않습니다. 명령을 다시 실행하면 새 비밀 버전을 만드는 대신 이미 완료된 결정적 배포를 재사용합니다. azd에는 자격 증명 모음과 비밀의 이름만 저장하며 값 자체는 저장하지 않습니다.

이름이 `verification`인 환경에는 더 엄격한 생성 전용 소유권 검사가 적용됩니다. 두 부트스트랩 명령 모두에 `-OwnershipPreflightPath <preflight.json>`과 `-OwnershipPlanPath <approved-plan.md>`를 전달합니다. 배포 입력 검증에서 `CREATE_ONLY_OWNERSHIP_VALIDATION=true`를 활성화하면 `OWNERSHIP_PLAN_FILE`, `OWNERSHIP_PREFLIGHT_FILE`, `OWNERSHIP_MANIFEST_FILE`, `OWNERSHIP_STATE_FILE`, `OWNERSHIP_READBACK_FILE`도 지정해야 합니다. 이 경로는 고객이 검토한 계획과 그에 일치하는 소유권 증거를 가리킵니다. 이 저장소는 해당 파일을 제공하지 않으며, 파일이 있다는 이유만으로 승인되었다고 가정하지도 않습니다. 증거가 없거나 일치하지 않으면 검증을 중단합니다.

보호된 신규 Foundry 모드에서는 새 계정, 프로젝트, 선언한 모델 배포가 동일한 검증 리소스 그룹에 속해야 합니다. 선택한 모드와 모델 이름을 사전 점검에 연결하고, 실제 리소스를 만들 때 생성 증빙과 일치하는 조회 결과를 기록합니다. 생성 계획만으로는 리소스를 만들었다고 입증할 수 없습니다. 재사용하는 Foundry는 외부 참조로 유지해야 하며 제거 대상에 포함하면 안 됩니다. 소유권 검사가 실패하더라도 환경 이름을 바꿔 우회하지 마십시오.

신규 Foundry에서는 키 저장소를 초기화하기 전에 `OWNERSHIP_VALIDATION_STAGE=bootstrap`과 해당 단계에 연결된 사전 점검을 설정합니다. 주 배포 전에는 실제 리소스 그룹 및 Key Vault 부트스트랩의 매니페스트, 상태, 읽기 결과를 제공합니다. 부트스트랩 단계에서는 아직 생성되지 않은 Foundry 리소스를 요구하지 않습니다. 주 배포 후에는 일치하는 `postprovision` 단계 증거로 선언한 Foundry 계층 전체를 검증합니다. 기본 단계는 `postprovision`이며, 어느 단계도 삭제를 승인하거나 별도의 제거 증거를 대신하지 않습니다.

Azure 변경 사항을 미리 확인합니다.

```powershell
azd provision --preview --no-state --environment <environment> --no-prompt
```

대상 리소스 그룹, 모드, 생성·수정·삭제 항목을 검토합니다. 미리 보기 출력은 모든 중첩 리소스의 전체 목록이 아니므로, 요약이 짧더라도 중첩된 변경이 없다고 판단해서는 안 됩니다.

미리 보기를 검토한 뒤에만 프로비저닝합니다.

```powershell
azd provision --no-state --environment <environment> --no-prompt
```

**최상위 프로비저닝 명령이 최종 성공을 보고할 때까지** 기다립니다. 최상위 배포가 아직 실행 중일 때 읽은 출력은 이전 배포의 것일 수 있습니다.

**최초 코드 배포 전 디렉터리 명단 확인 단계:** 템플릿과 후크는 `GroupMember.Read.All`을 자동으로 부여하지 않습니다. 고객이 사용자 및 그룹 명단을 사용하려면 Privileged Role Administrator 또는 Global Administrator가 지금 [아래 권한 부여 및 재조회 절차](#entra-users--groups-화면을-위한-디렉터리-읽기-권한)를 수행해야 합니다. 그렇지 않으면 명단 사용을 명시적으로 건너뜁니다. 선택 사항인 테넌트 전체 권한이 없으면 명단은 사용할 수 없습니다. 이미 Graph 토큰을 요청한 ID는 나중에 권한을 부여해도 반영에 **수 시간**이 걸릴 수 있습니다. Azure 측 캐시는 **약 24시간**이며 Function 재시작이나 재배포로 강제 갱신할 수 없고, 반영 완료를 보장하는 기한도 아닙니다.

최종 출력을 확인한 뒤 두 서비스를 모두 배포합니다.

```powershell
azd env get-values --environment <environment>
azd deploy --all --environment <environment> --no-prompt
```

주 배포는 Function ID와 프라이빗 엔드포인트를 기존 보안 주체 키 저장소에 연결하고 호출자별 정책 해석을 활성화합니다. 초기 거버넌스가 게시되기 전까지 추론은 닫힌 상태로 실패하며 `503 governance_unavailable`을 반환합니다. 아래 부트스트랩에서 활성 리비전을 보고하기 전에는 호출자를 온보딩하지 마십시오.

중첩된 배포 안에서 프로비저닝에 실패하면, 무엇이든 편집하기 전에 배포 리소스 자체가 아닌 실제로 처음 실패한 리소스를 찾습니다. 오류에 표시된 필드 이름만으로는 어느 리소스에서 거부했는지 알 수 없습니다.

## 배포 검증하기

이 절의 출력, 상태 확인, 리소스 읽기 명령은 읽기 전용입니다. 라이브 리소스를 변경하는 복구 명령은 별도로 표시합니다.

출력을 확인합니다.

```powershell
azd env get-values --environment <environment>
```

주요 출력:

| 출력 | 예상되는 의미 |
|---|---|
| `API_URL` | 거버넌스 대상 `/v1` base URL. 게이트웨이가 배포되지 않았으면 빈 값 |
| `APIM_NAME` | 생성된 서비스. control plane 전용 모드에서는 빈 값 |
| `GATEWAY_DEPLOYED` | inference 게이트웨이가 존재하는지 여부 |
| `APIM_OWNERSHIP` | `created` 또는 `none` |
| `FOUNDRY_OWNERSHIP` | `created` 또는 `existing` |
| `DISTRIBUTION_MODE` | `fresh` 또는 `existing` |
| `ENDPOINT_GOVERNANCE_MODE` | `ExplicitApim`, 또는 게이트웨이가 배포되지 않았으면 `none` |
| `BACKEND_ENDPOINT_CLASS` | `FoundryAccountOpenAIV1`, 또는 게이트웨이가 배포되지 않았으면 `none` |
| `FOUNDRY_ADMIN_ASSOCIATION` | `manual-required` |
| `FOUNDRY_PROJECT_ENROLLMENT` | `manual-required` |
| `CONTROL_PLANE_ENDPOINT` | control plane base URL |
| `ADMIN_INTERFACE_ENDPOINT` | 관리 콘솔 URL |
| `GOVERNANCE_ADMINISTRATION_INGRESS` | 적용된 관리 인그레스 방식 |
| `GOVERNANCE_SCOPE`, `GOVERNANCE_TEAMS` | 적용된 영속적 scope와 선택 가능한 team key |
| `GOVERNANCE_MEMBERSHIP_GROUPS`, `GOVERNANCE_MEMBERSHIP_SOURCE` | 적용된 Entra group 집합과 도출된 membership 방식 |
| `GOVERNANCE_POLICY_RESOLUTION` | `per-caller`여야 합니다. 다른 값이면 설치에 실패한 것입니다. |
| `ENTRA_TENANT_ID`, `ENTRA_API_AUDIENCE`, `ENTRA_REQUIRED_SCOPE` | 게이트웨이 호출자 계약 |
| `ENTRA_ADMIN_API_AUDIENCE`, `ENTRA_ADMIN_API_SCOPE` | 별도의 관리 계약 |

상태를 확인합니다.

```powershell
$controlPlane = '<control-plane-endpoint>'
Invoke-WebRequest -Uri "$controlPlane/api/healthz" -SkipHttpErrorCheck |
  Select-Object StatusCode
```

`200`이 반환되어야 합니다. 상태 확인 경로는 의도적으로 인증 대상에서 제외되어 있습니다.

익명 관리 접근이 거부되는지 확인합니다.

```powershell
Invoke-WebRequest -Uri "$controlPlane/api/v1/admin/overview" -SkipHttpErrorCheck |
  Select-Object StatusCode
```

본문 없는 `401`이 반환되어야 합니다.

`ADMIN_INTERFACE_ENDPOINT`를 열고 관리자 그룹의 구성원으로 로그인합니다. 여러 업무용 계정이 캐시되어 있다면 계정을 직접 선택하거나 새 브라우저 프로필을 사용합니다. 계정 레이블만 믿지 않고 발급된 토큰을 직접 검증합니다.

- `tid`가 `ENTRA_TENANT_ID`와 같은지
- `aud`가 `ENTRA_ADMIN_API_AUDIENCE`와 같은지
- `roles`에 `Governance.Administer`가 들어 있는지
- `exp`가 미래 시각인지

토큰을 출력하거나 명령에 붙여 넣거나 로그에 남기지 마십시오.

이 배포에서는 Function을 만든 뒤에야 미리 작성한 Easy Auth 문서를 적용합니다. 이때 중립적인 보안 주체 정책을 명시적으로 사용하고 `allowedApplications`는 생략합니다. 이것이 정식 형태입니다. 새로 만든 Flex Consumption 앱은 처음 적용할 때 빈 `allowedApplications` 컬렉션을 만들 수 있습니다. 그러면 요청이 Function 처리기에 도달하기도 전에 유효한 관리자 토큰이 거부됩니다.

`azd provision`으로 배포하면 이 문제가 자동으로 복구됩니다. `postprovision` 후크가 Function App의 실시간 인증 설정을 읽고, `allowedApplications`가 존재하지만 비어 있을 때만 제거합니다. 값이 있거나 이미 없는 키는 그대로 두므로 이 후크는 프로비저닝할 때마다 실행해도 안전합니다.

`azd` 없이 Bicep 템플릿을 직접 배포한다면(예: `az deployment group create`를 직접 사용하는 경우), Function App이 만들어진 뒤 같은 복구 작업을 직접 실행합니다. 다음 명령은 라이브 설정을 변경하는 복구 명령입니다.

```powershell
$env:AZURE_SUBSCRIPTION_ID = '<subscription-id>'
$env:GATEWAY_RESOURCE_GROUP_NAME = '<gateway-resource-group>'
$env:CONTROL_PLANE_FUNCTION_APP = '<function-app-name>'
node tools/distribution/Repair-EasyAuthClientAllowlist.mjs
```

아무것도 변경하지 않고 확인만 하려면 사이트의 인증 설정을 읽어 클라이언트 허용 목록 키가 없는지 확인합니다.

```powershell
az rest --method get `
  --url "https://management.azure.com/subscriptions/<subscription-id>/resourceGroups/<gateway-resource-group>/providers/Microsoft.Web/sites/<function-app-name>/config/authsettingsV2?api-version=2024-04-01" `
  --query "properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy" `
  --output json
```

결과에는 `allowedPrincipals`가 있어야 하며 `allowedApplications` 키는 없어야 합니다. `allowedApplications`가 존재하지만 비어 있으면, 원래 유효했을 모든 관리자 토큰이 본문 없는 `403`으로 거부됩니다. 키가 존재하고 값도 있다면 운영자가 의도적으로 구성한 것이므로 변경하지 마십시오.

초기화 도구는 게시하기 전에 동일한 Overview 경로가 토큰 없는 요청에는 본문 없는 `401`을, 검증된 관리자 토큰을 사용한 요청에는 `200`을 반환하는지 직접 확인합니다. 둘 중 하나라도 실패하면 게시하지 않고 중단한 뒤, 인증 관련 중첩 배포와 실시간으로 다시 읽은 `authsettingsV2` 값을 살펴봅니다. 인증된 요청이 본문 없는 `403`을 반환하고 다시 읽은 값에 빈 `allowedApplications`가 있다면, 추적 중인 정식 문서를 하나의 완전한 리소스 배포로 다시 적용합니다. 이 복구 작업은 라이브 인증 리소스를 변경합니다.

```powershell
$resourceGroup = azd env get-value GATEWAY_RESOURCE_GROUP_NAME --environment <environment>
$functionApp = azd env get-value CONTROL_PLANE_FUNCTION_APP --environment <environment>
$tenant = azd env get-value ENTRA_TENANT_ID --environment <environment>
$audience = azd env get-value ENTRA_ADMIN_API_AUDIENCE --environment <environment>

az deployment group create `
  --resource-group $resourceGroup `
  --name llm-governance-auth-confirm-<environment> `
  --template-file infra/modules/control-plane-authentication.bicep `
  --parameters functionAppName=$functionApp entraTenantId=$tenant controlPlaneAudience=$audience `
  --mode Incremental
```

새 관리자 토큰을 사용하여 30초 간격으로 세 번 확인합니다. 세 번 모두 익명 요청은 빈 본문의 `401`을, 인증된 요청은 비어 있지 않은 본문의 `200`을 반환해야 합니다. 키의 존재 여부만 다시 읽어 `allowedApplications`가 없는지 확인합니다. 최상위 프로비저닝이 실패한 뒤에는 애플리케이션 코드를 배포하거나 Function App을 다시 시작하거나 클라이언트 허용 목록을 추가하거나 문서 일부만 수동으로 보내면 **안 됩니다**. 부분적인 PUT 요청은 발급자, 클라이언트, 인증 없이 허용하는 작업, 상태 확인 제외 설정을 예고 없이 지울 수 있습니다.

정확한 Foundry 계정 범위에서 게이트웨이 관리 ID의 역할을 확인합니다.

```powershell
$foundryScope = '/subscriptions/<subscription-id>/resourceGroups/<foundry-resource-group>/providers/Microsoft.CognitiveServices/accounts/<foundry-account>'
az role assignment list --scope $foundryScope --output table
```

API와 정책 버전을 확인합니다.

```powershell
az apim api list `
  --resource-group <gateway-resource-group> `
  --service-name <apim-name> `
  --output table

az apim nv show `
  --resource-group <gateway-resource-group> `
  --service-name <apim-name> `
  --named-value-id gateway-policy-version `
  --query value `
  --output tsv
```

API Management는 정책 XML을 다시 읽을 때 형식을 재정렬합니다. 따라서 바이트 단위 동일성을 런타임 판정 기준으로 사용하지 않습니다. 예상되는 표식을 확인하고 범위를 한정한 동작 테스트를 실행합니다.

## 초기 구성

### Entra: 배포가 등록하는 것

테넌트에는 환경 이름이 붙은 애플리케이션 등록 네 개와 각각의 서비스 주체가 생성됩니다. 이들은 모든 리소스 그룹 외부에 있으므로 제거할 때 별도의 도구가 필요합니다.

| Application | 무엇인가 |
|---|---|
| `LLM Governance Gateway API (<environment>)` | 추론 토큰이 발급되는 대상 리소스입니다. 위임된 범위 `Gateway.Access`를 노출하며, 토큰에는 이 애플리케이션에 할당된 거버넌스 대상 그룹만 그룹 클레임으로 담습니다. |
| `LLM Governance Gateway CLI (<environment>)` | 호출자가 해당 토큰을 받기 위해 로그인하는 공개 클라이언트입니다. `Gateway.Access`에 대해 사전 승인되어 있어 호출자에게 동의 창이 표시되지 않습니다. |
| `LLM Governance Administration API (<environment>)` | 콘솔과 부트스트랩 도구에서 호출하는 리소스입니다. 위임된 범위 `Governance.Access`와 아래 역할을 노출합니다. |
| `LLM Governance Admin Console (<environment>)` | 콘솔의 단일 페이지 애플리케이션 클라이언트입니다. `Governance.Access`에 대해 사전 승인되어 있습니다. |

관리 API는 다음 세 가지 역할을 선언합니다.

| Role | 가지는 주체 | 부여하는 것 |
|---|---|---|
| `Governance.Administer` | user와 group | 거버넌스 상태 읽기, 그리고 예산, entitlement, 구성 변경 |
| `Governance.Read` | 사용자와 그룹 | 거버넌스 상태, 예산, 사용량을 읽습니다. 아무것도 변경하지 않습니다. |
| `Policy.Resolve` | 애플리케이션 | 게이트웨이 자체 ID가 허용 여부를 판단할 때 호출자의 정책을 해석합니다. |

감사자를 지정할 때는 관리 API의 서비스 주체에서 사용자나 그룹에 `Governance.Read`를 할당합니다. 제품의 다른 곳에서는 이 역할이 부여되지 않습니다.

두 API는 역할 할당을 다르게 처리하며, 이는 의도된 차이입니다. 관리 API는 역할 할당을 요구하므로 두 역할 중 어느 것도 없는 계정은 API에 도달하기 전 토큰 발급 단계에서 거부됩니다. 게이트웨이 API는 역할 할당을 요구하지 않으므로 테넌트 내 어떤 계정이든 게이트웨이 토큰을 받을 수 있습니다. 이후 허용되는 작업은 거버넌스 내용에 따라 결정되며, 이용 권한이 없는 호출자는 `principal-not-entitled`로 거부됩니다.

### Entra: 일회성 작업

배포에서는 설정된 보안 주체에 관리 역할을 할당합니다. 관리자를 추가하거나 제거할 때는 해당 그룹의 멤버 자격을 변경합니다. 재배포할 필요는 없습니다.

최초 인프라 배포 단계에서도 `GOVERNANCE_MEMBERSHIP_GROUP_IDS`에 있는 모든 그룹을 게이트웨이 API에 할당하고, 게이트웨이 토큰에는 해당 애플리케이션에 할당된 그룹만 포함되도록 구성합니다. 게이트웨이는 거버넌스 세트의 팀 카탈로그를 통해 해당 그룹 ID를 매핑합니다. 거버넌스 대상 그룹에 속하지 않은 사용자도 게이트웨이 토큰을 발급받을 수 있으며, 명시적인 주체 정책에 따라 허용될 수 있습니다. 워크로드도 마찬가지로 명시적인 애플리케이션 정책에 따라 허용될 수 있습니다. 일치하는 주체, 애플리케이션 또는 거버넌스 대상 팀 정책이 없으면 게이트웨이는 `principal-not-entitled`로 추론 요청을 거부합니다.

이미 발급된 토큰에는 접근 권한 회수가 즉시 반영되지 않습니다. 게이트웨이는 토큰을 오프라인으로 검증하므로, 호출자가 다음에 토큰을 새로 받거나 갱신할 때 또는 기존 토큰이 만료될 때 회수 조치가 반영됩니다.

### Entra: Users & Groups 화면을 위한 디렉터리 읽기 권한

Users 및 Groups 화면에는 거버넌스 대상 팀별 구성원이 표시됩니다. 컨트롤 플레인은 Microsoft Entra에 해당 멤버 자격을 요청합니다. 배포 자체에서는 디렉터리 권한을 부여하지 않으므로, 새 배포에서는 관리자가 권한을 부여하기 전까지 화면 요청이 `503 reading_unavailable / directory-snapshot-absent`로 거부됩니다.

이 단계는 선택 사항입니다. 이용 권한, 예산, 모델 허용 목록, 게이트웨이 및 다른 모든 화면은 이 단계 없이도 작동합니다. 명단이 필요하지 않다면 건너뛸 수 있습니다.

Microsoft Graph 애플리케이션 권한을 부여하려면 **Privileged Role Administrator** 또는 **Global Administrator** 역할이 필요합니다. Cloud Application Administrator, Application Administrator, AI Administrator는 다른 API에는 동의할 수 있지만 Microsoft Graph 앱 역할에는 동의할 수 없습니다. 이러한 역할 중 하나로 배포했다면 이 단계는 디렉터리 관리자에게 요청해야 합니다. 템플릿과 `azd` 후크는 이 권한을 자동으로 부여하지 않습니다. 아래 명령은 읽기 전용 확인이 아니라 고객이 명시적으로 승인한 디렉터리 변경입니다.

이 권한은 `GroupMember.Read.All`이며 그룹 멤버 자격을 읽을 수 있는 애플리케이션 권한 중 가장 제한적입니다. Microsoft Graph에서 그룹 단위 대안을 제공하지 않으므로 테넌트 전체에 적용됩니다. 제품에서 실제 사용 범위를 좁힙니다. 게시된 거버넌스 세트에서 팀으로 지정한 그룹만 조회하며, 모든 요청에서 식별자만 선택하므로 표시 이름, 보안 주체 이름, 메일 주소는 읽거나 저장하지 않습니다.

이 권한은 컨트롤 플레인의 관리 ID에 부여합니다.

```powershell
$environment = '<environment>'
$subscription = azd env get-value AZURE_SUBSCRIPTION_ID --environment $environment
$tenant = azd env get-value ENTRA_TENANT_ID --environment $environment
$resourceGroup = azd env get-value GATEWAY_RESOURCE_GROUP_NAME --environment $environment
$functionApp = azd env get-value CONTROL_PLANE_FUNCTION_APP --environment $environment
if ((az account show --query tenantId -o tsv) -ne $tenant) {
  throw 'Sign in to the deployment tenant before granting a directory permission.'
}
$identity = az functionapp identity show --subscription $subscription -g $resourceGroup -n $functionApp --query principalId -o tsv

$token = az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv
$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }
$graph = (Invoke-RestMethod -Headers $headers -Uri "https://graph.microsoft.com/v1.0/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'").value[0]
$role = $graph.appRoles | Where-Object { $_.value -eq 'GroupMember.Read.All' -and $_.allowedMemberTypes -contains 'Application' }

$body = @{ principalId = $identity; resourceId = $graph.id; appRoleId = $role.id } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Headers $headers -Body $body `
  -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$identity/appRoleAssignments"
```

다시 읽어 확인합니다.

```powershell
(Invoke-RestMethod -Headers $headers -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/$identity/appRoleAssignments").value |
  Select-Object resourceDisplayName, appRoleId, createdDateTime
```

**새 환경에서는 최초 애플리케이션 배포 전에 이 권한을 부여하고 확인하며, 컨트롤 플레인이 디렉터리를 읽기 시작한 뒤로 미루지 않습니다.** Azure는 관리 ID의 토큰을 리소스 URI별로 자체 백엔드에 **약 24시간** 동안 캐시합니다. Microsoft 문서에 따르면 권한 변경이 적용되기까지 **수 시간**이 걸릴 수 있으며, [관리 ID의 토큰은 만료되기 전에 강제로 새로 고칠 수 없습니다](https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/managed-identity-best-practice-recommendations#limitation-of-using-managed-identities-for-authorization). 이 설치 순서는 역할이 없는 토큰이 캐시될 위험을 줄이지만, 역할 할당의 재조회나 대략적인 캐시 시간이 즉시 접근 가능함 또는 일정한 완료 시점을 보장하지는 않습니다.

재조회는 디렉터리 역할 할당이 존재함을 증명할 뿐, 모든 Function 인스턴스가 해당 역할을 담은 토큰을 가지고 있음을 증명하지는 않습니다. 정확한 역할 할당이 이미 존재하면 POST를 반복하지 않습니다. 초기 거버넌스를 게시한 뒤 디렉터리 프로젝션 성공과 최신 사용자 및 그룹 읽기 결과로 런타임 준비 상태를 확인합니다. `azd deploy` 성공만으로 명단 화면의 준비가 완료되었다고 판단하지 않습니다.

권한을 나중에 부여하면 캐시된 토큰이 갱신될 때까지 인스턴스마다 적용이
지연되거나 서로 다른 응답이 나올 수 있습니다. Function App을 다시 시작해도
토큰 갱신은 보장되지 않으며 배포 측에서 Azure 캐시 시간을 단축할 수 없습니다.

같은 지연은 반대 방향에도 적용됩니다. 권한을 제거해도 디렉터리 읽기가 즉시
중단되지 않을 수 있으므로 회수는 최종 일관성 방식으로 처리합니다.

계속 거부된다는 이유로 더 넓은 권한을 부여하지 마십시오. 역할 할당이 있는지 먼저 확인한 다음, 화면이 아니라 프로젝터에서 기록한 내용을 살펴봅니다.

```powershell
$appId = az resource show -g $resourceGroup -n "appi-ctl-<name>-<environment>-<suffix>" `
  --resource-type microsoft.insights/components --query "properties.AppId" -o tsv
```

해당 구성 요소에서 `Directory reading projected.`를 쿼리하고 결과를 `customDimensions.HostInstanceId`로 그룹화합니다. `projected`는 적어도 한 인스턴스가 읽기를 완료했음을 증명합니다. 다른 인스턴스에는 오래된 토큰이 남아 있을 수 있지만 모든 거부를 캐시 때문이라고 단정하지 않고 기록된 이유를 확인합니다. 모든 인스턴스가 `unavailable`을 보고하면 정확한 역할 할당과 부여 시각을 프로젝터의 실패 이유와 비교합니다. 이 결과만으로 역할 할당이 없다고 단정하지 않습니다.

프로젝터는 매시 30분에 실행됩니다. 이 일정 대기는 권한 반영 지연과 별개입니다. 접근이 가능해지고 초기 거버넌스가 게시된 뒤에도 다음 정기 실행에서 최신 읽기 결과가 작성될 때까지 기다립니다. 정상 프로젝션이 작성되면 별도 조치 없이 기존의 읽기 결과 부재 상태를 대체합니다.

권한을 제거할 때는 `id`를 사용하여 `DELETE /v1.0/servicePrincipals/{identity}/appRoleAssignments/{id}`로 역할 할당을 삭제합니다.

### 제품: 거버넌스 Bootstrap

신규 배포에는 고객 거버넌스 콘텐츠가 전혀 없습니다. 완전한 세트가 게시되기 전까지 작성 작업은 `503 published-policy-source-incomplete`를 반환할 수 있으며, 불완전한 세트가 일부만 활성화되지는 않습니다.

로컬 JSON 입력 파일을 만들고 모든 자리 표시자를 바꿉니다. 테넌트 고유 식별자는 공개 저장소에 커밋하지 마십시오.

```json
{
  "tenantId": "<tenant-id>",
  "scopeGroupId": "organization",
  "organization": {
    "models": ["coding-primary"],
    "limits": {
      "requestsPerMinute": 80,
      "tokensPerMinute": 80000,
      "tokenQuota": 40000000,
      "quotaPeriod": "Monthly"
    }
  },
  "teams": [
    {
      "teamKey": "engineering",
      "membershipGroupId": "<entra-group-object-id>",
      "models": ["coding-primary"],
      "limits": {
        "requestsPerMinute": 40,
        "tokensPerMinute": 40000
      }
    }
  ],
  "models": [
    {
      "deploymentName": "<foundry-deployment-name>",
      "modelKey": "coding-primary"
    }
  ],
  "applications": [
    {
      "applicationId": "<caller-client-id>",
      "attributionQuality": "generic",
      "displayCode": "application.coding-agent"
    }
  ],
  "budgets": [],
  "fallback": null
}
```

초기화 도구는 모델 공급자, API 제품군, 수명 주기, 콘텐츠 안전 정보를 Foundry 배포에서 읽어 옵니다. 이 파일에 해당 정보를 입력할 수는 없습니다. 팀 그룹 ID는 Entra 개체 ID여야 하며, 범위가 더 좁은 모든 모델 허용 목록은 조직 허용 목록에 포함되어야 합니다.

관리자 로그인이나 게시 없이 검증합니다.

```powershell
node tools/distribution/Initialize-Governance.mjs `
  --environment <environment> `
  --input .\initial-governance.json `
  --dry-run
```

시험 실행에서는 읽기 전용 공급자 검색만 수행하며 범위, 팀 및 모델 키, 개수, 만료 시각만 출력합니다. 내용이 맞으면 `--dry-run` 없이 실행합니다.

```powershell
node tools/distribution/Initialize-Governance.mjs `
  --environment <environment> `
  --input .\initial-governance.json
```

이 도구는 기본적으로 확인 주소와 코드를 출력합니다. 같은 컴퓨터, 휴대폰 또는 다른 컴퓨터에서 해당 주소를 열고 코드를 입력한 뒤 `Governance.Administer` 역할이 있는 계정을 선택합니다. 이 방식은 점프 호스트, 컨테이너 등 로컬 브라우저가 없는 환경에서도 작동합니다. 대신 `--sign-in browser`를 전달하면 Authorization Code + PKCE 흐름을 사용합니다. 이 경우 `http://localhost:4173/governance-bootstrap`에서 네이티브 클라이언트용 루프백 리디렉션이 열리므로 같은 컴퓨터에 브라우저가 있어야 합니다. Entra는 localhost 리디렉션을 비교할 때 포트를 무시하므로 로컬 콘솔의 SPA 리디렉션과 다른 경로를 사용합니다. 이전 배포에서 이 브라우저 흐름을 사용하려면 배포된 ID 구성을 먼저 업데이트합니다. 어느 방식을 사용하든 토큰은 메모리에만 남습니다. 테넌트, 대상, 역할, 만료 시각을 검증하며 토큰을 출력하거나 저장하지 않습니다.

컨트롤 플레인은 리비전을 활성화하기 전에 다음 다섯 가지 대상을 쓰고 다시 읽어 확인합니다.

- 역할 할당. 관리 권한은 Entra에서 관리하므로 처음에는 비어 있습니다.
- 이용 권한과 팀 카탈로그.
- 공급자가 수집한 모델 레지스트리와 호출 애플리케이션.
- 선택적 다운그레이드 계획.
- 선택적 토큰 예산.

최초 게시가 중단되었다면 실패 원인을 해결한 뒤 `--resume --revision-id revision-0001`을 실행합니다. 초기화 도구는 저장된 리비전 1 제안만 재개하며, 공급자를 다시 읽거나 대체 내용을 새로 만들지 않습니다. 이 복구 경로에서는 저장된 검증 완료 내용을 다시 시도해야 하며 다른 내용으로 대체할 수 없습니다. 거버넌스 세트가 활성화되면 도구 재실행이 거부되므로 이후 변경에는 콘솔을 사용합니다. 포기가 필요한 복구에는 콘솔에서 서비스가 허용한 복구 작업만 사용합니다. 검증된 대상이 하나라도 있으면 포기가 거부되며, 부트스트랩 리비전을 복구하려면 높은 수준의 복구 권한이 필요합니다. 영구 제안이 없는 레거시 리비전은 재개하거나 대체할 수 없습니다. 권한을 가진 사용자가 검증된 대상이 하나도 없는 리비전을 포기한 후 새 제안을 만들어야 합니다.

이 도구에서 사용하는 보호된 경로는 다음과 같습니다.

```text
POST <control-plane-endpoint>/api/v1/admin/governance/publish
```

지원되는 배포형 작성 화면은 이 최초 세트가 있어야 사용할 수 있습니다.

### 호출자별 강제 적용 검증하기

프로비저닝 전에 초기화한 보안 주체 키 저장소는 영구적인 제품 상태입니다. `principal-key-secret`을 교체하면 가명화된 모든 주체, 애플리케이션, 알림 키가 바뀌며 새 기록이 이전 기록과 연결되지 않습니다. 따라서 일반적인 비밀 교체가 아니라 계획된 ID 마이그레이션으로 다뤄야 합니다.

게이트웨이는 선택한 키 저장소 모드가 구성된 경우에만 호출자별 정책 해석을 활성화합니다. 정책 해석 과정에서 비밀이나 완전하고 유효한 거버넌스 세트를 읽지 못하면 추론은 `503 governance_unavailable`을 반환합니다. 더 넓은 기본 권한으로 대체되는 일은 없습니다. Function App의 `PRINCIPAL_KEY_SECRET` 구성 참조가 `Resolved`를 보고하는지, APIM의 `governance-policy-enabled` 명명된 값이 `true`인지 확인합니다.

적용된 명명된 값이 `true`인지, 모델 화면에 공급자 및 등록된 배포와 일치하는 최신 카탈로그가 표시되는지 확인합니다. 그런 다음 더 많은 호출자를 온보딩하기 전에 `/v1` 게이트웨이를 통해 이용 권한이 있는 호출자 한 명과 없는 호출자 한 명을 검증합니다.

### 지속적인 제품 구성

부트스트랩 후에는 콘솔에서 다음 항목을 관리합니다.

- 거버넌스 대상 team과 호출자.
- 모델 allowlist와 rate 또는 quota 제한.
- 토큰 예산.
- 다운그레이드 계획.

모델 레지스트리는 30일 동안 유효하며, 마지막 7일 동안에는 경고가 표시됩니다. 만료되기 전에 모델 화면에서 **Refresh catalogue from provider**를 사용합니다. 새로 고침은 등록된 모든 배포를 다시 읽고 다음 레지스트리 버전을 게시합니다. 등록된 배포가 사라졌다면 이를 알리지 않고 누락하는 대신 작업을 거부합니다.

호출자는 주체 정책, 애플리케이션 정책 또는 자신이 속한 카탈로그 등록 팀 하나 이상의 정책에 따라 허용될 수 있습니다. 팀 카탈로그에 없는 그룹은 무시됩니다. 여러 거버넌스 대상 팀의 권한은 결합되며, 귀속 처리를 위해 하나의 팀을 임의로 선택하지 않습니다.

#### 정책이 결합되는 방식

정책에는 권한 부여 축과 제한 축이 따로 있습니다. 두 축에 하나의 병합 규칙을 함께 적용하지 않습니다.

| policy 값 | 결합 규칙 | 결과 |
|---|---|---|
| 모델 접근 | **일치하는 주체, 애플리케이션, 거버넌스 대상 팀의 모든 권한에 대한 OR** | 일치하는 특정 정책 중 하나라도 허용한 모델은 이용할 수 있습니다. 단, 조직 허용 목록에도 포함된 모델이어야 합니다. 조직 허용 목록은 상한이며 허용 권한이 아닙니다. |
| 속도 및 토큰 할당량 제한 | **적용 가능한 모든 제한이 함께 적용되며 가장 엄격한 값이 우선합니다.** | 요청은 조직, 일치하는 모든 팀, 주체, 애플리케이션의 제한을 모두 통과해야 합니다. 기간이 같은 제한 중 가장 작은 값이 실질적인 상한입니다. |
| 예산 | **적용 가능한 모든 예산이 독립적인 카운터로 적용됩니다.** | 조직, 팀, 주체, 애플리케이션 예산 중 가장 먼저 소진되는 예산이 요청을 거부합니다. 기간이 다른 예산은 더하거나 하나의 숫자로 환산하지 않습니다. |
| 다운그레이드 계획 | **하나의 계획이 구체성에 따라 우선합니다.** | 애플리케이션, 주체, 유일하게 특정할 수 있는 팀 하나, 조직 순으로 우선합니다. OR 계산이나 최솟값 계산이 아닙니다. |

예를 들어 조직에서 모델 `A`, `B`, `C`를 허용하고, Team Red는 `A`, Team Blue는 `B`, 호출자의 주체 정책은 `C`에 대한 권한을 부여한다고 가정하겠습니다. 두 팀에 모두 속한 호출자는 `A`, `B`, `C`를 모두 사용할 수 있습니다. 어느 팀이나 주체 권한에 `D`를 추가하더라도 조직 허용 목록에 `D`가 포함되기 전까지는 사용할 수 없습니다.

같은 호출자에게 조직 범위에서 월 1,000만, Team Red에서 400만, Team Blue에서 600만, 주체에서 300만의 토큰 예산이 있다면 네 개의 카운터가 모두 적용됩니다. 이때 300만인 주체 예산이 가장 먼저 소진되는 실질적인 상한이 됩니다. 조직 예산은 월 단위이고 팀 예산은 일 단위라면 둘 다 각자의 기간 동안 활성 상태로 유지됩니다. 게이트웨이는 이를 환산하거나 더하지 않으며 둘 중 하나라도 소진되면 요청을 거부합니다.

거버넌스 대상 팀이 정확히 하나이면 팀 사용량과 공유 팀 카운터에서 해당 팀의 정식 키를 사용합니다. 팀이 없거나 여러 개이면 팀 귀속 정보가 없으며, 적용 가능한 팀 제한은 호출자의 주체 카운터에 적용됩니다. 거버넌스 대상 팀이 없고 일치하는 주체, 애플리케이션, 팀 정책도 없는 호출자는 거부됩니다.

운영용 토큰 메트릭은 단일 팀으로 특정할 수 없을 때 리터럴 `not-single-team` 버킷을 사용합니다. 이 값은 팀 ID가 아니라 메트릭 범주입니다. 요청 단위 귀속 정보와 저장된 귀속 정보 모두에서 `teamKey`는 비워 두고 주체 및 애플리케이션 키는 그대로 유지합니다.

여러 팀에 속한 호출자에 대해서는 팀별 다운그레이드 계획을 임의로 선택하지 않습니다. 애플리케이션, 주체, 조직 계획은 기존의 구체성 순서를 그대로 유지하며, 팀 계획은 거버넌스 대상 팀을 정확히 하나로 특정할 수 있을 때만 적용됩니다.

#### 결합 규칙 커스터마이징하기

관리 콘솔에서는 위 규칙 안에서 모델, 제한, 예산, 다운그레이드 계획을 구성합니다. 관리자가 규칙 자체를 변경할 수는 없습니다. 다른 결합 의미 체계가 필요한 조직은 다음 경계에서 코드를 사용자 지정하여 해당 동작을 유지할 수 있습니다.

| 경계 | 여기서 바꾸는 내용 | 함께 해야 하는 후속 작업 |
|---|---|---|
| `app/governance-domain/authorization/governance-authorization-evaluator.mjs` | 어떤 주체, 애플리케이션, 팀 바인딩에서 접근 권한을 부여하는지와 조직 상한 아래에서 모델 권한을 결합하는 방식 | 권한 없음, 단일 팀, 여러 팀, 주체 전용, 애플리케이션 전용 사례를 포함하여 범위 우선순위 및 권한 부여 테스트를 갱신합니다. |
| `app/governance-domain/policy/effective-policy-composer.mjs` | 적용 가능한 속도, 할당량, 예산 제한을 게이트웨이 카운터로 변환하는 방식 | 생성되는 모든 문서를 스키마에 맞게 유지하고, 기간이 같거나 다른 제한을 테스트합니다. |
| `app/governance-domain/policy/fallback-plan-compiler.mjs` | 우선하는 다운그레이드 계획과 대체 경로 간선의 컴파일 방식 | 순환 거부, 통신 계약 호환성, 명시적 옵트인, 요청 모델 및 적용 모델 보고를 그대로 유지합니다. |
| `app/governance-domain/contracts/v1/effective-policy-document.schema.json` | 컨트롤 플레인과 API Management 사이에서 주고받는 버전이 지정된 문서 | 의미 체계 검사기, 픽스처, 영속성 테스트, 마이그레이션 및 읽기 동작을 함께 갱신합니다. |
| `apim/policies/inference.xml` | 해석된 문서의 강제 적용 | `tests/policy/Test-InferencePolicy.ps1`을 갱신하고, 모든 게이트웨이 배포 모듈에서 `gateway-policy-version`을 올린 뒤 변경된 분기를 APIM 추적으로 입증합니다. |

새 규칙을 관리 UI에만 또는 API Management에만 구현하지 마십시오. 컨트롤 플레인의 결정, 적용 정책 계약, 게이트웨이 강제 적용, 사용량 귀속, 관리 읽기 모델은 모두 같은 결과를 내야 합니다. 조직에서 명시적으로 다시 설계하고 테스트하지 않는 한, 사용자 지정 규칙도 다음 불변 조건을 그대로 지켜야 합니다.

- 어떤 모델도 조직 허용 목록 상한을 벗어날 수 없습니다.
- 일치하는 주체, 애플리케이션 또는 거버넌스 대상 팀 권한 없이 호출자가 허용되어서는 안 됩니다.
- 명확하게 선택할 수 없는 팀에 요청을 귀속해서는 안 됩니다.
- 이용 권한의 근거가 없거나 근거를 읽을 수 없는 상태가 권한 부여로 이어져서는 안 됩니다.
- 프롬프트와 완성 본문은 거버넌스 근거에 포함되지 않습니다.
- 배포되는 모든 정책 본문에는 새로 읽을 수 있는 정책 버전과 변경된 동작 범위에 초점을 맞춘 테스트가 함께 있어야 합니다.

**향후 작업이며 현재 우선순위는 아닙니다.** 버전이 지정된 소수의 결합 프로필을 거버넌스 구성으로 노출하고 관리 콘솔에 적용 정책 미리 보기를 추가하는 방안입니다. 이는 로드맵 표시일 뿐 약속이나 현재 지원되는 배포 옵션이 아닙니다. 이 기능을 구현하고 테스트하기 전까지 병합 연산자를 바꾸려면 위와 같은 코드 수준의 확장이 필요합니다.

### 알림

알림은 선택 사항입니다. 채널이 없으면 발견 사항은 콘솔에 계속 표시되지만 다른 곳으로 전송되지 않습니다. Slack이나 Microsoft Teams에서 웹후크를 만드는 방법, 구성 후 콘솔에 표시되는 내용, 전송 및 확인 방식은 [채팅 채널로 거버넌스 알림 보내기](05-notifications_ko.md)에서 설명합니다.

## 운영상의 한계

- **예산은 `best effort` 방식으로 적용됩니다.** 이미 진행 중인 요청은 그대로 처리되므로 상한을 초과할 수 있습니다.
- **변경 이력은 무엇이 바뀌었는지 기록합니다.** 변조 여부를 탐지하지 않으며 위변조 탐지 원장도 아닙니다.
- **동시 실행은 거버넌스 대상이 아닙니다.** 호출자별 동시 실행 상한은 없습니다.
- **요청한 모델과 적용 모델은 다를 수 있습니다.** 다운그레이드 계획에서 다른 모델을 선택할 수 있으며, 그 결정을 감추기 위해 응답의 모델을 다시 쓰지는 않습니다.
- **회수는 토큰 갱신 또는 만료 시점에만 반영됩니다.** 기존 토큰을 내부 검사하지는 않습니다.
- **네트워크 노출 방식은 구성 요소마다 다릅니다.** 영구 리소스는 프라이빗 네트워크로 구성됩니다. Basic v2 API Management와 `public-authenticated` 관리 화면은 공개되어 있으며, 관리 화면은 Entra로 인증됩니다.
- **Foundry 직접 접근은 별도로 관리해야 합니다.** 이 게이트웨이는 자신이 받은 요청만 거버넌스 대상으로 삼습니다.
- **표준 멤버 자격 프로필은 대화형 사용자를 위한 것입니다.** Azure에서 호스팅되는 워크로드 ID에는 별도로 구성하는 워크로드 앱 역할과 디렉터리 멤버 자격 해석기가 필요하며, 해당 프로필은 기본적으로 비활성화되어 있습니다.

조직, 팀, 주체, 애플리케이션 범위에서 정의한 정책은 축마다 다르게 결합됩니다. 특정 호출자에게 적용될 내용을 판단하는 방법은 [평가 환경 운영 및 제거](03-operations_ko.md)의 정책 확인 절차에서 설명합니다.

## Fresh End-to-End 검증 기록

2026-09-09에 완료한 격리된 신규 Azure 실행에서는 APIM Developer, 하나의 Foundry 계정에 배포한 `gpt-oss-120b`(OpenAI-OSS, 버전 1, Global Standard)와 `gpt-5-nano`(OpenAI, 2025-08-07, Global Standard), Functions, 관리 SWA를 사용했습니다. 별도로 승인된 클라이언트 두 개가 실제 위임 인증을 사용했으며, 하나는 관리용이고 다른 하나는 게이트웨이 호출용이었습니다. 초기 거버넌스에서 게시 대상 다섯 개를 검증했습니다. 스크립트는 APIM을 통해 스트리밍하지 않는 Chat Completions 요청을 보냈습니다. 두 모델 모두 정확한 요청 모델 및 적용 모델 헤더와 어시스턴트 응답이 포함된 `200`을 반환했고, 인증되지 않은 접근은 `401`, 허용되지 않은 모델은 `403`을 반환했습니다. 배포된 콘솔과 사용량은 브라우저에서 확인했습니다. 같은 작성자의 승인 및 재개 요청에는 `409`가 반환되었고, 초안을 철회한 후에도 활성 리비전은 유지되었습니다. 본문을 제외한 시간별 사용량은 공급자 집계인 OSS 130개와 nano 24개, 총 154개 토큰과 일치했습니다. 처리된 요청 두 건에서 이 공급자 토큰을 사용했고, 인증 후 거부된 요청 한 건의 사용량은 토큰 0개였습니다.

이는 단 한 번의 검증 결과이며, 운영 환경 적합성이나 다른 테넌트의 용량, 권한, 보안을 보장하지 않습니다. 별도 승인자를 사용하는 테스트는 이번 완료 조건에서 제외했으므로, 서로 다른 승인자가 실제 환경에서 승인하는 동작은 검증하지 않았습니다. Streaming, Responses, 기본 Basic v2 계층도 이번 실행에서는 검증하지 않았으므로 결과를 모든 SKU에 일반화할 수 없습니다. 계정 범위의 런타임 권한으로는 지역별 가용 할당량을 조회할 수 없었으며, 이번 실행에서 권한을 확대하지도 않았습니다. 이후 구독 읽기 범위를 변경하려면 명시적인 승인을 받고 범위를 제한해야 합니다. 기존 콘솔 PNG는 합성 테스트 데이터로 만든 이미지이며 Azure 검증 증거가 아닙니다. 정리 범위는 소유권 증빙으로 한정했습니다. 실제 APIM, Foundry, Entra 정리와 허용된 영구 삭제는 로컬 전용 검사기가 아니라 별도로 승인된 운영자 절차에서 수행했습니다. Key Vault의 7일 영구 삭제 보호 설정은 유지했으며 강제로 해제하지 않았습니다. 일시 삭제 지연과 복구 가능한 디렉터리 개체 때문에 활성 개체가 없다는 사실만으로 영구 삭제를 입증할 수는 없습니다.

## 제거

리소스 그룹만 삭제해서는 충분하지 않습니다. Entra 애플리케이션과 서비스 주체는 리소스 그룹 외부에 있으며, APIM, Foundry, 키 저장소 이름은 일시 삭제로 인해 계속 점유된 상태로 남을 수 있습니다.

매니페스트에 연결된 로컬 미리 보기를 준비합니다.

```powershell
pwsh -NoProfile -File tools/distribution/Remove-Deployment.ps1 `
  -ManifestPath <ownership-manifest.json> `
  -StatePath <ownership-state.json> `
  -ReadbackPath <fresh-exact-id-readback.json> `
  -Preview `
  -OutputPath <removal-preview.json>
```

`Remove-Deployment.ps1`과 `tools/deployment/ownership-contract.mjs`는 로컬
소유권 검사기와 승인 계획 도구이며 삭제 실행기가 아닙니다. Azure, Microsoft Graph
또는 `azd`를 호출하지 않으며 삭제나 영구 삭제를 수행하지 않습니다. 일치하는
`-ApproveResourceDelete`, `-ApproveEntraCleanup`, `-ApproveEntraPurge`,
`-ApproveApimPurge`, `-ApproveKeyVaultPurge` 스위치와 `-ApprovalPath`는 동일한
매니페스트, 상태, 조회 결과, 출력 입력을 바탕으로 단계별 승인 결과만 생성합니다.

이 저장소는 매니페스트, 상태, 조회 결과를 만들지 않으며 제거 실행기도 제공하지
않습니다. 별도로 승인된 운영자 절차에서 이러한 기록을 제공합니다. 비용을 중지하려면
그 절차에서 전용 리소스 그룹의 정확한 소유 리소스 ID와 최신 정확 ID 조회 결과에
기록된 별도 소유 Entra 애플리케이션 및 서비스 주체에만 작업합니다. 재사용한 Foundry
리소스와 기존 그룹은 보존하고, 리소스 삭제, Entra 정리, 각 영구 삭제 단계에 대해
별도의 승인을 받아야 합니다. `azd down`이나 리소스 그룹 일괄 제거를 사용하거나,
증빙을 임의로 꾸미거나, 단계 검증을 실제 삭제 실행으로 간주하지 마십시오. 최종 조회
결과는 승인된 운영자 절차에서만 확인합니다. 허용되는 기록 형식은
[`tools/deployment/ownership-contract.mjs`](../tools/deployment/ownership-contract.mjs)와
정제된
[`tests/infra/fixtures/ownership-contract-fixture.mjs`](../tests/infra/fixtures/ownership-contract-fixture.mjs)에서
확인합니다.

## 되돌리기

- 애플리케이션에 문제가 생겼다면 `azd deploy control-plane --environment <environment>` 또는 `azd deploy admin-console --environment <environment>`로 정상 작동이 확인된 이전 커밋을 배포합니다.
- 인프라에 문제가 생겼다면 `--no-state`로 정상 작동이 확인된 템플릿을 미리 본 후 프로비저닝합니다.
- 거버넌스 콘텐츠에 문제가 생겼다면 이전 콘텐츠를 검증된 새 리비전으로 게시합니다.
- 환경을 제거했다가 다시 만드는 것은 되돌리기가 아닙니다. ID와 리소스 수명 주기 상태도 새로 생성되기 때문입니다.

## 문제 해결

### 플랫폼의 거부와 제품의 거부 구분하기

서로 다른 두 계층에서 `403`을 반환할 수 있으며 각각 다른 방향으로 조사해야 합니다.

- **본문이 빈 `403`**은 제품 코드가 실행되기 전 App Service 인증 단계에서 반환된 것입니다. 사이트의 인증 설정을 확인합니다.
- **`reasonCode`가 담긴 JSON 본문이 있는 `403`**은 제품에서 반환된 것입니다. 인증에는 성공했지만 거버넌스에서 거부했다는 의미이므로 호출자의 이용 권한을 확인합니다.

먼저 응답 본문 길이를 확인합니다. 가장 빠르게 확인할 수 있는 항목이며 조사 범위를 절반으로 줄여 줍니다.

### 모든 관리 route가 본문이 빈 `403`을 응답한다

새로 만든 배포에서는 사이트의 인증 설정에 빈 클라이언트 허용 목록이 남을 수 있으며, 빈 허용 목록은 모든 호출자를 거부합니다. 프로비저닝 과정에서는 이를 자동으로 제거합니다. 해당 단계 없이 템플릿을 배포했거나 증상이 다시 나타난다면 설정을 읽어 해당 키가 없는지 확인합니다.

```powershell
az rest --method get --url "https://management.azure.com/subscriptions/<subscription>/resourceGroups/<resource-group>/providers/Microsoft.Web/sites/<function-app>/config/authsettingsV2?api-version=2024-04-01" --query "properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy"
```

`allowedApplications` 키가 존재하지만 비어 있는 상태가 문제입니다. 키가 없는 것은 정상이며 클라이언트 제한을 적용하지 않습니다. 관리 API를 호출할 수 있는 클라이언트 애플리케이션을 제한할 의도가 없다면 빈 목록을 값이 있는 목록으로 바꾸지 마십시오.

### 인증 변경이 아무 효과도 없어 보인다

사이트의 인증 설정 변경은 다음 요청에 바로 적용되지 않고 잠시 후 적용됩니다. 변경 사항이 적용되지 않았다고 판단하기 전에 1분 후 요청을 반복합니다. 설정을 쓴 직후 측정하면 잘못된 결론을 내리기 쉽습니다. 수정 사항이 적용되지 않은 것처럼 보이거나, 잘못된 변경이 문제없는 것처럼 보일 수 있습니다.

### Users and Groups 화면이 읽은 내용이 없다고 한다

`503 reading_unavailable / directory-snapshot-absent`는 컨트롤 플레인에서 디렉터리 읽기를 한 번도 기록하지 않았다는 뜻이며, 거버넌스 대상 팀이 비어 있다는 뜻은 아닙니다. 새 배포에서는 [Entra: Users & Groups 화면을 위한 디렉터리 읽기 권한](#entra-users--groups-화면을-위한-디렉터리-읽기-권한)에서 설명한 Microsoft Graph 권한 누락이 흔한 원인입니다. 권한이 이미 할당되어 있다면 해당 할당이 아직 ID 토큰에 반영되지 않았을 수 있습니다. 두 경우를 프로젝터 자체 기록으로 구분하는 방법은 해당 절에서 설명합니다.

### 영향 미리 보기에 호출자 근거가 없다고 표시된다

관리 리소스 API는 현재 신원 템플릿처럼 `groupMembershipClaims: 'SecurityGroup'`을 요청해야 합니다. 로그인한 사용자의 보안 그룹 ID를 토큰에 포함하는 설정이며, `GroupMember.Read.All`을 부여하거나 선택적 디렉터리 명단을 활성화하지 않습니다. `ApplicationGroup`으로 대체하면 게이트웨이에만 할당된 그룹이 관리 토큰에서 빠집니다.

이전 설치에서는 그룹 클레임 누락이 정책 해석기에 전달되어 `503 preview_unavailable / preview-source-unavailable`이 발생할 수 있습니다. 업데이트한 코드는 구체적인 `caller-policy-evidence-unavailable` 이유를 반환합니다. 콘솔 클라이언트가 아니라 관리 API 등록을 확인합니다.

```powershell
az ad app show --id <administration-api-client-id> --query groupMembershipClaims
```

값이 없거나 다르면 문서의 프로비저닝 절차를 통해 같은 환경에 업데이트한 신원 템플릿을 적용하되, 기존 애플리케이션 ID와 역할 할당을 유지합니다. 업데이트한 컨트롤 플레인과 콘솔을 배포한 뒤 빈 새 탭에 콘솔 URL을 입력하고 다시 로그인하여 새 토큰을 받습니다. 기존 탭의 복제나 새로고침은 세션 저장소의 만료되지 않은 토큰을 계속 사용할 수 있습니다. 승인하지 않은 저장된 초안을 미리 봅니다. 등록 설정의 재조회만으로 런타임 성공이 입증되지는 않습니다. 비교 결과와 활성 리비전이 변하지 않았음을 확인하고, 검증용 초안이라면 게시하지 말고 철회합니다.

토큰의 그룹 개수가 한도를 초과해도 그룹 목록이 생략됩니다. 이를 빈 소속으로 간주하거나 디렉터리 권한을 자동 부여하지 않고 명시적으로 비교 불가 처리합니다. 토큰을 진단 출력이나 문서에 붙여 넣지 않습니다. 이 토큰 갱신 문제는 관리 ID의 Graph 권한 반영 지연 및 디렉터리 프로젝터 스케줄과 별개입니다.

### 최초 거버넌스 로그인에서 AADSTS9002326이 발생한다

초기화 도구는 브라우저 Origin을 사용하는 SPA 토큰 교환이 아니라 네이티브 PKCE를 사용합니다. Entra는 localhost 리디렉션을 일치시킬 때 포트를 무시하므로, 이전 등록에서는 SPA 리디렉션 `http://localhost:4173`과 네이티브 리디렉션 `http://localhost`가 충돌할 수 있습니다. 현재 템플릿은 네이티브 경로를 `http://localhost/governance-bootstrap`으로 분리하며, 초기화 도구는 `http://localhost:4173/governance-bootstrap`에서 수신하고 `Origin` 헤더 없이 코드를 교환합니다.

같은 환경에 업데이트한 신원 템플릿을 적용하면서 콘솔 애플리케이션 ID, SPA 리디렉션 및 역할을 유지하고, 그에 맞는 업데이트한 초기화 도구를 사용합니다. 네이티브와 SPA 리디렉션 등록을 모두 확인한 뒤 초기화를 재시도합니다. 이 오류를 우회하려고 implicit flow를 활성화하거나 클라이언트 비밀을 추가하거나 배포된 콘솔의 SPA 리디렉션을 제거하지 않습니다. 초기 리비전이 활성 상태이고 게시 대상 다섯 개가 모두 검증됐는지 확인합니다. 로그인 성공만으로 초기화 성공을 판단하지 않습니다.

### bootstrap 도구가 요청한 로그인이 끝나지 않는다

디바이스 코드는 출력된 순간부터 약 15분 동안 유효하며, 도구는 그 시간 동안 계속 기다립니다. 코드가 만료되면 명령을 다시 실행하여 새 코드를 받습니다. 로그인에 성공하고 관리 경로가 응답하기 전까지는 아무것도 게시되지 않습니다.

### what-if가 검증 범위 경고와 함께 변경 없음으로 표시된다

`ExtensibleResourceNotSupported`는 what-if에서 Microsoft Graph 리소스를 평가하지 않았다는 뜻입니다. `NestedDeploymentShortCircuited`는 중첩 배포를 확장하지 못했다는 뜻입니다. 명령 성공이나 빈 변경 목록이 신원 또는 중첩 리소스의 변경 없음을 입증하지는 않습니다. 경고를 보존하고 의도한 템플릿과 매개변수 변경을 검토하며, 배포 후 정확한 애플리케이션 ID, 역할 할당 및 리소스 상태를 재조회합니다. 업그레이드에서는 해당 환경의 이름 생성 입력을 유지하고 이전 배포 템플릿과 비교합니다. 미리 보기 범위가 불완전하다는 이유로 앱 등록을 삭제하고 다시 만들지 않습니다.

### 채널 변경이 거부된다

주소는 자격 증명이므로 거부 응답에는 주소 대신 규칙 이름이 표시됩니다. `channel-kind-unsupported`는 이 배포에서 지원하지 않는 채널 종류라는 뜻입니다. `endpoint-refused`는 주소 자체가 허용되지 않았다는 뜻이며, 이 배포 외부에 있는 채널의 `https` 주소를 사용해야 합니다.

## 공식 참고 자료

- [Azure Developer CLI 참고 문서](https://learn.microsoft.com/azure/developer/azure-developer-cli/reference)
- [API Management의 AI 게이트웨이 기능](https://learn.microsoft.com/azure/api-management/genai-gateway-capabilities)
- [`llm-token-limit` 정책](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy)
- [`llm-emit-token-metric` 정책](https://learn.microsoft.com/azure/api-management/llm-emit-token-metric-policy)
- [`validate-azure-ad-token` 정책](https://learn.microsoft.com/azure/api-management/validate-azure-ad-token-policy)
- [대규모 언어 모델 요청 로깅](https://learn.microsoft.com/azure/api-management/api-management-howto-llm-logs)
- [API Management의 managed identity](https://learn.microsoft.com/azure/api-management/api-management-howto-use-managed-service-identity)
- [Microsoft Foundry 문서](https://learn.microsoft.com/azure/ai-foundry/)
- [Azure AI 인증](https://learn.microsoft.com/azure/ai-services/authentication)
- [Microsoft Entra ID의 애플리케이션 role](https://learn.microsoft.com/entra/identity-platform/howto-add-app-roles-in-azure-ad-apps)
- [Azure Functions Flex Consumption](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan)
- [Azure Static Web Apps](https://learn.microsoft.com/azure/static-web-apps/)
- [AI 게이트웨이에 대한 Azure Architecture Center 가이드](https://learn.microsoft.com/azure/architecture/ai-ml/guide/azure-openai-gateway-guide)

`Azure-Samples/AI-Gateway`와 `Azure-Samples/APIM-Unified-AI-Gateway-Sample` 저장소에서는 Microsoft가 공개한 참조 구현을 제공합니다. 이 안내서는 해당 배포 토폴로지를 그대로 따르지 않으며 구독 키 예시도 사용하지 않습니다.
