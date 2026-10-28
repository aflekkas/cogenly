/**
 * The seam where ThreadLaunchService hands a launch for another machine to
 * thread sync, which registers the launcher once the machine link exists.
 * Kept as a registry, like RemoteThreadCommands, so orchestration does not
 * depend on the machine link.
 */
import {
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ScheduledTaskRunNowInput,
  type AgentId,
  type AgentUpsertInput,
  type AgentMutationResult,
  type EnvironmentId,
  type OrchestrationV2ServerCommand,
  ThreadMachineCatalog,
  type ThreadId,
  type NodeId,
  ThreadRemoteError,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type { OrchestratorV2DispatchResult } from "./Orchestrator.ts";
import type { ThreadLaunchInput, ThreadLaunchResult } from "./ThreadLaunchService.ts";

/**
 * None when `machine` is this one, so the launch runs here; otherwise the
 * result of launching on `machine`, read from the replica it pushed here.
 */
export type RemoteThreadLauncher = (
  machine: EnvironmentId,
  input: ThreadLaunchInput,
) => Effect.Effect<Option.Option<ThreadLaunchResult>, ThreadRemoteError>;

export type RemoteDelegation = (
  command: Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>,
) => Effect.Effect<OrchestratorV2DispatchResult, ThreadRemoteError>;

export type RemoteMachineCatalog = (
  machine: EnvironmentId,
) => Effect.Effect<Option.Option<typeof ThreadMachineCatalog.success.Type>, ThreadRemoteError>;

export type RemoteTaskPending = (
  threadId: ThreadId,
  taskId?: NodeId,
) => Effect.Effect<boolean | undefined, ThreadRemoteError>;

export type RemoteAgentCreate = (
  machine: EnvironmentId,
  input: AgentUpsertInput,
  agentId: AgentId,
  callerAgentId?: AgentId,
) => Effect.Effect<AgentMutationResult, ThreadRemoteError>;

export type RemoteAgentDelete = (
  machine: EnvironmentId,
  id: AgentId,
  callerAgentId?: AgentId,
) => Effect.Effect<{ deleted: boolean }, ThreadRemoteError>;

export type RemoteTaskBranch = (
  threadId: ThreadId,
  resultKey: string,
) => Effect.Effect<string | undefined, ThreadRemoteError>;

export type RemoteScheduleUpsert = (
  owner: EnvironmentId,
  input: ScheduledTaskUpsertInput,
) => Effect.Effect<{ task: ScheduledTask }, ThreadRemoteError>;
export type RemoteScheduleRun = (
  owner: EnvironmentId,
  input: ScheduledTaskRunNowInput,
) => Effect.Effect<{ task: ScheduledTask }, ThreadRemoteError>;

export class RemoteThreadLaunch extends Context.Service<
  RemoteThreadLaunch,
  {
    readonly register: (launcher: RemoteThreadLauncher) => Effect.Effect<void, never, Scope.Scope>;
    readonly launch: RemoteThreadLauncher;
    readonly registerDelegation: (
      delegate: RemoteDelegation,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly delegate: RemoteDelegation;
    readonly catalog: RemoteMachineCatalog;
    readonly upsertSchedule: RemoteScheduleUpsert;
    readonly runSchedule: RemoteScheduleRun;
    readonly registerSchedules: (handlers: {
      upsert: RemoteScheduleUpsert;
      run: RemoteScheduleRun;
    }) => Effect.Effect<void, never, Scope.Scope>;
    readonly copyResult: RemoteTaskBranch;
    readonly registerCopyResult: (
      copy: RemoteTaskBranch,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly deleteAgent: RemoteAgentDelete;
    readonly registerAgentDelete: (
      remove: RemoteAgentDelete,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly createAgent: RemoteAgentCreate;
    readonly registerAgentCreate: (
      create: RemoteAgentCreate,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly resultPending: RemoteTaskPending;
    readonly registerResultPending: (
      reader: RemoteTaskPending,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly registerCatalog: (
      catalog: RemoteMachineCatalog,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("cogenly-server/orchestration-v2/RemoteThreadLaunch") {}

export const layer = Layer.effect(
  RemoteThreadLaunch,
  Effect.gen(function* () {
    const current = yield* Ref.make<RemoteThreadLauncher | undefined>(undefined);
    const delegation = yield* Ref.make<RemoteDelegation | undefined>(undefined);
    const catalog = yield* Ref.make<RemoteMachineCatalog | undefined>(undefined);
    const progress = yield* Ref.make<RemoteTaskPending | undefined>(undefined);
    const agentDeletion = yield* Ref.make<RemoteAgentDelete | undefined>(undefined);
    const agents = yield* Ref.make<RemoteAgentCreate | undefined>(undefined);
    const results = yield* Ref.make<RemoteTaskBranch | undefined>(undefined);
    const schedules = yield* Ref.make<
      { upsert: RemoteScheduleUpsert; run: RemoteScheduleRun } | undefined
    >(undefined);
    return RemoteThreadLaunch.of({
      registerSchedules: (handlers) =>
        Effect.acquireRelease(Ref.set(schedules, handlers), () => Ref.set(schedules, undefined)),
      upsertSchedule: (owner, input) =>
        Ref.get(schedules).pipe(
          Effect.flatMap((handlers) =>
            handlers === undefined
              ? Effect.fail(new ThreadRemoteError({ reason: "offline" }))
              : handlers.upsert(owner, input),
          ),
        ),
      runSchedule: (owner, input) =>
        Ref.get(schedules).pipe(
          Effect.flatMap((handlers) =>
            handlers === undefined
              ? Effect.fail(new ThreadRemoteError({ reason: "offline" }))
              : handlers.run(owner, input),
          ),
        ),
      registerCopyResult: (copy) =>
        Effect.acquireRelease(Ref.set(results, copy), () => Ref.set(results, undefined)),
      copyResult: (threadId, key) =>
        Ref.get(results).pipe(
          Effect.flatMap((copy) =>
            copy === undefined ? Effect.succeed(undefined) : copy(threadId, key),
          ),
        ),
      registerAgentDelete: (remove) =>
        Effect.acquireRelease(Ref.set(agentDeletion, remove), () =>
          Ref.set(agentDeletion, undefined),
        ),
      deleteAgent: (machine, id, callerAgentId) =>
        Ref.get(agentDeletion).pipe(
          Effect.flatMap((remove) =>
            remove === undefined
              ? Effect.fail(new ThreadRemoteError({ reason: "offline" }))
              : remove(machine, id, callerAgentId),
          ),
        ),
      registerAgentCreate: (create) =>
        Effect.acquireRelease(Ref.set(agents, create), () => Ref.set(agents, undefined)),
      createAgent: (machine, input, agentId, callerAgentId) =>
        Ref.get(agents).pipe(
          Effect.flatMap((create) =>
            create === undefined
              ? Effect.fail(
                  new ThreadRemoteError({
                    reason: "offline",
                    detail: "Machine agent creation is unavailable.",
                  }),
                )
              : create(machine, input, agentId, callerAgentId),
          ),
        ),
      registerResultPending: (reader) =>
        Effect.acquireRelease(Ref.set(progress, reader), () => Ref.set(progress, undefined)),
      resultPending: (threadId, taskId) =>
        Ref.get(progress).pipe(
          Effect.flatMap((reader) =>
            reader === undefined ? Effect.succeed(undefined) : reader(threadId, taskId),
          ),
        ),
      registerCatalog: (reader) =>
        Effect.acquireRelease(Ref.set(catalog, reader), () => Ref.set(catalog, undefined)),
      catalog: (machine) =>
        Ref.get(catalog).pipe(
          Effect.flatMap((reader) =>
            reader === undefined
              ? Effect.fail(new ThreadRemoteError({ reason: "offline" }))
              : reader(machine),
          ),
        ),
      registerDelegation: (delegate) =>
        Effect.acquireRelease(Ref.set(delegation, delegate), () => Ref.set(delegation, undefined)),
      delegate: (command) =>
        Ref.get(delegation).pipe(
          Effect.flatMap((delegate) =>
            delegate === undefined
              ? Effect.fail(
                  new ThreadRemoteError({
                    reason: "offline",
                    detail: "Machine delegation is unavailable. Omit machine to run here.",
                  }),
                )
              : delegate(command),
          ),
        ),
      register: (launcher) =>
        Effect.acquireRelease(Ref.set(current, launcher), () => Ref.set(current, undefined)),
      launch: (machine, input) =>
        Ref.get(current).pipe(
          Effect.flatMap((launcher) =>
            launcher === undefined
              ? Effect.fail(
                  new ThreadRemoteError({
                    reason: "rejected",
                    detail: "This server cannot reach other machines.",
                  }),
                )
              : launcher(machine, input),
          ),
        ),
    });
  }),
);
