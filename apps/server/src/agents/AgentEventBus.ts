import * as DateTime from "effect/DateTime";
import { canReceiveAgentEvent, matchesAgentEvent } from "./agentEventPolicy.ts";
import * as Store from "./AgentStore.ts";
import { AgentError, AgentEventContext, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Agents from "./AgentService.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(AgentEventContext));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEventContext));
const failure = (cause: unknown) =>
  new AgentError({ message: "Could not process agent event.", cause });
export class AgentEventBus extends Context.Service<
  AgentEventBus,
  {
    readonly emit: (event: AgentEventContext) => Effect.Effect<void, AgentError>;
    readonly drain: Effect.Effect<void, AgentError>;
    readonly lineage: (
      threadId: ThreadId,
    ) => Effect.Effect<Pick<AgentEventContext, "chainDepth" | "chainAgentIds">, AgentError>;
  }
>()("t3/agents/AgentEventBus") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* Agents.AgentService;
  const store = yield* Store.AgentStore;
  const schedules = yield* Schedules.ScheduledTaskService;
  const lock = yield* Semaphore.make(1);
  const emit: AgentEventBus["Service"]["emit"] = (event) =>
    Effect.gen(function* () {
      const payload = yield* encode(event);
      yield* sql`INSERT OR IGNORE INTO agent_events(event_key, payload_json, occurred_at) VALUES (${event.dedupKey}, ${payload}, ${event.occurredAt})`;
    }).pipe(Effect.mapError(failure));
  const lineage: AgentEventBus["Service"]["lineage"] = (threadId) =>
    Effect.gen(function* () {
      // Follow both direct Work handoffs and approval/governed Work launches. A
      // provider run id and an agent work reservation id are different identities.
      const rows = yield* sql<{ context_json: string }>`WITH RECURSIVE ancestry(thread_id) AS (
      SELECT ${threadId}
      UNION
      SELECT COALESCE(r.thread_id, w.work_thread_id, json_extract(t.payload_json, '$.sourceThreadId'))
      FROM ancestry a
      LEFT JOIN agent_run_threads g ON g.thread_id = a.thread_id
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = a.thread_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = COALESCE(g.source_run_id, json_extract(t.payload_json, '$.sourceAgentRunId'))
      LEFT JOIN agent_work_runs w ON w.run_id = COALESCE(g.source_run_id, json_extract(t.payload_json, '$.sourceAgentRunId'))
      WHERE COALESCE(r.thread_id, w.work_thread_id, json_extract(t.payload_json, '$.sourceThreadId')) IS NOT NULL
    ) SELECT d.context_json FROM agent_event_deliveries d JOIN ancestry a ON a.thread_id = d.work_thread_id`;
      const contexts = yield* Effect.forEach(rows, (r) => decode(r.context_json));
      return {
        chainDepth: Math.max(0, ...contexts.map((c) => c.chainDepth)),
        chainAgentIds: [...new Set(contexts.flatMap((c) => c.chainAgentIds))],
      };
    }).pipe(Effect.mapError(failure));
  const drain = Effect.gen(function* () {
    yield* agents.reconcile();
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM agent_events WHERE dispatched = 0 ORDER BY attempted_at, occurred_at, event_key LIMIT 500`;
    for (const row of rows) {
      const event = yield* decode(row.payload_json);
      const { tasks } = yield* schedules.list();
      let deferred = false;
      for (const task of tasks) {
        if (!matchesAgentEvent(task, event) || task.agentId == null) continue;
        const accepted = yield* schedules.triggerEvent(task.id, event);
        if (!accepted && canReceiveAgentEvent(yield* store.get(task.agentId), task, event)) {
          const prior =
            yield* sql`SELECT 1 FROM agent_event_deliveries WHERE agent_id = ${task.agentId} AND event_key = ${event.dedupKey}`;
          // Busy agents, caps and backoff defer durable events until a future tick.
          if (prior.length === 0) deferred = true;
        }
      }
      yield* sql`UPDATE agent_events SET dispatched = ${deferred ? 0 : 1}, attempted_at = ${DateTime.formatIso(yield* DateTime.now)} WHERE event_key = ${event.dedupKey}`;
    }
  }).pipe(lock.withPermits(1), Effect.mapError(failure));
  return AgentEventBus.of({ emit, drain, lineage });
});
export const layer = Layer.effect(AgentEventBus, make);
