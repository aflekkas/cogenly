import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Option from "effect/Option";
import {
  AgentError,
  AgentId,
  Commitment,
  ProjectLabelId,
  type AgentEventContext,
  type OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import { deriveWorkStatus } from "@t3tools/shared/workStatus";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Bus from "./AgentEventBus.ts";
import { isT3ImportCommandId } from "../t3Import/T3ImportCommandIds.ts";
import * as Events from "../orchestration-v2/EventStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

export class AgentEventReactor extends Context.Service<
  AgentEventReactor,
  {
    readonly tick: Effect.Effect<void, AgentError>;
    readonly observe: (event: OrchestrationV2StoredEvent) => Effect.Effect<void, AgentError>;
  }
>()("t3/agents/AgentEventReactor") {}
const decodeCommitment = Schema.decodeUnknownEffect(Schema.fromJsonString(Commitment));
const failure = (cause: unknown) =>
  new AgentError({ message: "Could not observe agent events.", cause });
const make = Effect.gen(function* () {
  const bus = yield* Bus.AgentEventBus;
  const sql = yield* SqlClient.SqlClient;
  const events = yield* Events.EventStoreV2;
  const projections = yield* Projections.ProjectionStoreV2;
  const scheduler = yield* Scheduler.Scheduler;
  const folders = yield* Folders.ManagedProjectFolders;
  const lock = yield* Semaphore.make(1);
  const threadContext = (threadId: ThreadId, occurredAt: string) =>
    Effect.gen(function* () {
      const thread = yield* projections.getThreadShell(threadId);
      if (thread === null || thread.deletedAt !== null) return null;
      if (thread.agent?.role !== "work") {
        const scratchRoot = yield* folders.scratchRoot;
        if (Option.isSome(scratchRoot)) {
          const scratch =
            yield* sql`SELECT 1 FROM projection_projects WHERE project_id = ${thread.projectId} AND workspace_root = ${scratchRoot.value}`;
          if (scratch.length) return null;
        }
      }
      const labels = yield* sql<{
        label_id: string;
      }>`SELECT folder_id AS label_id FROM effective_thread_project_folders WHERE thread_id = ${threadId} AND folder_id IS NOT NULL`;
      return {
        projectId: thread.projectId,
        labelIds: labels.map((r) => ProjectLabelId.make(r.label_id)),
        origin: thread.workOrigin ?? (thread.agent?.role === "work" ? "agent" : "direct"),
        occurredAt,
        ...(yield* bus.lineage(threadId)),
      };
    });
  const observe: AgentEventReactor["Service"]["observe"] = (stored) =>
    Effect.gen(function* () {
      const event = stored.event;
      // Imported T3 history must not trigger agents.
      if (isT3ImportCommandId(stored.commandId)) return;
      if (
        ![
          "run.updated",
          "checkpoint.captured",
          "provider-thread.updated",
          "provider-session.updated",
          "runtime-request.updated",
          "thread.pull-request-link-updated",
          "thread.pull-request-synced",
        ].includes(event.type)
      )
        return;
      const context = yield* threadContext(event.threadId, DateTime.formatIso(event.occurredAt));
      if (context === null) return;
      if (
        event.type !== "thread.pull-request-link-updated" &&
        event.type !== "thread.pull-request-synced"
      ) {
        const projection = yield* projections.getThreadRecords(event.threadId, [
          "runs",
          "nodes",
          "runtimeRequests",
          "turnItems",
          "providerThreads",
          "providerSessions",
          "checkpoints",
        ]);
        if (projection.thread.agent?.role === "conversation") return;
        const latest = projection.runs.reduce<(typeof projection.runs)[number] | undefined>(
          (a, b) => (a === undefined || b.ordinal > a.ordinal ? b : a),
          undefined,
        );
        if (latest === undefined) return;
        const status = deriveWorkStatus(projection);
        if (
          ["completed", "review_ready", "failed"].includes(status) &&
          ["completed", "failed"].includes(latest.status)
        ) {
          const kind = latest.status === "failed" ? "work.failed" : "work.completed";
          // Provider settlement and pending input can land after run.updated.
          // Re-evaluate on those updates, retaining the terminal run identity.
          yield* bus.emit({
            ...context,
            kind,
            occurredAt:
              latest.completedAt === null
                ? context.occurredAt
                : DateTime.formatIso(latest.completedAt),
            dedupKey: `work:${latest.id}:${kind}`,
            refs: { threadId: event.threadId, runId: latest.id },
          });
        }
        if (status === "review_ready" && latest.status === "completed")
          yield* bus.emit({
            ...context,
            kind: "work.review_ready",
            dedupKey: `work:${latest.id}:review_ready`,
            refs: { threadId: event.threadId, runId: latest.id },
          });
        return;
      }
      const links =
        event.type === "thread.pull-request-link-updated"
          ? [event.payload]
          : event.type === "thread.pull-request-synced"
            ? (event.payload.pullRequests ?? [])
            : [];
      for (const link of links) {
        const snapshot = link.snapshot;
        if (snapshot === null) continue;
        const revision = snapshot.headSha ?? snapshot.updatedAt;
        const refs = {
          threadId: event.threadId,
          prUrl: link.url,
          ...(snapshot.headSha === undefined ? {} : { headSha: snapshot.headSha }),
        };
        const kinds: AgentEventContext["kind"][] = ["pr.updated"];
        if (snapshot.checksState === "failing") kinds.push("pr.checks_failed");
        if (snapshot.state === "merged") kinds.push("pr.merged");
        for (const kind of kinds) {
          const version =
            kind === "pr.merged"
              ? (snapshot.mergedAt ?? snapshot.updatedAt)
              : kind === "pr.updated"
                ? `${snapshot.updatedAt}:${snapshot.state}:${snapshot.checksState ?? "unknown"}`
                : revision;
          yield* bus.emit({
            ...context,
            kind,
            refs,
            dedupKey: `pr:${link.url}:${context.projectId}:${kind}:${version}`,
          });
        }
      }
    }).pipe(Effect.mapError(failure));
  const tick = Effect.gen(function* () {
    const cursor = yield* sql<{
      sequence: number;
    }>`SELECT sequence FROM agent_event_cursor WHERE id = 1`;
    const batch = yield* Stream.runCollect(
      events.read({ afterSequence: cursor[0]!.sequence, limit: 500 }),
    );
    // Source emission and cursor advancement commit together. The separate bus
    // drain can resume after a crash, including after the launch reservation.
    for (const stored of batch)
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* observe(stored);
          yield* sql`UPDATE agent_event_cursor SET sequence = ${stored.sequence} WHERE id = 1`;
        }),
      );
    const at = DateTime.formatIso(yield* DateTime.now);
    const due = yield* sql<{
      payload_json: string;
      agent_id: string | null;
      source_thread_id: string | null;
    }>`SELECT payload_json, agent_id, source_thread_id FROM commitments WHERE status IN ('open', 'in_progress', 'waiting') AND json_extract(payload_json, '$.dueAt') <= ${at}`;
    for (const row of due) {
      const item = yield* decodeCommitment(row.payload_json);
      if (item.dueAt === null) continue;
      yield* bus.emit({
        kind: "commitment.due",
        dedupKey: `commitment:${item.id}:due:${item.dueAt}`,
        occurredAt: at,
        projectId: null,
        labelIds: item.labelIds,
        origin: row.agent_id === null ? "direct" : "agent",
        refs: { commitmentId: item.id },
        ...(row.source_thread_id === null
          ? { chainDepth: 0, chainAgentIds: [] }
          : yield* bus.lineage(ThreadId.make(row.source_thread_id))),
        ...(row.agent_id === null ? {} : { subjectAgentId: AgentId.make(row.agent_id) }),
      });
    }
    yield* bus.drain;
  }).pipe(lock.withPermits(1), Effect.mapError(failure));
  yield* scheduler.register("agent-events", tick);
  return AgentEventReactor.of({ tick, observe });
});
export const layer = Layer.effect(AgentEventReactor, make);
