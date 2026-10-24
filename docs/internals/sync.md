# Shared state invariants

[SharedState](../../apps/server/src/sync/SharedState.ts) owns portable project,
agent, schedule, integration and settings configuration. Domain mutations record their field deltas in
the same transaction as their existing read models. Peer merges commit the
merged document, projection, relay log and received cursor together. A socket
reply means that transaction committed; sending bytes does not acknowledge it.

Each field has an HLC ordered by physical milliseconds, logical counter, then
stable environment ID. Receiving advances the persisted local clock before the
next local edit, bounding observed wall time and logical counters to contain peer
clock skew. Stored and relayed field clocks retain their original identities and
ordering. Collections are fields, so concurrent replacements of a repo
list or fallback chain choose one whole value. Tombstones are permanent for an
ID, including against edits with newer clocks. Recreating means a new ID.
Local captures preserve the domain's checkout bindings; only peer merges reconcile
competing project documents. Concurrent moves of one remote choose the greatest repository
field clock across the competing documents. Every active local clone stays linked
to that winner; a remote-only link replaces them when no active clone remains.

There is one hub. Spokes send only their own authored deltas; the hub preserves
those clocks when relaying to other spokes. A spoke trusts forwarded authorship
only from its pinned hub. Never forward a merged snapshot as a new edit: that
would claim other machines' field clocks and defeat the authorship check.
Cursors are local to a sender's change log and durable per direct peer. They
are not interchangeable with orchestration event sequences, thread
`stream_version`, or another machine's cursor. Keep identity, database, clocks
and cursors together across recovery. There is no log compaction or cursor
reset protocol yet.

The receiver refuses a batch for what no build would accept: oversized
multi-document batches, cursor gaps, a field without its clock, forged
authorship and ownership changes. A refused batch fails whole and its cursor
does not advance, so nothing that depends on the build may refuse one.

Paired machines update at different times, so a machine regularly receives
documents from a newer build. It applies what it understands and keeps the
rest; it never refuses the change or stalls the stream for it
([`documentSchemas.ts`](../../apps/server/src/sync/documentSchemas.ts)):

- A key it does not know, at any depth, is stored and relayed as it came. No
  projection reads it, since projections decode with this build's schema and
  drop unknown keys.
- A known field whose value it cannot validate (a newer build widened it, or a
  peer sent something invalid) is never applied or relayed. The original
  change waits in `shared_deferred_changes`, as does a document kind it does
  not have, and is applied at startup once an update can read it.
- Writing a document back never drops what it does not understand. Untouched
  keys keep their stored value through the per-field merge, and a rewritten
  field gets back the nested keys its stored value holds that this build does
  not know (`preserveUnknown`). Array items pair up by their known content, so
  an unchanged repository keeps a newer field after a sibling is added.

So a new synced field needs no coordination: make it optional when it reads
from a document, since older documents lack it. Removing or retyping a field
still needs a decision, because older machines keep validating the old shape.

Only the owner machine may change an existing agent's or
schedule's sensitive fields (permissions, instructions, prompt, provider/model,
runtime mode, triggers); other machines may only rename an agent, or rename and
enable/disable a schedule, and deletes still retire work everywhere. Existing
jobs are backfilled to the local machine before scheduling starts; new jobs
default to their creating machine even when paired. An agent's triggers must
have the same owner. Reservations, due-work dispatch, event dispatch, webhooks
and reconciliation enforce ownership. Being offline does not grant another
machine permission to take over.
Documents owned by machines outside the current pairing remain stored and inert;
re-pairing does not transfer their execution to the new hub.

Sync uses the domain's text and collection limits. A document exceeding the normal
batch byte budget travels alone, so a valid configuration cannot wedge a cursor.
Legacy rows that cannot be captured are logged and skipped during bootstrap;
capture failure during repository backfill never fails a project read.
Bootstrap completion is durable per peer pairing; reconnects and scheduler ticks
do not rescan the domain tables. No-op edits and replayed merges do not invalidate
client streams.
Undecodable stored changes are logged and skipped while advancing their cursor.
Legacy URI-encoded MCP schedule IDs remain readable on disk and on the wire to
preserve task references and webhook URLs; new IDs hash keys that are not portable.

Shared repository identity is its remote. Local checkout IDs, absolute paths,
thread bindings, credentials, run counters and fallback position/reset time do
not replicate. Peer metadata edits preserve valid local execution bindings;
checkout resolution only fills a missing binding. Existing-worktree references travel only relative to a
repository; a worktree outside that repository is represented as root intent.
A remote-only repository link has no local checkout. Configuration sync never
clones it. Provider instances referenced by model selections still need to be
configured and signed in on the owner.

Settings documents are the exception to the shared transaction: settings.json
is the store, so [SettingsSync](../../apps/server/src/sync/SettingsSync.ts)
reconciles the file with the documents after the fact. It keeps the last agreed
value per key, so a changed local value is an edit to publish and a changed
shared value is a peer edit to apply. Before the first agreement, a key still at
its default adopts the peer's value instead of publishing the default. Only
`UNIVERSAL_SERVER_SETTING_KEYS` and project overrides travel. Paths, provider
instances, resource limits, machine identity and credentials stay local by
omission. Adding a key to the universal list follows the rule for any new synced
field: an older machine keeps it unread until it updates. Project overrides are stored per local repository
because every resolver reads them that way. Their `project-settings`
document is keyed by the project folder ID, and every repository in that folder carries the same
entry.

Web integration documents carry only their HTTP definition and project scope.
[IntegrationSync](../../apps/server/src/sync/IntegrationSync.ts) publishes definition
edits in the local mutation transaction and materializes peer edits separately.
OAuth grants, clients, headers and credential approvals stay local: receiving a
peer definition must not authorize a credential or a command on this machine.
Local command runners never enter this channel. Destination changes discard
local grants and headers; cosmetic changes keep them. A colliding agent-facing
name gets a local alias, which is never published back.

Thread replication is separate and single-writer; see
[thread sync](./thread-sync.md). Agent conversations are created lazily only
on their owner. An agent's `ownerMachine` changes only when the current owner
authors it, after the agent's conversation has moved. Shared project IDs
identify one project; equal names with different IDs produce
possible-duplicate records rather than an automatic merge.

Delete projections must not launch work or append replicated thread events.
In particular, an incoming agent tombstone retires its schedules immediately
and leaves its run ledger until AgentService's normal stop/delete path drains
it. Deleting a local projection directly can fire SQLite cleanup triggers;
those are local read-model maintenance, never replicated orchestration events.
