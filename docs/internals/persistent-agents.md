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
use the environment's normal read/operate grants. Memory aliases now read and mutate
the shared facts store; agent-authored notes are
proposals until the owner confirms them. Turn startup retrieves confirmed facts,
open commitments, recent owned messages and observable Work outcomes, bounded to
16,000 characters for agents and 4,000 for tagged ordinary chats. Agents read
labeled facts in every project; their own notes stay private to them.
Ordinary chats require confirmed tags and can opt out through `context.setEnabled`.
Selected references are persisted per provider run for inspection without copying
source bodies into the audit record.

After forty conversation runs since the last full handoff, startup opens a fresh native
session through the existing resume-fallback and `full_thread_summary` delivery path.
It carries the last twenty conversational items and a persisted, bounded extractive
summary of older texts. Memory and standing instructions are injected into that session
as on every turn. The complete application transcript remains an audit history; rotating
native sessions bounds provider context, not database retention. Summaries use bounded
text extracts, without spending extra provider turns, and can lose nuance from long
messages. Facts that must survive should be remembered explicitly.

Autonomous job reservations are transactional, limited to one active job per agent,
and capped per UTC day. Agents cannot be paused: failure backoff starts at one minute and
doubles up to one hour, but never disables an agent, since nothing could turn it back on.
An agent may also carry an ordered `fallbackChain` of provider instance + model pairs
after its primary `modelSelection`. When a background run's normalized provider failure
classifies as `usage_limit` or as a sign-in problem (`providerFallback.ts` reuses the
adapters' `OrchestrationV2ProviderFailure` classification; Muse only exposes sign-in
failures in message text), the reconciler advances the stored chain index instead of only
backing off: the next run uses the next entry, recorded on its `agent_work_runs` row with
the reason and any reported reset time. The primary entry returns at the reported reset,
or one hour after the failure when no reset is known. Other failures keep the backoff
above, and an agent with no chain behaves exactly as before.
Migration 072 re-enabled agents paused before this. The `agents.enabled` column now only
fences reservations while deletion stops active work. Owner conversation turns bypass
backoff and caps. Fixed-time triggers attached to an agent catch up once, then
advance from the current time; there is no backlog replay. All scheduling runs while
the server is up, including headless `apps/server` deployments. A VPS still needs a
process supervisor, persistent database/secrets/workspaces, provider credentials and
CLI dependencies, an explicit timezone for fixed-time schedules, backups, and secured
remote access. There is no multi-server scheduler lease: run one writer per home.

[`AgentAccessScope`](../../apps/server/src/agents/AgentAccessScope.ts) resolves access for
every surface. Agents have no per-project grants or autonomy level: with agent-level read
permission they read every live repository and every project label, draft adds proposals
in all of them, and execute lets them start Work in any repository without asking.
Without execute, Work becomes an owner approval for that one reviewed target. New agents
default to read, draft and execute; the high-impact grants stay off. Migration 073 dropped
the stored `scope` and `autonomy`. Trigger and permission changes still require an owner
approval. Agents add projects through the ordinary `project_create` and
`project_clone` tools, which need the execute grant.
Persistent agents start tracked Work through `start_agent_work` or `work_start`; untracked child launches,
forks and self-approval/configuration are explicitly refused so they cannot shed policy.
The authenticated MCP boundary applies policy before all toolkits; generic shell,
browser and device writes need every sensitive grant because their effects cannot be
bounded by an execute grant. Native provider tool approval remains the provider's runtime
boundary. Activity reads persisted provider runs and action records, never model claims.

Event triggers use the same scheduled-task identity and owner approval as timed triggers.
Their reactor advances a durable event cursor only in the transaction that records its
observations. Dispatch reserves the agent and the per-agent event key together before
launching Work; replay must never mint a second launch after a crash. Busy agents, caps
and backoff defer the persisted event. Causal depth follows governed Work and approval
ancestry, including agent-created commitments, and stops after two event invocations.

Event filters may only name live repositories and existing labels; the server rejects
invalid filters with `ScheduledTaskError.code = event_filter_out_of_scope`. Delivery
rechecks that the repository still exists. Labels on the source thread only affect
relevance filters. Repository-less
commitment events require an owned commitment or at least one readable label. Event triggers cannot use **Run now**:
they require a real source event (`event_run_now_unsupported`), so a manual invocation
cannot masquerade as an observed event in activity.
