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
current version. A passing `testConnection` refills that cache; a failing one
leaves it alone, so Settings also keeps its last test result per integration
version to show the failure reason.

Deferred: upstream OAuth (tokens will be vault items) and `stdio` transport
(the transport union is designed to admit it). Clients have no RPC for an
integration's tool list; only agents see tools, through `integration_tools`.
