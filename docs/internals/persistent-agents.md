# Persistent agent conversations

An agent owns one application conversation and any number of scheduled-task triggers.
Provider sessions and background work threads are execution details. The conversation's
application thread ID survives native session rotation. The contracts are in
[`agent.ts`](../../packages/contracts/src/agent.ts); `agents.*` WebSocket RPCs and the
existing `scheduledTasks.*` RPCs are the client surface. Set a trigger's `agentId` to
attach it. Thread shells expose `agent: { id, role }`; clients show `role: "work"`
as ordinary Work sessions with agent provenance. They are also reachable from
`agents.runs` or a conversation message's `senderThreadId`. Migrated conversations retain their old ID
and may lack the shell annotation; agent records are authoritative.

The scheduler's success means dispatch succeeded, as before. Actual provider completion
lives in `agent_work_runs`. Its reconciler reads durable provider run state, so shutdown
or losing a live subscription does not lose a result. Postbacks commit assistant messages
and timeline items with a stable command receipt and **no effects**. Never replace this
with `message.dispatch`: that would wake the agent in response to its own message.
Approval notices use separate receipts while the job remains active. Deletion disables
triggers before stopping owned threads, then removes identity, triggers and memory;
thread history remains available.

Memory tools never accept an agent ID. The MCP invocation credential's thread resolves
to either an agent conversation or one of its work records. Outside MCP clients and
unrelated threads cannot select another identity. Owner RPCs accept explicit IDs and
use the environment's normal read/operate grants. All small memory is injected at
provider turn start; beyond 16,000 characters it uses recent full facts plus an extractive
summary of older notes. Full notes stay available through `memory_read` and owner RPCs.
This bounds prompt size, rather than deleting durable facts.

After forty conversation runs since the last full handoff, startup opens a fresh native
session through the existing resume-fallback and `full_thread_summary` delivery path.
It carries the last twenty conversational items and a persisted, bounded extractive
summary of older texts. Memory and standing instructions are injected into that session
as on every turn. The complete application transcript remains an audit history; rotating
native sessions bounds provider context, not database retention. Summaries use bounded
text extracts, without spending extra provider turns, and can lose nuance from long
messages. Facts that must survive should be remembered explicitly.

Autonomous job reservations are transactional, limited to one active job per agent,
and capped per UTC day. Owner conversation turns remain available while an agent is
paused. Failure backoff starts at one minute, doubles up to one hour, and disables
an agent after five consecutive failures with a conversation notice. Enabling it again
resets its failure state. Fixed-time triggers attached to an agent catch up once, then
advance from the current time; there is no backlog replay. All scheduling runs while
the server is up, including headless `apps/server` deployments. A VPS still needs a
process supervisor, persistent database/secrets/workspaces, provider credentials and
CLI dependencies, an explicit timezone for fixed-time schedules, backups, and secured
remote access. There is no multi-server scheduler lease: run one writer per home.
