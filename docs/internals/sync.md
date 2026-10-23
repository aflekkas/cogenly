# Shared state invariants

[SharedState](../../apps/server/src/sync/SharedState.ts) owns portable project,
agent and schedule configuration. Domain mutations record their field deltas in
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

Only the three declared document kinds cross these channels. The receiver
rejects unknown fields, malformed values, oversized multi-document batches, cursor
gaps, forged authorship and ownership changes.
V1 ownership is fixed after creation: transferring execution needs a separate
handoff protocol. Only the owner machine may change an existing agent's or
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

Thread replication is separate and must remain single-writer. Agent
conversations are created lazily only on their owner. Project chat IDs and
existing thread bindings remain local; do not start appending replica events
until Phase 3 establishes ownership for those existing fixed IDs. Shared
project IDs identify one project; equal names with different IDs produce
possible-duplicate records rather than an automatic merge.

Delete projections must not launch work or append replicated thread events.
In particular, an incoming agent tombstone retires its schedules immediately
and leaves its run ledger until AgentService's normal stop/delete path drains
it. Deleting a local projection directly can fire SQLite cleanup triggers;
those are local read-model maintenance, never replicated orchestration events.
