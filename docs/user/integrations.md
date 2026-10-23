# Integrations

Integrations connect Cogenly to outside services — Gmail, Linear, GitHub, or
any remote MCP server — once, for every agent and every provider. You connect
a service a single time and Claude, Codex, and Muse turns can all use it
through Cogenly. Nothing about the providers' own MCP setup changes.

## Connect one

Ask in any chat or Work thread:

> Connect my Gmail: the MCP server is at https://example.com/mcp and the API
> key is in my vault as the `apiKey` field of the `gmail` item.

Your agent calls `integration_add` with the server URL and header templates
that reference the vault, like `Bearer {{credential:gmail.apiKey}}`. Raw
secrets never go into an integration: only references, resolved by the server
at call time. If a persistent agent asks to connect an integration, you get an
approval card first — approving it creates the integration. Your own chats
connect directly.

You can scope an integration to all projects or to specific project folders,
disable it without deleting it, and test the connection from Settings once
the Integrations page lands (the server RPCs `integrations.list`,
`integrations.create`, `integrations.update`, `integrations.delete`, and
`integrations.testConnection` already back it).

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
