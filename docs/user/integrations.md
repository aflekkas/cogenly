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
it replies with a sign-in link for you to open.

## More than one account

Connect a service once per account, for example two Slack workspaces or a
personal and a work Gmail. Give each its own name (`slack-acme`,
`slack-personal`) and an **Account** label; agents see "Slack · Acme" next to
the name and pick the right one. Each connection signs in, and is used,
separately.

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

## Not yet

Local `stdio` MCP servers are deferred — integrations speak remote HTTP MCP.

Agents can change or remove only integrations available in their project. Widening an integration’s project scope, or pointing one that holds a pasted token or vault credential at a new server, requires you to make the change in Settings → Integrations.
