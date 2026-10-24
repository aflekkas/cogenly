/**
 * ThreadLaunchRouting: starting a new thread on another paired machine. The
 * caller sends a portable launch over `threads.launch.v1` (through the hub
 * when both are spokes); the target resolves the project in its own terms,
 * launches through its own ThreadLaunchService so it owns the thread from its
 * first event and runs its first turn, pushes the thread back, then replies.
 * An offline target fails the launch at once; it is never queued. See
 * docs/internals/thread-sync.md.
 */
import {
  type EnvironmentId,
  EventId,
  isRemoteRepositoryPlaceholder,
  type MachineListResult,
  type PeerCallError,
  type ProjectId,
  ProjectLabelId,
  REMOTE_REPOSITORY_ID_PREFIX,
  SharedRepositoryRemote,
  type ThreadLaunchPortable,
  type ThreadLaunchProject,
  ThreadLaunchRemote,
  ThreadRemoteError,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ServerConfig from "../config.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as RemoteThreadLaunch from "../orchestration-v2/RemoteThreadLaunch.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import type * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import type * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import type * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import { readAttachmentFiles, writeAttachmentFiles } from "./attachmentFiles.ts";
import { ensureLocalCheckout } from "./localCheckout.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadSync from "./ThreadSync.ts";

/** A launch answers once its thread exists; provisioning and the turn run after. */
const LAUNCH_TIMEOUT = "2 minutes";

const decodeRemoteError = Schema.decodeUnknownOption(ThreadRemoteError);

/** Drops absent fields, so optional keys stay absent rather than undefined. */
const withoutUndefined = <A extends object>(value: {
  readonly [K in keyof A]-?: A[K] | undefined;
}) => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as A;
const isPortableRemote = Schema.is(SharedRepositoryRemote);

/** Why the local launch refused, in the words its cause gives. */
const launchFailureDetail = (
  error: ThreadLaunch.ThreadLaunchError | { readonly _tag: string; readonly message: string },
) => {
  const cause = "cause" in error ? error.cause : undefined;
  return typeof cause === "object" && cause !== null && "message" in cause
    ? String(cause.message)
    : error.message;
};

const make = Effect.gen(function* () {
  const replication = yield* ThreadReplication.ThreadReplication;
  const threadSync = yield* ThreadSync.ThreadSync;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const registry = yield* RemoteThreadLaunch.RemoteThreadLaunch;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projections = yield* Projections.ProjectionStoreV2;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const sql = yield* SqlClient.SqlClient;
  const context = yield* Effect.context<
    | SqlClient.SqlClient
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | RepositoryCheckout.RepositoryCheckout
    | RepositoryIdentityResolver.RepositoryIdentityResolver
    | ProjectLabelService.ProjectLabelService
  >();
  const self = replication.environmentId;

  const topology = machines.list.pipe(
    Effect.mapError(
      () =>
        new ThreadRemoteError({ reason: "offline", detail: "The machine list could not be read." }),
    ),
  );
  const nameOf = (view: MachineListResult, environmentId: EnvironmentId) =>
    view.machines.find((machine) => machine.environmentId === environmentId)?.name ??
    "That machine";

  /**
   * The directly linked machine a launch on `target` goes to: the target
   * itself from the hub, or the hub, which relays to its spoke.
   */
  const nextHop = (view: MachineListResult, target: EnvironmentId) => {
    const machine = view.machines.find(
      (candidate) => candidate.environmentId === target && candidate.relation !== "this",
    );
    if (machine === undefined || machine.pairing !== "paired")
      return Effect.fail(
        new ThreadRemoteError({
          reason: "rejected",
          detail:
            machine === undefined
              ? "That machine is not paired with this one."
              : `${machine.name} is no longer paired with this machine.`,
        }),
      );
    const hop =
      view.link._tag === "spoke"
        ? view.link.hubEnvironmentId
        : view.link._tag === "hub"
          ? target
          : undefined;
    const reachable = view.machines.some(
      (candidate) =>
        candidate.environmentId === hop && candidate.online && candidate.relation !== "this",
    );
    if (hop === undefined || !reachable || !machine.online)
      return Effect.fail(
        new ThreadRemoteError({
          reason: "offline",
          detail: `${machine.name} is offline. Launch on this machine instead, or try again when it reconnects.`,
        }),
      );
    return Effect.succeed(hop);
  };

  const fromPeer =
    (name: string) =>
    <A>(effect: Effect.Effect<A, PeerCallError | Cause.TimeoutError>) =>
      effect.pipe(
        Effect.mapError((error) => {
          if (error._tag === "PeerCallError" && error.reason === "handler-failed") {
            const remote = decodeRemoteError(error.error);
            if (Option.isSome(remote)) return remote.value;
          }
          if (error._tag === "PeerCallError" && error.reason === "unknown-channel")
            return new ThreadRemoteError({
              reason: "rejected",
              detail: `${name} runs an older version of Cogenly that cannot start threads for another machine. Update it, or launch on this machine.`,
            });
          return new ThreadRemoteError({ reason: "offline", detail: `${name} did not answer.` });
        }),
      );

  const callTarget = (
    view: MachineListResult,
    payload: (typeof ThreadLaunchRemote)["payload"]["Type"],
  ) =>
    Effect.gen(function* () {
      const hop = yield* nextHop(view, payload.target);
      return yield* machines
        .call(hop, ThreadLaunchRemote, payload)
        .pipe(Effect.timeout(LAUNCH_TIMEOUT), fromPeer(nameOf(view, payload.target)));
    });

  /** The project link a remote sits under; `preferred` first, as it is the launch's own. */
  const linkingProject = (remote: string, preferred: ProjectLabelId | undefined) =>
    sql<{ readonly label_id: string }>`SELECT label_id FROM label_repositories
      WHERE remote = ${remote}
      ORDER BY CASE WHEN label_id = ${preferred ?? ""} THEN 0 ELSE 1 END, label_id
      LIMIT 1`.pipe(
      Effect.map((rows) =>
        rows[0] === undefined ? undefined : ProjectLabelId.make(rows[0].label_id),
      ),
      Effect.orDie,
    );

  /** The launch's project in terms the target can map: its scratch folder or a remote. */
  const portableProject = Effect.fn("ThreadLaunchRouting.portableProject")(function* (
    input: ThreadLaunch.ThreadLaunchInput,
    targetName: string,
  ) {
    const remote = isRemoteRepositoryPlaceholder(input.projectId)
      ? input.projectId.slice(REMOTE_REPOSITORY_ID_PREFIX.length)
      : yield* replication
          .projectSource(input.projectId)
          .pipe(Effect.map((source) => (source.kind === "scratch" ? null : source.remote)));
    if (remote === null) return { kind: "scratch" } satisfies ThreadLaunchProject;
    if (remote === undefined || !isPortableRemote(remote))
      return yield* new ThreadRemoteError({
        reason: "needs-repository",
        detail: `This repository has no remote ${targetName} could clone. Launch on this machine instead.`,
      });
    const labelId = yield* linkingProject(remote, input.projectFolderId);
    return {
      kind: "repository",
      remote,
      ...(labelId === undefined ? {} : { labelId }),
    } satisfies ThreadLaunchProject;
  });

  /** On the target: this machine's project for a portable one, cloning a missing checkout. */
  const localProject = Effect.fn("ThreadLaunchRouting.localProject")(function* (
    project: ThreadLaunchProject,
  ) {
    if (project.kind === "scratch")
      return (yield* folders.ensureScratchProject.pipe(
        Effect.mapError(
          (error) =>
            new ThreadRemoteError({
              reason: "rejected",
              detail: `This machine has no "No project" folder for it: ${error.message}`,
            }),
        ),
      )).projectId;
    const existing = yield* replication.localProject({
      kind: "repository",
      remote: project.remote,
    });
    if (existing !== undefined) return existing;
    const labelId = yield* linkingProject(project.remote, project.labelId);
    if (labelId === undefined) {
      const view = yield* topology;
      return yield* new ThreadRemoteError({
        reason: "needs-repository",
        detail: `${nameOf(view, self)} has no project that links ${project.remote}. Add the repository to a project there, or launch on this machine.`,
      });
    }
    return yield* ensureLocalCheckout(labelId, project.remote).pipe(Effect.provideContext(context));
  });

  const portableLaunch = (
    input: ThreadLaunch.ThreadLaunchInput,
    workspaceStrategy: ThreadLaunchPortable["workspaceStrategy"],
  ) =>
    withoutUndefined<ThreadLaunchPortable>({
      surface: input.surface,
      workOrigin: input.workOrigin,
      sourceThreadId: input.sourceThreadId,
      sourceAgentId: input.sourceAgentId,
      sourceAgentRunId: input.sourceAgentRunId,
      agent: input.agent,
      title: input.title,
      generateTitle: input.generateTitle,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      workspaceStrategy,
      projectFolderId: input.projectFolderId,
      initialMessage: input.initialMessage,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });

  yield* registry.register((machine, input) =>
    Effect.gen(function* () {
      if (machine === self) return Option.none();
      const view = yield* topology;
      const name = nameOf(view, machine);
      yield* nextHop(view, machine);
      const strategy = input.workspaceStrategy;
      if (strategy.type === "existing_worktree")
        return yield* new ThreadRemoteError({
          reason: "rejected",
          detail: `An existing worktree is a folder on this machine. Start a new worktree on ${name}, or launch on this machine.`,
        });
      if (input.reuseExistingThread === true || input.importedNativeThread !== undefined)
        return yield* new ThreadRemoteError({
          reason: "rejected",
          detail: `Only a new thread can start on ${name}.`,
        });
      const project = yield* portableProject(input, name);
      const files = yield* readAttachmentFiles(input.initialMessage?.attachments ?? []).pipe(
        Effect.provideContext(context),
      );
      const result = yield* callTarget(view, {
        target: machine,
        commandId: input.commandId,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        project,
        launch: portableLaunch(input, strategy),
        files,
      });
      // The target pushed the thread here before it answered.
      const projection = yield* projections.getThreadProjection(result.threadId).pipe(
        Effect.mapError(
          () =>
            new ThreadRemoteError({
              reason: "rejected",
              detail: `The thread started on ${name} but has not reached this machine yet. It appears once it does.`,
            }),
        ),
      );
      return Option.some({ threadId: result.threadId, projection, resumed: result.resumed });
    }),
  );

  yield* channels.register(ThreadLaunchRemote, (payload, caller) =>
    Effect.gen(function* () {
      if (payload.target !== self) {
        const view = yield* topology;
        // Only the hub relays, and never back to the machine that asked.
        if (view.link._tag !== "hub" || payload.target === caller.environmentId)
          return yield* new ThreadRemoteError({ reason: "not-owner" });
        const relayed = yield* callTarget(view, payload);
        yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
        return relayed;
      }
      const projectId: ProjectId = yield* localProject(payload.project);
      yield* writeAttachmentFiles(payload.files).pipe(Effect.provideContext(context));
      const result = yield* launches
        .launch({
          ...payload.launch,
          commandId: payload.commandId,
          ...(payload.threadId === undefined ? {} : { threadId: payload.threadId }),
          projectId,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ThreadRemoteError({ reason: "rejected", detail: launchFailureDetail(error) }),
          ),
        );
      // The caller's projection shows the thread by the time it hears back.
      yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
      const last = yield* sql<{ readonly event_id: string }>`SELECT event_id
        FROM orchestration_events
        WHERE stream_id = ${result.threadId} AND aggregate_kind = 'thread'
        ORDER BY sequence DESC LIMIT 1`.pipe(Effect.orDie);
      return {
        threadId: result.threadId,
        resumed: result.resumed,
        eventIds: last.map((row) => EventId.make(row.event_id)),
      };
    }),
  );
});

/** Registers the launcher and the target handler for the scope of the machine link. */
export const layer = Layer.effectDiscard(make);
