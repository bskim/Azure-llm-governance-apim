# Sending Governance Notifications to a Chat Channel

The console shows every finding: a budget approaching its limit, a stale usage window, a caller with an ambiguous team, a publish that failed to verify. That is enough for an administrator who is looking at the console. It is not enough for anyone who is not, so a deployment can also push the same findings to a chat channel: an incoming webhook in Slack, or a Workflows trigger in Microsoft Teams.

Configuring a channel is optional, described below in [Is a channel worth configuring](#is-a-channel-worth-configuring). Everything else on this page describes what happens once one is set.

## The two channels this product speaks

Both channels are reached with an HTTPS **webhook address**: a URL that this deployment posts a JSON body to. Neither integration needs an app installed inside this product, a bot, or an inbound connection. The deployment only ever sends, never receives.

### Slack: an incoming webhook

Create the webhook from Slack's own app settings, following [Slack's current guide](https://api.slack.com/messaging/webhooks):

1. Create a Slack app, or reuse one you already have, in the workspace you want notifications posted to.
2. Open the app's **Incoming Webhooks** settings and turn on **Activate Incoming Webhooks**.
3. Select **Add New Webhook to Workspace**, choose the channel to post to, and authorize it.
4. Copy the generated URL. It has the shape `https://hooks.slack.com/services/...` (the rest of the path is elided here because it is the credential; see [Where the address is pasted](#where-the-address-is-pasted) below).

### Microsoft Teams: a Workflows trigger, not the retiring connector

Microsoft 365 (Office 365) connectors for Teams are being retired, and Microsoft's current guidance is to create the webhook through the **Workflows** app instead. See [Microsoft's guide to creating webhooks with Workflows](https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook) and the [retirement notice for Microsoft 365 connectors](https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/what-are-webhooks-and-connectors).

1. In the Teams channel you want notifications posted to, open **More options** and select **Workflows**.
2. Search for and select a template such as **Send webhook alerts to a channel**, or build one from scratch using the **When a Teams webhook request is received** trigger.
3. Configure and save the workflow.
4. Copy the webhook URL the workflow generates.

### One payload serves both

Slack's incoming webhook and Teams' Workflows trigger both accept a JSON body with a single `text` field, so this deployment sends the identical payload shape to either; the channel kind only changes which URL it is posted to. See [What a delivered message looks like](#what-a-delivered-message-looks-like) for the exact text.

## Setting the channel in the console

An administrator with the right permission (see [Reading and redirecting are different permissions](#reading-and-redirecting-are-different-permissions) below) pastes the webhook address into the console's notification channel field, chooses the channel kind, and saves.

### Where the address is pasted

The address is a credential (both Slack and Microsoft state this about their own webhook URLs), so once it is saved it is handled accordingly:

- It is **stored and never shown again**. Nothing in the console, and nothing any read of the channel returns, ever reproduces the full address.
- Reading the channel back returns only the **channel kind**, the **host** the address points at, **who set it**, and **when**. The console renders this as a single line:

  > Sending to `<host>`, set `<date>`.

  with the address field itself left empty.
- **Who set it** is recorded as a pseudonym derived from the caller, never as a directory identifier such as an object ID or a user principal name.

Only the host is ever shown because only the host is useful for recognizing which channel is configured. The rest of the address exists to authenticate the request, not to identify it.

### Reading and redirecting are different permissions

A role that can read notifications is not automatically able to change where they go. Seeing that a channel exists, which kind it is, and its host uses one permission; changing the address the channel sends to requires a separate, narrower one. This is deliberate: it is what lets an auditor confirm a channel is configured without also being able to redirect it somewhere else.

If your role can read the channel but not change it, saving a new address is refused rather than silently accepted.

## Refusals when setting a channel

Two refusals are possible when saving a channel, and they are reported separately on purpose: being told an address was refused when the channel kind was the problem sends an administrator looking in the wrong place.

- **`channel-kind-unsupported`**: the channel kind is not one this deployment can send to. Choose one of the two kinds this page describes.
- **`endpoint-refused`**: the address itself is not acceptable. It must be an `https` address of a channel outside this deployment. The refusal deliberately does not repeat the address back, because the address is a credential.

## What a delivered message looks like

A delivered message carries exactly the finding it was raised from; nothing more is composed for the channel. For example:

```
[warning] aggregate-stale
scope: organization
period: <period-start>
raised: <raised-at>
attempt: 1
```

A value the notification does not carry is left out of the message rather than written as the word `null`. A finding at organization scope carries no scope key, so the `scope` line names only the scope kind; many findings carry no reason code, so the `reason` line is absent entirely rather than shown empty.

## Is a channel worth configuring

With no channel configured, findings are still raised and still visible. The console is where they are read. Configuring a channel does not change what is found or how it is judged; it only changes whether the finding also reaches somebody who is not looking at the console at the moment it happens. Without one, a finding waits in the console until someone opens it.

## Delivery behaviour

- A due notification is attempted, and a failed attempt is retried with a backoff that doubles each time, starting at one minute, for up to five attempts in total. After the fifth failed attempt, delivery stops being retried and the notification is recorded as failed rather than left pending indefinitely.
- **A failed notification can still be acknowledged.** Acknowledgement and delivery are tracked separately, because otherwise a broken or misconfigured channel would leave every finding behind it permanently open, with no way for an administrator who has seen it in the console to close it.
- The ledger behind the notifications screen records, for every finding: how many delivery attempts were made, which channel the most recent attempt used, and whether anyone has acknowledged it. That is what lets an administrator tell a finding that reached the channel apart from one still waiting, still failing, or already closed.

## Deployment-Owned Generic Fallback

An operator can configure a fixed deployment-owned fallback through a Key Vault
secret reference as described in [Deployment](01-deployment.md#optional-fixed-webhook-and-initial-rollup-backfill).
It is used only when no console-configured channel exists. A stored Slack or
Teams channel takes precedence immediately on the next dispatcher run.

The fallback is for an external generic webhook that accepts the complete JSON
notification payload. It does not name a channel kind and therefore does not
send the Slack or Teams `{"text": ...}` body. Use the console channel setting
for Slack or Teams. The endpoint is validated during Function startup, but its
network reachability is established only when a notification is due.

## Extension point: another channel

Slack and Microsoft Teams are the two channels this deployment sends to today. Adding another channel is a payload shape (what that channel's webhook expects in place of `{"text": ...}`) plus a stored channel kind it can be selected under. This is stated here as the extension point it is, not as a promise that any particular channel will be added.
