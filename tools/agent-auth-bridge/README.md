# Signing in to a governed gateway from a coding agent

This is a how-to guide, not a product component. The five coding agents evaluated
for this project each take a credential in a different way, and two of them cannot
obtain a new one once they have started.

Everything here was measured against a local stand-in for the gateway, not inferred
from documentation. Where a client's behaviour differs from what its own guidance
suggests, the measurement is what is written down.

## The problem this solves

A governed gateway identifies the person making the request, so it needs a
Microsoft Entra token for a specific audience. That is a problem for a coding agent
in two ways.

**A shared key is not an identity.** Most published guidance for pointing a coding
agent at a model endpoint uses a gateway subscription key. It works immediately,
which is why it spreads. It also authenticates the deployment rather than the
caller, so per-person entitlement, quota, and revocation all stop being
enforceable while the setup still appears correct. Nothing in this guide uses one.

**A token expires and a session does not.** Measured behaviour:

| Client | Where the credential goes | On a refusal |
| --- | --- | --- |
| Codex CLI | a command it re-runs on an interval | runs the command again |
| OpenCode | a wrapper around its own requests | acquires a new one and retries |
| Copilot CLI | an environment variable | retries with the same value |
| Claude Code | an environment variable | retries with the same value |
| VS Code BYOK | registered in the editor | not applicable (see below) |

The first two have a way to refresh a credential. They still need the correct scope
and an OAuth client that the gateway approves. The last three have no place to put a
fresh credential, so a session that outlives its token fails with an error the user
cannot act on.

## Two facts that break the common recipes

**`--resource` does not produce a usable token.** A token requested with
`--resource` carries no `scp` claim, so a gateway that validates a delegated scope
rejects it. Request a scope instead:

```
az account get-access-token --scope api://<gateway-app-id>/Gateway.Access --output json
```

**`expiresOn` is a local timestamp with no offset.** Reading it as UTC makes the
token look valid for hours after it expired, or expired before it was issued,
depending on the machine. Use `expires_on`, which is epoch seconds. The helper in
this repository prefers it and falls back only when it is absent.

**Retry on 401, not on 403.** A 401 means the credential was not accepted and a new
one may help. A 403 means this caller is not entitled to what they asked for, and
retrying turns a clear refusal into a loop. Retry once, on 401 only.

**The Azure CLI signs in as itself.** This is the one that invalidates the recipe
above whenever the gateway pins an approved client. A token minted through `az`
carries the CLI's own application id in `azp`, so a gateway that checks `azp`
refuses it however correct the audience and scope are. In this deployment the
request does not even get that far: the CLI is not preauthorized for the audience
and the sign-in fails with `AADSTS65001`. Consenting would fix the issuance and
change nothing about the refusal.

So a command-based sign-in only works where the approved client *is* whatever the
command signs in as. Otherwise the sign-in has to be performed as the approved
client, which is what `--tenant` and `--client` below do.

## Clients with their own refresh hook

### Codex CLI

Codex runs a command and re-runs it on an interval, so it refreshes without help.
In `~/.codex/config.toml`:

```toml
[model_providers.governed]
name = "Governed gateway"
base_url = "https://<gateway-host>/v1"
wire_api = "responses"

[model_providers.governed.auth]
command = "cmd"                      # Windows: the Azure CLI is a batch file
args = ["/c", "az", "account", "get-access-token",
        "--scope", "api://<gateway-app-id>/Gateway.Access",
        "--output", "json"]
refresh_interval_ms = 2700000
```

On macOS and Linux drop the `cmd /c` wrapper and call `az` directly. This recipe only works where the
approved client is the one that command signs in as, which for the Azure CLI means the deployment
approved it through `ENTRA_DEVELOPER_CLIENT_APPLICATION_ID`. The default approves none, and the
sign-in then fails as described above; use the bridge with `--tenant` and `--client` instead.

Two things to know. Codex speaks Responses and only Responses, so a
Chat-Completions-only route cannot serve it. It also requests a model list at
startup. A route that does not answer `GET /v1/models` leaves an error on every
launch even though requests succeed.

### OpenCode

A plugin wrapping `fetch` is the only injection point that can see a response
status, which is what lets it recover from a refusal. Declare the provider with a
placeholder key so nothing real is stored, and overwrite the header in the wrapper.

Reasoning models reject a maximum-token field and any temperature other than one;
strip both in the wrapper rather than in each request.

## Clients that need the bridge

`agent-auth-bridge.mjs` listens on loopback, removes whatever credential the agent
sent, attaches a current Entra token, and forwards the request unchanged. It does
not translate wire formats, rewrite bodies, choose models, or change the path. The
credential is the deliberate exception: gateway attribution names the identity in
the token that the bridge presents, whether that came from device sign-in or the
configured command.

```
node tools/agent-auth-bridge/agent-auth-bridge.mjs \
  --port 8788 \
  --upstream https://<gateway-host> \
  --scope api://<gateway-app-id>/Gateway.Access \
  --tenant <directory-id> \
  --client <approved-client-id>
```

With `--tenant` and `--client` the bridge signs in by device code as the approved
client and prints a code to enter in a browser. The refresh token stays in the
process, so one sign-in covers a session that outlives several access tokens.
Without them it falls back to running `--command` (default `az`), which is only
correct where the approved client is the one that command signs in as. See the
Azure CLI note above.

`--upstream` is an origin with no path. The client keeps the gateway's own base
URL, using `http://127.0.0.1:8788/v1` in place of `https://<gateway-host>/v1`, and the
path is forwarded exactly as sent. A path on the upstream would be prepended to a
path the client already sent, and the resulting refusal reads like a routing fault
rather than a configuration one, so it is refused at startup instead.

It binds `127.0.0.1` only, retries once on 401 with a forced refresh, streams
responses through without buffering, and never writes a credential to its log.

### Claude Code

This bridge cannot connect Claude Code to this repository's gateway by itself.
Claude Code sends Anthropic Messages, while the bridge forwards the body unchanged
and the gateway serves an OpenAI-compatible API. Use a separate local proxy that
translates Anthropic Messages into the gateway's API and holds the Entra contract.
Do not point `ANTHROPIC_BASE_URL` at this bridge unless its upstream genuinely serves
Anthropic Messages.

### Copilot CLI

```
$env:COPILOT_PROVIDER_BASE_URL = 'http://127.0.0.1:8788'
$env:COPILOT_PROVIDER_BEARER_TOKEN = 'bridge'
$env:COPILOT_PROVIDER_WIRE_API = 'completions'
```

The bearer variable outranks the key variable and is always sent as
`Authorization`, whatever the provider type. Setting both is ambiguous and the
client warns about it. Background calls for prompt refinement and session naming
also reach the provider, so they are governed too.

### VS Code

A BYOK model declaration has no field for a token audience, so the editor requests
the one it assumes. This is why published guidance reaches for a
subscription key. Pointing the provider at the bridge removes the question: the
editor sends whatever it likes and the bridge replaces it.

Add the provider through the editor's model picker. The entry it writes to
`chatLanguageModels.json` is readable and editable afterwards; only the credential
stays in the operating system secret store, referenced by a placeholder:

```json
{
  "name": "AI Gateway",
  "vendor": "customendpoint",
  "apiKey": "${input:chat.lm.secret.<generated>}",
  "apiType": "responses",
  "models": [
    {
      "id": "coding-primary",
      "name": "AI Gateway (coding-primary)",
      "url": "http://127.0.0.1:8788/v1",
      "toolCalling": true,
      "vision": true,
      "maxInputTokens": 128000,
      "maxOutputTokens": 16000
    }
  ]
}
```

The URL is per model, not per provider. The `id` is sent as the model name, so
leaving it empty produces a request the gateway cannot route. The picker accepts
an empty value without complaint, and the failure appears later as a refusal.

A new provider is picked up after the window is reloaded.

## What is verified

`tests/contract/agent-auth-bridge.test.mjs` pins the behaviour this guide depends
on: a request with no credential arrives authenticated, a placeholder is removed
rather than forwarded, a refusal the agent could not act on is recovered, the
request path, body, model, and tools survive credential replacement, a streamed answer is piped, a
sign-in failure reaches the caller with nothing sent upstream, and nothing the
bridge reports carries a credential.

`tests/mock/gateway-mock.mjs` reproduces the refusal shapes of the deployed gateway
so a client can be exercised without spending a request against it.
