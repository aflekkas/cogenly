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

Upstream OAuth sign-in ("Sign in with Google" for an integration) is deferred;
v1 uses static header credentials from your vault. Local `stdio` MCP servers
are also deferred — v1 speaks remote HTTP MCP.

Agents can change or remove only integrations available in their project. Widening an integration’s project scope, or pointing one that holds a pasted token or vault credential at a new server, requires you to make the change in Settings → Integrations.
