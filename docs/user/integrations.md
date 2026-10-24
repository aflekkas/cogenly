# Integrations

Integrations connect Cogenly to outside services — Gmail, Linear, GitHub, or
any remote MCP server — once, for every agent and every provider. You connect
a service a single time and Claude, Codex, and Muse turns can all use it
through Cogenly. Nothing about the providers' own MCP setup changes.

## Default integrations

Settings → Integrations opens on the services Cogenly knows how to connect.
Choose **Connect** on one (or **Add account** for another account of it), fill
in what it asks for, and sign in. Each account then shows under its service with
its status and **Sign in**, **Reconnect** and **Remove**. Secrets are picked
from your vault, so store a key or client secret there first.

| Service                                                 | What it needs                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Google Workspace (Gmail, Calendar, Drive, Docs, Sheets) | Your own Google OAuth client and uv; see [Connect Google](#connect-google).                   |
| Linear                                                  | Sign in, or an API key                                                                        |
| Notion                                                  | Sign in                                                                                       |
| GitHub                                                  | A personal access token, or an OAuth app you create                                           |
| Atlassian (Jira, Confluence)                            | Sign in                                                                                       |
| Intercom                                                | Where your workspace is hosted (US or EU), then sign in or an access token. Mostly read-only. |
| Wispr Flow                                              | Sign in. Needs Notetaker and Cloud Sync on your Wispr account.                                |
| Slack                                                   | A Slack app you create; see [Connect Slack](#connect-slack).                                  |
| Fathom                                                  | Sign in                                                                                       |
| Figma                                                   | Not available yet: Figma only admits clients it approved.                                     |

Anything else is a **Custom MCP server** ([below](#connect-one)). GitHub's
toolsets can be narrowed afterwards by adding an `X-MCP-Toolsets` header in the
account's **Edit**.

Or ask an agent: "Connect my Linear" or "Connect my work Gmail". It connects
the service and gives you the sign-in link, or tells you what it needs first,
such as your region or a key it collects through a private card.

### Connect Slack

Slack doesn't let Cogenly register itself, so you create a Slack app once and
Cogenly signs in through it. Slack needs an HTTPS redirect URL, so open Cogenly
from its HTTPS address (a VPS, or your tailnet's HTTPS name) while doing this.

1. In Settings → Integrations, choose **Connect** on Slack and **Copy
   manifest**. It already contains your redirect URL, the Cogenly address
   followed by `/oauth/integrations/callback`.
2. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New
   App → From a manifest**, pick your workspace, and paste it.
3. In the app's **Agents & AI Apps** page, turn on **Model Context Protocol**.
4. Under **Basic Information**, copy the client ID. Store the client secret as
   an **API key** vault item allowing `slack.com`.
5. Back in Cogenly, enter the client ID, pick the secret with the key button,
   and choose **Connect and sign in**.

For a second workspace, create an app there the same way and choose **Add
account**.
An agent can do steps 4 and 5 for you: it collects the secret with
`request_secret` and calls `integration_add` with `catalogId: "slack"`.

## Connect one

For any other remote MCP server, choose **Add** on **Custom MCP server** under
Services:

1. Enter a display name and the server's URL. The name agents use is filled in
   from the display name; change it before saving if you like, since it is
   fixed afterwards.
2. Add any headers the server needs. For a secret, choose the key button
   beside the value and pick a vault item and field; Cogenly inserts a
   reference such as `Bearer {{credential:gmail.password}}`. Store the secret
   in your vault first. Once saved, header values typed in directly show as
   `••••`; leave one as it is to keep it, or type a new value.
3. Optionally add a hint agents see next to the name, and limit the
   integration to chosen projects.
4. Choose **Test connection** to see how many tools the server offers, or why
   it could not connect. Testing a new integration adds it first.

Each integration's menu can test, edit, turn it off without removing it, or
remove it. "Not checked" means nothing has listed its tools since it last
changed; testing it or an agent using it updates the status.

Or ask in any chat or Work thread:

> Connect my tracker: the MCP server is at https://example.com/mcp and the API
> key is in my vault as the `apiKey` field of the `tracker` item.

Your agent calls `integration_add` with the server URL and header templates
that reference the vault, like `Bearer {{credential:tracker.apiKey}}`. Raw
secrets never go into an integration: only references, resolved by the server
at call time. If a persistent agent asks to connect an integration, you get an
approval card first — approving it creates the integration. Your own chats
connect directly.

A vault item is only sent to a server listed in the item's allowed domains, or
to one you approved it for. Saving an integration in Settings, or approving an
agent's request, approves the vault items in its headers for that server.
Changing its URL drops that approval until you save it again.

## Sign in with OAuth

Most hosted MCP servers want you to sign in rather than paste a token. The
[default integrations](#default-integrations) set this up for you; for a custom
server, turn on **Sign in with OAuth** when you add it, leave the headers
empty, and choose **Sign in**. Your
browser opens the service's consent page; approve it and the integration turns
**Connected**. Agents keep access after that, including scheduled runs on a
server nobody is watching: Cogenly stores the tokens in your vault and renews
them on its own.

If the service later stops accepting the sign-in (you revoked access, or it
expired), the integration shows **Needs sign-in**. Choose **Sign in** again;
**Reconnect** in the menu does the same for a connected one.

When you [share the vault](vault.md#vault-on-several-machines) between paired
machines, signing in to a web integration on one machine signs it in on the
others too. One machine renews the sign-in for all of them: your hub when it
shares the vault with you, otherwise the machine you signed in on. If that
machine is offline when the sign-in runs out, the others show that they are
waiting for it; signing in again on any machine also works. Google and other
local integrations sign in on each machine separately.

Some services don't let Cogenly register itself (Slack: see
[Connect Slack](#connect-slack)). Create an app with the service, add the
redirect URL shown in the editor (your Cogenly address followed by
`/oauth/integrations/callback`), store the app's client secret in your vault,
and enter the client ID and pick the secret with the key button. The browser
you sign in with must be able to open that Cogenly address, so sign in from
the address you normally use to reach Cogenly.

Ask an agent to connect one and it replies with a sign-in link for you to open.
Google accounts ([below](#connect-google)) sign in the same way.

## More than one account

Connect a service once per account, for example two Slack workspaces or a
personal and a work Gmail: **Add account** on the service, with an **Account**
label such as "Acme". Agents see "Slack · Acme" next to its name
(`slack-acme`) and pick the right one. Each connection signs in, and is used,
separately. Google accounts work the same way: "Google · personal" and
"Google · Spawn Partners" are two integrations.

## Connect Google

Connect Gmail, Calendar, Drive, Docs and Sheets with the **Google Workspace**
preset. Each account is its own integration with an account label, and all of
them reuse your Google OAuth client.

1. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) on the
   machine running Cogenly (`brew install uv` on a Mac). Cogenly installs and
   runs its pinned Google server automatically.
2. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project. Under **APIs & Services → Library**, enable **Gmail API**, **Google
   Calendar API**, **Google Drive API**, **Google Docs API** and **Google Sheets
   API**.
3. Configure the OAuth consent screen in **Google Auth Platform**. For personal
   Gmail, choose **External** and publish it as **In production**. The
   “unverified app” warning is expected for your own client; continue only for
   the client you created. For a Workspace domain, choose **Internal** in a
   project belonging to your organization. Your administrator may need to allow
   the client. For a mix of personal and Workspace accounts, use External; an
   Internal client only admits members of its organization. Avoid **Testing**:
   these Workspace permissions make refresh tokens
   [expire after seven days](https://developers.google.com/identity/protocols/oauth2#expiration).
4. Create an OAuth client of type **Web application**. Add this **Authorized
   redirect URI** for Cogenly running on your Mac:

   `http://localhost:4773/oauth/integrations/google/callback`

   Use your Cogenly server's port if it differs. For a VPS, use its reachable
   HTTPS origin instead, for example:

   `https://cogenly.example.com/oauth/integrations/google/callback`

   Your proxy must forward `/oauth/integrations/google/` to Cogenly. The URI
   must match exactly. Download the client's JSON file.

5. Store that JSON as the value of an environment-wide **API key** vault item
   named `google-oauth-client`, with allowed domain `accounts.google.com`.
   Ask an agent to collect it privately with `request_secret` and
   `saveToVault: {name: "google-oauth-client", type: "api_key", domains: ["accounts.google.com"]}`.
   Paste the JSON into the private card, never chat.
   Alternatively, create a **Login** item with the same name and domain, using
   the client ID as its username and the client secret as its password.
6. Choose **Connect** on Google Workspace in Settings → Integrations and name
   the account, such as "personal", or ask an agent to "connect my Gmail"
   (`integration_add` with `catalogId: "google-workspace"`). Connecting from
   your VPS address uses it as the callback origin; an agent on a VPS also
   passes `callbackOrigin: "https://cogenly.example.com"`, matching step 4.
   Open the sign-in link, choose the intended Google account, and grant the
   requested permissions. Repeat with **Add account** for each account.
   Google tools may ask for `user_google_email`; give the agent the email
   address you signed in with.

On a VPS, the callback goes through Cogenly's HTTPS origin to the account's
private local server; your browser never needs to reach localhost on the VPS.
Sign-in links expire after ten minutes; choose **Sign in** again for a fresh
one. If Google revokes access, ask the agent to call `start_google_auth`
through `integration_call` and give you its new consent link.

Refresh tokens persist privately on the machine running Cogenly and refresh
automatically. Restarting Cogenly or turning an account off and on reuses them;
it does not request a new refresh token each time. Google permits
[100 refresh tokens per account per OAuth client](https://developers.google.com/identity/protocols/oauth2#expiration).
Remove or disable an integration in Settings to stop its server. Removing it
keeps its stored credentials; revoke the client's access in your Google Account
if you also want to invalidate its Google authorization.

## What agents see

Every turn carries one short line naming what is connected and which default
integrations are not connected yet:

> Connected integrations: gmail (Gmail, aflekkas@example.com), linear. Use
> integration_tools / integration_call. Also available to connect with
> integration_add catalogId: notion, slack, ….

Agents discover and use services through three tools, so a new integration
never adds new tools to every conversation:

- `integrations_list` — what is connected here, with status and tool counts.
- `integration_tools(name)` — one integration's tools and input schemas.
- `integration_call(name, tool, args)` — call a tool.

Agents can also set integrations up for you (`integration_add`,
`integration_update`, `integration_remove`), subject to the approval above.
They can change or remove only integrations available in their project.
Widening an integration’s project scope, or pointing one that holds a pasted
token or vault credential at a new server, requires you to make the change in
Settings → Integrations.
