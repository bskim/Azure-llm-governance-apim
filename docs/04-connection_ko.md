# 코딩 에이전트 연결하기

게이트웨이 URL을 받고 코딩 에이전트를 해당 주소에 연결해야 하는 상황을 위한 문서입니다. 게이트웨이가 공개하는 연결 계약을 지키는 방법과 연결 후 응답의 의미를 설명합니다.

게이트웨이 배포 방법([게이트웨이 배포하기](01-deployment_ko.md) 참고)이나 특정 호출자의 접근 범위([평가 환경 운영 및 제거](03-operations_ko.md)의 정책 확인 참고)는 다루지 않습니다. 게이트웨이와 통신할 수 있게 된 뒤 특정 요청이 허용·제한·거부된 이유는 해당 문서에서 설명합니다.

## 이 게이트웨이가 지키는 계약

다음은 게이트웨이가 보장하는 계약이며, 연결하는 클라이언트가 지켜야 할 사항입니다.

- OpenAI 호환 API 계열이며 `/v1` 기본 URL로 서비스됩니다.
- 호출자는 특정 테넌트, 대상(audience), 위임된 범위(scope, `Gateway.Access`)에 대한 Microsoft Entra 액세스 토큰으로 인증합니다.
- 위임 로그인에는 배포가 승인한 공용 클라이언트를 사용합니다. 해당 클라이언트 ID는 초기 연결을 위해 관리자가 제공하는 정보이며 자동 검색 메타데이터에 포함되지 않습니다.
- 토큰은 직접 획득하고 갱신해야 합니다. 게이트웨이가 대신 세션을 유지해 주지 않습니다.
- `401`, `403`, `429`는 의미와 재시도 방식이 서로 다릅니다.
- 이 배포의 정확한 테넌트, 대상, 범위 값은 자격 증명 없이 게이트웨이에서 확인할 수 있습니다.

이 계약을 지킬 수 있다면 어떤 클라이언트든 연결할 수 있습니다. 이 가이드의 나머지 부분에서는 설치 대상이 아니라 연결 방법을 설명합니다.

`/v1`은 OpenAI 호환 데이터 평면 통신 규약입니다. APIM Basic v2 서비스 계층과는 관계가 없습니다. 이 gateway가 구현한 upstream 경로는 해당 작업을 `/openai/v1` 아래에 정의하며 `/openai/v2` 변형은 정의하지 않습니다.

인프라는 구성된 Foundry 계정의 OpenAI v1 엔드포인트로 백엔드를 만듭니다. 공개하는 모든 작업에 대해 APIM 관리 ID 호출이 성공하는지를 배포 승인 기준으로 검증합니다.

## 게이트웨이 자신에게서 계약 알아내기

게이트웨이에서 받은 URL 외에는 아무것도 요구하지 않는 방법부터 시작합니다. 아래 세 가지 요청에는 자격 증명이 필요하지 않습니다.

**인증되지 않았거나 형식이 잘못된 요청.** `Authorization` 헤더 없이 또는 실제 토큰이 아닌 bearer 값으로 작업을 호출합니다. 두 경우의 응답은 같습니다.

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://<gateway-host>/.well-known/oauth-protected-resource/v1"

{"error":{"code":"invalid_token", ...}}
```

**그 링크를 따라갑니다.** 링크가 가리키는 메타데이터 문서는 자격 증명 없이도 `200`으로 응답합니다.

```json
{
  "resource": "https://<gateway-host>/v1",
  "authorization_servers": ["https://login.microsoftonline.com/<tenant-id>/v2.0"],
  "scopes_supported": ["<audience>/Gateway.Access"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Azure AI Governance Gateway"
}
```

여기에는 클라이언트 ID나 비밀 키가 없습니다. `resource`는 이미 받은 `/v1` 기본 URL과 정확히 같습니다. `authorization_servers`는 로그인 대상 테넌트를 지정합니다. `scopes_supported`는 요청해야 할 정확한 대상 한정 범위를 지정합니다. 즉 범위 이름만 있는 형태가 아니라 `<audience>/Gateway.Access`입니다. 응답에는 `Cache-Control: max-age=3600`도 포함되므로 클라이언트는 시작할 때마다 가져오지 않고 한 시간 동안 캐시할 수 있습니다.

클라이언트는 거부 응답 하나로 resource 계약을 확인할 수 있으므로 테넌트와 대상 값을 표에서 옮겨 적을 필요가 없습니다. 이 메타데이터는 OAuth 클라이언트를 등록하거나 배포가 승인한 클라이언트 목록을 공개하지 않습니다. 게이트웨이 관리자에게 승인된 클라이언트 ID를 받거나 관리자가 지정한 클라이언트를 사용합니다. 해당 클라이언트로 메타데이터에서 확인한 범위를 요청합니다.

**이 게이트웨이가 서비스하지 않는 경로.** 구현되지 않은 경로와 메서드 조합을 호출하면 다음 응답을 받습니다.

```
HTTP/1.1 404 Not Found
{"error":{"code":"route_not_supported", ...}}
```

이 응답은 실제로 존재하는 경로를 나열하지 않습니다. 호출할 대상은 응답의 경로 목록이 아니라 메타데이터 문서와 이 가이드에서 확인합니다.

## 요청이 돌아오는 방식

토큰을 제시하면 게이트웨이는 호출자의 거버넌스를 확인하고 다음 중 하나로 응답합니다. 운영에 적용하기 전에는 대상 배포에서 정확한 상태 코드, 헤더, 백엔드 호환성을 검증해야 합니다.

| 응답 | 의미 |
| --- | --- |
| `200`, `x-policy-resolution: resolved` | 서비스됨. `x-requested-model`과 `x-effective-model`이 모두 있으며 서로 다를 수 있습니다. 관리자가 대체 모델로의 downgrade를 구성할 수 있습니다. 사용량 집계는 응답 본문에 있습니다. |
| `403`, code `caller_not_entitled`, `x-policy-resolution: refused` | 인증은 되었지만 이 게이트웨이가 이 경로에 대해 신뢰하는 명단(roster)에 없습니다. 본문은 팀이나 모델을 지목하지 않습니다. 거버넌스 구조는 호출자가 읽을 수 있는 대상이 아닙니다. |
| `403`, code `model_not_allowed`, 본문에 `allowed_models` 나열 | 인증되었고 일부 모델에 대한 이용 권한이 있지만 요청한 모델은 아닙니다. **이 거부에는 `x-policy-resolution`이 없습니다.** 따라서 이 헤더로 해당 거부를 다른 경우와 구분할 수 없습니다. |
| `403`, code `token_quota_exceeded`, 헤더 `Retry-After: <seconds>` | 적용 중인 기간별 할당량이 소진되었습니다. 토큰을 갱신해도 달라지지 않으며, 표시된 재설정 간격 전에는 재시도해도 성공할 수 없습니다. |
| `429`, code `rate_limit_exceeded`, 헤더 `Retry-After: <seconds>` | 요청 속도가 한도를 초과했습니다. 대기 시간을 임의로 정하지 않고 응답 헤더에 지정된 간격을 따릅니다. |
| `404`, code `route_not_supported` | 경로와 메서드 조합이 이 게이트웨이가 서비스하는 대상이 아닙니다. |

**백엔드로 전달이 허용된 요청은 제공자가 거부하더라도 할당량을 사용할 수 있습니다.** APIM은 백엔드로 보내기 전에 요청 한도를 적용하므로 게이트웨이 검증을 통과한 요청은 제공자가 나중에 `400`을 반환해도 집계될 수 있습니다. 대상 배포에서 이 동작을 확인하고 지속되는 `400`을 짧은 간격으로 반복해서 재시도하지 마십시오.

### 클라이언트에게 각 상태 코드가 의미하는 것

클라이언트는 상태 코드에 따라 재시도 여부를 결정합니다.

- **`401`**: 자격 증명이 없거나 형식이 잘못되었거나 만료되었습니다. 새 토큰을 획득하면 해결될 수 있습니다. 새 토큰으로 한 번만 재시도하며, 다시 실패하면 추가로 재시도하지 않습니다.
- **`403`**: 호출자는 인증되었지만 정책이 요청을 거부했거나 기간별 할당량이 소진되었습니다. 새 토큰으로는 어느 경우도 해결되지 않습니다. 이용 권한에 따른 거부는 재시도하지 않습니다. `token_quota_exceeded`이면 `Retry-After` 간격 이상 기다리거나 관리자에게 할당량 변경을 요청합니다.
- **`429`**: 요청 속도가 한도를 초과했습니다. 속도를 줄이고 `Retry-After` 헤더가 알려주는 간격만큼 기다린 뒤 재시도합니다.

## 토큰을 계속 유효하게 유지하기

토큰 유효기간은 대략 한 시간입니다. 자격 증명을 보유한 구성 요소는 만료 전에 토큰을 갱신할 수 있어야 하며, 이 요구 사항은 아래 경로마다 다릅니다. 자격 증명이 프로세스 수명 동안 고정된 에이전트는 직접 갱신할 수 없으므로 다른 구성 요소가 대신 갱신해야 합니다.

offline access를 요청한 경우 발급받은 refresh 토큰을 보관해 갱신에 사용합니다. refresh 토큰을 버려도 세션의 첫 한 시간은 동작하지만, 작업 중 토큰이 만료되면 다시 로그인해야 합니다.

## 이 계약을 지키는 두 가지 방법, 둘 다 필수는 아닙니다

올바른 테넌트, 대상, 범위에 대한 유효한 Entra 토큰을 제시하고 만료 전에 갱신할 수 있다면 무엇이든 연결할 수 있습니다. 실제로는 다음 두 방식 중 하나를 사용합니다.

### 로컬 프록시

로컬 프로세스는 Entra 자격 증명을 보관·갱신하거나 에이전트의 전송 형식을 변환하거나 두 작업을 모두 수행할 수 있습니다. 변환 프록시가 gateway에 OpenAI 호환 요청을 보내고 인증 계약을 지키면, 이 gateway에서 테스트하지 않은 에이전트도 연결할 수 있습니다.

**프록시는 필수가 아닙니다.** 에이전트가 스스로 이 계약을 지킬 수 있다면(아래 참고) 프록시가 필요하지 않습니다.

OpenCodex는 에이전트 앞에 둘 수 있는 프록시의 한 예입니다. [독립적으로 관리되는 MIT 프로젝트](https://github.com/lidge-jun/opencodex)이며 이 게이트웨이의 종속 구성 요소가 아닙니다. 설치 전에는 [OpenCodex 문서](https://opencodex.me/)와 보안 경계를 검토합니다.

이 저장소는 자격 증명 갱신이 필요한 클라이언트를 위한 인증 브리지를 제공합니다. 사용법은 [`tools/agent-auth-bridge/README.md`](../tools/agent-auth-bridge/README.md)에 정리되어 있습니다. 이 브리지는 요청을 그대로 전달하며 전송 형식, 본문, 모델을 바꾸지 않습니다. 클라이언트가 다른 프로토콜을 사용하면 별도의 변환 프록시가 필요합니다. 게이트웨이는 어느 구성 요소의 동작도 보증하지 않습니다.

#### OpenCodex와 자격 증명 bridge 연결

이 선택적 구성의 역할은 다음과 같이 나뉩니다.

```text
Codex 또는 Claude Code
        -> OpenCodex :10100       프로토콜 및 모델 선택
        -> agent-auth-bridge      Entra 토큰 획득 및 갱신
        -> APIM /v1               권한, 한도, 원격 측정
        -> Microsoft Foundry
```

조직의 의존성 검토와 릴리스 절차를 거쳐 OpenCodex 버전을
선택합니다. 승인된 패키지 레지스트리를 명시적으로 구성하고 레지스트리 및
패키지 관리자 정책에 따라 무결성을 확인합니다. 무결성 정보가
없거나 일치하지 않으면 거부해야 합니다. OpenCodex 프로젝트의 설치 안내를 따른 뒤
이 저장소의 인증 브리지를 시작합니다.

```powershell
node tools/agent-auth-bridge/agent-auth-bridge.mjs `
  --port 8788 `
  --upstream https://<gateway-host> `
  --scope <audience>/Gateway.Access `
  --tenant <tenant-id> `
  --client <approved-client-id>
```

다음 항목을 `~/.opencodex/config.json`에 추가합니다. 기존 파일의 다른 provider나 client 설정은 교체하지 마십시오. `<gateway-model-alias>`는 게이트웨이 관리자가 게시한 논리적 `modelKey`로 바꿉니다. `apiKey` 값은 로컬 프록시가 요구하는 자리 표시자이며 비밀 정보가 아닙니다. 브리지가 이 값을 제거하고 Entra 토큰을 제시합니다.

```json
{
  "port": 10100,
  "hostname": "127.0.0.1",
  "providers": {
    "governed-gateway": {
      "adapter": "openai-responses",
      "baseUrl": "http://127.0.0.1:8788/v1",
      "apiKey": "placeholder-replaced-by-bridge",
      "defaultModel": "<gateway-model-alias>",
      "models": ["<gateway-model-alias>"],
      "liveModels": false,
      "allowPrivateNetwork": true
    }
  },
  "defaultProvider": "governed-gateway",
  "clientIntegrations": {
    "codex": false,
    "grok": false,
    "claude-desktop": false
  },
  "claudeCode": {
    "enabled": true,
    "nativePassthrough": false,
    "model": "governed-gateway/<gateway-model-alias>",
    "smallFastModel": "governed-gateway/<gateway-model-alias>",
    "modelMap": {
      "<claude-code-model-id>": "governed-gateway/<gateway-model-alias>"
    },
    "systemEnv": false,
    "injectAgents": false
  },
  "syncResumeHistory": false
}
```

설정 파일을 검증한 뒤 OpenCodex를 시작합니다.

```powershell
ocx config validate "$HOME/.opencodex/config.json" --json
ocx start --port 10100
```

이 최소 구성에서는 기본 클라이언트 통합이 꺼져 있으므로 클라이언트의 기본 URL을 직접 `http://127.0.0.1:10100/v1`로 설정합니다. Responses 클라이언트에서는 `governed-gateway/<gateway-model-alias>`를 선택합니다. Claude Code는 Anthropic Messages를 `http://127.0.0.1:10100`으로 보내며, 들어오는 모델 ID가 `claudeCode.modelMap` 항목과 일치해야 합니다. OpenCodex가 프로토콜을 변환하고 이 저장소의 인증 브리지가 Entra 로그인과 자격 증명 교체를 담당합니다.

로컬 프록시 구성을 해제할 때는 OpenCodex를 중지합니다.

```powershell
ocx stop
```

관리자가 추가 요청을 승인하지 않았다면 이 gateway에 대해 OpenCodex `retryOn429`를 켜지 마십시오. 예시 config에는 해당 항목이 없으므로 gateway의 `429`와 `Retry-After`가 같은 대상에 대한 암묵적 재시도 없이 클라이언트에 전달됩니다.

### 직접 연결

에이전트 자체의 프로토콜과 인증만으로 이 계약을 지킬 수 있다면 중개자 없이 게이트웨이에 직접 연결할 수 있습니다. 다음 표는 선택한 버전에서 검증해야 할 클라이언트 통신 규약의 고려 사항을 요약합니다.

| Client | Contract 고려 사항 | 로컬 프록시 필요? |
| --- | --- | --- |
| Codex CLI | 일정 간격으로 토큰 획득 명령을 실행하므로 도움 없이 갱신합니다. 그 명령이 로그인하는 클라이언트는 배포가 승인한 클라이언트여야 합니다. | 아니오 |
| OpenCode | 자신의 plugin 안에서 스스로 토큰을 획득하고 갱신합니다. 자기 고유의 강한 application identity를 가진 유일한 client입니다. | 아니오 |
| GitHub Copilot CLI | 프로세스 수명 동안 고정된 환경 변수에서 bearer 토큰을 가져옵니다. | 예 |
| VS Code with a custom model endpoint | 이 게이트웨이의 audience에 대한 토큰을 요청할 수 없습니다. | 예 |
| Claude Code | Anthropic Messages를 사용합니다. 이 저장소의 자격 증명 bridge는 이를 변환하지 않습니다. 위 OpenCodex 경로에서는 측정한 Messages 요청 한 건을 Responses로 변환했습니다. | 예(프로토콜 변환) |

이 고려 사항은 모든 클라이언트, 버전, 배포된 게이트웨이에 적용되는 보장이 아닙니다. 선택한 버전은 대상 배포와 고객의 릴리스 절차에서 검증해야 합니다. 목록에 없는 클라이언트도 같은 기준으로 검증합니다. 즉 이 대상과 범위에 대한 토큰을 획득하고 만료 전에 갱신하며, 배포된 게이트웨이를 통해 승인된 요청을 완료할 수 있는지 확인합니다.

중개자 없는 연결이 실제로 동작하는지는 배포의 두 가지 사실이 결정합니다. 첫째, 위임 토큰은 배포가 승인한 공개 클라이언트에서 발급된 것만 허용하므로, Azure CLI처럼 명령으로 로그인하는 방식은 운영자가 `ENTRA_DEVELOPER_CLIENT_APPLICATION_ID`로 그 클라이언트를 승인하지 않는 한 거부됩니다. 기본값은 아무 클라이언트도 승인하지 않으며, 이때의 거부는 설정 문제가 아니라 로그인이나 권한 부여 실패처럼 보입니다. 둘째, 이 게이트웨이는 `/v1/responses`와 `/v1/chat/completions`만 제공하므로, 시작할 때 모델 목록을 조회하는 클라이언트는 실제 요청이 성공하더라도 `/v1/models`에서 `404 route_not_supported`를 받습니다.

## 선택하기 전에 알아둘 두 가지 사실

**이 게이트웨이는 게이트웨이에 도달한 트래픽에만 거버넌스를 적용합니다.** 에이전트나 에이전트가 통신하는 구성 요소가 기반 모델에 직접 도달할 수 있다면, 해당 트래픽은 이용 권한, 요청 속도 제한, 예산 등 게이트웨이의 모든 정책을 우회합니다. 프록시든 직접 연결이든 에이전트 요청이 거치는 유일한 경로일 때만 "거버넌스 대상"입니다.

**프록시는 설정된 신원으로 인증하며 실제 사용자로 인증하지 않습니다.** 프록시를 거친 요청의 게이트웨이 로그와 거버넌스에는 프록시가 보유한 자격 증명(service principal, 공유 로그인, 애플리케이션 신원)이 표시되며, 프롬프트를 입력한 사람은 표시되지 않습니다. 사람 단위 귀속이 중요하다면 누구의 신원으로 기록되는지 확인한 뒤 자격 증명을 선택하고 구성해야 합니다.

## 이 가이드가 절대 요구하지 않는 것

- 제공자 API key를 에이전트 설정에 붙여넣는 것. 이 게이트웨이는 Entra 토큰으로 호출자를 인증합니다. 공유 key는 사람이 아니라 배포를 인증하므로 호출자 단위 거버넌스를 완전히 무력화합니다.
- 토큰을 획득한 세션보다 오래 남는 방식으로 디스크에 영속화하는 것.
- CLI 자체의 자격 증명 캐시를 읽어 오는 것. 토큰은 이 게이트웨이가 명시한 대상과 범위에 대해 문서화된 흐름으로 획득해야 하며, 다른 도구가 저장한 상태를 읽어 얻으면 안 됩니다.
- 등록되지 않은 클라이언트 ID를 신뢰하는 것. 사용하는 흐름에 대해 이 게이트웨이의 테넌트가 인식하는 애플리케이션으로 로그인해야 합니다.

## 연결 검증하기

1. 자격 증명 없이 검색 요청을 반복해 위에서 설명한 `401`과 메타데이터 문서가 반환되는지 확인합니다. 로그인 전에 대상 호스트가 올바른지 확인하는 단계입니다.
2. 메타데이터 문서가 지정한 테넌트, 대상, 범위에 대한 토큰을 획득하고 실제 요청을 한 번 보냅니다. `x-policy-resolution: resolved`와 함께 `200`이 반환되어야 합니다. 여기서 `403`이 반환되는 것은 연결 문제가 아닙니다. 특정 호출자가 특정 모델을 이용할 권한이 있는지를 결정하는 요인은 [평가 환경 운영 및 제거](03-operations_ko.md)의 정책 확인에서 설명합니다.
3. 로컬 프록시를 사용한다면 2단계 결과를 신뢰하기 전에 에이전트 요청에 제공자 키나 오래된 캐시 토큰이 아니라 프록시의 토큰이 포함되는지 확인합니다.

## 되돌리기

클라이언트 연결에는 게이트웨이 쪽에서 되돌릴 서버 측 상태가 없습니다. 연결을 해제할 때는 로컬에서 변경한 내용을 원래대로 돌립니다. 에이전트의 기본 URL을 이전 값으로 되돌리거나 로컬 프록시를 중지합니다. 프록시가 이 목적으로 자체 Entra 애플리케이션을 등록했다면, 해당 등록을 제거하는 작업은 자신의 테넌트에서 수행하는 별도의 되돌릴 수 있는 작업이며 게이트웨이에는 영향을 주지 않습니다.
