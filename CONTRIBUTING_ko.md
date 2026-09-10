> English: [CONTRIBUTING.md](CONTRIBUTING.md)

# 기여 안내

이 개념 증명(PoC) 프로젝트에 기여해 주셔서 감사합니다. Pull request를 작성할 때는 변경 범위를 좁게 유지하고, 사용자에게 보이는 동작과 보안 및 복구에 미치는 영향을 설명합니다.

## Push 또는 pull request 전에

- `npm ci`로 잠금 파일에 지정된 버전의 의존성을 복원합니다.
- 공개용 로컬 검증에는 `pwsh -NoProfile -File tests/Test-Local.ps1 -PublicOnly -IncludeExternalOpenApiLint`를 사용합니다. Docker는 문서에 안내된 영속성 통합 테스트에만 필요합니다. OpenAPI lint는 지정된 버전의 CLI를 오프라인으로 확인하며 검사 중에는 레지스트리에 접근하지 않으므로, 조직이 승인한 레지스트리에서 `npx --yes --registry (npm config get registry).Trim() @redocly/cli@2.39.0 --version`으로 미리 한 번 내려받습니다.
- 공급망 스크립트는 입력을 명시적으로 받습니다. `npm run supply-chain:check -- --output-dir <공개 목록에 포함되지 않는 디렉터리> --generated-at <ISO 8601 시각>`과 `npm run supply-chain:validate -- --evidence <파일> --sbom <파일>` 형식으로 실행합니다. 두 명령 모두 이러한 인수 없이는 의도적으로 실패하므로, 먼저 `tools/supply-chain/registry-policy.template.json`에서 레지스트리와 무결성 정책을 설정합니다.
- 간결한 검증 또는 재현 절차를 포함합니다. 테스트 데이터가 필요하면 민감 정보를 제거한 최소한의 테스트 데이터를 제공합니다.
- 회사 레지스트리 인증 정보, 테넌트·구독 식별자, 내부 테스트 보고서, 자격 증명 등 비공개 자료는 포함하지 않습니다.

Push 전에 로컬에서 검증합니다. 이 저장소에는 GitHub Actions가 구성되어 있지 않습니다. 공개용 로컬 검증은 단위 테스트, 공개 인터페이스 규약 검사, UI 빌드, 스냅샷 검사를 실행합니다. 이 검사는 Azure 리소스를 배포하거나 고객 환경의 종단 간 동작을 입증하지 않습니다. 사전 요구 사항은 [빠른 시작](docs/00-quickstart_ko.md)과 [배포 안내](docs/01-deployment_ko.md)에 정리되어 있습니다. 지원되는 평가 범위는 새 APIM 서비스이며, 기존 Foundry 배포를 선택적으로 재사용할 수 있습니다. 변경 시에는 기존 복구 동작을 보존합니다.

## Pull request

제한 사항과 PoC 전용 동작을 설명합니다. 테스트는 오프라인에서 실행할 수 있도록 유지합니다. 문서의 명령 중 Azure 리소스를 변경하고 운영자 승인이 필요한 명령은 명확하게 표시합니다. 번호가 붙은 공개 안내서는 `docs/00`부터 `docs/05`까지만 유지합니다.

## 보안 보고

공개 이슈에 비밀 정보, 자격 증명 또는 취약점 악용에 관한 세부 정보를 올리지 않습니다. 이 저장소에서 GitHub의 비공개 취약점 보고 기능을 사용할 수 있다면 해당 기능을 이용합니다. 사용할 수 없다면 관리자의 프로필을 통해 비공개 연락 방법을 문의합니다. 비공개 연락 경로가 확인되기 전까지는 세부 정보를 보내지 않으며, 문의할 때에도 민감한 정보는 포함하지 않습니다.
