import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Projections from "./ProjectionStore.ts";
import { REPLICA_COMMAND_PREFIX } from "./ReplayedCommandIds.ts";

const runtime = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(EventStore.layer, Projections.layer, EffectOutbox.layer).pipe(
      Layer.provideMerge(Sqlite.layerMemory),
    ),
  ),
);

const threadId = ThreadId.make("thread:owned-elsewhere");
const created = (id: string, at: DateTime.Utc): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "thread.created",
  threadId,
  occurredAt: at,
  payload: idleThreadProjection(liveThreadShell(threadId)).thread,
});

it.effect("a thread owned by another machine takes events only from replication", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const at = yield* DateTime.now;
    yield* sql`INSERT INTO thread_owners(thread_id, owner_env, local, epoch, updated_at) VALUES (${threadId}, 'env:vps', 0, 0, ${DateTime.formatIso(at)})`;

    const local = yield* Effect.flip(sink.write({ events: [created("event:local", at)] }));
    expect(local.cause).toBeInstanceOf(EventSink.ThreadOwnedElsewhereError);

    yield* sink.write({
      commandId: CommandId.make(`${REPLICA_COMMAND_PREFIX}batch`),
      events: [created("event:replica", at)],
    });
    const rows = yield* sql<{ event_id: string }>`SELECT event_id FROM orchestration_events`;
    expect(rows.map((row) => row.event_id)).toEqual(["event:replica"]);
  }).pipe(Effect.provide(runtime)),
);

it.effect("recovery leaves a replica's running turn to the machine that runs it", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* Projections.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const at = yield* DateTime.now;
    const runId = RunId.make("run:replica");
    const instanceId = ProviderInstanceId.make("codex");
    const run: OrchestrationV2Run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5" },
      providerThreadId: ProviderThreadId.make("provider-thread:replica"),
      userMessageId: MessageId.make("message:replica"),
      rootNodeId: NodeId.make("node:replica"),
      activeAttemptId: RunAttemptId.make("attempt:replica"),
      status: "running",
      requestedAt: at,
      startedAt: at,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* sink.write({
      events: [
        created("event:thread", at),
        {
          id: EventId.make("event:run"),
          type: "run.updated",
          threadId,
          runId,
          occurredAt: at,
          payload: run,
        },
      ],
    });
    expect(yield* projections.getRecoveryThreadIds("runtime")).toEqual([threadId]);

    yield* sql`INSERT INTO thread_owners(thread_id, owner_env, local, epoch, updated_at) VALUES (${threadId}, 'env:vps', 0, 0, ${DateTime.formatIso(at)})`;
    expect(yield* projections.getRecoveryThreadIds("runtime")).toEqual([]);
  }).pipe(Effect.provide(runtime)),
);

it.effect("a handoff in progress fences the owner's own writes", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const at = yield* DateTime.now;
    yield* sink.write({ events: [created("event:before", at)] });
    yield* sql`INSERT INTO thread_owners(thread_id, owner_env, local, epoch, handoff_json, updated_at) VALUES (${threadId}, 'env:mac', 1, 0, '{}', ${DateTime.formatIso(at)})`;

    const fenced = yield* Effect.flip(sink.write({ events: [created("event:during", at)] }));
    expect(fenced.cause).toBeInstanceOf(EventSink.ThreadOwnedElsewhereError);

    yield* sql`UPDATE thread_owners SET handoff_json = NULL WHERE thread_id = ${threadId}`;
    yield* sink.write({ events: [created("event:after", at)] });
    expect((yield* sql`SELECT event_id FROM orchestration_events`).length).toBe(2);
  }).pipe(Effect.provide(runtime)),
);
