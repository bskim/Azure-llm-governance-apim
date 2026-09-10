# 채팅 채널로 거버넌스 알림 보내기

콘솔에서는 예산 한도 접근, 사용량 집계 지연, 호출자의 불명확한 팀 소속, 게시 검증 실패 등의 발견 사항(finding)을 확인할 수 있습니다. 콘솔을 열지 않은 관리자에게도 알리려면 같은 내용을 Slack의 incoming webhook이나 Microsoft Teams의 Workflows 트리거로 전달할 수 있습니다.

채널 설정은 선택 사항입니다. [채널 설정이 필요한 경우](#채널-설정이-필요한-경우)를 기준으로 필요 여부를 판단한 뒤, 아래 절차에 따라 채널을 설정하고 전달 동작을 확인합니다.

## 이 제품이 지원하는 두 채널

두 채널 모두 HTTPS **webhook 주소**로 연결됩니다. 게이트웨이 배포 환경에서 이 URL로 JSON 본문을 POST합니다. 연동을 위해 게이트웨이에 앱이나 봇을 설치하거나 인바운드 연결을 열 필요는 없습니다. 알림 연동은 외부 채널로 보내는 단방향 전송입니다.

### Slack: incoming webhook

webhook은 [Slack의 최신 가이드](https://api.slack.com/messaging/webhooks)에 따라 Slack 앱 설정에서 만듭니다.

1. 알림을 게시할 워크스페이스에서 Slack 앱을 새로 만들거나 기존 앱을 재사용합니다.
2. 앱의 **Incoming Webhooks** 설정을 열고 **Activate Incoming Webhooks**를 켭니다.
3. **Add New Webhook to Workspace**를 선택하고 게시할 채널을 고른 뒤 승인합니다.
4. 생성된 URL을 복사합니다. URL은 `https://hooks.slack.com/services/...` 형태입니다. 나머지 경로는 인증 정보이므로 여기서는 생략합니다. 입력할 곳은 [주소를 붙여넣는 위치](#주소를-붙여넣는-위치)에서 설명합니다.

### Microsoft Teams: 폐지되는 connector 대신 Workflows trigger

Teams용 Microsoft 365(Office 365) connector는 폐지 절차가 진행 중이며, Microsoft는 대신 **Workflows** 앱에서 webhook을 만들도록 안내합니다. 최신 절차와 폐지 일정은 [Workflows로 webhook을 만드는 Microsoft 가이드](https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)와 [Microsoft 365 connector 폐지 공지](https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/what-are-webhooks-and-connectors)에서 확인할 수 있습니다.

1. 알림을 게시할 Teams 채널에서 **More options**를 열고 **Workflows**를 선택합니다.
2. **Send webhook alerts to a channel**과 같은 템플릿을 검색해 선택하거나, **When a Teams webhook request is received** 트리거를 사용해 새로 만듭니다.
3. 워크플로를 구성하고 저장합니다.
4. 워크플로가 생성한 webhook URL을 복사합니다.

### 두 채널에 공통으로 사용하는 메시지 형식

Slack의 incoming webhook과 Teams의 Workflows 트리거 모두 단일 `text` 필드를 가진 JSON 본문을 받아들이므로, 두 채널에 같은 형식의 데이터를 보냅니다. 채널 종류에 따라 전송할 URL만 달라집니다. 실제 메시지 형식은 [전달 메시지 예시](#전달-메시지-예시)에서 확인할 수 있습니다.

## 콘솔에서 채널 설정하기

채널 변경 권한이 있는 관리자는 콘솔의 알림 채널 필드에 webhook 주소를 붙여넣고, 채널 종류를 선택한 뒤 저장합니다. 필요한 권한은 [조회와 전송 대상 변경 권한의 구분](#조회와-전송-대상-변경-권한의-구분)에서 설명합니다.

### 주소를 붙여넣는 위치

webhook 주소에는 인증 정보가 포함되어 있습니다. Slack과 Microsoft도 이 URL을 비밀로 관리하도록 안내하며, 저장 후에는 다음과 같이 처리합니다.

- **저장된 전체 주소는 다시 표시하지 않습니다.** 콘솔과 채널 조회 응답 모두에 적용됩니다.
- 채널을 조회하면 **채널 종류**, 주소의 **호스트**, **설정한 관리자**, **설정 시각**만 반환됩니다. 콘솔은 이를 다음과 같이 표시합니다.

  > Sending to `<host>`, set `<date>`.

  주소 입력란은 비워 둡니다.
- **설정한 관리자**는 호출자 정보에서 파생한 가명으로 기록합니다. 개체 ID나 사용자 계정 이름(UPN) 같은 디렉터리 식별자는 기록하지 않습니다.

구성된 전송 대상을 식별할 수 있도록 호스트만 표시합니다. 나머지 경로는 인증에 사용되므로 노출하지 않습니다.

### 조회와 전송 대상 변경 권한의 구분

알림 조회 권한과 전송 대상 변경 권한은 별개입니다. 채널의 존재 여부, 종류, 호스트를 조회할 수 있어도 전송 주소를 바꾸려면 별도의 제한된 권한이 필요합니다. 따라서 감사자에게 채널 구성을 확인할 권한만 부여하고 전송 대상 변경은 허용하지 않을 수 있습니다.

조회 권한만 있는 관리자가 새 주소를 저장하려고 하면 요청이 거부됩니다.

## 채널 설정 시 발생하는 거부

채널 저장 시에는 종류와 주소의 오류를 구분해 보고합니다.

- **`channel-kind-unsupported`**: 지원하지 않는 채널 종류입니다. 이 오류가 발생하면 이 페이지에서 설명하는 두 종류 중 하나로 변경합니다.
- **`endpoint-refused`**: 허용되지 않는 주소입니다. 배포 환경 외부에 있는 채널의 `https` 주소여야 합니다. 주소에 인증 정보가 포함되어 있으므로 오류 응답에도 입력한 주소를 반환하지 않습니다.

## 전달 메시지 예시

메시지에는 알림을 발생시킨 발견 사항이 담기며, 채널별로 내용을 덧붙이지 않습니다. 예시는 다음과 같습니다.

```
[warning] aggregate-stale
scope: organization
period: <period-start>
raised: <raised-at>
attempt: 1
```

알림에 없는 값은 `null`로 표시하지 않고 메시지에서 생략합니다. 조직 범위의 발견 사항에는 범위 키가 없으므로 `scope` 줄에 범위 종류만 표시합니다. 사유 코드가 없으면 `reason` 줄도 생략합니다.

## 채널 설정이 필요한 경우

채널을 설정하지 않아도 발견 사항은 기록되며 콘솔에서 확인할 수 있습니다. 채널 설정은 탐지 대상이나 판단 기준을 바꾸지 않습니다. 콘솔을 열지 않은 관리자에게도 알림을 전달해야 하는 경우에 채널을 구성합니다.

## 전달 동작

- 전달 시점이 되면 알림 전송을 시도합니다. 실패하면 1분부터 시작해 대기 시간을 두 배씩 늘려 재시도하며, 최초 시도를 포함해 총 다섯 번까지 시도합니다. 다섯 번째 시도도 실패하면 재시도를 중단하고 실패로 기록합니다.
- **전달에 실패한 알림도 확인 처리(acknowledge)할 수 있습니다.** 확인 처리와 전달 상태는 별도로 추적합니다. 채널 장애나 설정 오류가 있어도 관리자는 콘솔에서 확인한 알림을 닫을 수 있습니다.
- 알림 원장에는 발견 사항별 전달 시도 횟수, 최근 시도에서 사용한 채널, 확인 처리 여부를 기록합니다. 관리자는 이 기록으로 전달 완료, 대기, 실패, 확인 완료 상태를 구분할 수 있습니다.

## 배포 소유 Generic Fallback

운영자는 [배포](01-deployment_ko.md#선택적-고정-webhook-및-초기-rollup-backfill)에서
설명한 Key Vault 비밀 참조를 통해 배포 소유의 고정 대체 대상을 구성할 수 있습니다.
콘솔에서 구성한 채널이 없을 때만 사용합니다. 저장된 Slack 또는 Teams 채널은 다음
dispatcher 실행부터 즉시 우선합니다.

이 대체 대상은 전체 JSON 알림 payload를 받을 수 있는 외부 generic webhook용입니다.
채널 종류를 지정하지 않으므로 Slack 또는 Teams의 `{"text": ...}` 본문을 보내지
않습니다. Slack 또는 Teams는 콘솔 채널 설정으로 사용합니다. endpoint는 Function
시작 중에 검증하지만 네트워크 연결 가능 여부는 알림이 전달될 때에만 확인합니다.

## 확장 지점: 다른 채널 추가

현재 지원하는 채널은 Slack과 Microsoft Teams입니다. 다른 채널을 구현하려면 해당 webhook이 요구하는 본문 형식과 저장·선택에 사용할 채널 종류를 추가해야 합니다. 이는 확장 방법에 대한 설명이며, 특정 채널의 추가를 약속하는 것은 아닙니다.
