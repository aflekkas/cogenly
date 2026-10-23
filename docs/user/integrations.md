# Integrations

Integrations connect Cogenly to outside services — Gmail, Linear, GitHub, or
any remote MCP server — once, for every agent and every provider. You connect
a service a single time and Claude, Codex, and Muse turns can all use it
through Cogenly. Nothing about the providers' own MCP setup changes.

## Connect one

From Settings → Integrations, under Services:

1. Choose **Add integration**.
2. Enter a display name and the server's URL. The name agents use is filled in
   from the display name; change it before saving if you like, since it is
   fixed afterwards.
3. Add any headers the server needs. For a secret, choose the key button
   beside the value and pick a vault item and field; Cogenly inserts a
   reference such as `Bearer {{credential:gmail.password}}`. Store the secret
   in your vault first. Once saved, header values typed in directly show as
   `••••`; leave one as it is to keep it, or type a new value.
4. Optionally add a hint agents see next to the name, and limit the
   integration to chosen projects.
5. Choose **Test connection** to see how many tools the server offers, or why
   it could not connect. Testing a new integration adds it first.

Each integration has a switch to turn it off without removing it, and a menu
to edit, test, or remove it. "Not checked" means nothing has listed its tools
since it last changed; testing it or an agent using it updates the status.

Or ask in any chat or Work thread:

> Connect my Gmail: the MCP server is at https://example.com/mcp and the API
> key is in my vault as the `apiKey` field of the `gmail` item.

Your agent calls `integration_add` with the server URL and header templates
that reference the vault, like `Bearer {{credential:gmail.apiKey}}`. Raw
secrets never go into an integration: only references, resolved by the server
at call time. If a persistent agent asks to connect an integration, you get an
approval card first — approving it creates the integration. Your own chats
connect directly.

A vault item is only sent to a server listed in the item's allowed domains, or
to one you approved it for. Saving an integration in Settings, or approving an
agent's request, approves the vault items in its headers for that server.
Changing its URL drops that approval until you save it again.

## Sign in with OAuth

Most hosted MCP servers (Linear, Notion, Atlassian, GitHub, Intercom, Wispr
Flow) want you to sign in rather than paste a token. Turn on **Sign in with
OAuth** when you add one, leave the headers empty, and choose **Sign in**. Your
browser opens the service's consent page; approve it and the integration turns
**Connected**. Agents keep access after that, including scheduled runs on a
server nobody is watching: Cogenly stores the tokens in your vault and renews
them on its own.

If the service later stops accepting the sign-in (you revoked access, or it
expired), the integration shows **Needs sign-in**. Choose **Sign in** again;
**Reconnect** in the menu does the same for a connected one.

Some services, such as Slack, don't let Cogenly register itself. Create an app
with the service, add the redirect URL shown in the editor (your Cogenly
address followed by `/oauth/integrations/callback`), store the app's client
secret in your vault, and enter the client ID and pick the secret with the key
button. The browser you sign in with must be able to open that Cogenly
address, so sign in from the address you normally use to reach Cogenly.

Ask an agent to connect one ("Connect Linear: https://mcp.linear.app/mcp") and
it replies with a sign-in link for you to open. Google accounts
([below](#connect-google)) sign in the same way.

## More than one account

Connect a service once per account, for example two Slack workspaces or a
personal and a work Gmail. Give each its own name (`slack-acme`,
`slack-personal`) and an **Account** label; agents see "Slack · Acme" next to
the name and pick the right one. Each connection signs in, and is used,
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
6. Ask an agent to call `integration_add` with
   `preset: "google-workspace"` and `accountLabel: "personal"`. For a VPS,
   also pass `callbackOrigin: "https://cogenly.example.com"`, matching step 4.
   Open the returned sign-in link (or choose **Sign in** on the account in
   Settings → Integrations), choose the intended Google account, and grant the
   requested permissions. Repeat with another account label for each account.
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

Every turn carries one short line when anything is connected:

> Connected integrations: gmail (Gmail, aflekkas@example.com), linear. Use
> integration_tools / integration_call.

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
