import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type MachineHealthReport,
  type OrchestrationV2Subagent,
} from "@cogenly/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { ThreadId, OrchestrationV2Subagent as SubagentSchema } from "@cogenly/contracts";

import * as Identity from "../machines/MachineIdentity.ts";
import * as Machines from "../machines/Machines.ts";
import * as Channels from "../machines/PeerChannels.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeControllableProvider } from "../orchestration-v2/testkit/ControllableProvider.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Health from "./MachineHealth.ts";
import * as Fixes from "./MachineHealthFixes.ts";
import { readStuckQueues } from "./staleRuns.ts";
import { STUCK_RUN_AFTER_MS, stuckQueuesItems } from "./healthChecks.ts";

const threadId = ThreadId.make("thread:health-race");
const environmentId = EnvironmentId.make("test:health-race");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const key = `stuck-runs:thread:${threadId}`;

const encodeSubagent = Schema.encodeEffect(Schema.fromJsonString(SubagentSchema));

it.effect.each([
  "orphan beside healthy turn",
  "stale turn replaced before dispatch",
  "same stale turn still active",
  "idle queued messages",
] as const)("Fix targets only stale work: %s", (scenario) => {
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
  const database = Sqlite.layerMemory;
  const runtime = Layer.mergeAll(
    database,
    layerWithRegistry({ name: "health-fix-race" }, provider.registry, {
      databaseLayer: database,
      runEffectWorker: false,
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* Worker.OrchestrationEffectWorkerV2;
    const sql = yield* SqlClient.SqlClient;
    const milestone = (type: string) =>
      orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter((row) => row.event.type === type),
        Stream.take(1),
        Stream.runDrain,
      );
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:health"),
      title: "Health",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const send = (id: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${id}`),
        threadId,
        messageId: MessageId.make(id),
        text: "Work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
    yield* send("first");
    yield* worker.drain().pipe(Effect.orDie);
    yield* milestone("provider-turn.updated");
    const first = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    const staleAt = DateTime.makeUnsafe(
      DateTime.toEpochMillis(yield* DateTime.now) - STUCK_RUN_AFTER_MS - 1000,
    );
    const staleIso = DateTime.formatIso(staleAt);
    const orphanId = NodeId.make("node:old-orphan");
    if (scenario === "idle queued messages") {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queue-for-health"),
        threadId,
        messageId: MessageId.make("message:health-queued"),
        text: "Send this",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
      yield* provider.finish(provider.turns[0]!, turn.id, {
        class: "provider_error",
        message: "Failure",
        code: null,
        retryable: null,
      });
      yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
        Stream.filter(
          (row) => row.event.type === "run.updated" && row.event.payload.queueHeld === true,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* worker.drain();
      expect(yield* readStuckQueues(yield* DateTime.now)).toEqual([]);
      const queues = yield* readStuckQueues(
        DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + 240_000),
      );
      expect(stuckQueuesItems(queues)[0]?.title).toBe("Queued messages not sending in Health");
    } else if (scenario === "orphan beside healthy turn") {
      const task: OrchestrationV2Subagent = {
        id: orphanId,
        threadId,
        runId: null,
        parentNodeId: first.rootNodeId!,
        origin: "provider_native",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: modelSelection.instanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Old work",
        title: "Old work",
        model: "gpt-5",
        status: "running",
        result: null,
        startedAt: staleAt,
        completedAt: null,
        updatedAt: staleAt,
      };
      const payload = yield* encodeSubagent(task);
      yield* sql`INSERT INTO orchestration_v2_projection_subagents
          (subagent_id, thread_id, parent_node_id, provider, origin, status, started_at, updated_at, payload_json)
          VALUES (${orphanId}, ${threadId}, ${first.rootNodeId}, 'codex', 'provider_native', 'running', ${staleIso}, ${staleIso}, ${payload})`;
    } else {
      yield* sql`UPDATE orchestration_v2_projection_runs SET requested_at = ${staleIso} WHERE run_id = ${first.id}`;
    }
    let replaced = false;
    const dispatch: Threads.ThreadManagementService["Service"]["dispatch"] = (command) =>
      Effect.gen(function* () {
        if (scenario === "stale turn replaced before dispatch" && !replaced) {
          replaced = true;
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const turn = projection.providerTurns[0]!;
          yield* provider.finish(provider.turns[0]!, turn.id);
          yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0, threadId }).pipe(
            Stream.filter(
              (row) =>
                row.event.type === "provider-turn.updated" &&
                row.event.payload.id === turn.id &&
                row.event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* worker.drain().pipe(Effect.orDie);
          yield* send("replacement");
          yield* worker.drain().pipe(Effect.orDie);
        }
        return yield* orchestrator.dispatch(command);
      });
    const report: MachineHealthReport = {
      environmentId,
      machineName: "Test",
      status: "fail",
      observedAt: yield* DateTime.now,
      serverVersion: "0.3.2",
      uptimeSeconds: 1,
      reachable: true,
      checks: [
        {
          id: "stuck-runs",
          status: "fail",
          summary: "Stuck",
          items: [
            {
              key,
              status: "fail",
              title: "Stuck",
              detail: "",
              since: staleAt,
              target: { _tag: "thread", threadId },
              fix: scenario === "idle queued messages" ? "send-queue" : "resume",
            },
          ],
        },
      ],
    };
    const fixesLayer = Fixes.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Health.MachineHealth)({ report: Effect.succeed(report) }),
          Layer.mock(Machines.Machines)({}),
          Channels.layer,
          Layer.mock(Identity.MachineIdentity)({
            self: Effect.succeed({
              environmentId,
              name: "Test",
              role: "computer",
              hardware: "laptop",
              platform: "darwin",
              serverVersion: "0.3.2",
              providers: [],
            }),
          }),
          Layer.mock(Threads.ThreadManagementService)({
            getThreadRecords: orchestrator.getThreadRecords,
            dispatch,
          }),
          Layer.mock(Tasks.ScheduledTaskService)({}),
          Layer.succeed(SqlClient.SqlClient, sql),
          NodeServices.layer,
        ),
      ),
    );
    const result = yield* Fixes.MachineHealthFixes.pipe(
      Effect.flatMap((fixes) => fixes.fix({ itemKeys: [key] })),
      Effect.provide(fixesLayer),
    );
    yield* worker.drain().pipe(Effect.orDie);
    const after = yield* orchestrator.getThreadProjection(threadId);
    if (scenario !== "same stale turn still active")
      expect(result.outcomes[0]!.status).toBe("fixed");
    if (scenario === "idle queued messages") {
      expect(after.runs.filter((run) => run.status === "queued")).toHaveLength(0);
      expect(provider.turns.at(-1)?.message.text).toContain("Send this");
      expect(provider.turns).toHaveLength(2);
    } else if (scenario === "same stale turn still active") {
      expect(after.runs.find((run) => run.id === first.id)!.status).toBe("interrupted");
    } else {
      const healthy = after.runs.at(-1)!;
      expect(healthy.status).toBe("running");
      expect(healthy.queueHeld).not.toBe(true);
      expect(
        after.turnItems.filter(
          (item) => item.runId === healthy.id && item.type === "run_interrupt_request",
        ),
      ).toEqual([]);
      if (scenario === "orphan beside healthy turn")
        expect(after.subagents[0]!.status).toBe("interrupted");
    }
  }).pipe(Effect.provide(runtime), Effect.scoped);
});
