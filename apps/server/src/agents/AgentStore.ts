import { factDocumentId } from "../sync/documentSchemas.ts";
import * as SharedState from "../sync/SharedState.ts";
import { decodeAgentRow } from "./agentRecord.ts";
import {
  Agent,
  AgentPermissions,
  AgentError,
  AgentId,
  type AgentFallbackReason,
  ModelSelection as ModelSelectionSchema,
  FactId,
  type RunId,
  type ContextPrincipal,
  AgentMemoryNote,
  AgentCoreMemory,
  AgentListItem,
  type AgentMarkReadInput,
  AgentWorkRun,
  AgentEventContext,
  ThreadId,
  type AgentMemoryWriteInput,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Facts from "../context/FactService.ts";
import * as Retrieval from "../context/ContextRetrievalService.ts";
import { builderSystemPrompt } from "./builderPrompt.ts";

interface Row {
  payload_json: string;
  owner_machine?: string | null;
  consecutive_failures: number;
  backoff_until: string | null;
  daily_run_cap: number;
  project_folder_id?: string | null;
  unread_count: number;
  latest_message_json?: string | null;
}
const decode = Schema.decodeUnknownEffect(AgentListItem);
const decodeNote = Schema.decodeUnknownEffect(AgentMemoryNote);
const decodeEventContext = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEventContext));
const encodeEventContext = Schema.encodeSync(Schema.fromJsonString(AgentEventContext));
const decodeRun = Schema.decodeUnknownEffect(AgentWorkRun);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ModelSelectionSchema),
);
const decodeCoreMemory = Schema.decodeEffect(AgentCoreMemory);
const decodeSelectionJson = (json: string | null) =>
  json == null
    ? Effect.succeed(undefined)
    : decodeModelSelectionJson(json).pipe(Effect.catch(() => Effect.succeed(undefined)));
const encodePermissions = Schema.encodeEffect(Schema.fromJsonString(AgentPermissions));
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
    /** Deletion only: blocks new background reservations while active work is stopped. */
    readonly retire: (id: AgentId) => Effect.Effect<void, AgentError>;
    readonly markRead: (input: AgentMarkReadInput) => Effect.Effect<AgentListItem, AgentError>;
    readonly memory: (id: AgentId) => Effect.Effect<ReadonlyArray<AgentMemoryNote>, AgentError>;
    readonly remember: (
      input: AgentMemoryWriteInput,
      principal?: ContextPrincipal,
    ) => Effect.Effect<AgentMemoryNote, AgentError>;
    readonly forget: (
      agentId: AgentId,
      id: string,
      principal?: ContextPrincipal,
    ) => Effect.Effect<boolean, AgentError>;
    readonly context: (threadId: ThreadId, runId?: RunId) => Effect.Effect<string, AgentError>;
    readonly updateCoreMemory: (
      id: AgentId,
      text: string,
    ) => Effect.Effect<{ text: string }, AgentError>;
    /** Reserve background work only; owner messages never consume this allowance. */
    readonly reserve: (id: AgentId) => Effect.Effect<boolean, AgentError>;
    readonly outcome: (id: AgentId, succeeded: boolean) => Effect.Effect<Agent, AgentError>;
    /** Persist where the fallback chain currently points; index 0 clears it. */
    readonly setFallback: (
      id: AgentId,
      state: {
        readonly index: number;
        readonly reason: AgentFallbackReason | null;
        readonly until: string | null;
      },
    ) => Effect.Effect<void, AgentError>;
    readonly createRun: (run: AgentWorkRun) => Effect.Effect<void, AgentError>;
    readonly runs: (id?: AgentId) => Effect.Effect<ReadonlyArray<AgentWorkRun>, AgentError>;
    readonly finishRun: (
      id: string,
      status: "completed" | "failed",
      summary: string,
      fallback?: {
        readonly reason: AgentFallbackReason;
        readonly resetAt: string | null;
      },
    ) => Effect.Effect<void, AgentError>;
    readonly markRunning: (id: string) => Effect.Effect<void, AgentError>;
    readonly markPosted: (id: string) => Effect.Effect<void, AgentError>;
  }
>()("cogenly-server/agents/AgentStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const shared = yield* SharedState.SharedState;
  const facts = yield* Facts.FactService;
  const retrieval = yield* Retrieval.ContextRetrievalService;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fromRow = (row: Row) =>
    Effect.all([decodeAgentRow(row), decodeLatestMessage(row.latest_message_json ?? "null")]).pipe(
      Effect.flatMap(([data, latestMessage]) =>
        decode({
          ...data,
          unreadCount: row.unread_count ?? 0,
          latestMessage,
        }),
      ),
      Effect.mapError(storeError),
    );
  const get = (id: AgentId) =>
    sql<Row>`SELECT a.*, (SELECT f.folder_id FROM effective_thread_project_folders f WHERE f.thread_id = a.conversation_thread_id) AS project_folder_id, (SELECT json_object('id', m.message_id, 'role', m.role, 'text', substr(json_extract(m.payload_json, '$.text'), 1, 240), 'createdAt', m.created_at, 'updatedAt', m.updated_at) FROM orchestration_v2_projection_messages m WHERE m.thread_id = a.conversation_thread_id AND m.role IN ('user', 'assistant') AND m.message_id NOT LIKE 'agent-kickoff:%' AND m.message_id NOT LIKE 'agent-fallback:%' AND m.streaming = 0 AND trim(json_extract(m.payload_json, '$.text')) <> '' ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS latest_message_json, (SELECT COUNT(*) FROM orchestration_v2_projection_messages m WHERE m.thread_id = a.conversation_thread_id AND m.role = 'assistant' AND m.streaming = 0 AND trim(json_extract(m.payload_json, '$.text')) <> '' AND (m.updated_at, m.message_id) > (a.last_read_at, a.last_read_message_id)) AS unread_count FROM agents a WHERE a.agent_id = ${id}`.pipe(
      Effect.mapError(storeError),
      Effect.flatMap((rows) =>
        rows[0] ? fromRow(rows[0]) : Effect.fail(new AgentError({ message: "Agent not found." })),
      ),
    );
  const list = () =>
    sql<Row>`SELECT a.*, (SELECT f.folder_id FROM effective_thread_project_folders f WHERE f.thread_id = a.conversation_thread_id) AS project_folder_id, (SELECT json_object('id', m.message_id, 'role', m.role, 'text', substr(json_extract(m.payload_json, '$.text'), 1, 240), 'createdAt', m.created_at, 'updatedAt', m.updated_at) FROM orchestration_v2_projection_messages m WHERE m.thread_id = a.conversation_thread_id AND m.role IN ('user', 'assistant') AND m.message_id NOT LIKE 'agent-kickoff:%' AND m.message_id NOT LIKE 'agent-fallback:%' AND m.streaming = 0 AND trim(json_extract(m.payload_json, '$.text')) <> '' ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) AS latest_message_json, (SELECT COUNT(*) FROM orchestration_v2_projection_messages m WHERE m.thread_id = a.conversation_thread_id AND m.role = 'assistant' AND m.streaming = 0 AND trim(json_extract(m.payload_json, '$.text')) <> '' AND (m.updated_at, m.message_id) > (a.last_read_at, a.last_read_message_id)) AS unread_count FROM agents a ORDER BY a.agent_id`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, fromRow)),
      Effect.mapError(storeError),
    );
  const forThread = (id: ThreadId) =>
    sql<Row>`SELECT a.*, (SELECT f.folder_id FROM effective_thread_project_folders f WHERE f.thread_id = a.conversation_thread_id) AS project_folder_id FROM agents a WHERE a.conversation_thread_id = ${id} OR EXISTS (SELECT 1 FROM agent_work_runs r WHERE r.agent_id = a.agent_id AND r.work_thread_id = ${id}) OR EXISTS (SELECT 1 FROM agent_run_threads r WHERE r.agent_id = a.agent_id AND r.thread_id = ${id}) LIMIT 1`.pipe(
      Effect.flatMap((rows) => (rows[0] ? fromRow(rows[0]) : Effect.succeed(null))),
      Effect.mapError(storeError),
    );
  const memory = (id: AgentId) =>
    get(id).pipe(
      Effect.andThen(
        // Newest by creation time, not rowid: a synced fact's rowid is its arrival order here.
        sql`SELECT COALESCE(f.legacy_note_id,f.id) AS id,f.agent_id AS agentId,json_extract(f.payload_json,'$.text') AS text,COALESCE(f.legacy_source,CASE WHEN json_extract(f.payload_json,'$.createdBy')='user' THEN 'owner' ELSE json_extract(f.payload_json,'$.createdBy') END) AS source,json_extract(f.payload_json,'$.createdAt') AS createdAt,f.updated_at AS updatedAt FROM facts f WHERE f.agent_id=${id} AND f.status IN ('proposed','confirmed') AND NOT EXISTS (SELECT 1 FROM facts newer WHERE newer.agent_id=f.agent_id AND COALESCE(newer.legacy_note_id,newer.id)=COALESCE(f.legacy_note_id,f.id) AND newer.status IN ('proposed','confirmed') AND (json_extract(newer.payload_json,'$.createdAt'),newer.rowid)>(json_extract(f.payload_json,'$.createdAt'),f.rowid)) ORDER BY f.updated_at DESC,f.id`,
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeNote(row))),
      Effect.mapError(storeError),
    );
  const remember = (input: AgentMemoryWriteInput, principal: ContextPrincipal = "user") =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* get(input.agentId);
          // An agent reads every project, so its own notes carry no project labels.
          const replacement = {
            subject: "Agent memory",
            text: input.text,
            agentId: input.agentId,
            labelIds: [],
            visibility: "user" as const,
            sourceRefs: input.source?.startsWith("thread:")
              ? [{ kind: "thread" as const, id: input.source.slice(7) }]
              : [],
          };
          const existing =
            input.id === undefined
              ? []
              : yield* sql<{
                  id: string;
                }>`SELECT id FROM facts WHERE agent_id=${input.agentId} AND (legacy_note_id=${input.id} OR id=${input.id}) AND status IN ('proposed','confirmed') ORDER BY json_extract(payload_json,'$.createdAt') DESC,rowid DESC LIMIT 1`;
          const { fact } = existing[0]
            ? yield* facts.supersede({ id: FactId.make(existing[0].id), replacement }, principal)
            : yield* facts.create(replacement, principal);
          const noteId = input.id ?? fact.id;
          yield* sql`UPDATE facts SET legacy_note_id=${noteId},legacy_source=${input.source ?? "owner"} WHERE id=${fact.id}`;
          yield* shared.capture("fact", factDocumentId(fact.id));
          const notes = yield* memory(input.agentId);
          // A note identical to one this agent already has answers as that note.
          const kept = yield* sql<{
            id: string;
          }>`SELECT COALESCE(w.legacy_note_id,w.id) AS id FROM facts f JOIN facts w ON w.id=f.duplicate_of WHERE f.id=${fact.id}`;
          return (
            notes.find((note) => note.id === noteId) ??
            notes.find((note) => note.id === kept[0]?.id)!
          );
        }),
      )
      .pipe(Effect.mapError(storeError));
  const runs = (id?: AgentId) =>
    (id === undefined
      ? sql`SELECT * FROM agent_work_runs WHERE posted = 0 ORDER BY created_at`
      : sql`SELECT * FROM agent_work_runs WHERE agent_id = ${id} ORDER BY created_at DESC LIMIT 100`
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (r) =>
          Effect.gen(function* () {
            const usedSelection = yield* decodeSelectionJson(
              typeof r.model_selection_json === "string" ? r.model_selection_json : null,
            );
            return yield* decodeRun({
              id: r.run_id,
              agentId: r.agent_id,
              triggerId: r.trigger_id,
              triggerKind: r.trigger_kind,
              ...(r.trigger_context_json == null
                ? {}
                : {
                    triggerContext: yield* decodeEventContext(r.trigger_context_json),
                  }),
              workThreadId: r.work_thread_id,
              status: r.status,
              createdAt: r.created_at,
              completedAt: r.completed_at,
              summary: r.summary,
              posted: r.posted === 1,
              ...(usedSelection === undefined ? {} : { modelSelection: usedSelection }),
              ...(typeof r.fallback_reason !== "string"
                ? {}
                : { fallbackReason: r.fallback_reason as AgentFallbackReason }),
              ...(!("fallback_reset_at" in r) ? {} : { fallbackResetAt: r.fallback_reset_at }),
            });
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
      sql
        .withTransaction(
          Effect.gen(function* () {
            const owner = agent.ownerMachine ?? (yield* shared.defaultOwner);
            yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap, owner_machine) VALUES (${agent.id}, ${agent.conversationThreadId}, json_remove(${encodeAgent({ ...agent, ownerMachine: owner })}, '$.projectFolderId'), 1, ${agent.dailyRunCap}, ${owner}) ON CONFLICT(agent_id) DO UPDATE SET payload_json = excluded.payload_json, daily_run_cap = excluded.daily_run_cap, owner_machine = excluded.owner_machine`;
            yield* shared.capture("agent", agent.id);
            return yield* get(agent.id);
          }),
        )
        .pipe(Effect.mapError(storeError)),

    retire: (id) =>
      sql`UPDATE agents SET enabled = 0 WHERE agent_id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(storeError),
      ),
    delete: (id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id IN (SELECT task_id FROM scheduled_tasks WHERE agent_id = ${id})`;
            const schedules = yield* sql<{
              task_id: string;
            }>`SELECT task_id FROM scheduled_tasks WHERE agent_id = ${id}`;
            for (const task of schedules) yield* shared.capture("schedule", task.task_id, true);
            yield* shared.capture("agent", id, true);
            yield* sql`DELETE FROM scheduled_tasks WHERE agent_id = ${id}`;
            yield* sql`DELETE FROM agent_conversation_context WHERE agent_id = ${id}`;
            yield* sql`DELETE FROM agent_memory WHERE agent_id = ${id}`;
            yield* sql`DELETE FROM agent_work_runs WHERE agent_id = ${id}`;
            yield* sql`DELETE FROM commitments WHERE agent_id = ${id} AND status = 'proposed'`;
            yield* sql`UPDATE commitments SET agent_id = NULL, payload_json = json_set(payload_json, '$.agentId', NULL, '$.owner', json_object('kind', 'user')) WHERE agent_id = ${id} OR (json_extract(payload_json, '$.owner.kind') = 'agent' AND json_extract(payload_json, '$.owner.agentId') = ${id})`;
            const rows = yield* sql`DELETE FROM agents WHERE agent_id = ${id} RETURNING agent_id`;
            return rows.length > 0;
          }),
        )
        .pipe(Effect.mapError(storeError)),
    forget: (agentId, id, principal = "user") =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              id: string;
            }>`SELECT id FROM facts WHERE agent_id=${agentId} AND (legacy_note_id=${id} OR id=${id}) AND status IN ('proposed','confirmed')`;
            for (const row of rows) yield* facts.retract(FactId.make(row.id), principal);
            return rows.length > 0;
          }),
        )
        .pipe(Effect.mapError(storeError)),
    context: (threadId, runId) =>
      Effect.gen(function* () {
        const agent = yield* forThread(threadId);
        if (agent === null) {
          // A builder thread is a fresh conversation: its whole brief is the
          // builder prompt, with no agent identity and no retrieved facts.
          const builder = yield* sql<{
            found: number;
          }>`SELECT 1 AS found FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND json_extract(payload_json, '$.surface') = 'builder' LIMIT 1`;
          if (builder.length > 0) return builderSystemPrompt;
        }
        const context = yield* retrieval.forTurn({
          threadId,
          ...(runId === undefined ? {} : { runId }),
          principal: agent === null ? "user" : `agent:${agent.id}`,
          budgetChars: agent === null ? 4000 : 16000,
        });
        if (agent === null) return context.text;
        return `You are ${agent.name}, the owner's persistent agent.\nResponsibility:\n${agent.responsibility}\nYou act on your own across all of the owner's projects and repositories, within your permissions: ${yield* encodePermissions(agent.permissions)}. Use project_list to see them and project_create or project_clone to add one.\nStanding instructions:\n${agent.instructions}\n\nCore memory (curated, always in context):\n${agent.coreMemory ?? ""}\nUse agent_core_memory_update to maintain this block (8000 character budget). Keep hard constraints, preferences and current priorities; instructions and retrieved facts are separate.\n\n${context.text}\nUse fact_search to retrieve accessible facts, fact_propose for uncertain facts, and fact_supersede to replace proposals. memory_read, memory_remember and memory_forget remain aliases for your own facts. Only the user can confirm a proposal. Use list_open_items for shared commitments, propose_commitment for extracted obligations, and update_commitment_status with evidence. Use request_agent_approval for new triggers or permission changes; you can never approve your own requests. Use start_agent_work to start or propose repository Work. Send concise messages to the owner.`;
      }).pipe(Effect.mapError(storeError)),
    updateCoreMemory: (id, text) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const validated = yield* decodeCoreMemory(text);
            const at = yield* now;
            const rows =
              yield* sql`UPDATE agents SET payload_json = json_set(payload_json, '$.coreMemory', ${validated}, '$.updatedAt', ${at}) WHERE agent_id = ${id} RETURNING agent_id`;
            if (!rows.length) return yield* new AgentError({ message: "Agent not found." });
            yield* shared.capture("agent", id);
            return { text: validated };
          }),
        )
        .pipe(Effect.mapError(storeError)),
    reserve: (id) =>
      Effect.gen(function* () {
        const at = yield* now;
        const day = at.slice(0, 10);
        const rows =
          yield* sql`UPDATE agents SET run_day = ${day}, daily_runs = CASE WHEN run_day = ${day} THEN daily_runs + 1 ELSE 1 END WHERE agent_id = ${id} AND enabled = 1 AND (owner_machine IS NULL OR owner_machine = ${shared.environmentId}) AND (backoff_until IS NULL OR backoff_until <= ${at}) AND (run_day IS NULL OR run_day <> ${day} OR daily_runs < daily_run_cap) AND NOT EXISTS (SELECT 1 FROM agent_work_runs WHERE agent_id = ${id} AND status IN ('starting', 'running'))
            AND NOT EXISTS (SELECT 1 FROM thread_owners WHERE thread_id = agents.conversation_thread_id
              AND (local = 0 OR handoff_json IS NOT NULL)) RETURNING agent_id`;
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
        yield* sql`UPDATE agents SET payload_json = json_set(payload_json, '$.updatedAt', ${DateTime.formatIso(at)}), consecutive_failures = ${failures}, backoff_until = ${until} WHERE agent_id = ${id}`;
        return yield* get(id);
      }).pipe(Effect.mapError(storeError)),
    setFallback: (id, state) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* sql`UPDATE agents SET payload_json = json_set(payload_json, '$.updatedAt', ${at}, '$.fallbackIndex', ${state.index}, '$.fallbackReason', ${state.reason === null ? null : state.reason}, '$.fallbackUntil', ${state.until}) WHERE agent_id = ${id}`;
      }).pipe(Effect.mapError(storeError)),
    createRun: (run) =>
      sql`INSERT INTO agent_work_runs(run_id, agent_id, trigger_id, work_thread_id, status, created_at, trigger_kind, trigger_context_json, model_selection_json, fallback_reason) VALUES (${run.id}, ${run.agentId}, ${run.triggerId}, ${run.workThreadId}, ${run.status}, ${run.createdAt}, ${run.triggerKind ?? "trigger"}, ${run.triggerContext === undefined ? null : encodeEventContext(run.triggerContext)}, ${run.modelSelection === undefined ? null : JSON.stringify(run.modelSelection)}, ${run.fallbackReason ?? null})`.pipe(
        Effect.asVoid,
        Effect.mapError(storeError),
      ),
    finishRun: (id, status, summary, fallback) =>
      now.pipe(
        Effect.flatMap((at) =>
          fallback === undefined
            ? sql`UPDATE agent_work_runs SET status = ${status}, completed_at = ${at}, summary = ${summary} WHERE run_id = ${id}`
            : sql`UPDATE agent_work_runs SET status = ${status}, completed_at = ${at}, summary = ${summary}, fallback_reason = ${fallback.reason}, fallback_reset_at = ${fallback.resetAt} WHERE run_id = ${id}`,
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
export const layer = Layer.effect(AgentStore, make).pipe(
  Layer.provide(Layer.mergeAll(Facts.layer, Retrieval.layer, SharedState.layer)),
);
