> 한국어: [README_ko.md](README_ko.md)

# LLM Governance Gateway for Coding Agents on Azure

An Azure reference implementation for governing the LLM backends used by coding agents. It places Azure API Management between coding tools and Microsoft Foundry models, uses Microsoft Entra ID for caller identity, and provides one place to control model access and token consumption.

## Why teams need this

Competitive open-weight models have expanded the model choices available on Azure. Coding agents are also increasing the number, size, and duration of LLM requests. A development organization may now run several agents across multiple models while each tool holds its own endpoint and authentication configuration.

That growth creates an operating problem. Teams need to know who used which model, how many tokens each team consumed, whether the request followed an approved route, and what should happen when a limit is reached. When access is configured separately in each tool and provider, there is no common policy or usage view across them.

This gateway makes that traffic explicit. APIM authenticates the caller, resolves the models and limits that apply, forwards the request with managed identity, and emits body-free usage evidence. The administration console manages the policy and shows the result.

Token economics in this project means measuring and controlling token consumption by caller, team, application, and model. Provider billing remains the source of truth for monetary cost.

## Who it is for

This project is intended for teams that operate LLM backends for software development and coding agents:

- developer platform and Developer Experience teams;
- AI platform teams managing Foundry model deployments;
- coding-agent operations teams responsible for access, quotas, and usage; and
- security or cloud platform teams replacing distributed provider credentials with an Entra-authenticated route.

## What it governs

- Caller identity through Microsoft Entra ID.
- Model access for organizations, teams, individual subjects, and applications.
- Request rate, token rate, period quota, and token budget.
- Optional fallback to an approved model when a configured threshold is reached.
- Pseudonymous usage, policy outcomes, and configuration revisions without retaining prompt or completion text by default.

## Architecture

```text
coding agent or compatible client
	|
	| Microsoft Entra access token
	v
Azure API Management /v1
	|
	| managed identity
	v
Microsoft Foundry account /openai/v1
	|
	v
model deployment
```

The APIM route is the governed data plane. Traffic sent directly to a Foundry account or project endpoint bypasses this gateway and is outside its usage and policy results.

## Why the endpoint is `/v1`

`/v1` identifies the OpenAI-compatible data-plane contract used by the coding agent. It is not the version of this repository and is unrelated to the APIM Basic v2 service tier.

The gateway accepts `/v1/responses` and `/v1/chat/completions`, then calls the Microsoft Foundry account endpoint at `/openai/v1`. The [Foundry Models v1 API](https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle) works with OpenAI clients and removes the previous need to change dated `api-version` parameters. Responses is available for supported Foundry models, while Chat Completions applies to models that implement that wire contract.

The current upstream routes implemented by this gateway define these operations under `/openai/v1`; they do not define `/openai/v2` variants. A future `/v2` route would require a published upstream contract plus separate schemas, policies, compatibility tests, and migration guidance.

## Start an evaluation

Use an existing Foundry deployment and create a new APIM instance when your organization already has a model it can test. This is the shortest path that exercises the governed data plane. If no suitable Foundry deployment exists, use the create-everything mode in an isolated resource group.

Control-plane-only mode evaluates the console and policy model but does not prove inference governance.

Start with the [PoC Quickstart](docs/00-quickstart.md). It covers installation, deployment preview, minimal governance, one allowed request, one denied model, console verification, and removal. Use the [detailed deployment guide](docs/01-deployment.md) for every mode and troubleshooting path.

Use the [coding-agent connection guide](docs/04-connection.md) after the gateway works with a raw request. It covers direct connections, the repository authentication bridge, and an optional OpenCodex protocol-translation path.

## Prerequisites at a glance

For the recommended evaluation path, install Node.js 24 or later, PowerShell 7, Azure CLI, and Azure Developer CLI. Docker is optional for the fast local test and required for the persistence integration test. You also need an Azure subscription, permission to create resources and role assignments, and permission to create Microsoft Entra applications and service principals.

Bring either an existing Microsoft Foundry account/project and model deployment, or choose the isolated create-everything mode. The deployment uses the Foundry **account** OpenAI-compatible endpoint for inference; the project is recorded as deployment context and is not used as the APIM backend URL.

Before installing dependencies, explicitly configure a package registry approved by your organization. Package integrity must satisfy your registry and package-manager policy; missing or mismatched integrity is rejected. Your organization owns registry governance, license review, SBOM, signing, and release approval.

## Cost and security considerations

This repository is a proof of concept, not a fixed-price service. Expect separate charges for the Basic v2 API Management instance, Microsoft Foundry model usage, Flex Consumption execution, serverless Cosmos DB storage, Storage and Key Vault, private endpoints, and Log Analytics ingestion. The exact amount depends on region, model, capacity, traffic, retention, and whether you deploy one or two model accounts. Token counts and quotas help control consumption; provider billing remains the source of truth. Use the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/) and remove evaluation resources when finished.

The default topology exposes the APIM data plane publicly and requires Microsoft Entra authentication. Durable governance storage and the principal-key store are private-networked, and created model/data resources disable local key authentication where the template supports it. Direct access to the Foundry account is a separate path and bypasses gateway policy and telemetry, so remove direct inference roles from governed callers when bypass must be prevented. Webhook URLs are credentials; configure them only through the console and keep a separate secure copy.

## PoC boundaries

The repository demonstrates the governed request path and administration workflow. Before production adoption, each organization must choose its own controls for the following areas.

| Area | Included here | Production decision |
|---|---|---|
| Audit | Configuration revisions and operational events | Evidence retention, tamper resistance, access review, and compliance controls |
| Cost | Token counts, quotas, budgets, and fallback | Invoice reconciliation, chargeback, and financial reporting |
| Reliability | A single-region evaluation topology | Capacity planning, load testing, SLOs, HA, and disaster recovery |
| Network | Public Basic v2 APIM ingress protected by Entra authentication | Private ingress, private Foundry connectivity, DNS, and removal of direct model access |
| Client compatibility | Responses, Chat Completions, and tested bridge/proxy contracts | Supported client versions, release testing, and adapter ownership |

Budgets are best effort because requests already in progress may complete after a cap is reached. Access withdrawal takes effect when an issued token expires or refreshes. These behaviors are measured PoC boundaries, not billing or immediate-revocation guarantees.

## Customize the evaluation

Use `azd env set` for deployment settings and the administration console for models, teams, limits, budgets, fallback, and notifications. Keep the logical model alias sent by clients separate from the provider deployment name configured in Microsoft Foundry. Refresh the model catalogue before its 30-day validity window expires.

Changing policy-combination semantics is a code-level customization, not a console setting. The deployment guide identifies the authorization evaluator, effective-policy composer, fallback compiler, versioned contract, and APIM policy that must change together; update their tests and policy version as one change.

## First troubleshooting checks

- `200` from `/api/healthz` confirms the control-plane host is reachable; it does not prove inference is ready.
- `503 governance_unavailable` before the first publication means no complete active governance revision or provider mapping is available.
- `403 model_not_allowed` means authentication succeeded and policy refused the requested model; do not retry it.
- A body-free `403` on administration routes points to App Service authentication settings, not governance content.
- Requests sent directly to Microsoft Foundry will not appear in gateway usage or policy results.

## Evaluation success criteria

- [ ] An allowed request returns `200` through the APIM `/v1` endpoint.
- [ ] A denied model returns `403` without reaching the model backend.
- [ ] The console shows the active configuration and caller-specific model access.
- [ ] Usage reports tokens without prompt or completion bodies.
- [ ] A governance change produces a new visible revision.

## Validation status

The detailed [fresh end-to-end validation record](docs/01-deployment.md#fresh-end-to-end-validation-record) reports the verified models, request outcomes, usage accounting, cleanup boundary, and untested limits. It is one validation run, not production certification or a guarantee for another tenant.

## Documentation

| Guide | Use It For |
|---|---|
| [PoC Quickstart](docs/00-quickstart.md) | Clean clone, recommended deployment, minimal governance, first requests, and removal. |
| [Deployment Reference](docs/01-deployment.md) | All deployment modes, permissions, recovery, verification, and troubleshooting. |
| [Administration Console](docs/02-administration.md) | Reading and changing models, access, budgets, usage, notifications, and revisions. |
| [Operations Runbook](docs/03-operations.md) | Evaluation operation, policy checks, cleanup ownership, and approval boundaries. |
| [Coding-Agent Connection](docs/04-connection.md) | Direct connections, the authentication bridge, and optional local proxy patterns. |
| [Chat Notifications](docs/05-notifications.md) | Optional Slack and Microsoft Teams delivery. |

## Contributing and security

Read the [contribution guide](CONTRIBUTING.md) for focused pull requests, local validation, and sanitized reproduction details. Read the [security policy](SECURITY.md) before reporting a vulnerability.

## License

[MIT](LICENSE).

Dependencies retain their own licenses. See [third-party notice handling](NOTICE) before redistributing application artifacts. Preserve the console's generated `vendor/THIRD-PARTY-NOTICES.txt` alongside its authentication bundle and the upstream license files in Function dependencies.
