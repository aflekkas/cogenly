# Import from T3 Code

The importer ([`apps/server/src/t3Import/`](../../apps/server/src/t3Import/)) brings a local T3
Code install's projects and threads into a running Cogenly environment. The user guide is
[Importing from T3 Code](../user/importing-from-t3-code.md).

## Replay, never copy the database

T3 Code and Cogenly share migrations 1-62 and then diverge under the same migration ids. Never copy
T3's `statev2.sqlite` into Cogenly or open it as Cogenly state: Effect migrations are keyed by id, so
Cogenly would treat its own later migrations as applied and break.

Instead the importer opens T3's database read-only with `immutable=1`, decodes each thread event with
Cogenly's `OrchestrationV2DomainEvent` schema, and writes it through `EventSinkV2.write`, the path a
live command takes. Projections, search, and connected clients update normally, so Cogenly does not
need to restart. `immutable=1` takes no locks and ignores T3's WAL, which is why the import requires
T3 Code to be quit (`server-runtime.json`) and reports pending WAL bytes.

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
sessions and would create duplicate threads under different ids. `cogenly t3-import` runs the same
service offline against a home no server is using.
