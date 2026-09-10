# Connecting A Coding Agent

You have been given a gateway URL and told to point your coding agent at it. This guide covers exactly that: how to hold the connection contract this gateway publishes, and what its responses mean once you do.

It does not cover deploying the gateway (see [Deploying The Gateway](01-deployment.md)) or what a specific caller is entitled to reach (see the policy checks in [Operating And Removing An Evaluation Environment](03-operations.md)). Once you can talk to the gateway at all, that second document explains why a particular request was allowed, narrowed, or refused.

## The Contract This Gateway Owns

This is the whole of what the gateway promises, and the whole of what you need to hold to connect anything to it:

- an OpenAI-compatible API family, served at a `/v1` base URL;
- callers authenticate with a Microsoft Entra access token for a specific tenant, audience, and delegated scope (`Gateway.Access`);
- a delegated sign-in uses a public client that the deployment has approved; its client ID is onboarding information, not discovery metadata;
- a token has to be acquired and renewed; nothing about the gateway keeps a session alive for you;
- `401`, `403`, and `429` mean different things and require different retry behavior;
- the exact tenant, audience, and scope values for *this* deployment are discoverable from the gateway itself with no credential.

Anything that can hold this contract can connect. The rest of this guide describes how, not what to install.

The `/v1` name is the OpenAI-compatible data-plane contract. It is unrelated to the APIM Basic v2 service tier. The upstream routes implemented by this gateway define these operations under `/openai/v1` and do not define `/openai/v2` variants.

The infrastructure constructs the backend from the configured Foundry account's OpenAI v1 endpoint. Validate successful managed-identity calls through APIM for every advertised operation as a deployment acceptance criterion.

## Discover The Contract From The Gateway Itself

Start by asking the gateway nothing more than the URL you were given. All three requests below need no credential.

**An unauthenticated or malformed request.** Call any operation with no `Authorization` header, or with a bearer value that is not a real token. Both answer identically:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://<gateway-host>/.well-known/oauth-protected-resource/v1"

{"error":{"code":"invalid_token", ...}}
```

**Follow that link.** The metadata document it points to answers `200`, still with no credential:

```json
{
  "resource": "https://<gateway-host>/v1",
  "authorization_servers": ["https://login.microsoftonline.com/<tenant-id>/v2.0"],
  "scopes_supported": ["<audience>/Gateway.Access"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Azure AI Governance Gateway"
}
```

It carries no client ID and no secret. `resource` is exactly the `/v1` base URL you already have. `authorization_servers` names the tenant to sign in against. `scopes_supported` names the exact, audience-qualified scope to request: `<audience>/Gateway.Access`, not the bare scope name. The response also carries `Cache-Control: max-age=3600`, so a client can cache it for an hour rather than fetching it on every start.

The metadata lets a client discover the resource contract from one refusal instead of copying tenant and audience values from a table. It does not enroll an OAuth client or disclose which clients the deployment approves. Obtain an approved client ID from the gateway administrator, or use the approved client your administrator names, then request the discovered scope through that client.

**A route this gateway does not serve.** Call a path or method combination it does not implement, and you get:

```
HTTP/1.1 404 Not Found
{"error":{"code":"route_not_supported", ...}}
```

The response never lists what routes *do* exist. Use the metadata document and this guide, not enumeration, to find out what to call.

## What A Request Comes Back As

Once you present a token, the gateway resolves this caller's governance and responds in one of the following ways. Verify the exact status, headers, and backend compatibility in the target deployment before relying on them operationally.

| Response | What it means |
| --- | --- |
| `200`, `x-policy-resolution: resolved` | Served. `x-requested-model` and `x-effective-model` are both present and may differ. An administrator can configure a downgrade to a substitute model. Usage counts are in the response body. |
| `403`, code `caller_not_entitled`, `x-policy-resolution: refused` | Authenticated, but not on any roster this gateway trusts for this route. The body names no team and no model. The governance structure is not the caller's to read. |
| `403`, code `model_not_allowed`, body lists `allowed_models` | Authenticated and entitled to something, just not the requested model. **`x-policy-resolution` is absent on this refusal.** Do not use it to distinguish this case from any other. |
| `403`, code `token_quota_exceeded`, header `Retry-After: <seconds>` | The applicable period quota is exhausted. Refreshing the token cannot change it, and retrying before the stated reset interval cannot succeed. |
| `429`, code `rate_limit_exceeded`, header `Retry-After: <seconds>` | Going too fast. Honour the deployed response header rather than guessing a backoff. |
| `404`, code `route_not_supported` | The path/method combination is not one this gateway serves. |

**A request admitted to the backend can still spend allowance when the backend rejects it.** APIM applies request limits before backend dispatch, so a request that passes gateway validation can be counted even if the provider later returns `400`. Confirm this behavior in the target deployment, and do not retry a persistent `400` in a tight loop.

### What Each Status Means For A Client

Use the status code to decide whether to retry:

- **`401`**: the credential is missing, malformed, or expired. Acquiring a fresh token may fix it. Retry once, with a new token, and no more.
- **`403`**: the caller is authenticated, but policy refuses the request or a period quota is exhausted. A fresh token cannot fix either case. Do not retry an entitlement refusal. For `token_quota_exceeded`, wait at least the `Retry-After` interval or ask an administrator to change the quota.
- **`429`**: you are going too fast. Slow down and retry after the interval the `Retry-After` header gives you.

## Keeping A Token Alive

Tokens live on the order of an hour. Whatever holds the credential has to be able to renew it before then, and that requirement is different for every path below: an agent whose credential is fixed for the life of its process cannot renew anything and needs something else to do it.

**The specific mistake to avoid:** requesting offline access and then discarding the refresh token you were issued. It looks correct: the first hour of a session works fine, and then the token expires mid-task and a long-running session turns into an unexpected sign-in prompt in the middle of somebody's work. If you request offline access, keep what it gives you and use it.

## Two Ways To Hold This Contract, Neither Required

Anything that can present a valid Entra token for the right tenant, audience, and scope, and renew it before it expires, can connect. In practice that happens one of two ways.

### A Local Proxy

A process on your own machine can hold and renew the Entra credential, translate the agent's wire format, or do both. A translating proxy can support an agent this gateway has not tested, provided it sends an OpenAI-compatible request to the gateway and preserves the authentication contract.

**This is not required.** If your agent can hold the contract on its own (see below), you do not need one.

OpenCodex is one example of a proxy that can sit in front of an agent this way. It is an [independently maintained MIT project](https://github.com/lidge-jun/opencodex), not a dependency or component of this gateway. Review its [documentation](https://opencodex.me/) and security boundary before installing it.

This repository ships a credential-refresh bridge for clients that need one: see [`tools/agent-auth-bridge/README.md`](../tools/agent-auth-bridge/README.md). It forwards requests unchanged and does not translate wire formats, rewrite bodies, or choose models. Use a separate protocol-translating proxy when the client speaks a different protocol. Neither component's behavior is warranted by the gateway.

#### OpenCodex With The Credential Bridge

This optional arrangement keeps the responsibilities separate:

```text
Codex or Claude Code
        -> OpenCodex :10100       protocol and model selection
        -> agent-auth-bridge      Entra acquisition and refresh
        -> APIM /v1               entitlement, limits, and telemetry
        -> Microsoft Foundry
```

Select an OpenCodex version through your organization's dependency review and
release process. Configure an approved package registry explicitly, require
integrity that satisfies your registry and package-manager policy, and reject
missing or mismatched integrity. Follow the upstream installation instructions,
then start the repository bridge:

```powershell
node tools/agent-auth-bridge/agent-auth-bridge.mjs `
  --port 8788 `
  --upstream https://<gateway-host> `
  --scope <audience>/Gateway.Access `
  --tenant <tenant-id> `
  --client <approved-client-id>
```

Merge the following named fields into `~/.opencodex/config.json`; do not replace unrelated providers or client settings in an existing file. Replace `<gateway-model-alias>` with the logical `modelKey` published by the gateway administrator. The `apiKey` value is a non-secret placeholder required by the local proxy; the bridge removes it and presents the Entra token instead.

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

Validate and start it:

```powershell
ocx config validate "$HOME/.opencodex/config.json" --json
ocx start --port 10100
```

With native client integration disabled in this minimal configuration, point the client at `http://127.0.0.1:10100/v1` yourself. Select `governed-gateway/<gateway-model-alias>` for a Responses client. A Claude Code connection sends Anthropic Messages to `http://127.0.0.1:10100`; its incoming model ID must match a `claudeCode.modelMap` entry. OpenCodex translates that request, while the repository bridge still owns Entra sign-in and credential replacement.

Stop OpenCodex to roll back this local layer:

```powershell
ocx stop
```

Do not enable OpenCodex `retryOn429` for this gateway unless the administrator has approved the additional counted requests. The example configuration leaves it absent, so the gateway's `429` and `Retry-After` reach the client without an implicit same-target retry.

### A Direct Connection

Where an agent's own protocol and authentication can already hold the contract, point it straight at the gateway with no intermediary. The table summarizes client contract considerations that must be validated for the selected version:

| Client | Contract consideration | Needs a local proxy? |
| --- | --- | --- |
| Codex CLI | Runs a token-acquisition command on an interval, so it renews unaided. Whatever that command signs in as must be a client the deployment approves. | No |
| OpenCode | Acquires and renews its own token inside its plugin; the one client with a strong application identity of its own. | No |
| GitHub Copilot CLI | Takes a bearer token from an environment variable that is fixed for the life of the process. | Yes |
| VS Code with a custom model endpoint | Cannot request a token for this gateway's audience at all. | Yes |
| Claude Code | Speaks Anthropic Messages. The shipped credential bridge does not translate it; the optional OpenCodex path above translated one measured Messages request into Responses. | Yes (protocol translation) |

These considerations are not a promise about every client, version, or deployed gateway. Validate the selected version in the target deployment and through your release process. A client not on this list may hold the contract unaided or may not. Apply the same test: can it acquire a token for this audience and scope, renew it before expiry, and complete an approved request through the deployed gateway?

Two deployment facts decide whether an unaided path works at all. First, a delegated token is accepted only from a public client the deployment approves, so a command-based sign-in such as the Azure CLI is refused unless the operator approved that client through `ENTRA_DEVELOPER_CLIENT_APPLICATION_ID`; the default approves none, and the refusal looks like a sign-in or authorization failure rather than a configuration one. Second, this gateway serves only `/v1/responses` and `/v1/chat/completions`, so a client that lists models when it starts gets `404 route_not_supported` from `/v1/models` even though its actual requests succeed.

## Two Facts Worth Knowing Before You Choose

**Only traffic that reaches this gateway is governed by it.** If your agent, or anything it talks to, can reach the underlying model directly, that traffic bypasses every policy this gateway applies: entitlement, rate limits, budgets, all of it. A proxy or a direct connection is only "governed" if it is the only path your agent's requests take.

**A proxy authenticates as whatever identity it was configured with, not as you.** Whatever appears in this gateway's logs and governance for a request routed through a proxy is the credential the proxy holds (a service principal, a shared sign-in, an application identity), not a record of the person who typed the prompt. Choose and configure that credential deliberately if per-person attribution matters to you.

## What This Guide Will Never Ask You To Do

- Paste a provider API key into an agent's configuration. This gateway authenticates callers with Entra tokens; a shared key authenticates a deployment, not a person, and defeats per-caller governance entirely.
- Persist a token to disk in a way that outlives the session that acquired it.
- Scrape a CLI's own credential cache. Acquire a token through a documented flow for the audience and scope this gateway names, not by reading another tool's stored state.
- Trust an unregistered client ID. Sign in as an application this gateway's tenant recognises for the flow you are using.

## Validate The Connection

1. Repeat the discovery request with no credential and confirm you get the `401` and the metadata document described above. This confirms you have the right host before you spend a sign-in on it.
2. Acquire a token for the tenant, audience, and scope the metadata document names, and make one real request. Expect `200` with `x-policy-resolution: resolved`. A `403` here is not a connection problem. See the policy checks in [Operating And Removing An Evaluation Environment](03-operations.md) for what determines whether a specific caller is entitled to a specific model.
3. If you are using a local proxy, confirm the request your agent sends carries the proxy's token, not a provider key or a stale cached one, before you trust the result of step 2.

## Rolling Back

There is no server-side state to undo on the gateway side of a client connection. Rolling back means undoing what you changed on your own machine: point your agent's configured base URL back at whatever it used before, or stop the local proxy. If a proxy registered its own Entra application for this purpose, removing that registration is a separate, reversible action on your own tenant and does not affect the gateway.
