# Import from T3 Code

The importer ([`apps/server/src/t3Import/`](../../apps/server/src/t3Import/)) brings a local T3
Code install's projects and threads into a running Cogenly environment. The user guide is
[Importing from T3 Code](../user/importing-from-t3-code.md).

## Replay, never copy the database

T3 Code and Cogenly share migrations 1-62 and then diverge under the same migration ids. Never copy
T3's `statev2.sqlite` into Cogenly or open it as Cogenly state: Effect migrations are keyed by id, so
Cogenly would treat its own later migrations as applied and break.

Instead the importer reads T3's database, decodes each thread event with Cogenly's
`OrchestrationV2DomainEvent` schema, and writes it through `EventSinkV2.write`, the path a live
command takes. Projections, search, and connected clients update normally, so Cogenly does not need
to restart.

## Reading a T3 that keeps running

T3 Code may stay open, so a scan reads a snapshot, not the live file
([`T3SourceDatabase.ts`](../../apps/server/src/t3Import/T3SourceDatabase.ts)):

- **Small backup steps inside one held read transaction.** The snapshot is SQLite's online backup
  from a read-only connection. Unaided, a multi-step backup restarts whenever another process writes
  the source, so against a busy T3 it may never finish. The source connection therefore opens a read
  transaction first; `sqlite3_backup_step` reuses an open one, so every step reads the same moment
  and T3's writes never restart it. Steps run on Node's thread pool with the event loop free between
  them, which is what keeps a 12 GB copy from stalling the server, and they report progress. T3
  keeps writing meanwhile (its WAL just can't checkpoint past the reader).
- **Never hold the event loop.** The T3 source is read through synchronous `node:sqlite`; a read
  over every thread at once stalled the server for seconds on a large database, long enough for
  every client's socket to miss its ping and drop. Per-thread reads are chunked with yields between
  chunks; keep new whole-database reads chunked the same way.
- **Never create files in T3's directory.** A WAL reader recreates `-wal`/`-shm` files next to a
  closed database, so the live file is opened as a WAL reader only while its `-wal` exists (T3
  running) and as `immutable=1` otherwise. Snapshots are always read `immutable=1`.
- **The scan's snapshot is the import's.** The service holds the snapshot from `scan` until the
  confirmed `run` ends, so the import writes exactly what the report showed. A new scan, the end of
  the run, or the service stopping deletes it. An unconfirmed scan keeps its copy until one of those,
  which costs disk space the size of T3's database.
- **Free space is checked first** (database plus WAL plus headroom) and a short disk fails the scan
  with `insufficient-space`, before anything is copied.

T3 changes after the snapshot simply aren't in it; the next run picks them up through the ledger
below.

Thread ids are kept, so subagent links, forks, context transfers, and attachment file names remain
valid. Project ids are remapped by normalized workspace root, because the same folder can already be
a Cogenly project under another id.

## Idempotency: ledger plus derived event ids

Two layers make re-runs safe; keep both.

- **Ledger** (migration 078, `t3_import_threads`, `t3_import_projects`). One row per imported thread
  records the last T3 sequence written. A re-run reads only newer events. A thread with events that
  did not come from the import was continued in Cogenly and is reported as diverged; its newer T3
  events are not applied, because appending them would interleave two histories.
- **Event ids** are `t3-import:v1:<T3 event id>`. A batch drops ids already stored, so an import
  interrupted between a write and its ledger update repeats nothing. The `t3-import:v1:` prefix also
  separates imported events from native ones when classifying a thread without a ledger row.

Changing the event id scheme re-imports every thread as new. Bump the version prefix only together
with a migration of existing ids.

## Command ids and reactor guards

Imported history replays runs finishing, pull requests syncing, and assistant messages arriving that
happened in T3 long ago. Every imported write carries a `command:t3-import:` command id
([`T3ImportCommandIds.ts`](../../apps/server/src/t3Import/T3ImportCommandIds.ts)), and everything
that reacts to new activity skips those events: queue promotion and the domain-event subscribers in
`Orchestrator.ts` (settlement, pull request sync, delegated questions, awareness),
`AgentEventReactor`, and the agent message stream in `AgentService`.

**A new subscriber that starts work, notifies, or wakes a thread from domain events must skip
`isT3ImportCommandId(stored.commandId)`.** Otherwise one import can start agents or send a
notification per imported thread.

## Runtime state is recorded as stopped

A T3 run that was running, a session that was ready, or a request that was pending would look like
work Cogenly must recover or continue. [`T3EventMapping.ts`](../../apps/server/src/t3Import/T3EventMapping.ts)
records such state as interrupted, stopped, or cancelled as it replays. Pull request links keep their
data but lose `watch`, so the importer never starts polling hosts. Later events in the same history
still move an entity to its real final state.

## Provider instances

Claude resumes by session id inside its config directory, so a thread only resumes if Cogenly has a
provider instance with T3's instance id and `homePath`. The importer always creates missing instances
(for example `claude-personal`) and reports a conflict when the id exists with a different home. It
never reads secrets, sign-ins, or provider environment variables.

## Shared folders

Imported threads keep their T3 worktree paths under `~/.t3/scratch` and `~/.t3/worktrees`. Cogenly
manages only its own worktree directories, so it never cleans these. Do not add `~/.t3` paths to
Cogenly's managed worktree settings.

## Entry points

The service is `T3ImportService`; RPCs are `t3Import.status`, `.scan`, `.run`, and `.cancel`. Settings
→ Import and the onboarding import step render the same flow (`useT3ImportFlow` and
`T3ImportFlowView` in `apps/web/src/components/settings/T3ImportSettings.tsx`). Onboarding offers
it instead of the agent-session import when T3 is found, because both read the same native
sessions and would create duplicate threads under different ids.

`cogenly setup` and `cogenly t3-import` drive the same job API
([`cli/setupBackend.ts`](../../apps/server/src/cli/setupBackend.ts)). When a server owns the home and
answers, they call its RPCs with a short-lived session minted from the home's secrets, scoped to
`SETUP_CLI_SCOPES` ([`cli/liveServer.ts`](../../apps/server/src/cli/liveServer.ts)), so the server
runs the job and authorizes it like any client. Otherwise they take server ownership of the home and
run the service in-process. A recorded server that doesn't answer still holds ownership, so the CLI
stops rather than write behind it; keep that order when adding CLI writers.
