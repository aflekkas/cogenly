import { expect, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import { pair } from "../machines/testkit.ts";
import { startThreadMachine } from "./testkit.ts";

for (const outcome of ["complete", "cancel", "limit"] as const)
  it.live(
    `remote delegation: ${outcome}, owner execution, replicated results, parent wake and idempotent retry`,
    () =>
      Effect.gen(function* () {
        const hub = yield* startThreadMachine(
          "delegate-hub",
          "cloud-server",
          () => [],
          undefined,
          true,
        );
        const laptop = yield* startThreadMachine(
          "delegate-laptop",
          "computer",
          () => [],
          undefined,
          true,
        );
        yield* pair(hub, laptop);
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
          yield* laptop.sync.sync(hub.environmentId);
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
              (row) =>
                row.event.type === "run.updated" && row.event.payload.status === "interrupted",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* laptop.sync.sync(hub.environmentId);
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
              row.event.type === "provider-turn.updated" &&
              row.event.payload.status === "completed",
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
        yield* laptop.sync.sync(hub.environmentId);
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
