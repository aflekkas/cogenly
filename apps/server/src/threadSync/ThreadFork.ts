import {
  type ThreadForkMachineInput,
  type ThreadForkMachineResult,
  ThreadForkRequest,
  ThreadRemoteError,
  ProjectLabelId,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Git from "../git/GitWorkflowService.ts";
import * as Channels from "../machines/PeerChannels.ts";
import * as Events from "../orchestration-v2/EventStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { isForkableSourceRunStatus } from "../orchestration-v2/ThreadForkService.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as Replication from "./ThreadReplication.ts";
import * as Routing from "./ThreadRouting.ts";
import * as Sync from "./ThreadSync.ts";

export class ThreadFork extends Context.Service<
  ThreadFork,
  {
    readonly fork: (
      input: ThreadForkMachineInput,
      provenance?: Threads.ThreadManagementProvenance,
    ) => Effect.Effect<ThreadForkMachineResult, ThreadRemoteError>;
  }
>()("cogenly-server/threadSync/ThreadFork") {}

const make = Effect.gen(function* () {
  const replication = yield* Replication.ThreadReplication;
  const routing = yield* Routing.ThreadRouting;
  const sync = yield* Sync.ThreadSync;
  const channels = yield* Channels.PeerChannels;
  const launches = yield* Launch.ThreadLaunchService;
  const threads = yield* Threads.ThreadManagementService;
  const projections = yield* Projections.ProjectionStoreV2;
  const projects = yield* Projects.ProjectStoreV2;
  const events = yield* Events.EventStoreV2;
  const git = yield* Git.GitWorkflowService;
  const sql = yield* SqlClient.SqlClient;
  const self = replication.environmentId;
  const fork: ThreadFork["Service"]["fork"] = Effect.fn("ThreadFork.fork")(function* (
    input,
    provenance = { createdBy: "user", creationSource: "web" },
  ) {
    if (input.sourceThreadId === input.targetThreadId)
      return yield* new ThreadRemoteError({
        reason: "rejected",
        detail: "A fork needs a new thread ID.",
      });
    const source = yield* projections.getThreadProjection(input.sourceThreadId).pipe(Effect.orDie);
    const limit = yield* DispatchModeLimit;
    if (limit !== undefined && exceededDispatchModeLimit(limit, source.thread) !== undefined)
      return yield* new ThreadRemoteError({
        reason: "rejected",
        detail: "This fork exceeds the caller's runtime mode.",
      });
    const owner = yield* replication.owner(input.sourceThreadId);
    if (owner?.handoff != null) return yield* new ThreadRemoteError({ reason: "moving" });
    if (owner !== undefined && !owner.local)
      return yield* routing.callMachine(
        owner.owner,
        ThreadForkRequest,
        {
          owner: owner.owner,
          input,
          ...provenance,
        },
        "2 minutes",
      );
    const existing = yield* projections
      .getThreadProjection(input.targetThreadId)
      .pipe(Effect.option);
    if (Option.isSome(existing)) {
      if (
        existing.value.thread.lineage.parentThreadId !== input.sourceThreadId ||
        existing.value.thread.lineage.relationshipToParent !== "fork" ||
        (existing.value.thread.ownerMachine ?? self) !== input.machine
      )
        return yield* new ThreadRemoteError({
          reason: "rejected",
          detail: "That target thread already exists.",
        });
      const repository = existing.value.contextTransfers.find(
        (transfer) => transfer.targetThreadId === input.targetThreadId && transfer.type === "fork",
      )?.repository;
      return {
        targetThreadId: input.targetThreadId,
        sequence: yield* events
          .latestSequence({ threadId: input.targetThreadId })
          .pipe(Effect.orDie),
        branch: repository === undefined ? existing.value.thread.branch : repository.branch,
        commit: repository?.commit ?? null,
        usedLastPushed: repository?.usedLastPushed ?? false,
      };
    }
    const point = input.sourcePoint;
    const checkpoint =
      point?.type === "checkpoint"
        ? source.checkpoints.find((item) => item.id === point.checkpointId)
        : undefined;
    const run =
      point?.type === "run"
        ? source.runs.find((run) => run.id === point.runId)
        : point?.type === "checkpoint"
          ? source.runs.find((run) => run.id === checkpoint?.runId)
          : source.runs
              .filter((run) => isForkableSourceRunStatus(run.status))
              .toSorted((a, b) => b.ordinal - a.ordinal)[0];
    if (run === undefined || !isForkableSourceRunStatus(run.status))
      return yield* new ThreadRemoteError({
        reason: "busy",
        detail:
          "No finished turn is available to fork. Wait for a turn to finish or choose an earlier response.",
      });
    if (input.machine === self) {
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId: input.commandId,
          sourceThreadId: input.sourceThreadId,
          targetThreadId: input.targetThreadId,
          sourcePoint: { type: "run", runId: run.id },
          ...(input.title === undefined ? {} : { title: input.title }),
          ...provenance,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ThreadRemoteError({
                reason: "rejected",
                detail: "This conversation could not be forked.",
              }),
          ),
        );
      return {
        targetThreadId: input.targetThreadId,
        sequence: result.sequence,
        branch: source.thread.branch,
        commit: null,
        usedLastPushed: false,
      };
    }
    const portableProject = yield* replication.projectSource(source.thread.projectId);
    const project = yield* projects
      .get(source.thread.projectId)
      .pipe(Effect.orDie, Effect.map(Option.getOrThrow));
    if (
      portableProject.kind === "local" ||
      (portableProject.kind === "repository" && portableProject.remote === null)
    )
      return yield* new ThreadRemoteError({
        reason: "needs-repository",
        detail: "Link this repository's remote to its project before forking to another machine.",
      });
    const repository =
      portableProject.kind === "scratch"
        ? undefined
        : yield* git.forkSource({
            remote: portableProject.remote!,
            cwd: source.thread.worktreePath ?? project.workspaceRoot,
            ...(input.allowLastPushed === undefined
              ? {}
              : { allowLastPushed: input.allowLastPushed }),
          });
    const { providers } = yield* launches.providers(input.machine).pipe(
      Effect.mapError(
        () =>
          new ThreadRemoteError({
            reason: "offline",
            detail: "The target's provider catalog is unavailable.",
          }),
      ),
    );
    const ready = providers.filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.availability !== "unavailable" &&
        provider.status !== "error" &&
        provider.models.length > 0,
    );
    const driver = source.providerThreads.find(
      (item) => item.id === source.thread.activeProviderThreadId,
    )?.driver;
    const provider =
      ready.find((provider) => provider.instanceId === source.thread.modelSelection.instanceId) ??
      ready.find((provider) => provider.driver === driver) ??
      ready[0];
    if (provider === undefined)
      return yield* new ThreadRemoteError({
        reason: "rejected",
        detail: "No provider is ready on the target machine. Set one up before forking.",
      });
    const model =
      provider.models.find((model) => model.slug === source.thread.modelSelection.model) ??
      provider.models.find((model) => model.isDefault) ??
      provider.models[0]!;
    const folders = yield* sql<{
      readonly label_id: string;
    }>`SELECT label_id FROM thread_project_labels WHERE thread_id = ${input.sourceThreadId}`.pipe(
      Effect.orDie,
    );
    const launched = yield* launches
      .launch({
        commandId: input.commandId,
        threadId: input.targetThreadId,
        machine: input.machine,
        projectId: source.thread.projectId,
        title: input.title ?? `${source.thread.title} fork`,
        modelSelection:
          provider.instanceId === source.thread.modelSelection.instanceId &&
          model.slug === source.thread.modelSelection.model
            ? source.thread.modelSelection
            : { instanceId: provider.instanceId, model: model.slug },
        runtimeMode: source.thread.runtimeMode,
        interactionMode: source.thread.interactionMode,
        workspaceStrategy: {
          type: "root",
          ...(repository?.branch == null ? {} : { branch: repository.branch }),
        },
        fork: {
          sourceThreadId: input.sourceThreadId,
          sourcePoint: { type: "run", runId: run.id },
          ...(repository === undefined ? {} : { repository }),
        },
        ...(folders[0] === undefined
          ? {}
          : { projectFolderId: ProjectLabelId.make(folders[0].label_id) }),
        ...provenance,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            Launch.remoteLaunchFailure(cause) ??
            new ThreadRemoteError({
              reason: "rejected",
              detail: "The target could not create the fork. The source conversation is unchanged.",
            }),
        ),
      );
    // The target may be replaying an accepted launch whose first reply was lost.
    // Report its durable snapshot even if the source has advanced since then.
    const placedRepository = launched.projection.contextTransfers.find(
      (transfer) => transfer.targetThreadId === input.targetThreadId && transfer.type === "fork",
    )?.repository;
    return {
      targetThreadId: input.targetThreadId,
      sequence: yield* events.latestSequence({ threadId: input.targetThreadId }).pipe(Effect.orDie),
      branch:
        placedRepository === undefined
          ? launched.projection.thread.branch
          : placedRepository.branch,
      commit: placedRepository?.commit ?? null,
      usedLastPushed: placedRepository?.usedLastPushed ?? false,
    };
  });
  yield* channels.register(ThreadForkRequest, (payload, caller) =>
    Effect.gen(function* () {
      const result =
        payload.owner === self
          ? yield* fork(payload.input, {
              createdBy: payload.createdBy,
              creationSource: payload.creationSource,
            })
          : yield* routing.callMachine(payload.owner, ThreadForkRequest, payload, "2 minutes");
      yield* sync.sync(caller.environmentId).pipe(
        Effect.mapError(
          () =>
            new ThreadRemoteError({
              reason: "behind",
              detail:
                "The fork exists but has not reached this client. Retry with the same target thread ID.",
            }),
        ),
      );
      return result;
    }),
  );
  return ThreadFork.of({ fork });
});
export const layer = Layer.effect(ThreadFork, make);
