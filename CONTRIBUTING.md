> Korean: [CONTRIBUTING_ko.md](CONTRIBUTING_ko.md)

# Contributing

Thanks for helping improve this proof of concept. Keep pull requests focused and explain the user-visible behavior, security impact, and recovery implications.

## Before pushing or opening a pull request

- Run `npm ci` to restore locked dependencies.
- For the public local gate, run `pwsh -NoProfile -File tests/Test-Local.ps1 -PublicOnly -IncludeExternalOpenApiLint`. Docker is needed only for the documented persistence integration. The OpenAPI lint resolves its pinned CLI offline and never reaches a registry during the gate, so fetch it once beforehand from a registry your organization approves with `npx --yes --registry (npm config get registry).Trim() @redocly/cli@2.39.0 --version`.
- The supply-chain scripts take their inputs explicitly: `npm run supply-chain:check -- --output-dir <directory outside the published inventory> --generated-at <iso-8601-timestamp>` and `npm run supply-chain:validate -- --evidence <file> --sbom <file>`. Both fail without those arguments by design; configure the registry and integrity policy from `tools/supply-chain/registry-policy.template.json` first.
- Include a concise validation or reproduction recipe and sanitized, minimal fixtures where tests need data.
- Do not include corporate registry identities, tenant or subscription identifiers, internal test reports, credentials, or other private material.

Run validation locally before pushing. This repository does not configure GitHub Actions. The public local gate runs the unit tests, public contracts, UI build, and snapshot checks. These checks do not deploy Azure resources or prove end-to-end behavior in a customer environment. See the [quickstart](docs/00-quickstart.md) and [deployment guide](docs/01-deployment.md) for prerequisites. The supported evaluation scope is a new APIM service, optionally reusing an existing Foundry deployment. Preserve existing recovery behavior.

## Pull requests

Describe limitations and PoC-only behavior. Keep tests offline, and clearly label documented commands that change Azure resources and require operator approval. Keep numbered public guides limited to `docs/00` through `docs/05`.

## Security reports

Never put secrets, credentials, or exploit details in a public issue. If GitHub private vulnerability reporting is enabled for this repository, use that feature. If it is unavailable, do not assume a working private channel: use the maintainer profile to request private contact instructions, without including sensitive details in the request.
