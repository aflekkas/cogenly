import * as Membership from "../projectLabels/ProjectRepositoryMembership.ts";
/**
 * ThreadLaunchRouting: starting a new thread on another paired machine. The
 * caller sends a portable launch over `threads.launch.v1` (through the hub
 * when both are spokes); the target resolves the project in its own terms,
 * launches through its own ThreadLaunchService so it owns the thread from its
 * first event and runs its first turn. Delegated callers fetch that child on
 * the priority channel; other launches push history before replying.
 * An offline target fails the launch at once; it is never queued. See
 * docs/internals/thread-sync.md.
 */
import {
  CommandId,
  type EnvironmentId,
  EventId,
  isRemoteRepositoryPlaceholder,
  type MachineListResult,
  type PeerCallError,
  ProjectId,
  ProjectLabelId,
  REMOTE_REPOSITORY_ID_PREFIX,
  SharedRepositoryRemote,
  type ThreadLaunchPortable,
  type ThreadLaunchProject,
  ThreadLaunchRemote,
  ThreadCommandForward,
  ThreadId,
  EnvironmentId as EnvironmentIdSchema,
  ThreadMachineCatalog,
  ThreadTaskProgress,
  ThreadAgentCreate,
  ThreadTaskBranch,
  ThreadScheduleUpsert,
  ThreadScheduleRun,
  ThreadRemoteError,
} from "@cogenly/contracts";
import { exportBundle, importBundle } from "./repositoryBundle.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as AgentService from "../agents/AgentService.ts";
import * as SharedSync from "../sync/SharedSync.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { derive } from "@cogenly/provider-core/server/IdAllocator";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Crypto from "effect/Crypto";
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
import * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import type * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import type * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import { readAttachmentFiles, writeAttachmentFiles } from "./attachmentFiles.ts";
import { ensureLocalCheckout } from "./localCheckout.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadRouting from "./ThreadRouting.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
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
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* Projections.ProjectionStoreV2;
  const projects = yield* Projects.ProjectStoreV2;
  const checkout = yield* RepositoryCheckout.RepositoryCheckout;
  const agentService = yield* Effect.serviceOption(AgentService.AgentService);
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks.ScheduledTaskService);
  const sharedSync = yield* SharedSync.SharedSync;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const sql = yield* SqlClient.SqlClient;
  const membership = yield* Membership.ProjectRepositoryMembership;
  const context = yield* Effect.context<
    | SqlClient.SqlClient
    | Git.GitVcsDriver
    | FileSystem.FileSystem
    | Crypto.Crypto
    | Path.Path
    | ServerConfig.ServerConfig
    | RepositoryCheckout.RepositoryCheckout
    | RepositoryIdentityResolver.RepositoryIdentityResolver
    | ProjectLabelService.ProjectLabelService
  >();
  const self = replication.environmentId;
  const routing = yield* ThreadRouting.ThreadRouting;
  const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const orchestrator = yield* Effect.serviceOption(Orchestrator.OrchestratorV2);
  const scheduler = yield* Scheduler.Scheduler;
  const crypto = yield* Crypto.Crypto;
  const creating = new Set<string>();
  const abandon = (childThreadId: ThreadId, target: EnvironmentId, commandId: CommandId) =>
    Effect.gen(function* () {
      // A committed parent link wins, including a crash just after attachment.
      const attached = yield* sql`SELECT 1 FROM orchestration_v2_projection_subagents
        WHERE child_thread_id = ${childThreadId} AND origin = 'app_owned'`;
      if (attached.length === 0)
        yield* routing.callMachine(
          target,
          ThreadCommandForward,
          {
            command: {
              type: "thread.stop",
              commandId: CommandId.make(
                `${commandId}:abandon-child:${yield* crypto.randomUUIDv4()}`,
              ),
              threadId: childThreadId,
            },
            files: [],
            priority: true,
          },
          "30 seconds",
        );
      yield* sql`DELETE FROM remote_delegation_intents WHERE child_thread_id = ${childThreadId}`;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Remote delegation cleanup deferred until reconnect", {
          childThreadId,
          reason: error._tag,
        }),
      ),
    );
  if (Option.isSome(orchestrator)) {
    yield* scheduler.register(
      "remote-delegated-results",
      Effect.gen(function* () {
        if ((yield* machines.list).link._tag === "standalone") return;
        const abandoned = yield* sql<{
          readonly child_thread_id: string;
          readonly target: string;
          readonly command_id: string;
        }>`SELECT child_thread_id, target, command_id FROM remote_delegation_intents`;
        yield* Effect.forEach(
          abandoned.filter((row) => !creating.has(row.child_thread_id)),
          (row) =>
            abandon(
              ThreadId.make(row.child_thread_id),
              EnvironmentIdSchema.make(row.target),
              CommandId.make(row.command_id),
            ),
          { concurrency: 8, discard: true },
        );
        // Pending parent links are durable, so reconnect/restart resumes tracking.
        const pending = yield* sql<{
          readonly child_thread_id: string;
          readonly owner_env: string;
        }>`
          SELECT DISTINCT s.child_thread_id, o.owner_env
          FROM orchestration_v2_projection_subagents s
          JOIN thread_owners o ON o.thread_id = s.child_thread_id AND o.local = 0
          WHERE s.origin = 'app_owned' AND json_extract(s.payload_json, '$.result') IS NULL
            AND NOT EXISTS (SELECT 1 FROM thread_owners p WHERE p.thread_id = s.thread_id AND p.local = 0)`;
        yield* Effect.forEach(
          pending,
          (row) =>
            routing
              .refreshDelegated(
                EnvironmentIdSchema.make(row.owner_env),
                ThreadId.make(row.child_thread_id),
              )
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Remote delegated tracking deferred", {
                    threadId: row.child_thread_id,
                    reason: error.reason,
                  }),
                ),
              ),
          { concurrency: 8, discard: true },
        );
        yield* orchestrator.value.recoverDelegatedTasks;
      }),
    );
  }
  yield* registry.registerResultPending((threadId, taskId) =>
    Effect.gen(function* () {
      const owner = yield* replication.owner(threadId);
      if (owner === undefined || owner.local) return undefined;
      return (yield* routing.callMachine(
        owner.owner,
        ThreadTaskProgress,
        { target: owner.owner, threadId, ...(taskId === undefined ? {} : { taskId }) },
        "30 seconds",
      )).pending;
    }),
  );
  yield* channels.register(ThreadTaskProgress, (payload) =>
    payload.target !== self
      ? routing.callMachine(payload.target, ThreadTaskProgress, payload, "30 seconds")
      : threads.delegatedTaskResultPending(payload.threadId, payload.taskId).pipe(
          Effect.map((pending) => ({ pending })),
          Effect.mapError(() => new ThreadRemoteError({ reason: "rejected" })),
        ),
  );
  yield* registry.registerCatalog((machine) =>
    machine === self
      ? Effect.succeed(Option.none())
      : routing
          .callMachine(machine, ThreadMachineCatalog, { target: machine }, "30 seconds")
          .pipe(Effect.map((result) => Option.some(result.providers))),
  );
  yield* channels.register(ThreadMachineCatalog, (payload) =>
    payload.target === self
      ? Option.isNone(providers)
        ? Effect.succeed({ providers: [] })
        : providers.value.getProviders.pipe(Effect.map((providers) => ({ providers })))
      : routing.callMachine(payload.target, ThreadMachineCatalog, payload, "30 seconds"),
  );

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

  /** Forks need their source history on the target before launch. */
  const pushHistory = (hop: EnvironmentId, name: string) =>
    threadSync.sync(hop).pipe(
      Effect.mapError(
        (error) =>
          new ThreadRemoteError({
            reason: "behind",
            detail: `Thread history could not be sent to ${name} (${error.reason}), so the fork cannot start there yet.`,
          }),
      ),
    );

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
    input: Pick<ThreadLaunch.ThreadLaunchInput, "projectId" | "projectFolderId">,
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
    yield* membership
      .validate({ ...input, repositoryRemote: remote })
      .pipe(
        Effect.mapError(
          (cause) => new ThreadRemoteError({ reason: "rejected", detail: cause.message }),
        ),
      );
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
      subagent: input.subagent,
      fork: input.fork,
      handoffSummary: input.handoffSummary,
      handoffContext: input.handoffContext,
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
      const bundle =
        input.repositorySource === undefined
          ? undefined
          : yield* exportBundle(input.repositorySource.cwd, input.repositorySource.revision).pipe(
              Effect.provideContext(context),
            );
      const files = yield* readAttachmentFiles(input.initialMessage?.attachments ?? []).pipe(
        Effect.provideContext(context),
      );
      const priority = input.subagent !== undefined && input.threadId !== undefined;
      if (priority) yield* routing.refreshDelegated(machine, input.threadId!);
      if (input.fork !== undefined) yield* pushHistory(yield* nextHop(view, machine), name);
      const result = yield* callTarget(view, {
        target: machine,
        ...(priority ? { priority: true } : {}),
        commandId: input.commandId,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        project,
        launch: portableLaunch(input, strategy),
        ...(bundle === undefined ? {} : { bundle }),
        files,
      });
      const projection = yield* Effect.gen(function* () {
        if (priority) yield* routing.refreshDelegated(machine, result.threadId);
        return yield* projections.getThreadProjection(result.threadId);
      }).pipe(
        Effect.mapError(
          () =>
            new ThreadRemoteError({
              reason: priority ? "behind" : "rejected",
              detail: priority
                ? `The child on ${name} could not be read. Its creation is being cancelled; retry with the same clientRequestId.`
                : `The thread started on ${name} but has not reached this machine yet. It appears once it does.`,
            }),
        ),
      );
      return Option.some({ threadId: result.threadId, projection, resumed: result.resumed });
    }),
  );

  yield* registry.registerDelegation((command) =>
    Effect.gen(function* () {
      const { machine, ...local } = command;
      if (machine === undefined || machine === self)
        return yield* threads.dispatch(local).pipe(
          Effect.mapError(
            () =>
              new ThreadRemoteError({
                reason: "rejected",
                detail: "This machine refused the delegated task.",
              }),
          ),
        );
      const childThreadId = derive.delegatedTaskThread({ commandId: command.commandId });
      const attach = (driver: import("@cogenly/contracts").ProviderDriverKind) =>
        threads.dispatch({ ...local, type: "delegated_task.attach", driver }).pipe(
          Effect.mapError(
            () =>
              new ThreadRemoteError({
                reason: "rejected",
                detail:
                  "The child started, but its parent task could not be recorded. Retry with the same clientRequestId.",
              }),
          ),
        );
      if (yield* threads.hasReceipt(command.commandId)) {
        const child = yield* projections.getThreadProjection(childThreadId).pipe(Effect.orDie);
        return yield* attach(child.providerThreads[0]!.driver);
      }
      const parent = yield* projections
        .getThreadProjection(command.parentThreadId)
        .pipe(Effect.orDie);
      const run = parent.runs.find((run) => run.id === command.parentRunId);
      if (
        run === undefined ||
        !["starting", "running", "waiting"].includes(run.status) ||
        run.rootNodeId !== command.parentNodeId
      )
        return yield* new ThreadRemoteError({
          reason: "rejected",
          detail: "The parent run is no longer active.",
        });
      let workspaceStrategy = command.workspaceStrategy ?? { type: "root" as const };
      let repositorySource: ThreadLaunch.ThreadLaunchInput["repositorySource"];
      if (workspaceStrategy.type === "worktree") {
        const project = yield* projects
          .get(parent.thread.projectId)
          .pipe(Effect.orDie, Effect.map(Option.getOrThrow));
        const cwd = parent.thread.worktreePath ?? project.workspaceRoot;
        const git = yield* Git.GitVcsDriver.pipe(Effect.provideContext(context));
        const commit = yield* git.resolveCommit({ cwd, revision: workspaceStrategy.baseRef }).pipe(
          Effect.mapError(
            () =>
              new ThreadRemoteError({
                reason: "needs-repository",
                detail: "The parent commit could not be resolved.",
              }),
          ),
        );
        repositorySource = { cwd, revision: commit.commitSha };
        workspaceStrategy = {
          ...workspaceStrategy,
          baseRef: commit.commitSha,
          startFromOrigin: false,
        };
      }
      // Refuse offline/older peers before starting work or recording cleanup.
      yield* routing.refreshDelegated(machine, childThreadId);
      // Persist before crossing the peer link. Failed or interrupted creation is
      // cancelled directly; a restart retries cleanup even without a child replica.
      yield* sql`INSERT OR IGNORE INTO remote_delegation_intents
        (child_thread_id, target, command_id, parent_thread_id)
        VALUES (${childThreadId}, ${machine}, ${command.commandId}, ${command.parentThreadId})`.pipe(
        Effect.orDie,
      );
      creating.add(childThreadId);
      return yield* Effect.gen(function* () {
        const result = yield* launches
          .launch({
            commandId: CommandId.make(`${command.commandId}:remote-child`),
            threadId: childThreadId,
            projectId: parent.thread.projectId,
            machine,
            ...(parent.thread.surface === undefined ? {} : { surface: parent.thread.surface }),
            subagent: {
              parentThreadId: command.parentThreadId,
              rootThreadId: parent.thread.lineage.rootThreadId,
              taskNodeId: derive.delegatedTaskNode({ commandId: command.commandId }),
            },
            title: command.title ?? command.task.slice(0, 100),
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            workspaceStrategy,
            ...(repositorySource === undefined ? {} : { repositorySource }),
            initialMessage: {
              messageId: derive.delegatedTaskMessage({ commandId: command.commandId }),
              senderThreadId: command.parentThreadId,
              text: command.task,
              attachments: [],
            },
            createdBy: command.createdBy,
            creationSource: command.creationSource,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                ThreadLaunch.remoteLaunchFailure(error) ??
                new ThreadRemoteError({
                  reason: "rejected",
                  detail: "The target refused to launch the delegated child.",
                }),
            ),
          );
        const driver = result.projection.providerThreads[0]?.driver;
        if (driver === undefined)
          return yield* new ThreadRemoteError({
            reason: "behind",
            detail:
              "The remote child has not replicated its provider thread yet. Retry with the same clientRequestId.",
          });
        const attached = yield* attach(driver);
        yield* sql`DELETE FROM remote_delegation_intents WHERE child_thread_id = ${childThreadId}`.pipe(
          Effect.orDie,
        );
        return attached;
      }).pipe(
        Effect.onExit(() => abandon(childThreadId, machine, command.commandId)),
        Effect.ensuring(
          Effect.sync(() => {
            creating.delete(childThreadId);
          }),
        ),
      );
    }),
  );

  yield* registry.registerSchedules({
    upsert: (owner, input) =>
      Effect.gen(function* () {
        const view = yield* topology;
        yield* nextHop(view, owner);
        if (input.workspaceStrategy.type === "existing_worktree")
          return yield* new ThreadRemoteError({
            reason: "rejected",
            detail:
              "Choose a repository root or new worktree for a schedule owned by another machine.",
          });
        const project = yield* portableProject(
          {
            projectId: input.projectId,
            ...(input.projectFolderId == null ? {} : { projectFolderId: input.projectFolderId }),
          },
          nameOf(view, owner),
        );
        const { projectId: _project, ownerMachine: _owner, ...portable } = input;
        return yield* routing.callMachine(
          owner,
          ThreadScheduleUpsert,
          { target: owner, project, input: portable },
          LAUNCH_TIMEOUT,
        );
      }),
    run: (owner, input) =>
      routing.callMachine(owner, ThreadScheduleRun, { target: owner, input }, LAUNCH_TIMEOUT),
  });
  yield* channels.register(ThreadScheduleUpsert, (payload, caller) =>
    Effect.gen(function* () {
      if (payload.target !== self) {
        const result = yield* routing.callMachine(
          payload.target,
          ThreadScheduleUpsert,
          payload,
          LAUNCH_TIMEOUT,
        );
        yield* sharedSync.sync(caller.environmentId).pipe(Effect.ignore);
        return result;
      }
      if (Option.isNone(scheduledTasks))
        return yield* new ThreadRemoteError({ reason: "rejected" });
      const projectId =
        payload.project.kind === "scratch"
          ? yield* localProject(payload.project)
          : ((yield* replication.localProject({
              kind: "repository",
              remote: payload.project.remote,
            })) ?? (`remote:${payload.project.remote}` as ProjectId));
      if (projectId === undefined)
        return yield* new ThreadRemoteError({ reason: "needs-repository" });
      const result = yield* scheduledTasks.value
        .upsert({ ...payload.input, projectId, ownerMachine: self })
        .pipe(
          Effect.mapError(
            (error) => new ThreadRemoteError({ reason: "rejected", detail: error.message }),
          ),
        );
      yield* sharedSync
        .sync(caller.environmentId)
        .pipe(Effect.mapError(() => new ThreadRemoteError({ reason: "behind" })));
      return result;
    }),
  );
  yield* channels.register(ThreadScheduleRun, (payload) =>
    payload.target !== self
      ? routing.callMachine(payload.target, ThreadScheduleRun, payload, LAUNCH_TIMEOUT)
      : Option.isNone(scheduledTasks)
        ? Effect.fail(new ThreadRemoteError({ reason: "rejected" }))
        : scheduledTasks.value
            .runNow(payload.input)
            .pipe(
              Effect.mapError(
                (error) => new ThreadRemoteError({ reason: "rejected", detail: error.message }),
              ),
            ),
  );

  const copiedResults = new Map<string, string>();
  yield* registry.registerCopyResult((threadId, key) =>
    Effect.gen(function* () {
      const cached = copiedResults.get(key);
      if (cached !== undefined) return cached;
      const owner = yield* replication.owner(threadId);
      if (owner === undefined || owner.local) return undefined;
      const child = yield* projections.getThreadProjection(threadId).pipe(Effect.orDie);
      if (child.thread.worktreePath === null || child.thread.branch === null) return undefined;
      const project = yield* projects.get(child.thread.projectId).pipe(Effect.orDie);
      if (Option.isNone(project))
        return yield* new ThreadRemoteError({
          reason: "needs-repository",
          detail: "The result is available; clone its repository here to receive its branch.",
        });
      const result = yield* routing.callMachine(
        owner.owner,
        ThreadTaskBranch,
        { target: owner.owner, threadId },
        LAUNCH_TIMEOUT,
      );
      yield* importBundle(project.value.workspaceRoot, result.bundle, result.branch).pipe(
        Effect.provideContext(context),
      );
      if (copiedResults.size >= 256) copiedResults.delete(copiedResults.keys().next().value!);
      copiedResults.set(key, result.branch);
      return result.branch;
    }),
  );
  yield* channels.register(ThreadTaskBranch, (payload) =>
    Effect.gen(function* () {
      if (payload.target !== self)
        return yield* routing.callMachine(
          payload.target,
          ThreadTaskBranch,
          payload,
          LAUNCH_TIMEOUT,
        );
      const thread = yield* projections.getThreadProjection(payload.threadId).pipe(Effect.orDie);
      if (
        thread.thread.ownerMachine != null ||
        thread.thread.worktreePath === null ||
        thread.thread.branch === null
      )
        return yield* new ThreadRemoteError({ reason: "needs-repository" });
      if (
        thread.runs.some((run) =>
          ["queued", "preparing", "starting", "running", "waiting", "finalizing"].includes(
            run.status,
          ),
        )
      )
        return yield* new ThreadRemoteError({
          reason: "busy",
          detail: "The child has pending work. Its branch can return after that work ends.",
        });
      const git = yield* Git.GitVcsDriver.pipe(Effect.provideContext(context));
      const commit = yield* git
        .resolveCommit({ cwd: thread.thread.worktreePath, revision: "HEAD" })
        .pipe(Effect.mapError(() => new ThreadRemoteError({ reason: "needs-repository" })));
      return {
        branch: thread.thread.branch,
        bundle: yield* exportBundle(thread.thread.worktreePath, commit.commitSha).pipe(
          Effect.provideContext(context),
        ),
      };
    }),
  );

  yield* registry.registerAgentCreate((machine, input, agentId) =>
    Effect.gen(function* () {
      const view = yield* topology;
      yield* nextHop(view, machine);
      const project =
        input.projectId === null
          ? { kind: "scratch" as const }
          : yield* portableProject(
              {
                projectId: input.projectId,
                ...(input.projectFolderId == null
                  ? {}
                  : { projectFolderId: input.projectFolderId }),
              },
              nameOf(view, machine),
            );
      const { projectId: _projectId, ownerMachine: _owner, id: _id, ...portable } = input;
      return yield* routing.callMachine(
        machine,
        ThreadAgentCreate,
        { target: machine, agentId, project, input: portable },
        LAUNCH_TIMEOUT,
      );
    }),
  );
  yield* channels.register(ThreadAgentCreate, (payload, caller) =>
    Effect.gen(function* () {
      if (payload.target !== self) {
        const result = yield* routing.callMachine(
          payload.target,
          ThreadAgentCreate,
          payload,
          LAUNCH_TIMEOUT,
        );
        yield* sharedSync.sync(caller.environmentId).pipe(Effect.ignore);
        yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
        return result;
      }
      if (Option.isNone(agentService))
        return yield* new ThreadRemoteError({
          reason: "rejected",
          detail: "This server cannot create agents.",
        });
      if (payload.project.kind === "repository")
        yield* membership
          .validate({
            projectId: ProjectId.make(`remote:${payload.project.remote}`),
            projectFolderId: payload.input.projectFolderId,
            repositoryRemote: payload.project.remote,
          })
          .pipe(
            Effect.mapError(
              (cause) => new ThreadRemoteError({ reason: "rejected", detail: cause.message }),
            ),
          );
      const projectId = yield* localProject(payload.project);
      const result = yield* agentService.value
        .upsert({ ...payload.input, projectId, ownerMachine: self }, payload.agentId)
        .pipe(
          Effect.mapError(
            (error) => new ThreadRemoteError({ reason: "rejected", detail: error.message }),
          ),
        );
      yield* sharedSync.sync(caller.environmentId).pipe(
        Effect.mapError(
          () =>
            new ThreadRemoteError({
              reason: "behind",
              detail: "The agent was created, but its configuration has not reached the caller.",
            }),
        ),
      );
      yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
      return result;
    }),
  );

  yield* channels.register(ThreadLaunchRemote, (payload, caller) =>
    Effect.gen(function* () {
      if (payload.target !== self) {
        const view = yield* topology;
        // Only the hub relays, and never back to the machine that asked.
        if (view.link._tag !== "hub" || payload.target === caller.environmentId)
          return yield* new ThreadRemoteError({ reason: "not-owner" });
        if (payload.launch.fork !== undefined)
          yield* pushHistory(payload.target, nameOf(view, payload.target));
        const relayed = yield* callTarget(view, payload);
        if (payload.priority !== true)
          yield* threadSync.sync(caller.environmentId).pipe(Effect.ignore);
        return relayed;
      }
      if (payload.project.kind === "repository")
        yield* membership
          .validate({
            projectId: ProjectId.make(`remote:${payload.project.remote}`),
            projectFolderId: payload.launch.projectFolderId,
            repositoryRemote: payload.project.remote,
          })
          .pipe(
            Effect.mapError(
              (cause) => new ThreadRemoteError({ reason: "rejected", detail: cause.message }),
            ),
          );
      const projectId: ProjectId = yield* localProject(payload.project);
      if (payload.bundle !== undefined) {
        yield* checkout
          .ensureCheckout(projectId)
          .pipe(
            Effect.mapError(
              (error) =>
                new ThreadRemoteError({ reason: "needs-repository", detail: error.message }),
            ),
          );
        const project = yield* projects.get(projectId).pipe(Effect.orDie);
        if (Option.isNone(project))
          return yield* new ThreadRemoteError({ reason: "needs-repository" });
        yield* importBundle(project.value.workspaceRoot, payload.bundle).pipe(
          Effect.provideContext(context),
        );
      }
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
      // New delegated callers fetch only this thread over the priority channel.
      if (payload.priority !== true)
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
export const layer = Layer.effectDiscard(make).pipe(Layer.provide(Membership.layer));
