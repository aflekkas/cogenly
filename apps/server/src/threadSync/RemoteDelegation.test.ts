import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadLaunchRemote,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import { pair, awaitLinkState, startProxy } from "../machines/testkit.ts";
import { startThreadMachine, threadCreated, userMessage } from "./testkit.ts";

it.live(
  "a spoke delegates to its hub while its own replication to the hub is stuck",
  () =>
    Effect.gen(function* () {
      const hub = yield* startThreadMachine("stuck-hub", "cloud-server", () => [], undefined, true);
      const laptop = yield* startThreadMachine(
        "stuck-laptop",
        "computer",
        () => [],
        undefined,
        true,
      );
      yield* pair(hub, laptop);
      const parent = Option.getOrThrow(laptop.engine);
      const config = yield* laptop.run(ServerConfig.ServerConfig);
      const projectId = ProjectId.make("scratch");
      yield* laptop.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'No project',${`${config.baseDir}/scratch`},'[]','2026-10-24T00:00:00Z','2026-10-24T00:00:00Z')`;
      // The hub refuses the batch holding an older laptop thread on every
      // pass, so nothing the laptop wrote after it reaches the hub.
      const at = yield* DateTime.now;
      yield* laptop.sink.write({
        events: [threadCreated("event:laptop-own", at), userMessage("event:stuck", at, "stuck")],
      });
      yield* hub.sql`CREATE TRIGGER refuse_laptop BEFORE INSERT ON orchestration_v2_projection_messages
        WHEN NEW.thread_id = 'thread:on-laptop' BEGIN SELECT RAISE(FAIL, 'refused'); END`;
      // The hub quarantines the refused thread instead of failing the whole pass.
      yield* laptop.sync.sync(hub.environmentId);
      expect(
        yield* hub.sql`SELECT DISTINCT thread_id FROM thread_replication_deferred WHERE reason IS NOT NULL`,
      ).toEqual([{ thread_id: "thread:on-laptop" }]);

      const parentId = ThreadId.make("parent");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      yield* parent.dispatch({
        type: "thread.create",
        commandId: CommandId.make("parent-create"),
        threadId: parentId,
        projectId,
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* parent.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("parent-message"),
        threadId: parentId,
        messageId: MessageId.make("message:parent"),
        text: "Delegate work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* Option.getOrThrow(laptop.worker).drain();
      const run = (yield* parent.getThreadProjection(parentId)).runs[0]!;
      // Also block the opposite bulk stream. The child must bypass both.
      const poison = threadCreated("event:hub-poison", at);
      if (poison.type !== "thread.created") return yield* Effect.die("Missing thread");
      yield* hub.sink.write({
        events: [
          {
            ...poison,
            threadId: ThreadId.make("thread:poison"),
            payload: { ...poison.payload, id: ThreadId.make("thread:poison") },
          },
        ],
      });
      yield* laptop.sql`CREATE TRIGGER refuse_hub BEFORE INSERT ON orchestration_v2_projection_threads
        WHEN NEW.thread_id = 'thread:poison' BEGIN SELECT RAISE(FAIL, 'refused'); END`;
      // The laptop quarantines the refused thread instead of failing the whole pass.
      yield* hub.sync.sync(laptop.environmentId);
      expect(
        yield* laptop.sql`SELECT DISTINCT thread_id FROM thread_replication_deferred WHERE reason IS NOT NULL`,
      ).toEqual([{ thread_id: "thread:poison" }]);
      const before = yield* laptop.replication.cursors(hub.environmentId);
      const accepted = yield* parent.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate-to-hub"),
        parentThreadId: parentId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        machine: hub.environmentId,
        task: "Do the task on the hub",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const task = accepted.storedEvents.find((row) => row.event.type === "subagent.updated")!;
      if (task.event.type !== "subagent.updated") return yield* Effect.die("Missing task");
      const childId = task.event.payload.childThreadId!;
      expect(hub.launched.map((launch) => launch.threadId)).toEqual([childId]);
      expect((yield* parent.getThreadProjection(childId)).thread.ownerMachine).toBe(
        hub.environmentId,
      );
      expect((yield* laptop.replication.cursors(hub.environmentId)).received).toEqual(
        before.received,
      );
      expect((yield* parent.getThreadProjection(childId)).messages[0]?.text).toBe(
        "Do the task on the hub",
      );
      // The parent never reached the hub; the child names it only by id.
      expect(yield* Effect.result(hub.projections.getThreadProjection(parentId))).toMatchObject({
        _tag: "Failure",
      });
      const childEngine = Option.getOrThrow(hub.engine);
      const worker = Option.getOrThrow(hub.worker);
      yield* worker.drain();
      yield* childEngine.streamStoredEventsFrom({ afterSequence: 0, threadId: childId }).pipe(
        Stream.filter((row) => row.event.type === "provider-turn.updated"),
        Stream.take(1),
        Stream.runDrain,
      );
      const child = yield* childEngine.getThreadProjection(childId);
      yield* hub.provider.finish(hub.provider.turns[0]!, child.providerTurns[0]!.id);
      yield* childEngine.streamStoredEventsFrom({ afterSequence: 0, threadId: childId }).pipe(
        Stream.filter(
          (row) =>
            row.event.type === "provider-turn.updated" && row.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* worker.drain();
      yield* childEngine.streamStoredEventsFrom({ afterSequence: 0, threadId: childId }).pipe(
        Stream.filter(
          (row) => row.event.type === "run.updated" && row.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* laptop.tick("remote-delegated-results");
      yield* parent.streamStoredEventsFrom({ afterSequence: 0, threadId: parentId }).pipe(
        Stream.filter(
          (row) => row.event.type === "subagent.updated" && row.event.payload.result !== null,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const finished = yield* parent.getThreadProjection(parentId);
      expect(finished.runs[0]?.delegatedCompletion?.delivery?.taskIds).toContain(
        task.event.payload.id,
      );
      expect((yield* laptop.replication.cursors(hub.environmentId)).received).toEqual(
        before.received,
      );
    }).pipe(Effect.scoped),
  30000,
);

it.live.each([
  "complete",
  "cancel",
  "limit",
  "stopping",
  "attach-refused",
  "slow-progress",
  "replica-refused",
  "legacy",
  "offline",
] as const)(
  "remote delegation: %s, owner execution, replicated results, parent wake and idempotent retry",
  (outcome) =>
    Effect.gen(function* () {
      const hub = yield* startThreadMachine(
        "delegate-hub",
        "cloud-server",
        () => [],
        undefined,
        true,
      );
      let afterLaunch: Effect.Effect<void> = Effect.void;
      const laptop = yield* startThreadMachine(
        "delegate-laptop",
        "computer",
        () => [],
        undefined,
        true,
        undefined,
        false,
        { afterLaunch: () => afterLaunch, legacyDelegation: outcome === "legacy" },
      );
      const proxy = yield* startProxy(hub);
      yield* pair(hub, laptop, proxy.url);
      const poisonAt = yield* DateTime.now;
      yield* laptop.sink.write({ events: [threadCreated("event:bulk-poison", poisonAt)] });
      yield* hub.sql`CREATE TRIGGER refuse_child_bulk BEFORE INSERT ON orchestration_v2_projection_threads
        WHEN NEW.thread_id = 'thread:on-laptop' BEGIN SELECT RAISE(FAIL, 'refused'); END`;
      // The hub quarantines the refused thread instead of failing the whole pass.
      yield* laptop.sync.sync(hub.environmentId);
      expect(
        yield* hub.sql`SELECT DISTINCT thread_id FROM thread_replication_deferred WHERE reason IS NOT NULL`,
      ).toEqual([{ thread_id: "thread:on-laptop" }]);
      const parent = Option.getOrThrow(hub.engine);
      const childEngine = Option.getOrThrow(laptop.engine);
      const parentWorker = Option.getOrThrow(hub.worker);
      const childWorker = Option.getOrThrow(laptop.worker);
      const config = yield* hub.run(ServerConfig.ServerConfig);
      const projectId = ProjectId.make("scratch");
      yield* hub.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'No project',${`${config.baseDir}/scratch`},'[]','2026-10-24T00:00:00Z','2026-10-24T00:00:00Z')`;
      const parentId = ThreadId.make("parent");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      yield* parent.dispatch({
        type: "thread.create",
        commandId: CommandId.make("parent-create"),
        threadId: parentId,
        projectId,
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* parent.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("parent-message"),
        threadId: parentId,
        messageId: MessageId.make("message:parent"),
        text: "Delegate work",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* parentWorker.drain();
      expect(
        hub.provider.turns,
        JSON.stringify((yield* parent.getThreadProjection(parentId)).runs),
      ).toHaveLength(1);
      yield* parent.streamStoredEventsFrom({ afterSequence: 0, threadId: parentId }).pipe(
        Stream.filter((row) => row.event.type === "provider-turn.updated"),
        Stream.take(1),
        Stream.runDrain,
      );
      const run = (yield* parent.getThreadProjection(parentId)).runs[0]!;
      const request = {
        type: "delegated_task.request" as const,
        commandId: CommandId.make("remote-delegate"),
        parentThreadId: parentId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        machine: laptop.environmentId,
        task: "Do the task",
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        completionWake: "always" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      if (outcome === "offline") {
        yield* Effect.sync(() => proxy.server.close());
        yield* proxy.dropAll;
        yield* awaitLinkState(laptop, (view) => view.status !== "online");
        expect(yield* parent.dispatch(request).pipe(Effect.flip)).toMatchObject({
          reason: "offline",
        });
        expect(laptop.launched).toHaveLength(0);
        return;
      }
      if (outcome === "legacy") {
        // A 0.3.2 caller also gets a clear refusal from a new target, before launch.
        const oldCaller = yield* hub.machines
          .call(laptop.environmentId, ThreadLaunchRemote, {
            target: laptop.environmentId,
            commandId: CommandId.make("legacy-launch"),
            threadId: ThreadId.make("legacy-child"),
            project: { kind: "scratch" },
            launch: {
              subagent: {
                parentThreadId: parentId,
                rootThreadId: parentId,
                taskNodeId: NodeId.make("legacy-task"),
              },
              title: "Old caller",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              createdBy: "agent",
              creationSource: "mcp",
            },
            files: [],
          })
          .pipe(Effect.flip);
        expect(oldCaller).toMatchObject({
          reason: "handler-failed",
          error: { reason: "rejected", detail: expect.stringContaining("0.3.3") },
        });
        const error = yield* parent.dispatch(request).pipe(Effect.flip);
        expect(error).toMatchObject({ reason: "rejected" });
        expect(error.message).toContain("0.3.3");
        expect(laptop.launched).toHaveLength(0);
        return;
      }
      if (outcome === "replica-refused") {
        afterLaunch =
          hub.sql`CREATE TRIGGER refuse_child BEFORE INSERT ON orchestration_v2_projection_threads
          WHEN NEW.thread_id = 'thread:delegated-task:remote-delegate'
          BEGIN SELECT RAISE(FAIL, 'refused'); END`.pipe(Effect.asVoid, Effect.orDie);
        yield* parent.dispatch(request).pipe(Effect.flip);
        const childId = laptop.launched[0]!.threadId!;
        const child = yield* childEngine.getThreadProjection(childId);
        expect(child.runs.every((run) => ["interrupted", "cancelled"].includes(run.status))).toBe(
          true,
        );
        expect(yield* hub.sql`SELECT * FROM remote_delegation_intents`).toHaveLength(0);
        // A restart retries an unadopted intent without needing a local child projection.
        yield* hub.sql`INSERT INTO remote_delegation_intents VALUES (
          ${childId}, ${laptop.environmentId}, 'recovered-launch', ${parentId})`;
        yield* hub.tick("remote-delegated-results");
        expect(yield* hub.sql`SELECT * FROM remote_delegation_intents`).toHaveLength(0);
        expect((yield* parent.getThreadProjection(parentId)).subagents).toHaveLength(0);
        return;
      }
      if (outcome === "stopping") {
        yield* parent.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("interrupt-before-delegate"),
          threadId: parentId,
          runId: run.id,
        });
        yield* parent.dispatch(request).pipe(Effect.flip);
        expect(laptop.launched).toHaveLength(0);
        return;
      }
      if (outcome === "attach-refused") {
        afterLaunch = parent
          .dispatch({
            type: "thread.stop",
            commandId: CommandId.make("stop-before-attach"),
            threadId: parentId,
          })
          .pipe(Effect.asVoid, Effect.orDie);
        yield* parent.dispatch(request).pipe(Effect.flip);
        const child = yield* Option.getOrThrow(laptop.engine).getThreadProjection(
          laptop.launched[0]!.threadId!,
        );
        expect(child.runs.every((run) => ["interrupted", "cancelled"].includes(run.status))).toBe(
          true,
        );
        expect((yield* parent.getThreadProjection(parentId)).subagents).toHaveLength(0);
        expect(yield* hub.sql`SELECT * FROM remote_delegation_intents`).toHaveLength(0);
        return;
      }
      const accepted = yield* parent.dispatch(request);
      const task = accepted.storedEvents.find((row) => row.event.type === "subagent.updated")!;
      if (task.event.type !== "subagent.updated") return yield* Effect.die("Missing task");
      const childId = task.event.payload.childThreadId!;
      expect((yield* parent.getThreadProjection(childId)).thread.ownerMachine).toBe(
        laptop.environmentId,
      );
      expect(hub.provider.turns).toHaveLength(1);
      yield* childWorker.drain();
      expect(laptop.provider.turns).toHaveLength(1);
      yield* childEngine.streamStoredEventsFrom({ afterSequence: 0, threadId: childId }).pipe(
        Stream.filter((row) => row.event.type === "provider-turn.updated"),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(laptop.provider.turns).toHaveLength(1);
      expect(laptop.provider.turns[0]?.threadId).toBe(childId);
      const child = yield* childEngine.getThreadProjection(childId);
      expect(child.providerSessions[0]?.id).not.toBe(
        (yield* parent.getThreadProjection(parentId)).providerSessions[0]?.id,
      );
      if (outcome === "limit") {
        const resetAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 3 }));
        yield* laptop.provider.finish(laptop.provider.turns[0]!, child.providerTurns[0]!.id, {
          class: "usage_limit",
          message: "You've hit your usage limit.",
          code: "usageLimitExceeded",
          retryable: true,
          resetAt,
          limitKind: "quota",
        });
        yield* childEngine.streamStoredEventsFrom({ afterSequence: 0, threadId: childId }).pipe(
          Stream.filter(
            (row) => row.event.type === "run.updated" && row.event.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const failed = (yield* childEngine.getThreadProjection(childId)).runs[0]!;
        yield* childEngine.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("arm-remote-recovery"),
          threadId: childId,
          limitRecovery: { runId: failed.id, resetAt, autoResume: true },
        });
        yield* hub.tick("remote-delegated-results");
        yield* parent.recoverDelegatedTasks;
        expect((yield* parent.getThreadProjection(parentId)).subagents[0]?.result).toBeNull();
        // Stop crosses the peer link and ends recovery on the owner.
        yield* parent.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-remote-recovery"),
          threadId: childId,
        });
        yield* parent.recoverDelegatedTasks;
        expect(
          (yield* childEngine.getThreadProjection(childId)).thread.limitRecovery?.autoResume,
        ).toBe(false);
        expect(yield* childEngine.delegatedTaskResultPending(childId)).toBe(false);
        expect(yield* hub.remoteLaunch.resultPending(childId)).toBe(false);
        yield* parent.streamStoredEventsFrom({ afterSequence: 0, threadId: parentId }).pipe(
          Stream.filter(
            (row) => row.event.type === "subagent.updated" && row.event.payload.result !== null,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        expect((yield* parent.getThreadProjection(parentId)).subagents[0]?.result).not.toBeNull();
        return;
      }
      if (outcome === "cancel") {
        yield* parent.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-remote-child"),
          threadId: childId,
        });
        yield* childWorker.drain();
        // The fake provider does not emit on interrupt; close its stream as a real provider does.
        yield* laptop.provider.finish(laptop.provider.turns[0]!, child.providerTurns[0]!.id);
        yield* childEngine.streamStoredEventsFrom({ afterSequence: 0, threadId: childId }).pipe(
          Stream.filter(
            (row) =>
              row.event.type === "provider-turn.updated" &&
              row.event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* childWorker.drain();
        yield* childEngine.streamStoredEventsFrom({ afterSequence: 0, threadId: childId }).pipe(
          Stream.filter(
            (row) => row.event.type === "run.updated" && row.event.payload.status === "interrupted",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* hub.tick("remote-delegated-results");
        yield* parent.recoverDelegatedTasks;
        yield* parent.streamStoredEventsFrom({ afterSequence: 0, threadId: parentId }).pipe(
          Stream.filter(
            (row) =>
              row.event.type === "subagent.updated" && row.event.payload.status === "interrupted",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        expect((yield* parent.getThreadProjection(parentId)).subagents[0]?.status).toBe(
          "interrupted",
        );
        return;
      }
      yield* laptop.provider.finish(laptop.provider.turns[0]!, child.providerTurns[0]!.id);
      yield* childEngine.streamStoredEventsFrom({ afterSequence: 0, threadId: childId }).pipe(
        Stream.filter(
          (row) =>
            row.event.type === "provider-turn.updated" && row.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* childWorker.drain();
      yield* childEngine.streamStoredEventsFrom({ afterSequence: 0, threadId: childId }).pipe(
        Stream.filter(
          (row) => row.event.type === "run.updated" && row.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      if (outcome === "slow-progress") {
        // The peer read remains in flight until a parent command finishes.
        // Holding the parent lock across this read deadlocks both operations.
        yield* hub.remoteLaunch.registerResultPending(() =>
          parent
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("during-peer-progress"),
              threadId: parentId,
              title: "Still responsive",
            })
            .pipe(Effect.as(false), Effect.orDie),
        );
      }
      yield* hub.tick("remote-delegated-results");
      yield* parent.streamStoredEventsFrom({ afterSequence: 0, threadId: parentId }).pipe(
        Stream.filter(
          (row) =>
            row.event.type === "subagent.updated" && row.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const finished = yield* parent.getThreadProjection(parentId);
      expect(finished.subagents[0]?.result).toBeTruthy();
      expect(
        finished.contextTransfers.some((transfer) => transfer.type === "subagent_result"),
      ).toBe(true);
      expect(finished.runs[0]?.delegatedCompletion?.delivery?.taskIds).toContain(
        task.event.payload.id,
      );
      const retry = yield* parent.dispatch(request);
      expect(retry.storedEvents.map((row) => row.event.id)).toEqual(
        accepted.storedEvents.map((row) => row.event.id),
      );
      expect(laptop.launched).toHaveLength(1);
    }).pipe(Effect.scoped),
  30000,
);

it.live("abandon preserves a just-attached cloud child while its parent projection lags", () =>
  Effect.gen(function* () {
    const hub = yield* startThreadMachine("lag-hub", "cloud-server", () => [], undefined, true);
    const laptop = yield* startThreadMachine("lag-laptop", "computer", () => [], undefined, true);
    yield* pair(hub, laptop);
    const parent = Option.getOrThrow(laptop.engine);
    const config = yield* laptop.run(ServerConfig.ServerConfig);
    const projectId = ProjectId.make("scratch");
    yield* laptop.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES (${projectId},'No project',${`${config.baseDir}/scratch`},'[]','2026-10-24T00:00:00Z','2026-10-24T00:00:00Z')`;
    const parentId = ThreadId.make("parent");
    const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    yield* parent.dispatch({
      type: "thread.create",
      commandId: CommandId.make("parent-create"),
      threadId: parentId,
      projectId,
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* parent.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("parent-message"),
      threadId: parentId,
      messageId: MessageId.make("message:parent"),
      text: "Delegate work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* Option.getOrThrow(laptop.worker).drain();
    const run = (yield* parent.getThreadProjection(parentId)).runs[0]!;
    // Simulate a committed attachment whose projection has not caught up.
    yield* laptop.sql`CREATE TRIGGER lag_subagents AFTER INSERT ON orchestration_v2_projection_subagents
        WHEN NEW.origin = 'app_owned' BEGIN DELETE FROM orchestration_v2_projection_subagents
        WHERE subagent_id = NEW.subagent_id; END`;
    const before = yield* laptop.replication.cursors(hub.environmentId);
    const accepted = yield* parent.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-to-hub"),
      parentThreadId: parentId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      machine: hub.environmentId,
      task: "Do the task on the hub",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = accepted.storedEvents.find((row) => row.event.type === "subagent.updated")!;
    if (task.event.type !== "subagent.updated") return yield* Effect.die("Missing task");
    const childId = task.event.payload.childThreadId!;
    expect(hub.launched.map((launch) => launch.threadId)).toEqual([childId]);
    expect((yield* parent.getThreadProjection(childId)).thread.ownerMachine).toBe(
      hub.environmentId,
    );
    expect((yield* laptop.replication.cursors(hub.environmentId)).received).toEqual(
      before.received,
    );
    expect((yield* parent.getThreadProjection(childId)).messages[0]?.text).toBe(
      "Do the task on the hub",
    );

    expect(
      yield* laptop.sql`SELECT 1 FROM orchestration_v2_projection_subagents WHERE child_thread_id = ${childId}`,
    ).toEqual([]);
    expect(
      yield* laptop.sql`SELECT 1 FROM remote_delegation_intents WHERE child_thread_id = ${childId}`,
    ).toEqual([]);
    const stopped =
      yield* hub.sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id LIKE '%abandon-child:%'`;
    expect(stopped).toEqual([]);
  }).pipe(Effect.scoped),
);
