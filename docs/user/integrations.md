# Integrations

Integrations connect Cogenly to outside services — Gmail, Linear, GitHub, or
any remote MCP server — once, for every agent and every provider. You connect
a service a single time and Claude, Codex, and Muse turns can all use it
through Cogenly. Their own connectors for catalog services are hidden by default;
see [Claude and Codex connectors](#claude-and-codex-connectors).

## Default integrations

Settings → Integrations lists your connected accounts first. Choose **Add**,
then a service or **Custom MCP server**. Choose the same service again to add
another account.
Services that let Cogenly register itself sign in with one click. The others
show a short guided setup right on the row: each step links to the exact page
in the service's console and gives you the values to copy, such as the
redirect address. Paste the client ID and secret, or the key, into the form at
the end; Cogenly stores the secret in your vault and never shows it again.

Each account then shows as **Connected**, **Needs sign-in**,
or an error with what to do about it, such as **Sign in**, **Test again** or
**Install uv**.

- **Google Workspace** (Gmail, Calendar, Drive, Docs): your own Google OAuth
  client, made once in a guided setup; see [Connect Google](#connect-google).
- **Slack**: a Slack app you create from Cogenly's manifest; see
  [Connect Slack](#connect-slack).
- **GitHub**: a personal access token, or your own OAuth app; see
  [Connect GitHub](#connect-github).
- **Linear**: sign in, or an API key.
- **Notion**, **Fathom**: sign in.
- **Wispr Flow**: sign in. Needs Notetaker and Cloud Sync on your Wispr account.

Anything else, including Jira, Confluence, Intercom or Figma, is a **Custom MCP
server** ([below](#connect-one)). Accounts you connected from an earlier
catalog keep working there.

Or ask an agent: "Connect my Linear" or "Connect my work Gmail". It connects
the service and gives you the sign-in link, or tells you what comes first and
gives you a link that opens that step in Settings. It can also collect a key or
client secret itself through a private card.

### Connect Slack

Slack doesn't let Cogenly register itself, so you create a Slack app once and
Cogenly signs in through it. Slack needs an HTTPS redirect address, so open
Cogenly from its HTTPS address (a VPS, or your tailnet's HTTPS name) while
doing this.

Choose **Add → Slack** and follow the steps: copy the manifest (it
already contains your Cogenly address), create an app from it at
[api.slack.com/apps](https://api.slack.com/apps), turn on **Model Context
Protocol** on the app's **Agents & AI Apps** page, then paste the app's client
ID and client secret from **Basic Information**. Cogenly opens Slack's sign-in
next. For a second workspace, choose **Add → Slack** again and do the same there.

### Connect GitHub

GitHub doesn't let Cogenly register itself either. The quickest way is a
[fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
with access to the repositories agents should use: paste it when you choose
**Add → GitHub**. To sign in instead, pick **Your OAuth app**, register one at
[github.com/settings/applications/new](https://github.com/settings/applications/new)
with the callback address the step shows, and paste its client ID and secret.
GitHub's toolsets can be narrowed afterwards by adding an `X-MCP-Toolsets`
header in the account's **Edit**.

## Connect one

For any other remote MCP server, choose **Add → Custom MCP server**:

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
**Sign in again** in the menu does the same for a connected one.

Some custom servers don't let Cogenly register itself. Choose **Set up** on
the account's row, create an app with the service, and add the exact redirect
address in the step. Paste its client ID and secret in the private form;
Cogenly stores the secret in your vault and continues to sign-in.
The browser you sign in with must be able to open that Cogenly address, so sign
in from the address you normally use to reach Cogenly.

Ask an agent to connect one and it replies with a sign-in link for you to open.
Google accounts ([below](#connect-google)) sign in the same way.

## More than one account

Connect a service once per account, for example two Slack workspaces or a
personal and a work Gmail: choose **Add**, pick the service again, and give
the account a name such as "Acme". Agents see "Slack · Acme" next to its name
(`slack-acme`) and pick the right one. Each connection signs in, and is used,
separately. Google accounts work the same way: "Google · personal" and
"Google · Spawn Partners" are two integrations.

## Connect Google

Connect Gmail, Calendar, Drive and Docs with the **Google Workspace** entry.
Each account is its own integration with an account label, and all of them
use one Google OAuth client of your own, which you make once.

Choose **Add → Google Workspace** and name the account, such as
"personal". The first time, the row walks you through the client in Google
Cloud, with a link to each page:

1. Create a project.
2. Turn on the Gmail, Calendar, Drive, Docs and Sheets APIs.
3. Set up the consent screen. For personal Gmail, choose **External**; for a
   Workspace domain, **Internal** in a project of your organization (your
   administrator may need to allow the client). For a mix, use External.
4. Under **Audience**, publish the app so it reads **In production**. In
   **Testing**, Google's refresh tokens
   [expire after seven days](https://developers.google.com/identity/protocols/oauth2#expiration).
   The "unverified app" warning is expected for your own client.
5. Add the scopes the step lists.
6. Create an OAuth client of type **Web application** with the exact
   **Authorized redirect URI** the step shows, your Cogenly address followed
   by `/oauth/integrations/google/callback`. On a VPS, open Settings from its
   HTTPS address so that is the address used, and make your proxy forward
   `/oauth/integrations/google/` to Cogenly.
7. Paste the client ID and secret into the form.

Cogenly saves the client in your vault as `google-oauth-client` and opens
Google's sign-in. Choose the intended Google account and grant the requested
permissions. Repeat with **Add → Google Workspace** for each account.

Cogenly runs Google's server with [uv](https://docs.astral.sh/uv/). If uv is
missing on the machine running Cogenly, the account shows **Install uv**;
choose it, or run `brew install uv`, and the account starts without a restart.

An agent can do this too: ask it to "connect my Gmail". It relays the same
steps with a link to them in Settings, or collects the downloaded client JSON
through a private card (`request_secret` with
`saveToVault: {name: "google-oauth-client", type: "api_key", domains: ["accounts.google.com"]}`)
and connects with `integration_add` and `catalogId: "google-workspace"`. An
agent on a VPS also passes `callbackOrigin: "https://cogenly.example.com"`.
Google tools may ask for `user_google_email`; give the agent the email address
you signed in with.

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

- `integrations_list` — what is connected here, with status and tool counts,
  and for an account that isn't usable, what to do next and a Settings link.
- `integration_tools(name)` — one integration's tools and input schemas.
- `integration_call(name, tool, args)` — call a tool.

Agents can also set integrations up for you (`integration_add`,
`integration_update`, `integration_remove`), subject to the approval above.
They can change or remove only integrations available in their project.
Widening an integration’s project scope, or pointing one that holds a pasted
token or vault credential at a new server, requires you to make the change in
Settings → Integrations.

### Claude and Codex connectors

Claude and Codex bring connectors of their own: claude.ai connectors, ChatGPT
apps, and MCP servers from plugins or your `~/.claude` and `~/.codex` config.
For the services in the default catalog, Cogenly turns those copies off in the
agents it runs, connected in Cogenly or not, so each service shows up once and
goes through Cogenly integrations. Connectors for services the catalog doesn't
cover, such as Figma, stay available. Your Claude and Codex config is not
changed.

To give agents the provider connectors as well, turn on **Use provider
connectors too** in Settings → Integrations. It applies to agent sessions that
start after the change. MCP servers that run as a local command, rather than
at a URL, are never turned off.
