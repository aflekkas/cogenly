import * as NodeSqlite from "node:sqlite";

import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Worker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const threadId = ThreadId.make("thread:long-history");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
// Rows of each kind a long-lived thread accumulates: nodes, user messages and
// their turn items, and subagents.
const HISTORY_ROWS = 2_000;
const SEEDED_AT = "2026-01-01T00:00:00.000Z";

const send = (
  key: string,
  dispatchMode: Extract<OrchestrationV2Command, { type: "message.dispatch" }>["dispatchMode"],
): Extract<OrchestrationV2Command, { type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: CommandId.make(`send:${key}`),
  threadId,
  messageId: MessageId.make(`message:${key}`),
  text: `Message ${key}`,
  attachments: [],
  dispatchMode,
  createdBy: "user",
  creationSource: "web",
});

const awaitEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
      Stream.filter((row) => predicate(row.event)),
      Stream.take(1),
      Stream.runDrain,
    );
  });

/** Every row SQLite returns to the server while `effect` runs, by statement. */
const recordRowsRead = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = NodeSqlite.StatementSync.prototype.all;
      const reads: Array<{ readonly sql: string; readonly rows: number }> = [];
      NodeSqlite.StatementSync.prototype.all = function (
        this: NodeSqlite.StatementSync,
        ...args: Array<never>
      ) {
        const rows = original.apply(this, args as never);
        reads.push({ sql: this.sourceSQL.replace(/\s+/g, " ").trim(), rows: rows.length });
        return rows;
      } as typeof original;
      return { original, reads };
    }),
    ({ reads }) => effect.pipe(Effect.map((value) => ({ value, reads }))),
    ({ original }) =>
      Effect.sync(() => {
        NodeSqlite.StatementSync.prototype.all = original;
      }),
  );

/** A running turn with one message queued behind it, on a thread with a long history. */
const longThreadWithQueuedMessage = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* Worker.OrchestrationEffectWorkerV2;
  const sql = yield* SqlClient.SqlClient;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project:test"),
    title: "Long history",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch(send("busy", { type: "start_immediately" }));
  yield* worker.drain();
  yield* awaitEvent((event) => event.type === "provider-turn.updated");
  yield* orchestrator.dispatch(send("queued", { type: "queue_after_active" }));

  const projection = yield* orchestrator.getThreadProjection(threadId);
  const busy = projection.runs.find((run) => run.userMessageId === MessageId.make("message:busy"))!;
  const queued = projection.runs.find(
    (run) => run.userMessageId === MessageId.make("message:queued"),
  )!;

  // Clone the busy run's rows into history, as years of steering leave behind.
  yield* sql`
    INSERT INTO orchestration_v2_projection_nodes (
      node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status, provider_thread_id,
      provider_turn_id, runtime_request_id, checkpoint_scope_id, started_at, completed_at, payload_json
    )
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${HISTORY_ROWS})
    SELECT 'node:seed:' || n, thread_id, run_id, node_id, root_node_id, 'subagent', 'completed',
      provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id,
      ${SEEDED_AT}, ${SEEDED_AT},
      json_set(payload_json, '$.id', 'node:seed:' || n, '$.kind', 'subagent',
        '$.status', 'completed', '$.parentNodeId', node_id,
        '$.startedAt', ${SEEDED_AT}, '$.completedAt', ${SEEDED_AT})
    FROM seq CROSS JOIN orchestration_v2_projection_nodes
    WHERE node_id = ${busy.rootNodeId}
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
    )
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${HISTORY_ROWS})
    SELECT 'message:seed:' || n, thread_id, run_id, node_id, role, streaming, created_at,
      updated_at, json_set(payload_json, '$.id', 'message:seed:' || n)
    FROM seq CROSS JOIN orchestration_v2_projection_messages
    WHERE message_id = ${busy.userMessageId}
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_items (
      turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
      parent_item_id, ordinal, type, status, updated_at, payload_json
    )
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${HISTORY_ROWS})
    SELECT 'turn-item:seed:' || n, thread_id, run_id, node_id, provider_thread_id,
      provider_turn_id, parent_item_id, 100 + n, type, status, updated_at,
      json_set(payload_json, '$.id', 'turn-item:seed:' || n,
        '$.messageId', 'message:seed:' || n, '$.ordinal', 100 + n)
    FROM seq CROSS JOIN orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId}
      AND type = 'user_message'
      AND json_extract(payload_json, '$.messageId') = ${busy.userMessageId}
  `;
  const subagent = JSON.stringify({
    id: "subagent:seed",
    threadId,
    runId: busy.id,
    parentNodeId: busy.rootNodeId,
    origin: "provider_native",
    createdBy: "agent",
    driver: "codex",
    providerInstanceId: "codex",
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "Review the change",
    title: null,
    model: null,
    status: "completed",
    result: "Done",
    startedAt: SEEDED_AT,
    completedAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_subagents (
      subagent_id, thread_id, run_id, parent_node_id, provider, driver, provider_instance_id,
      provider_thread_id, child_thread_id, origin, status, started_at, completed_at, updated_at,
      payload_json
    )
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${HISTORY_ROWS})
    SELECT 'subagent:seed:' || n, ${threadId}, ${busy.id}, ${busy.rootNodeId}, 'codex', 'codex',
      'codex', NULL, NULL, 'provider_native', 'completed', ${SEEDED_AT}, ${SEEDED_AT}, ${SEEDED_AT},
      json_set(${subagent}, '$.id', 'subagent:seed:' || n)
    FROM seq
  `;

  // The seeded history decodes like any other, so a full read really is large.
  const history = yield* orchestrator.getThreadRecords(threadId, [
    "nodes",
    "messages",
    "subagents",
    "turnItems",
  ]);
  expect(history.nodes.length).toBeGreaterThan(HISTORY_ROWS);
  expect(history.messages.length).toBeGreaterThan(HISTORY_ROWS);
  expect(history.subagents.length).toBe(HISTORY_ROWS);
  expect(history.turnItems.length).toBeGreaterThan(HISTORY_ROWS);
  return { queued };
});

const runtime = (provider: ReturnType<typeof makeControllableProvider>) => {
  const database = Sqlite.layerMemory;
  return Layer.mergeAll(
    database,
    layerWithRegistry({ name: "queued-run-cancel-cost" }, provider.registry, {
      databaseLayer: database,
      runEffectWorker: false,
    }),
  );
};

it.effect("cancelling a queued message reads the same rows however long the thread is", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { queued } = yield* longThreadWithQueuedMessage;

    const { reads } = yield* recordRowsRead(
      orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("cancel:queued"),
        threadId,
        runId: queued.id,
      }),
    );

    const cancelled = yield* orchestrator.getThreadRecords(threadId, ["runs"], {
      runIds: [queued.id],
    });
    expect(cancelled.runs[0]?.status).toBe("cancelled");
    // Every statement reads a handful of rows, and the whole command stays far
    // below the size of any one history table.
    expect(reads.filter((read) => read.rows > 5)).toEqual([]);
    expect(reads.reduce((total, read) => total + read.rows, 0)).toBeLessThan(50);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("orders a thread's messages through the message item index", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    yield* longThreadWithQueuedMessage;

    const captured: Array<{ readonly sql: string; readonly params: ReadonlyArray<unknown> }> = [];
    const original = NodeSqlite.StatementSync.prototype.all;
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        NodeSqlite.StatementSync.prototype.all = function (
          this: NodeSqlite.StatementSync,
          ...args: Array<never>
        ) {
          captured.push({ sql: this.sourceSQL, params: args });
          return original.apply(this, args as never);
        } as typeof original;
      }),
      () => orchestrator.getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] }),
      () =>
        Effect.sync(() => {
          NodeSqlite.StatementSync.prototype.all = original;
        }),
    );

    const ordering = captured.filter(
      (statement) =>
        statement.sql.includes("$.messageId") && statement.sql.includes("MIN(ordinal)"),
    );
    expect(ordering).toHaveLength(1);
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${ordering[0]!.sql}`,
      ordering[0]!.params,
    );
    expect(
      plan.some((row) => row.detail.includes("orchestration_v2_projection_turn_items_message_idx")),
    ).toBe(true);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("command reads preserve filtered item ordering and settled-node semantics", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    yield* longThreadWithQueuedMessage;
    const before = yield* orchestrator.getThreadRecords(threadId, ["runs", "nodes", "turnItems"]);
    const busy = before.runs.find((run) => run.status === "running")!;
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      SELECT 'run:finished', thread_id, ordinal + 10000, provider, provider_thread_id, 'completed', requested_at, completed_at,
        json_set(payload_json, '$.id', 'run:finished', '$.status', 'completed', '$.ordinal', ordinal + 10000), provider_instance_id
      FROM orchestration_v2_projection_runs WHERE run_id = ${busy.id}`;
    for (const [id, runId, kind, status] of [
      ["node:old-leaf", "run:finished", "tool_call", "completed"],
      ["node:old-live", "run:finished", "tool_call", "running"],
      ["node:old-control", "run:finished", "subagent", "completed"],
      ["node:active-leaf", busy.id, "tool_call", "completed"],
      ["node:runless", null, "tool_call", "completed"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_nodes
        SELECT ${id}, thread_id, ${runId}, parent_node_id, root_node_id, ${kind}, ${status},
          provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id,
          started_at, completed_at,
          json_set(payload_json, '$.id', ${id}, '$.runId', ${runId}, '$.kind', ${kind}, '$.status', ${status})
        FROM orchestration_v2_projection_nodes WHERE node_id = ${busy.rootNodeId}`;
    }
    const full = yield* orchestrator.getThreadRecords(threadId, ["nodes", "turnItems"]);
    const filtered = yield* orchestrator.getThreadRecords(threadId, ["nodes", "turnItems"], {
      // Duplicate requested types retain IN semantics and must not duplicate items.
      turnItemTypes: ["error", "user_message", "user_message"],
      omitSettledLeafNodes: true,
    });
    expect(filtered.turnItems).toEqual(
      full.turnItems.filter((item) => item.type === "error" || item.type === "user_message"),
    );
    expect(filtered.nodes).toEqual(full.nodes.filter((node) => node.id !== "node:old-leaf"));
    expect(
      (yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: [],
      })).turnItems,
    ).toEqual([]);
    const onlyBusy = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["user_message"],
      turnItemRunId: busy.id,
    });
    expect(onlyBusy.turnItems).toEqual(
      full.turnItems.filter((item) => item.type === "user_message" && item.runId === busy.id),
    );
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("send reads bounded control rows and reuses an existing queued message item", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const { queued } = yield* longThreadWithQueuedMessage;
    // Historical runs must not become dispatch input, even when their ordinal
    // is much larger than the live run's. New runs still use the durable max.
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      SELECT 'run:history:' || n, thread_id, 100 + n, provider, provider_thread_id,
        'completed', requested_at, ${SEEDED_AT},
        json_set(payload_json, '$.id', 'run:history:' || n, '$.ordinal', 100 + n,
          '$.status', 'completed', '$.completedAt', ${SEEDED_AT}), provider_instance_id
      FROM (WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${HISTORY_ROWS}) SELECT n FROM seq)
      CROSS JOIN orchestration_v2_projection_runs WHERE run_id = ${queued.id}`;
    const before = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
      turnItemMessageIds: [MessageId.make("message:seed:1000")],
    });
    const { value, reads } = yield* recordRowsRead(
      orchestrator.dispatch({
        ...send("redispatch", { type: "queue_after_active" }),
        messageId: MessageId.make("message:seed:1000"),
      }),
    );
    expect(value.storedEvents.some((row) => row.event.type === "run.created")).toBe(true);
    expect(reads.filter((read) => read.rows > 10)).toEqual([]);
    expect(reads.reduce((total, read) => total + read.rows, 0)).toBeLessThan(100);
    const after = yield* orchestrator.getThreadRecords(threadId, ["runs", "turnItems"], {
      turnItemMessageIds: [MessageId.make("message:seed:1000")],
    });
    expect(after.runs.at(-1)?.ordinal).toBe(HISTORY_ROWS + 101);
    expect(after.turnItems).toHaveLength(1);
    expect(after.turnItems[0]?.id).toBe(before.turnItems[0]?.id);
    // EventSink moves the retained item's ordinal into its newly assigned run.
    expect(after.turnItems[0]?.ordinal).toBeGreaterThan(before.turnItems[0]!.ordinal);
    expect(after.turnItems[0]?.runId).toBe(after.runs.at(-1)?.id);
  }).pipe(Effect.provide(runtime(provider)));
});

it.effect("dispatch retains a title-history witness with ECMAScript maintenance whitespace", () => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    yield* longThreadWithQueuedMessage;
    yield* sql`UPDATE orchestration_v2_projection_messages
      SET payload_json = json_set(payload_json, '$.text', ${"\uFEFF /CoMpAcT \u2029"})
      WHERE thread_id = ${threadId}`;
    const filter = { messageDispatch: { messageId: MessageId.make("message:new") } };
    const maintenance = yield* orchestrator.getThreadRecords(threadId, ["messages"], filter);
    expect(maintenance.messages.length).toBeLessThanOrEqual(3);
    expect(maintenance.messages.every(Orchestrator.isNativeMaintenanceCommand)).toBe(true);
    yield* sql`UPDATE orchestration_v2_projection_messages
      SET payload_json = json_set(payload_json, '$.text', 'Original work')
      WHERE message_id = 'message:seed:1000'`;
    const realHistory = yield* orchestrator.getThreadRecords(threadId, ["messages"], filter);
    expect(realHistory.messages.map((message) => message.id)).toContain("message:seed:1000");
    expect(
      realHistory.messages.some((message) => !Orchestrator.isNativeMaintenanceCommand(message)),
    ).toBe(true);
    expect(realHistory.messages.length).toBeLessThanOrEqual(3);
  }).pipe(Effect.provide(runtime(provider)));
});
