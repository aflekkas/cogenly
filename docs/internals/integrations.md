# Integrations gateway

Integrations belong to Cogenly, so every provider, delegated child and scheduled
run reaches the same project-scoped service through the `cogenly` MCP endpoint.
Agents discover tools on demand through `integrations_list`, `integration_tools`
and `integration_call`. Setup knowledge is repository data exposed by
`integration_setup_guide`; Settings manages accounts rather than reproducing
vendor setup flows. Add service knowledge there without adding a client wizard.

Native CLI servers, plugins and hosted connectors would bypass Cogenly's scope,
status and credential handling and duplicate its tools, so every Claude and
Codex session turns them off. There is no setting to restore them and no import:
an agent connects the service as a Cogenly integration instead. Native
configuration is never rewritten.

Repo MCP definitions stay in the checkout rather than being imported or synced.
`RepoMcpTrust` gates local command execution for both Claude and Codex. URL servers always load. Local consent is keyed by
remote and a canonical hash of the full definitions; keeping it outside the repo
prevents a checkout from granting its own consent. Own GitHub identities, linked
project owners and repositories with no remote are trusted automatically. Provider
adapters recheck before the next turn so edited definitions cannot reuse old trust.
Claude passes reviewed repo servers explicitly, and its project-server settings
exclude commands waiting on trust.
Administrator-managed `managed-mcp.json` rejects the strict flag; Cogenly omits
that flag, and the managed servers remain and are named to agents. Codex has no
strict flag: before launching each session, Cogenly lists enabled servers from
the home directory, outside any repository, with `mcp list --json` and disables
each, plus plugins/apps, using session overrides. Each thread then reads its
cwd's config layers and disables every server whose transport is defined
outside a `project` layer, plus untrusted project commands; that thread
configuration propagates to native children. A failed server enumeration fails session startup rather than
silently restoring bypass access. Muse SDK 1.4.6 only admits additive session
MCP configuration and ignores unknown keys; native suppression is unsupported
and its turns carry that notice.

Project scope and destination approvals live in the service. Every gateway entry
point takes the caller's project label; inaccessible accounts look absent.
Persistent agents request approval for new accounts or destination changes.
Credentials are resolved immediately before a request, never in tool results.
Changing an endpoint or OAuth client invalidates its grant. Tool lists and health
are cached by definition version; subscriptions update Settings and Sources on
mutations and observed status changes.

## OAuth origins and state

Remote OAuth discovers authorization metadata, dynamically registers where
supported, and uses single-use state bound to PKCE and the integration definition.
Tokens live in vault items; refresh is serialized per account. The public callback
is authorized by state, so the consenting browser need not have a Cogenly session.
Pending authorization does not survive a server restart.

The callback origin must be reachable from the consenting browser. On a VPS or
Tailscale connection, the agent supplies the public HTTPS origin on first setup;
loopback MCP requests cannot infer it. Subsequent requests reuse the account's
successful browser origin. Registered clients are reused only with matching
redirect URIs. A new consent invalidates older pending flows for the account.

## Server-owned processes

Generic stdio definitions launch commands without a shell, resolve secret
environment templates from the vault, restart after crashes, and stop after five
minutes without an active request (Google gets fifteen minutes so a pending
consent link can finish). Disabled or removed definitions retire the
process and cannot be restarted by stale in-flight requests. Process cleanup
signals only the captured process identity.

Google Workspace uses pinned `workspace-mcp` 2.1.2 over stdio, with a callback-only
loopback listener. Its launcher replaces the package's credential-file backend
with a vault bridge before importing the package entry point. Each process gets
a separate capability through its environment; the bridge is untraced, returns
no-store responses, and is retired on disconnect or replacement. Both initial
grants and refreshed grants go to the vault. The user's Google client is also
vault-backed; no token or secret is an argv value. Google state and non-secret
browser-origin metadata may remain in the account directory. The package's
attachment routes and missing-state callback fallback are removed.
