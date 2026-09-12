# Using The Administration Console

The console is where an administrator sees what the gateway is doing and changes what it allows. This guide walks through it in the order a first-time administrator needs, and says what each screen is claiming so you can tell a real answer from an absent one.

Two facts apply throughout the console.

**Ordinary changes always take two steps: save a draft, then explicitly approve and publish.** The default `Governance.Administer` role can approve its own saved draft, or another administrator can approve it. No extra setting or Entra role grant is needed for self-approval. Saving never publishes ordinary budget, model, access, or fallback edits, even for an owner. Only an explicit `initialOnly` bootstrap import retains one-step approval and publication. The new revision governs requests only after every publication target confirms it. If publication stops partway through, callers keep getting the previous active revision.

**A screen that cannot answer refuses instead of showing nothing.** An empty table and a store that has never been written are different facts, and the console does not render them alike. When you see a refusal with a reason code, that is the product declining to present an answer it does not have.

Screenshots on this page show the current local deterministic UI with synthetic fixtures, not an Azure deployment result. Demo personas, DEV selectors, and sample metrics are local-only examples; a deployed console shows the identity you signed in with.

## Getting In

The console URL is the `ADMIN_INTERFACE_ENDPOINT` output of the deployment. Sign in with the Microsoft Entra account that holds the administration role assigned during deployment. See [Deploying The Gateway](01-deployment.md) for how that role is assigned and changed.

What you can do is decided by the role your account holds, not by the screen. A screen you may read but not change shows a **Read-only** marker on each section you cannot act on, rather than offering a control that would be refused after you click it.

## Overview

![The overview screen](images/console-overview.png)

The posture row is the fastest read of whether the deployment is working: which configuration is serving, whether usage aggregation is complete, whether reconciliation is current, and whether message bodies are being retained. Body retention is `Disabled` by default and should stay that way unless you decided otherwise.

Under it, each figure carries how it was obtained. `Reported` and `Fresh` mean the number came from the gateway's own usage rollup and the window it covers has closed.

**`Unknown` is an answer, not a gap.** Where the deployed usage path does not collect median latency or error rate, those values read `Not collected`. The local fixture values in these screenshots are not Azure measurements. A figure the product cannot measure is labelled rather than filled with a plausible number.

## Publishing

![The publishing screen](images/console-lifecycle.png)

This screen is the one to open when you are not sure whether a change reached callers. The banner names the revision that is serving right now. Below it, every revision shows the lifecycle actor codes recorded for authoring, approval, and publication, plus the publication targets that confirmed. Bootstrap authoring alone uses its bootstrap code; every later deployed administrative write uses a stable, versioned pseudonymous actor code derived with the deployment's key from the authenticated administrator's validated tenant and object identifiers. The code distinguishes administrators while the active key version is retained, but does not store those identifiers, names, emails, claims, or credentials. A write whose administrator identity cannot be established is refused with `caller_not_identifiable` before it is persisted or published.

A revision that shows fewer confirmed targets than it has is mid-publish, and the previous revision is still what callers get.

Saving returns HTTP `201` with `outcome: proposed`, `state: draft`, and the revision ID, without publication target writes. On the Publishing screen, the author or another write-capable administrator explicitly chooses **Approve and publish**. A single administrator can complete both steps. Self-approval records the same truthful actor code for author and approver and the existing `self-approval-granted` reason; a different administrator's approval keeps their distinct actor code. Previous histories are not rewritten.

To approve or retry, the console sends an approval-only request, `{ "resume": true, "revisionId": "revision-0002" }`. It identifies an already stored proposal and contains no configuration or mutation fields. The service loads and publishes the immutable stored proposal, so a reviewer cannot substitute content and the recorded author remains the author of what is published.

A target failure changes the lifecycle to `failed`; fix its cause and retry the stored proposal, which retries only the unfinished targets. To change a draft, its author must withdraw it and submit a new proposal. A draft author can abandon their own unapproved proposal with `POST /v1/admin/governance/publish` and `{ "command": "withdraw", "revisionId": "revision-0002" }`. This records a terminal withdrawal without publishing content; readers and other administrators cannot withdraw it.

Recovery abandonment remains **owner-only**, separate from administrator self-approval. The console exposes `{ "command": "abandon", "revisionId": "revision-0002" }` only for an eligible untouched draft, approval, or failed proposal authored by `bootstrap-import` or the legacy shared `governance-administrator`. It requires publish permission and the focused `abandon-legacy-configuration` capability held only by `Governance.Own`; ordinary administrators cannot use it to discard another author's proposal. Publishing proposals are refused, and verified targets or publication activity also prevent abandonment. Verified targets report `proposal-abandonment-verified-targets`. Repair and retry instead. A legacy revision with no stored proposal refuses content replacement: with verified targets it reports `legacy-recovery-required`, and with none it reports `legacy-recovery-abandon-required` until an authorized owner abandons it and creates a fresh proposal.

### Preview A Saved Draft

The deployed administration API requests `SecurityGroup` token claims for the caller's own memberships. This does not grant Microsoft Graph directory-reading permission. Groups assigned only to the gateway would be missing from an administration API `ApplicationGroup` claim, so that narrower claim is not used for this preview. Sign in again after upgrading the identity configuration. An absent group claim, including token group overage, reports `caller-policy-evidence-unavailable`; it is never treated as an empty group list. See [installation troubleshooting](01-deployment.md#impact-preview-reports-missing-caller-evidence).

For a draft with stored content, choose **Preview impact** on the Publishing screen. Select the API family to compare the active policy with the saved proposal. The comparison includes allowed models, provider deployment mappings, request and token limits, budget thresholds, and fallback paths or rejection reasons. It uses the same policy resolver for both sides at one evaluation time.

The supported target is **the current authenticated caller only**, including the application identity in that caller's validated request. The preview does not impersonate a different coding client, select arbitrary users, or substitute an administrator's membership for another caller. In local mode it explicitly identifies deterministic persona evidence; that is not proof of deployed authorization. If the current caller's identity or membership cannot be established, the comparison reports unavailable rather than inventing a policy.

In a deployment, this identity comes from the **control-plane token**, not an inference token. Entra token subjects can differ between resource audiences, and the administration client can differ from the coding client. The preview preserves the validated token subject, application, and delegated/application flow; it does not replace the subject with an object ID. A stored membership record for an inference subject may therefore not match. The `inference-token-identity-not-established` limitation means subject- and application-scoped results are not evidence of the coding client's gateway policy; a refusal here does not establish that client's access.

The request reads the immutable stored proposal, not edited policy content supplied by the browser. Previewing does not save, approve, publish, consume tokens, or change active policy. A changed active set or draft revision during comparison makes the result stale; refresh and compare again. Continue through the existing distinct approval and verified publication process when ready.

This is a static policy comparison, not a measurement of live budget counters or a prediction that the next request will succeed. An unchanged result applies only to this caller and API family, not every caller. Review the reported refusal or unavailable reasons on each side, and use the separately described [local evaluation scenarios](03-operations.md#repeatable-local-evaluation) for repeatable reference checks.

## Budgets

![The budgets screen](images/console-budgets.png)

A budget is authored here and applies from the moment it is published. The screen separates what was configured from what is enforced, because they are not the same question.

Budgets are best effort. A cap can be passed before enforcement catches up, and the screen reports how far. If you need a hard guarantee that no request exceeds a number, this product does not provide one; see the limitations in [Deploying The Gateway](01-deployment.md#operating-limitations).

Budgets do not merge into a single number, and every applicable counter can stop a request. Publication and enforcement preserve the authored budget identity, version, scope, model, period, action, threshold, and accounting basis. Unsupported or ambiguous combinations are rejected before publication rather than silently sharing a counter. The policy checks in [Operating And Removing An Evaluation Environment](03-operations.md) describe the combination rules.

### Understanding observed consumption

Consumption is an aggregate of usage records, not a readback of the live APIM counter. Inspect the requested aggregation interval, the latest complete observed window, and the covered and missing windows alongside the total. A gap can make measured consumption lower than actual consumption. For an incomplete observation, remaining tokens stay unavailable (`null`), not an estimated allowance; missing observations and budgets without a token quota are reported as unmeasured.

The requested budget version identifies the configuration used to select the observation and calculate its quota. It does not prove which policy version governed every recorded request. The current rollup contract does not collect policy-version or APIM-counter identity evidence, so these remain **not collected**. The console does not infer those values from the current configuration or backfill old records when a version changes.

Changing a budget version can change APIM counter identity without erasing usage history. Do not compare a fresh counter with the aggregate as if they were the same measurement, or interpret either as Azure Billing cost. Refresh after publication and review the observation interval and completeness before interpreting the new budget's remaining allowance.

### Budget actions

Budgets use tokens, not currency. The accounting basis is `apim-estimated-total-tokens`; Azure Billing remains the source for monetary cost. Budget actions and model fallback are separate settings.

| Action | Behavior | Threshold settings |
|---|---|---|
| `HARD_BLOCK` | Blocks when the configured token quota is exhausted. There is no grace allowance. | Optional `warnAtBasisPoints` for an earlier warning, from 1 to 9,999. |
| `SOFT_WARNING` | Warns near the configured limit and blocks at the limit plus the grace allowance. It is not warning-only, unlimited use. | Required `graceBasisPoints`, from 1 to 10,000. |
| `THROTTLE` | Applies a request-rate tier at each configured usage threshold. It does not create a hard token quota of its own; other applicable quotas can still block. Requests above the rate receive `429`. | Increasing `atBasisPoints` thresholds, from 1 to 20,000, each with a supported `tierCode`. |

Thresholds use basis points: 100 means 1%, 500 means 5%, and 10,000 means 100%. For a 1,000,000-token budget, `HARD_BLOCK` caps at 1,000,000 tokens. `SOFT_WARNING` with `graceBasisPoints: 500` warns near 1,000,000 and caps at 1,050,000 tokens. APIM warning thresholds use whole percentages, so the warning point may differ from the authored threshold. Both caps remain best effort.

The current deployment supports `tier-reduced` and `tier-minimal`. Their request rates are configured by the gateway: one half and one tenth of the deployment's `requestsPerMinute`, respectively, rounded down with a minimum of one request per minute. The console selects these tiers and their trigger thresholds; it does not set new tier codes or edit their request rates. For example, a throttle budget can select `tier-reduced` at 8,000 basis points and `tier-minimal` at 9,500. These are illustrative settings, not recommended production defaults.

### Creating and editing a budget

1. A write-capable administrator opens **Budgets** and adds a budget or edits an existing row. Read access alone does not authorize a change.
2. For a new budget, select `organization`, `team`, `subject`, or `application`. An existing budget's scope is not editable; changing it requires a separately reviewed removal and addition.
3. Select `all-models` or `per-model`. A per-model budget requires a logical model key from the published model catalogue and is supported only for organization and team scopes. Subject and application scopes support all-model budgets only.
4. Select `Hourly`, `Daily`, `Weekly`, `Monthly`, or `Yearly`, then enter a positive whole-number token limit.
5. Select the action and its threshold settings. An edit can change the amount, period, model coverage, action, and thresholds. Switching to all models removes the individual model key. Unsupported combinations and overlapping budget coverage are refused. The same scope and model coverage can have one quota budget (`HARD_BLOCK` or `SOFT_WARNING`) and one `THROTTLE` budget. Choosing another period does not permit a second budget of the same kind.
6. Save the draft, then follow the explicit approval and publication step in [Publishing](#publishing). Saving a draft does not change the active budget. You or another administrator can approve and publish it; the change takes effect only after the publication targets are verified.

Changing a budget's settings creates a new version; an unchanged submission is refused. APIM counter keys include the budget ID and version, so the new version does not inherit the previous version's consumption counter. Editing a budget is not a way to preserve a continuous billing-period total; the usage history remains a separate record.

### Blocking a model without fallback

To cap one model without switching to another, use an organization- or team-scoped `per-model` budget, select the target model, set the period and token limit, and choose `HARD_BLOCK`. Leave the applicable fallback plan disabled or unconfigured. An earlier warning threshold is optional and does not enable fallback by itself.

When that model's quota is exhausted, APIM refuses the request before forwarding it to Foundry with `403 token_quota_exceeded` and a `Retry-After` header. It does not select an alternative model. Requests remain blocked until the period resets or an administrator changes the applicable limit. This budget alone does not block other models; their own and any shared limits still apply. In-flight requests can still complete, so this is not an exact monetary spending ceiling.

## Models

![The models screen](images/console-models.png)

The catalogue shows what each model can do, what this deployment allows it to do, what it served, and the meters Azure publishes for it.

Each row shows the logical model alias first and the registered provider deployment name directly underneath it. The deployment name remains visible even when provider quota cannot be read; if the registry has no mapping, it is shown as unknown rather than guessed from the alias.

You bring a model under governance by selecting one of the deployment's own model deployments; the console reads the choices from the deployment rather than asking you to type a name. Removing a model asks for a reason and a review of its references. A model still allowed by an entitlement cannot be removed on its own; related changes must be explicitly acknowledged and proposed together, so the catalogue cannot quietly stop covering something a caller is still entitled to.

Retiring an entitlement does not delete its model references. Removing a model still referenced by a revoked binding requires an approved whole-set replacement that removes the references consistently. The [reference-aware removal workflow](#reviewing-team-and-model-removal) prepares that replacement as one draft without editing historical revisions. Provider capture and price controls appear only when the generated deployment configuration declares those routes available; supported deployment modes supply that configuration.

The catalogue is a captured reading with a version and an expiry. Refresh it from the provider before it expires, or the screen will tell you it is reporting a stale one.

## Fallback

![The fallback screen](images/console-fallback.png)

A downgrade plan decides what happens when a caller cannot have the model it asked for. Exactly one plan governs a given caller.

The screen answers three separate questions: what was authored, which hops this caller may take and which rule permitted or refused each one, and what would happen to a request right now. A scope with no plan says so, and the request panel says no decision can be shown rather than implying that nothing would happen.

When a plan sends a request to another model, the response is not rewritten to hide that. A caller can therefore receive a model it did not name, and both this screen and the usage records say which one served.

### Creating a fallback plan

A fresh installation with `fallback: null` has an empty plan list. A write-capable administrator can now open **Fallback** and use **Create a fallback plan**, even when the screen reports no plan. When a plan already exists, select the creation operation to add a plan for a different target.

1. Enter a unique plan identifier and choose the target: `global` (no key), `team` (an existing canonical team key), `subject` (gateway subject), or `application` (application client ID). The identifier suggestions reuse the published catalogue; administrator actor codes and diagnostic HMAC keys are not substitutes for target identifiers.
2. Add connections using registered model aliases, for example `coding-secondary` → `coding-primary`. Creation does not widen any entitlement. The actual caller must still be entitled to both models, and the existing compiler checks API-family compatibility.
3. The safe defaults are **disabled**, **pinned**, and **header**. An operator may explicitly enable the plan and select **preferred** with **inline** notices; inline is refused with pinned intent. Duplicate plan identifiers, another plan for the exact same target (including disabled or retired plans), unknown teams/models, self-loops, cycles, and multiple targets for one source are refused.
4. Choose **Save new plan draft**. The response is HTTP `201`, `state: draft`, and the actual revision ID. No active policy or publication target is written. In **Publishing**, the same administrator or another administrator must explicitly approve and publish that immutable proposal; normal author-only withdrawal and owner-only legacy recovery remain unchanged.

The existing deployed route `POST /api/v1/admin/fallback` now accepts creation:

```json
{
  "command": "add",
  "plan": {
    "planId": "plan-global-coding-fallback",
    "target": { "kind": "global", "key": null },
    "enabled": false,
    "modelSelectionIntent": "pinned",
    "substitutionNotice": "header",
    "edges": [{ "from": "coding-secondary", "to": "coding-primary" }]
  }
}
```

The server sets version, state, validity start, issuer, and the `fallback-plan-created` reason; creation cannot replace those fields. The three safe-default settings may be omitted. Explicit approval/publication uses the same route with only `{ "resume": true, "revisionId": "<returned revision ID>" }`. Later, save `{ "planId": "plan-global-coding-fallback", "changes": { "enabled": true, "modelSelectionIntent": "preferred", "substitutionNotice": "inline" } }` and explicitly approve/publish the new returned draft. Readers cannot create or resume. The local equivalent creation route is `POST /api/local/fallback/propose`; its console uses the same two-step workflow.

### Editing an existing fallback plan

The editor preserves the existing plan's enabled state, selection intent, and substitution notice. It can replace that plan's model connections without changing its identity, target, issuer, or validity window. Creation and editing both save a complete proposal for explicit approval and verified publication.

1. Select the scope whose existing plan you intend to change. Enable fallback and choose `preferred` intent if requests may use a substitute; `pinned` intent keeps the requested model.
2. Add, remove, or change source-to-target model connections using registered aliases. A plan can contain at most 32 connections; self-loops, cycles, and multiple outgoing connections from one source are refused.
3. Each request can use only one connection (`maxDepth: 1`), not traverse a multi-hop chain. Several connections map different requested models.
4. Treat the displayed caller/API-family compilation results as a preview, not a guarantee for all callers. Registration, entitlement, and API-family compatibility are checked for the actual caller. The preview does not prove a lower price, equivalent capabilities, or residency.
5. Submit a changed proposal and complete [Publishing](#publishing). Reordering unchanged connections is not a policy change. Saving a draft does not activate its new connections.

APIM uses a permitted connection when the plan is enabled, intent is `preferred`, and the configured pressure threshold is reached. If no permitted connection exists, the requested model remains subject to all its existing quotas and budgets; fallback does not bypass a block. The reference-only `onExhausted: deny` option is not implemented in the deployed effective-policy/APIM path and is not offered in the console.

## Usage

![The usage screen](images/console-usage.png)

Usage is reported in the tokens this gateway metered. It counts what passed through the gateway; requests that reached a model by another route are not here, and no screen in this console claims otherwise.

The banner describes the window rather than just dating it: when the window started and ended, when it was read, the ingestion lag, and whether it has closed. A window that has not closed, or that was read inside the lag, is labelled instead of being presented as a final number.

**People appear as pseudonymous keys, not names.** The rows are aggregates, and no prompt or completion text is returned to this screen. If you need to know which person a key belongs to, that mapping is not something the console will show you.

Pseudonymous does not mean anonymous. A subject or application key combined with model, token, policy outcome, and timing data can still be personal data when your organization can link it to a person.

Before onboarding developers, document and approve the monitoring purpose, data categories, recipients, access rules, retention and deletion periods, escalation or rights path, and key-custody and re-identification rules. Review provider and platform diagnostics separately because they may retain message bodies even when this console does not. This PoC does not provide organizational approval or a monitoring notice for you.

## Users And Groups

![The users and groups screen](images/console-users-groups.png)

This screen answers who belongs to each governed team and what policy they end up with, and it is where you change who may use what.

The directory projection at the top is a reading, and it is read-only: it asks only about the groups the published governance set names as teams, so it is not a directory browser and you cannot pick an arbitrary person or group from it. Below it, the entitlement form saves one change as a draft and returns its revision. Saving does not change active access. Follow the approval and publication steps in [Publishing](#publishing); the revision governs new requests only after every target confirms it.

The directory reading needs a Microsoft Graph permission that a deployment does not grant itself. Until an administrator grants it, the reading refuses with `reading_unavailable / directory-snapshot-absent`. Authorized entitlement and assignment authoring remains available independently, using entered keys and published team mappings rather than a directory picker. See [Entra: Directory Reading For Users And Groups](01-deployment.md#entra-directory-reading-for-users-and-groups) for who can grant it and how.

### Choosing identifiers

Identifier help uses values from the published snapshots that the administrator is authorized to read. It is not a tenant-wide directory search and does not turn a directory display code into a gateway identity. Check the source and identifier type before selecting or copying a value; copying alone does not create a draft or publish a change.

| Identifier | Where it belongs | Do not substitute |
|---|---|---|
| Gateway subject identifier | Subject entitlement or subject policy-role assignment; matches the gateway token's `sub` | Entra user object ID (`oid`), email, directory display code, or `sk1` |
| Application/client identifier | Application entitlement or application policy-role assignment; matches `azp` or `appid` | Application object ID, service-principal object ID, or `ak1` |
| Entra group object ID | Team membership mapping or a supported group policy-role assignment | Team key or a user object ID |
| Canonical team key | A published governed-team selection | Entra group object ID |
| Logical model alias | Entitlement allowlist, model budget, or fallback connection | Provider deployment name |
| Provider deployment name | Capturing a model from the available provider deployments | Logical model alias |

Current-caller diagnostics show server-derived `sk1` and `ak1` telemetry pseudonyms only when the verified identity and derivation configuration are available. They are not entitlement targets. Deployed diagnostics are scoped to the **control-plane token** and do not establish the coding client's inference-token identity; subjects and clients can differ across those contexts. The local label identifies deterministic fixture evidence, not a deployed caller.

The browser does not derive these pseudonyms, receive the derivation secret, or accept a token for inspection. Missing evidence is unavailable rather than guessed. A failed clipboard operation reports that copying is unavailable instead of claiming success; use the visible value and its type to copy manually if permitted. An unavailable directory reading remains separate from authorized values already present in the published configuration.

### Editing model access and token limits

The entitlement editor shows the selected binding's allowed models, requests per minute, tokens per minute, token quota, and quota period. Selecting another binding reloads its own values. Limits are independent of budgets: a request must satisfy every applicable control, not just the value edited on this screen.

1. Select an existing entitlement to edit its allowed models and limits, or use **Add an entitlement** for a person, application, or existing governed team.
2. For a person or application, enter the gateway subject (`sub`) or application/client identifier (`azp` or `appid`), not a display name, email address, or derived `sk1`/`ak1` telemetry key. Use [identifier help](#choosing-identifiers) to distinguish these values. For a team, choose its published team mapping. The organization-wide ceiling is edited through its existing binding, not added as a second entitlement.
3. Set the rate limits and, when needed, a token quota together with its period: `Hourly`, `Daily`, `Weekly`, `Monthly`, or `Yearly`. These are token limits, not currency amounts.
4. A blank field on a new entitlement adds no limit. Editing an existing limit requires an explicit replacement value; clearing its field does not remove the persisted limit. A quota and its period must be supplied together. An unchanged submission is refused.
5. Submit the proposal and complete [Publishing](#publishing). Refreshing before publication still shows the active binding, not the draft's proposed values.

Active non-global entitlements can be retired (`state: revoked`), and revoked, unexpired entitlements can be restored (`state: active`). The organization ceiling cannot be retired. Inactive bindings retain their models and limits, which are read-only until restored. State changes preserve the original grant reason; revision history records the actor and change. Retirement is not deletion: removing a referenced team or model requires a consistent whole-set replacement, because removal validation also checks revoked bindings.

### Governance policy assignments

**Grant a governance-policy role** edits the versioned governance assignment snapshot. Select the role, assignee kind and key, and scope from the supported combinations; enter an assignment identifier and a bounded reason code. A team-scoped assignment also names a published team. Granting or revoking an assignment creates a draft and follows the same approval and publication process.

In a deployed environment, this does **not** create Microsoft Entra app-role assignments or grant access to the administration console or API. Deployed administrative permissions come from app roles in the caller's validated access token; manage those roles in Microsoft Entra. Snapshot assignments contribute governance-policy role and scope evidence, and do not grant model access without an entitlement. Local demo personas use snapshot assignments for their demonstration authorization and are not proof of deployed Entra access.

### Bringing a directory group under governance

Because this screen does not browse the directory, you name the group yourself. The team form takes a team name and the group's **object ID**. Submitting it saves the new team mapping as a draft, not an active mapping. Follow the approval and publication steps in [Publishing](#publishing) before expecting it in the directory projection or caller policy.

To find the object ID, open the [Microsoft Entra admin center](https://entra.microsoft.com), go to **Entra ID** > **Groups** > **All groups**, select the group, and copy **Object ID** from its overview. It is a GUID.

Membership itself stays in the directory. Adding a team decides which group this product governs; who is in that group is changed in Entra, and the console never writes to it.

### Reviewing team and model removal

Removing a governed team or model is a configuration change, not cloud cleanup. It does not delete a Microsoft Entra group, change directory membership, or delete a provider model deployment. Historical revisions remain unchanged.

1. In the team or model form, choose the target and removal reason, then review the removal plan.
2. Read each blocking reference and the proposed action. Active, revoked, and expired references are considered; retirement alone does not remove a reference.
3. Explicitly acknowledge every listed reference change. Nothing is selected automatically. If the resulting configuration would be invalid, resolve the reported blocker before proceeding; the workflow does not silently remove unrelated grants.
4. Submit the acknowledged plan. The server re-reads active configuration and rejects a stale plan, incomplete acknowledgments, or references that do not belong to it.
5. Open the resulting draft in [Publishing](#publishing), review its impact where available, and complete the existing approval and publication process. Planning and saving leave active policy unchanged.

Team removal can require removing team-targeted entitlements, team-scoped governance assignments, and team-targeted fallback plans from the new snapshot. Model removal can require pruning the model from entitlement allowlists, removing per-model budgets, and removing fallback connections. Each operation is included in the plan rather than inferred from an unchecked checkbox. The existing validators remain the authority for whether the resulting set can be published.

The workflow requires entitlement-write authority and global read scope; changes to budgets also require budget-write authority. These are existing governance capabilities, not new Entra role assignments. Publication failure continues through the existing recovery process: a draft is not active merely because some targets accepted it, and a retry uses the stored proposal rather than rebuilding it from changed browser input.

## Notifications

![The notifications screen](images/console-notifications.png)

Notifications record what each period earned, whether it reached anyone, and whether anyone acknowledged it. The counters separate raised, awaiting delivery, delivered, failed, and acknowledged, so a finding that was raised but never delivered is visible as undelivered rather than quietly dropped.

The delivery channel is configured on this screen. **The address is stored and never shown again.** Only its host is displayed afterwards, which is enough to tell which channel is configured and not enough to recover the webhook. Keep your own copy of the address; if you lose it, you set a new one rather than reading the old one back.

Reading notifications does not grant authority to acknowledge them or change their channel. Those mutations require the notification write capability and are refused before request content is read or an actor is recorded.

The console is enough if someone is looking at it. For what the two supported channels expect and how delivery behaves, see [Sending Governance Notifications to a Chat Channel](05-notifications.md).

## Change History

![The change history screen](images/console-audit.png)

Every governance change appears here with its recorded actor code, version, reason, and the configuration it was made under. The coverage line states what the trail includes for the scope you are viewing, so a short list is distinguishable from a filtered one. Deployed administrative actor codes are stable pseudonyms for the active key version, so this view can distinguish administrative actions without exposing a person's direct identifier.

**This is a record of what changed, not a tamper-evident ledger.** It makes no claim to detect alteration of its own contents. If you need that property, it has to come from somewhere else.

Export is available to roles permitted to take a copy away. A role that may read the trail but not export it is told so in place of the control.

## Where To Go Next

- [Deploying The Gateway](01-deployment.md) covers deployment, Entra one-time actions, bootstrap, removal, and troubleshooting, and lists what this product does not guarantee.
- [Operating And Removing An Evaluation Environment](03-operations.md) explains safe operation and cleanup, including what a caller gets when organization, team, subject, and application policy all apply.
- [Connecting A Coding Agent](04-connection.md) is what to hand to someone who has to point a tool at the gateway.
- [Sending Governance Notifications to a Chat Channel](05-notifications.md) covers Slack and Microsoft Teams delivery.
