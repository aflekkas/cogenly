import {
  Agent,
  AgentPermissions,
  AgentScope,
  AgentError,
  AgentId,
  AgentMemoryNote,
  AgentListItem,
  type AgentMarkReadInput,
  AgentWorkRun,
  ThreadId,
  type AgentMemoryWriteInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { conversationCarryOver, memoryContext } from "./context.ts";

interface Row {
  payload_json: string;
  consecutive_failures: number;
  backoff_until: string | null;
  pause_reason: string | null;
  enabled: number;
  daily_run_cap: number;
  unread_count: number;
  latest_message_json?: string | null;
}
const decode = Schema.decodeUnknownEffect(AgentListItem);
const decodeNote = Schema.decodeUnknownEffect(AgentMemoryNote);
const decodeRun = Schema.decodeUnknownEffect(AgentWorkRun);
const decodeJsonRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodePermissions = Schema.encodeEffect(Schema.fromJsonString(AgentPermissions));
const encodeScope = Schema.encodeEffect(Schema.fromJsonString(AgentScope));
const decodeLatestMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AgentListItem.fields.latestMessage),
);
const encodeAgent = Schema.encodeSync(Schema.fromJsonString(Agent));
const storeError = (cause: unknown) =>
  new AgentError({ message: "Could not access agent data.", cause });
export class AgentStore extends Context.Service<
  AgentStore,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<AgentListItem>, AgentError>;
    readonly get: (id: AgentId) => Effect.Effect<AgentListItem, AgentError>;
    readonly forThread: (id: ThreadId) => Effect.Effect<Agent | null, AgentError>;
    readonly save: (agent: Agent) => Effect.Effect<Agent, AgentError>;
    readonly delete: (id: AgentId) => Effect.Effect<boolean, AgentError>;
    readonly markRead: (input: AgentMarkReadInput) => Effect.Effect<AgentListItem, AgentError>;
    readonly memory: (id: AgentId) => Effect.Effect<ReadonlyArray<AgentMemoryNote>, AgentError>;
    readonly remember: (input: AgentMemoryWriteInput) => Effect.Effect<AgentMemoryNote, AgentError>;
    readonly forget: (agentId: AgentId, id: string) => Effect.Effect<boolean, AgentError>;
    readonly context: (threadId: ThreadId) => Effect.Effect<string, AgentError>;
    readonly carryOver: (
      agentId: AgentId,
      ordinal: number,
      messages: ReadonlyArray<{ role: string; text: string }>,
    ) => Effect.Effect<void, AgentError>;
    /** Reserve background work only; owner messages never consume this allowance. */
    readonly reserve: (id: AgentId) => Effect.Effect<boolean, AgentError>;
    readonly outcome: (id: AgentId, succeeded: boolean) => Effect.Effect<Agent, AgentError>;
    readonly createRun: (run: AgentWorkRun) => Effect.Effect<void, AgentError>;
    readonly runs: (id?: AgentId) => Effect.Effect<ReadonlyArray<AgentWorkRun>, AgentError>;
    readonly finishRun: (
      id: string,
      status: "completed" | "failed",
      summary: string,
    ) => Effect.Effect<void, AgentError>;
    readonly markRunning: (id: string) => Effect.Effect<void, AgentError>;
    readonly markPosted: (id: string) => Effect.Effect<void, AgentError>;
  }
>()("t3/agents/AgentStore") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fromRow = (row: Row) =>
    Effect.all([
      decodeJsonRecord(row.payload_json),
      decodeLatestMessage(row.latest_message_json ?? "null"),
    ]).pipe(
      Effect.flatMap(([data, latestMessage]) =>
        decode({
          // Legacy agents created by the idempotent 063 importer after startup
          // use the same migration mapping; ordinary saves always carry policy.
          responsibility: "",
          scope: [],
          autonomy: "autonomous_within_policy",
          permissions: {
            read: true,
            draft: true,
            execute: true,
            send: true,
            create_pr: true,
            merge: true,
            deploy: true,
            delete: true,
          },
          notifyPolicy: "all",
          ...data,
          paused: row.enabled !== 1,
          unreadCount: row.unread_count ?? 0,
          latestMessage,
          consecutiveFailures: row.consecutive_failures,
          backoffUntil: row.backoff_until,
          pauseReason: row.pause_reason,
          enabled: row.enabled === 1,
          dailyRunCap: row.daily_run_cap,
        }),
      ),
      Effect.mapError(storeError),
    );
  const get = (id: AgentId) =>
    sql<Row>`SELECT a.*, (SELECT json_object('id', m.message_id, 'role', m.role, 'text', substr(json_extract(m.payload_json, '$.text'), 1, 240), 'createdAt', m.created_at, 'updatedAt', m.updated_at) FROM orchestration_v2_projection_messages m WHERE m.thread_id = a.conversation_thread_id AND m.role IN ('user', 'assistant') AND m.streaming = 0 AND trim(json_extract(m.payload_json, '$.text')) <> '' ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS latest_message_json, (SELECT COUNT(*) FROM orchestration_v2_projection_messages m WHERE m.thread_id = a.conversation_thread_id AND m.role = 'assistant' AND m.streaming = 0 AND trim(json_extract(m.payload_json, '$.text')) <> '' AND (m.updated_at, m.message_id) > (a.last_read_at, a.last_read_message_id)) AS unread_count FROM agents a WHERE a.agent_id = ${id}`.pipe(
      Effect.mapError(storeError),
      Effect.flatMap((rows) =>
        rows[0] ? fromRow(rows[0]) : Effect.fail(new AgentError({ message: "Agent not found." })),
      ),
    );
  const list = () =>
    sql<Row>`SELECT a.*, (SELECT json_object('id', m.message_id, 'role', m.role, 'text', substr(json_extract(m.payload_json, '$.text'), 1, 240), 'createdAt', m.created_at, 'updatedAt', m.updated_at) FROM orchestration_v2_projection_messages m WHERE m.thread_id = a.conversation_thread_id AND m.role IN ('user', 'assistant') AND m.streaming = 0 AND trim(json_extract(m.payload_json, '$.text')) <> '' ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS latest_message_json, (SELECT COUNT(*) FROM orchestration_v2_projection_messages m WHERE m.thread_id = a.conversation_thread_id AND m.role = 'assistant' AND m.streaming = 0 AND trim(json_extract(m.payload_json, '$.text')) <> '' AND (m.updated_at, m.message_id) > (a.last_read_at, a.last_read_message_id)) AS unread_count FROM agents a ORDER BY a.agent_id`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
      Effect.mapError(storeError),
    );
  const forThread = (id: ThreadId) =>
    sql<Row>`SELECT a.* FROM agents a WHERE a.conversation_thread_id = ${id} OR EXISTS (SELECT 1 FROM agent_work_runs r WHERE r.agent_id = a.agent_id AND r.work_thread_id = ${id}) OR EXISTS (SELECT 1 FROM agent_run_threads r WHERE r.agent_id = a.agent_id AND r.thread_id = ${id}) LIMIT 1`.pipe(
      Effect.flatMap((rows) => (rows[0] ? fromRow(rows[0]) : Effect.succeed(null))),
      Effect.mapError(storeError),
    );
  const memory = (id: AgentId) =>
    get(id).pipe(
      Effect.andThen(
        sql`SELECT note_id AS id, agent_id AS agentId, text, source, created_at AS createdAt, updated_at AS updatedAt FROM agent_memory WHERE agent_id = ${id} ORDER BY updated_at DESC, note_id`,
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeNote(row))),
      Effect.mapError(storeError),
    );
  const remember = (input: AgentMemoryWriteInput) =>
    Effect.gen(function* () {
      yield* get(input.agentId);
      const at = yield* now;
      const id = input.id ?? `memory:${yield* crypto.randomUUIDv4()}`;
      yield* sql`INSERT INTO agent_memory(note_id, agent_id, text, source, created_at, updated_at) VALUES (${id}, ${input.agentId}, ${input.text}, ${input.source ?? "owner"}, ${at}, ${at}) ON CONFLICT(agent_id, note_id) DO UPDATE SET text = excluded.text, source = excluded.source, updated_at = excluded.updated_at`;
      const notes = yield* memory(input.agentId);
      return notes.find((n) => n.id === id)!;
    }).pipe(Effect.mapError(storeError));
  const runs = (id?: AgentId) =>
    (id === undefined
      ? sql`SELECT * FROM agent_work_runs WHERE posted = 0 ORDER BY created_at`
      : sql`SELECT * FROM agent_work_runs WHERE agent_id = ${id} ORDER BY created_at DESC LIMIT 100`
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (r) =>
          decodeRun({
            id: r.run_id,
            agentId: r.agent_id,
            triggerId: r.trigger_id,
            workThreadId: r.work_thread_id,
            status: r.status,
            createdAt: r.created_at,
            completedAt: r.completed_at,
            summary: r.summary,
            posted: r.posted === 1,
          }),
        ),
      ),
      Effect.mapError(storeError),
    );
  return AgentStore.of({
    get,
    list,
    forThread,
    memory,
    remember,
    runs,
    markRead: (input) =>
      Effect.gen(function* () {
        const agent = yield* get(input.agentId);
        const rows = yield* sql<{
          updated_at: string;
          message_id: string;
        }>`SELECT updated_at, message_id FROM orchestration_v2_projection_messages WHERE thread_id = ${agent.conversationThreadId} AND message_id = ${input.lastReadMessageId} AND role = 'assistant' AND streaming = 0 AND trim(json_extract(payload_json, '$.text')) <> ''`;
        const message = rows[0];
        if (!message)
          return yield* new AgentError({
            message: "Read message not found in this agent's conversation.",
          });
        // Server-resolved timestamps prevent future cursors. Tuple ordering keeps
        // simultaneous messages distinct, and stale devices can never move it back.
        yield* sql`UPDATE agents SET last_read_at = ${message.updated_at}, last_read_message_id = ${message.message_id} WHERE agent_id = ${agent.id} AND (last_read_at, last_read_message_id) < (${message.updated_at}, ${message.message_id})`;
        return yield* get(agent.id);
      }).pipe(Effect.mapError(storeError)),
    save: (agent) =>
      sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${agent.id}, ${agent.conversationThreadId}, ${encodeAgent(agent)}, ${agent.enabled ? 1 : 0}, ${agent.dailyRunCap}) ON CONFLICT(agent_id) DO UPDATE SET payload_json = excluded.payload_json, enabled = excluded.enabled, daily_run_cap = excluded.daily_run_cap, pause_reason = CASE WHEN excluded.enabled = 1 THEN NULL ELSE agents.pause_reason END, consecutive_failures = CASE WHEN excluded.enabled = 1 AND agents.enabled = 0 THEN 0 ELSE agents.consecutive_failures END, backoff_until = CASE WHEN excluded.enabled = 1 AND agents.enabled = 0 THEN NULL ELSE agents.backoff_until END`.pipe(
        Effect.andThen(get(agent.id)),
        Effect.mapError(storeError),
      ),
    delete: (id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id IN (SELECT task_id FROM scheduled_tasks WHERE agent_id = ${id})`;
            yield* sql`DELETE FROM scheduled_tasks WHERE agent_id = ${id}`;
            yield* sql`DELETE FROM agent_conversation_context WHERE agent_id = ${id}`;
            yield* sql`DELETE FROM agent_memory WHERE agent_id = ${id}`;
            yield* sql`DELETE FROM agent_work_runs WHERE agent_id = ${id}`;
            const rows = yield* sql`DELETE FROM agents WHERE agent_id = ${id} RETURNING agent_id`;
            return rows.length > 0;
          }),
        )
        .pipe(Effect.mapError(storeError)),
    forget: (agentId, id) =>
      sql`DELETE FROM agent_memory WHERE agent_id = ${agentId} AND note_id = ${id} RETURNING note_id`.pipe(
        Effect.map((r) => r.length > 0),
        Effect.mapError(storeError),
      ),
    context: (threadId) =>
      Effect.gen(function* () {
        const agent = yield* forThread(threadId);
        if (agent === null) return "";
        const notes = yield* memory(agent.id);
        const context = yield* sql<{
          summary: string;
        }>`SELECT summary FROM agent_conversation_context WHERE agent_id = ${agent.id}`.pipe(
          Effect.mapError(storeError),
        );
        return `You are ${agent.name}, the owner's persistent agent.\nResponsibility:\n${agent.responsibility}\nAutonomy: ${agent.autonomy}. Permissions: ${yield* encodePermissions(agent.permissions).pipe(Effect.mapError(storeError))}. Scope grants: ${yield* encodeScope(agent.scope).pipe(Effect.mapError(storeError))}.\nStanding instructions:\n${agent.instructions}\n\nAgent memory:\n${memoryContext(notes)}\nEarlier conversation summary:\n${context[0]?.summary ?? ""}\nUse memory_read, memory_remember and memory_forget to maintain durable facts. Use list_open_items for shared commitments, propose_commitment for extracted obligations, and update_commitment_status with evidence. Use request_agent_approval for new triggers or permission changes; you can never approve your own requests. Use start_agent_work to start or propose repository Work. Send concise messages to the owner.`;
      }),
    carryOver: (agentId, ordinal, messages) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          summary: string;
          covered_run_ordinal: number;
        }>`SELECT * FROM agent_conversation_context WHERE agent_id = ${agentId}`;
        if ((rows[0]?.covered_run_ordinal ?? 0) >= ordinal) return;
        const { summary } = conversationCarryOver(rows[0]?.summary ?? "", messages);
        yield* sql`INSERT INTO agent_conversation_context(agent_id, summary, covered_run_ordinal) VALUES (${agentId}, ${summary}, ${ordinal}) ON CONFLICT(agent_id) DO UPDATE SET summary = excluded.summary, covered_run_ordinal = excluded.covered_run_ordinal`;
      }).pipe(Effect.mapError(storeError)),
    reserve: (id) =>
      Effect.gen(function* () {
        const at = yield* now;
        const day = at.slice(0, 10);
        const rows =
          yield* sql`UPDATE agents SET run_day = ${day}, daily_runs = CASE WHEN run_day = ${day} THEN daily_runs + 1 ELSE 1 END WHERE agent_id = ${id} AND enabled = 1 AND (backoff_until IS NULL OR backoff_until <= ${at}) AND (run_day IS NULL OR run_day <> ${day} OR daily_runs < daily_run_cap) AND NOT EXISTS (SELECT 1 FROM agent_work_runs WHERE agent_id = ${id} AND status IN ('starting', 'running')) RETURNING agent_id`;
        return rows.length > 0;
      }).pipe(Effect.mapError(storeError)),
    outcome: (id, succeeded) =>
      Effect.gen(function* () {
        const agent = yield* get(id);
        const failures = succeeded ? 0 : agent.consecutiveFailures + 1;
        const at = yield* DateTime.now;
        const until = succeeded
          ? null
          : DateTime.formatIso(
              DateTime.add(at, { seconds: Math.min(3600, 60 * 2 ** (failures - 1)) }),
            );
        yield* sql`UPDATE agents SET payload_json = json_set(payload_json, '$.updatedAt', ${DateTime.formatIso(at)}), consecutive_failures = ${failures}, backoff_until = ${until}, enabled = CASE WHEN ${failures} >= 5 THEN 0 ELSE enabled END, pause_reason = CASE WHEN ${failures} >= 5 THEN 'Paused after five consecutive failures. Enable this agent to retry.' ELSE NULL END WHERE agent_id = ${id}`;
        return yield* get(id);
      }).pipe(Effect.mapError(storeError)),
    createRun: (run) =>
      sql`INSERT INTO agent_work_runs(run_id, agent_id, trigger_id, work_thread_id, status, created_at) VALUES (${run.id}, ${run.agentId}, ${run.triggerId}, ${run.workThreadId}, ${run.status}, ${run.createdAt})`.pipe(
        Effect.asVoid,
        Effect.mapError(storeError),
      ),
    finishRun: (id, status, summary) =>
      now.pipe(
        Effect.flatMap(
          (at) =>
            sql`UPDATE agent_work_runs SET status = ${status}, completed_at = ${at}, summary = ${summary} WHERE run_id = ${id}`,
        ),
        Effect.asVoid,
        Effect.mapError(storeError),
      ),
    markRunning: (id) =>
      sql`UPDATE agent_work_runs SET status = 'running' WHERE run_id = ${id} AND status = 'starting'`.pipe(
        Effect.asVoid,
        Effect.mapError(storeError),
      ),
    markPosted: (id) =>
      sql`UPDATE agent_work_runs SET posted = 1 WHERE run_id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(storeError),
      ),
  });
});
export const layer = Layer.effect(AgentStore, make);
