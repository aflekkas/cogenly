import {
  AgentError,
  CommandId,
  MessageId,
  type Agent,
  ModelSelection,
  type RunId,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { decideFallback } from "./providerFallback.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

export type InboxItem = {
  readonly kind: string;
  readonly target: string;
  readonly text: string;
  readonly at: string;
};
/** Repeated updates carry the latest snapshot and a count, while different results retain their refs. */
export const renderBusyInbox = (items: ReadonlyArray<InboxItem>) => {
  const grouped = new Map<string, { item: InboxItem; count: number }>();
  for (const item of items.toSorted((a, b) => a.at.localeCompare(b.at))) {
    const key = `${item.kind}:${item.target}`;
    grouped.set(key, { item, count: (grouped.get(key)?.count ?? 0) + 1 });
  }
  if (!grouped.size) return "";
  return (
    "Arrived while busy (read these results before continuing; full details are available through their refs):\n" +
    [...grouped.values()]
      .map(
        ({ item, count }) =>
          `[${item.kind}:${item.target}]${count > 1 ? ` (${count} updates; latest)` : ""} ${item.text.slice(0, 1200)}`,
      )
      .join("\n")
  );
};
export class AgentInbox extends Context.Service<
  AgentInbox,
  {
    readonly sweep: (agent: Agent) => Effect.Effect<void, AgentError>;
  }
>()("cogenly-server/agents/AgentInbox") {}
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const decodeSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* Threads.ThreadManagementService;
  return AgentInbox.of({
    sweep: (agent) =>
      Effect.gen(function* () {
        // Each completed turn owns a frozen batch. Retry after an uncertain send reuses
        // exactly the same payload and command receipt, including after a server restart.
        const turns = yield* sql<{
          run_id: RunId;
          requested_at: string;
          completed_at: string;
        }>`SELECT r.run_id, r.requested_at, r.completed_at FROM orchestration_v2_projection_runs r
      WHERE r.thread_id = ${agent.conversationThreadId} AND r.status IN ('completed','failed','interrupted')
        AND r.completed_at IS NOT NULL AND r.requested_at >= (SELECT installed_at FROM agent_continuity_epoch)
        AND NOT EXISTS (SELECT 1 FROM agent_inbox_sweeps s WHERE s.run_id = r.run_id)
      ORDER BY r.ordinal`;
        for (const turn of turns) {
          const results =
            yield* sql<InboxItem>`SELECT 'work' AS kind, work_thread_id AS target, COALESCE(summary, status) AS text, completed_at AS at FROM agent_work_runs
        WHERE agent_id = ${agent.id} AND completed_at > ${turn.requested_at} AND completed_at <= ${turn.completed_at}
        UNION ALL
        SELECT 'postback' AS kind, m.message_id AS target, json_extract(m.payload_json, '$.text') AS text, m.created_at AS at FROM orchestration_v2_projection_messages m
        WHERE m.thread_id = ${agent.conversationThreadId} AND m.run_id IS NULL AND m.role = 'assistant' AND m.created_at > ${turn.requested_at} AND m.created_at <= ${turn.completed_at}
          AND json_extract(m.payload_json, '$.senderThreadId') IS NOT NULL AND json_extract(m.payload_json, '$.scheduledTaskId') IS NULL
        UNION ALL
        SELECT 'approval' AS kind, id AS target, status AS text, decided_at AS at FROM agent_approvals WHERE agent_id = ${agent.id} AND decided_at > ${turn.requested_at} AND decided_at <= ${turn.completed_at}
        UNION ALL
        SELECT json_extract(context_json, '$.kind') AS kind, COALESCE(json_extract(context_json, '$.refs.prUrl'), json_extract(context_json, '$.refs.threadId'), event_key) AS target, context_json AS text, json_extract(context_json, '$.occurredAt') || ':' || printf('%020d', rowid) AS at FROM agent_event_deliveries
        WHERE agent_id = ${agent.id} AND json_extract(context_json, '$.occurredAt') > ${turn.requested_at} AND json_extract(context_json, '$.occurredAt') <= ${turn.completed_at}`;
          // App-owned child results already use delegated completion delivery, which
          // queues behind a live turn and records observation. Never enqueue them twice.
          const body = renderBusyInbox(results);
          const selection = decideFallback(
            agent,
            DateTime.toEpochMillis(yield* DateTime.now),
          ).selection;
          yield* sql`INSERT OR IGNORE INTO agent_inbox_sweeps(agent_id, run_id, text, model_selection_json, delivered) VALUES (${agent.id}, ${turn.run_id}, ${body}, ${encodeSelection(selection)}, ${body ? 0 : 1})`;
        }
        const pending = yield* sql<{
          run_id: string;
          text: string;
          model_selection_json: string;
        }>`SELECT run_id, text, model_selection_json FROM agent_inbox_sweeps WHERE agent_id = ${agent.id} AND delivered = 0 ORDER BY rowid`;
        for (const batch of pending) {
          const thread = yield* threads.getThreadShell(agent.conversationThreadId);
          if (thread === null || thread.deletedAt !== null) return;
          yield* threads.dispatch({
            type: "message.dispatch",
            threadId: agent.conversationThreadId,
            commandId: CommandId.make(`agent-inbox:${batch.run_id}`),
            messageId: MessageId.make(`agent-inbox:${batch.run_id}`),
            text: batch.text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            notification: {
              source: { kind: "system" },
              outcome: "updated",
              summary: "Results arrived while the agent was working",
              detail: batch.text,
            },
            modelSelection: yield* decodeSelection(batch.model_selection_json),
            createdBy: "system",
            creationSource: "server",
          });
          yield* sql`UPDATE agent_inbox_sweeps SET delivered = 1 WHERE run_id = ${batch.run_id}`;
        }
      }).pipe(
        Effect.mapError(
          (cause) => new AgentError({ message: "Could not deliver agent inbox.", cause }),
        ),
      ),
  });
});
export const layer = Layer.effect(AgentInbox, make);
