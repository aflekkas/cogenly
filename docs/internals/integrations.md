# Integrations gateway

One gateway, not one MCP config per provider. Cogenly already exposes a
single `cogenly` MCP endpoint to every provider turn; integrations ride that
endpoint instead of being written into each CLI's native MCP config. Native
CLI MCPs are untouched by this work and are removed, if ever, one by one.

Agents get three generic tools — `integrations_list`, `integration_tools`,
`integration_call` — plus management tools (`integration_add`,
`integration_update`, `integration_remove`). A new integration adds zero tools
to the model's context; discovery is one call away. The alternative (proxying
every upstream tool into the endpoint) trades a bounded context for unbounded
tool overload as integrations grow.

Credentials are resolved server-side, right before the upstream request, from
`{{credential:<item>.<field>}}` header templates
([Integrations.ts](../../apps/server/src/integrations/Integrations.ts)).
Resolution fails closed: a missing or malformed reference fails the call and
no request is sent. Resolved values never cross back — not in tool results,
not in list output (which returns templates, never values), not in errors
(upstream messages are bounded and credential-free by construction). The
resolver sits behind the small `IntegrationCredentials` interface, backed by
the [vault](./vault.md): a reference is a vault item name and field, and a
missing item or field counts as no credential. Accounts may associate metadata
with those vault items; legacy integration references keep their names. CLI
process exposure is a separate permission and resolves through AccountAccess
with authenticated thread/project/agent/provider context. The integration
resolver's unrestricted server caller must not be reused for process delivery.

Persistent agents must obtain owner approval to add an integration or change its
URL, transport, or headers. Update approvals freeze those fields together so a
pending proposal cannot inherit newly attached credentials. Ordinary agent edits
preserve that destination in the service, and credential resolution checks the
stored approved origin. Settings edits authorize the new origin directly.

Integration definitions live in the `integrations` table (migration 083) as
payload JSON with a tombstone, shaped to become shared documents under sync:
edits resolve per field later without a schema change. Upstream tool lists
are cached per integration version with a short TTL and invalidated on edit;
calls use streamable-HTTP JSON-RPC with a bounded timeout, and upstream
failures map to a small set of reasons agents can act on.

Project scope is enforced in the service, not the toolkit: every gateway
entry point takes the caller's project label (or `null` for unfiled turns,
`undefined` for the unrestricted owner view) and scoped integrations are
indistinguishable from missing ones outside their projects. The per-turn
context line is built in `RuntimePolicy` through `buildProjectManifest`, so
all three adapters carry it with no per-provider code.

`integrations.list` reports `connected` only while the tool cache holds the
current version, `error` with a message when the last upstream round trip for
this version failed, and `needs_sign_in` for an OAuth integration without a
usable grant. A passing `testConnection` refills that cache; Settings also
keeps its last test result per integration version to show the failure reason.
`integrations.subscribe` pushes the list after every change and status flip.

## OAuth sign-in

An integration with `auth: { type: "oauth" }` signs in per the MCP
authorization spec ([IntegrationOAuth.ts](../../apps/server/src/integrations/IntegrationOAuth.ts)).
Constraints that are not obvious from the code:

- The redirect URI is `<origin>/oauth/integrations/callback` on the origin the
  request that started sign-in reached (the WebSocket upgrade for Settings, the
  MCP request for agents), like `/oauth/mcp`. A browser elsewhere cannot open a
  loopback origin, so an agent's loopback request uses that account's last
  successful browser origin, persisted as server-only state (in the account
  directory for Google). A first-time loopback request needs an explicit
  `callbackOrigin`, or a sign-in through Settings on the reachable address.
  Dynamic registrations record their redirect URIs and are reused only for the
  same one.
- The callback is unauthenticated: the browser that consents need not hold a
  Cogenly session. The single-use `state`, bound in memory to the PKCE verifier
  and to the integration's URL at the time, is the authority; pending sign-ins
  do not survive a restart. Its path is untraced because the query carries the
  code.
- Non-secret OAuth state (endpoints, client registration, expiry, signed-in) is
  persisted inside the integration payload but never leaves the service; tokens
  are a vault item ([vault](./vault.md)). A new URL or client id drops both.
- One refresh per account at a time: waiters re-read the token under the lock
  and use what the refresh produced. A token-endpoint refusal of the grant marks
  the integration `needs_sign_in`, and later calls fail before any request, so
  a revoked grant never loops.

## Managed local servers

A `local` integration is a fixed preset (today only Google Workspace,
[local/](../../apps/server/src/integrations/local/)), never a command from
Settings or MCP: Cogenly pins the package, runs one process per account over stdio, and passes the OAuth client through
the environment, never argv. Only its state-bearing OAuth callback listener uses a runner-allocated loopback
port. MCP has no HTTP listener, and the pinned launcher removes the package's
attachment routes and missing-state callback fallback. Remote URLs,
including OAuth discovery and token endpoints, go through
[RemoteEndpoint.ts](../../apps/server/src/integrations/RemoteEndpoint.ts),
which refuses non-public addresses and pins the connection to the checked DNS
answers.

There is one sign-in entry point: `beginSignIn` returns an `IntegrationSignIn`
for both kinds, and `needs_sign_in` means the same thing for both. A local
link is a ten-minute capability ticket on the account's fixed callback origin
(Google needs that exact redirect URI registered), which asks the process for
its consent URL; the callback is routed to the process by the OAuth `state` it
issued. The process keeps the Google grant on disk, so Cogenly does not hold
those tokens. A rejected grant is tracked separately from its credential file;
only an explicit sign-in moves that file aside and restarts the process for
reauthorization. Any committed edit retires the running definition (a stale
in-flight request cannot restart it); an empty update changes nothing, so
asking for a fresh link does not kill a pending sign-in.

Clients have no RPC for an integration's tool list; only agents see tools,
through `integration_tools`.

## Default catalog

The catalog ([integrationCatalog.ts](../../packages/contracts/src/integrationCatalog.ts))
is static data shared by the server, Settings and the context line. Connecting
an entry resolves it, in one pure function
([IntegrationCatalog.ts](../../apps/server/src/integrations/IntegrationCatalog.ts)),
into an ordinary integration definition; nothing records which entry it came
from. Settings groups accounts by matching the endpoint (or the local preset),
so hand-added integrations for a catalog URL group too, and a persistent
agent's catalog request is proposed as the resolved definition, so the owner
approves exactly what gets created. A request that lacks an input fails
`invalid_request` with the agent's next step as its cause, so agents learn
what to collect without a new error reason per service.
