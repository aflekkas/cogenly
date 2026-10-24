import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2ProviderThread,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Rollback from "./CheckpointRollbackService.ts";
import * as Checkpoints from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as Projections from "./ProjectionStore.ts";
import * as Projects from "./ProjectStore.ts";
import * as Sessions from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadCommands from "./ThreadCommandExecutor.ts";

for (const movedCwd of [true, false]) {
  it.effect(
    `a missing pre-move checkpoint fails before filesystem or provider changes (${movedCwd ? "old cwd" : "missing ref"})`,
    () =>
      Effect.gen(function* () {
        const id = ThreadId.make("thread:checkpoint-moved");
        const at = yield* DateTime.now;
        const providerThreadId = ProviderThreadId.make("provider-thread:moved");
        const scopeId = CheckpointScopeId.make("scope:moved");
        const checkpointId = CheckpointId.make("checkpoint:moved");
        const base = idleThreadProjection(liveThreadShell(id));
        const projection = {
          ...base,
          thread: {
            ...base.thread,
            activeProviderThreadId: providerThreadId,
            branch: "feature/moved",
            worktreePath: "/new-machine/worktree",
          },
          providerThreads: [
            yield* Schema.decodeUnknownEffect(OrchestrationV2ProviderThread)({
              id: providerThreadId,
              driver: "codex",
              providerInstanceId: base.thread.modelSelection.instanceId,
              providerSessionId: ProviderSessionId.make("session:old-machine"),
              appThreadId: id,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: at,
              updatedAt: at,
            }),
          ],
          checkpointScopes: [
            {
              id: scopeId,
              threadId: id,
              runId: null,
              nodeId: NodeId.make("node:scope"),
              parentScopeId: null,
              providerThreadId,
              kind: "root_run" as const,
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: movedCwd ? "/old-machine/worktree" : "/new-machine/worktree",
              createdAt: at,
            },
          ],
          checkpoints: [
            {
              id: checkpointId,
              threadId: id,
              scopeId,
              runId: null,
              nodeId: NodeId.make("node:scope"),
              parentCheckpointId: null,
              ordinalWithinScope: 0,
              appRunOrdinal: null,
              ref: CheckpointRef.make("refs/t3/missing"),
              status: "ready" as const,
              files: [],
              capturedAt: at,
            },
          ],
        };
        const touched: Array<string> = [];
        const forbidden = (operation: string) => () =>
          Effect.sync(() => {
            touched.push(operation);
          }).pipe(Effect.andThen(Effect.die("unexpected side effect")));
        let reads = 0;
        const checkpoints = Checkpoints.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(CheckpointStore.CheckpointStore)({
                hasCheckpointRef: () =>
                  Effect.sync(() => {
                    reads++;
                    return false;
                  }),
                restoreCheckpoint: forbidden("restore"),
              }),
              IdAllocator.layer,
            ),
          ),
        );
        const runtime = Rollback.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              checkpoints,
              IdAllocator.layer,
              ThreadCommands.layer,
              Layer.mock(Projections.ProjectionStoreV2)({
                getThreadRecords: () => Effect.succeed(projection),
              }),
              Layer.mock(GitWorkflow.GitWorkflowService)({
                pruneWorktrees: forbidden("prune"),
                createWorktree: forbidden("create"),
              }),
              Layer.mock(Sessions.ProviderSessionManagerV2)({ open: forbidden("provider") }),
              Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: forbidden("policy") }),
              Layer.mock(Projects.ProjectStoreV2)({ get: forbidden("project") }),
              Layer.mock(EventSink.EventSinkV2)({ write: forbidden("write") }),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );
        const result = yield* Effect.gen(function* () {
          const rollback = yield* Rollback.CheckpointRollbackServiceV2;
          return yield* rollback
            .execute({ threadId: id, providerThreadId, checkpointId, scopeId })
            .pipe(Effect.flip);
        }).pipe(Effect.provide(runtime));
        expect(result.reason).toBe("checkpoint-unavailable");
        expect(reads).toBe(movedCwd ? 0 : 1);
        expect(touched).toEqual([]);
      }),
  );
}
