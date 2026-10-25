import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProjectLabelError,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";
import * as SetupScripts from "../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadFork from "./ThreadFork.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Machines from "../machines/Machines.ts";
import { startMachine } from "../machines/testkit.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import { makeControllableProvider } from "../orchestration-v2/testkit/ControllableProvider.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RemoteThreadCommands from "../orchestration-v2/RemoteThreadCommands.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as RemoteThreadLaunch from "../orchestration-v2/RemoteThreadLaunch.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchRouting from "./ThreadLaunchRouting.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SharedSync from "../sync/SharedSync.ts";
import * as SharedState from "../sync/SharedState.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadRouting from "./ThreadRouting.ts";
import * as ThreadSync from "./ThreadSync.ts";
import * as ThreadTransfer from "./ThreadTransfer.ts";
import * as ProjectMove from "./ProjectMove.ts";
import * as ProjectLabelFolders from "../projectLabels/ProjectLabelFolders.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerConfig from "../config.ts";

/**
 * A paired-machine server with thread replication and routing over a real
 * peer link. Passes are explicit (no change stream, no scheduler), and the
 * orchestrator is replaced by `dispatch`, which turns a command into events.
 */
export const startThreadMachine = Effect.fn("startThreadMachine")(function* (
  name: string,
  role: "computer" | "cloud-server",
  dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => ReadonlyArray<OrchestrationV2DomainEvent> = () => [],
  gitStatus?: GitWorkflow.GitWorkflowService["Service"]["status"],
  execution = false,
  forkOptions?: {
    readonly git: Pick<GitWorkflow.GitWorkflowService["Service"], "forkSource" | "forkCheckout">;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly clone?: (remote: string) => Effect.Effect<string>;
  },
) {
  const machine = yield* startMachine(name, role);
  const database = Layer.succeed(SqlClient.SqlClient, yield* machine.run(SqlClient.SqlClient));
  const remoteServices = Layer.merge(RemoteThreadCommands.layer, RemoteThreadLaunch.layer);
  const provider = makeControllableProvider(CodexProviderCapabilitiesV2, ["codex"], `${name}:turn`);
  const runtime = execution
    ? layerWithRegistry({ name }, provider.registry, {
        databaseLayer: database,
        runEffectWorker: false,
        environmentId: machine.environmentId,
        remoteServices,
      })
    : Layer.empty;
  const stores = yield* machine.run(
    Layer.build(
      Layer.mergeAll(
        runtime,
        EventSink.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(EventStore.layer, Projections.layer, EffectOutbox.layer),
          ),
        ),
        remoteServices,
      ),
    ),
  );
  const inStores = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    machine.run(Effect.provideContext(effect, stores as never));
  const sink = yield* inStores(EventSink.EventSinkV2);
  const projections = yield* inStores(Projections.ProjectionStoreV2);
  const engine = execution
    ? Option.some(yield* inStores(Orchestrator.OrchestratorV2))
    : Option.none<Orchestrator.OrchestratorV2["Service"]>();
  const worker = execution
    ? Option.some(yield* inStores(Worker.OrchestrationEffectWorkerV2))
    : Option.none<Worker.OrchestrationEffectWorkerV2["Service"]>();
  const launchRegistry = yield* inStores(RemoteThreadLaunch.RemoteThreadLaunch);
  /**
   * Launches this machine ran itself, as its ThreadLaunchService was asked:
   * the thread and its first message are written here, so this machine owns
   * them from the first event. A repeated command returns the same thread.
   */
  const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const launches = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Effect.gen(function* () {
        if (input.machine !== undefined)
          return Option.getOrThrow(yield* launchRegistry.launch(input.machine, input));
        launched.push(input);
        const id = input.threadId ?? ThreadId.make(`thread:launched:${input.commandId}`);
        const existing = yield* Effect.option(projections.getThreadProjection(id));
        if (Option.isSome(existing))
          return { threadId: id, projection: existing.value, resumed: true };
        if (Option.isSome(engine)) {
          yield* engine.value.dispatch({
            type: "thread.create",
            commandId: input.commandId,
            threadId: id,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: null,
            subagent: input.subagent,
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          });
          if (input.initialMessage !== undefined)
            yield* engine.value.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${input.commandId}:message`),
              threadId: id,
              messageId: input.initialMessage.messageId ?? MessageId.make(`${id}:message`),
              text: input.initialMessage.text,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            });
          return {
            threadId: id,
            projection: yield* projections.getThreadProjection(id),
            resumed: false,
          };
        }
        const at = yield* DateTime.now;
        const thread = idleThreadProjection(liveThreadShell(id)).thread;
        yield* sink.write({
          commandId: input.commandId,
          events: [
            {
              id: EventId.make(`event:${input.commandId}:created`),
              type: "thread.created",
              threadId: id,
              occurredAt: at,
              payload: { ...thread, title: input.title, projectId: input.projectId },
            },
            ...(input.initialMessage === undefined
              ? []
              : [
                  userMessage(
                    `event:${input.commandId}:message`,
                    at,
                    input.initialMessage.text,
                    id,
                  ),
                ]),
          ],
        });
        return {
          threadId: id,
          projection: yield* projections.getThreadProjection(id),
          resumed: false,
        };
      }).pipe(Effect.orDie),
  });
  const replicationContext = yield* inStores(Layer.build(ThreadReplication.layer));
  const replication = yield* ThreadReplication.ThreadReplication.pipe(
    Effect.provideContext(replicationContext),
  );
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    assertProviderInstanceEnabled: () => Effect.void,
    getThreadProjection: (id) => projections.getThreadProjection(id).pipe(Effect.orDie),
    delegatedTaskResultPending: (threadId, taskId) =>
      Option.isSome(engine)
        ? engine.value.delegatedTaskResultPending(threadId, taskId)
        : Effect.succeed(false),
    hasReceipt: (commandId) =>
      machine.run(SqlClient.SqlClient).pipe(
        Effect.flatMap(
          (sql) =>
            sql`SELECT 1 FROM orchestration_command_receipts WHERE command_id = ${commandId}`,
        ),
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    dispatch: (command) =>
      Option.isSome(engine)
        ? engine.value.dispatch(command)
        : sink.write({ commandId: command.commandId, events: dispatch(command) }).pipe(
            Effect.map((storedEvents) => ({
              sequence: storedEvents.at(-1)?.sequence ?? 0,
              storedEvents,
            })),
            Effect.orDie,
          ),
  });
  // Projects read straight from the tables tests fill; nothing here clones.
  const labels = Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return Layer.mock(ProjectLabelService.ProjectLabelService)({
        list: () => Effect.succeed({ labels: [] }),
        moveThread: ({ threadId, folderId }) =>
          Effect.gen(function* () {
            if (folderId !== null)
              yield* sql`INSERT OR IGNORE INTO thread_project_labels(thread_id, label_id) VALUES (${threadId}, ${folderId})`;
            return { threadId, projectFolderId: folderId };
          }).pipe(Effect.orDie),
        // Swaps the remote-only placeholder for the record, as the service does.
        bindRepositoryCheckout: ({ labelId, remote, repositoryId }) =>
          Effect.gen(function* () {
            bound.push({ labelId, remote, repositoryId });
            yield* sql`UPDATE label_repositories SET repository_id = ${repositoryId}
              WHERE label_id = ${labelId} AND remote = ${remote}`;
            return { label: undefined as never };
          }).pipe(Effect.orDie),
        readActive: (id) =>
          Effect.gen(function* () {
            const label = (yield* sql<{
              readonly name: string;
            }>`SELECT name FROM project_labels WHERE label_id = ${id}`.pipe(Effect.orDie))[0];
            if (label === undefined)
              return yield* new ProjectLabelError({ operation: "readActive", reason: "not_found" });
            const links = yield* sql<{
              readonly repository_id: string;
              readonly remote: string | null;
            }>`SELECT repository_id, remote FROM label_repositories WHERE label_id = ${id}`.pipe(
              Effect.orDie,
            );
            return {
              label: {
                id,
                name: label.name,
                instructions: "",
                createdAt: "2026-10-24T00:00:00.000Z",
                updatedAt: "2026-10-24T00:00:00.000Z",
                repositoryIds: links.map((link) => ProjectId.make(link.repository_id)),
                repositories: links.map((link) => ({
                  repositoryId: ProjectId.make(link.repository_id),
                  remote: link.remote,
                  directoryName: null,
                })),
                sourceLinks: [],
                projectChatThreadId: null,
                threadCount: 0,
              },
            };
          }),
      });
    }),
  );
  // Cloning stands in as binding the link to a new record, as bindRepositoryCheckout does.
  const checkouts: Array<{ readonly labelId: string; readonly remote: string }> = [];
  // Which folders are checkouts of which remote, as git would report them.
  const remotes = new Map<string, string>();
  const identities = Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: (cwd) =>
      Effect.succeed(
        remotes.has(cwd)
          ? {
              canonicalKey: remotes.get(cwd)!,
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: `https://${remotes.get(cwd)!}.git`,
              },
            }
          : null,
      ),
  });
  // "No project" is <home>/scratch, created on demand like ManagedProjectFolders does.
  const folders = Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const root = path.resolve(config.baseDir, "scratch");
      return Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        ensureScratchProject: Effect.gen(function* () {
          const projectId = ProjectId.make("project:scratch");
          yield* sql`INSERT OR IGNORE INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
            VALUES (${projectId}, 'No project', ${root}, 0, '[]', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
          return { projectId };
        }).pipe(Effect.orDie),
      });
    }),
  );
  const bound: Array<{
    readonly labelId: string;
    readonly remote: string;
    readonly repositoryId: string;
  }> = [];
  const repositoryCheckout = Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return Layer.mock(RepositoryCheckout.RepositoryCheckout)({
        ensureCheckout: () => Effect.void,
        checkoutRepository: ({ labelId, remote }) =>
          Effect.gen(function* () {
            checkouts.push({ labelId, remote });
            const root =
              forkOptions?.clone === undefined
                ? `/clones/${remote}`
                : yield* forkOptions.clone(remote);
            const repositoryId = ProjectId.make(`project:clone:${remote}`);
            yield* sql`INSERT OR IGNORE INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
              VALUES (${repositoryId}, ${remote}, ${root}, 0, '[]', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
            yield* sql`UPDATE label_repositories SET repository_id = ${repositoryId}
              WHERE label_id = ${labelId} AND remote = ${remote}`;
            return { repositoryId };
          }).pipe(Effect.orDie),
      });
    }),
  );
  // Fork tests run the real launcher and orchestrator; only external providers,
  // cloning and unrelated preparation services are replaced.
  const providerCatalog =
    forkOptions === undefined
      ? Layer.empty
      : Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(forkOptions.providers),
        });
  const preparationFinished = yield* Deferred.make<void>();
  const forkLaunches =
    forkOptions === undefined
      ? launches
      : ThreadLaunch.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.unwrap(
                Effect.gen(function* () {
                  const store = yield* ProjectStore.ProjectStoreV2;
                  return Layer.mock(ProjectService.ProjectService)({
                    getById: (id) =>
                      store.get(id).pipe(
                        Effect.map(
                          Option.map((project) => ({
                            ...project,
                            id: project.projectId,
                            repositoryIdentity: null,
                          })),
                        ),
                        Effect.orDie,
                      ),
                  });
                }),
              ),
              Layer.mock(SetupTracker.WorktreeSetupTracker)({
                stageStatus: () => Effect.void,
                markUncancellable: () => Effect.void,
                finish: () =>
                  Deferred.succeed(preparationFinished, undefined).pipe(Effect.as(null)),
              }),
              Layer.mock(TerminalManager.TerminalManager)({}),
              Layer.mock(SetupScripts.ProjectSetupScriptRunner)({
                runForThread: () => Effect.succeed({ status: "no-script" }),
              }),
              providerCatalog,
              Layer.mock(ServerSettings.ServerSettingsService)({}),
              Layer.mock(TextGeneration.TextGeneration)({}),
              CommandReceipts.layer,
              IdAllocator.layer,
              Layer.succeed(RemoteThreadLaunch.RemoteThreadLaunch, launchRegistry),
            ),
          ),
        );
  const context = yield* inStores(
    Layer.build(
      Layer.mergeAll(
        ProjectMove.layer,
        ThreadLaunchRouting.layer,
        forkOptions === undefined ? Layer.empty : ThreadFork.layer,
      ).pipe(
        Layer.provideMerge(forkLaunches),
        Layer.provide(providerCatalog),
        Layer.provideMerge(ThreadTransfer.layer),
        Layer.provideMerge(ThreadRouting.layer),
        Layer.provideMerge(ThreadSync.layer),
        Layer.provideMerge(
          Layer.succeed(ThreadReplication.ThreadReplication, {
            ...replication,
            changes: Stream.never,
          }),
        ),
        Layer.provide(ProjectStore.layer),
        Layer.provide(Layer.mock(Git.GitVcsDriver)({})),
        Layer.provide(labels),
        Layer.provide(
          Layer.mock(ProjectLabelFolders.ProjectLabelFolders)({
            dirForLabel: (label) =>
              Effect.succeed({ dir: `/projects/${label.name}`, dirName: label.name }),
          }),
        ),
        Layer.provide(repositoryCheckout),
        Layer.provide(identities),
        Layer.provide(folders),
        Layer.provideMerge(SharedSync.layer.pipe(Layer.provideMerge(SharedState.layer))),
        Layer.provide(
          Layer.succeed(Machines.Machines, { ...machine.machines, subscribe: Stream.never }),
        ),
        Layer.provide(Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void })),
        Layer.provide(threads),
        Layer.provide(
          Option.isSome(engine)
            ? Layer.succeed(Orchestrator.OrchestratorV2, engine.value)
            : Layer.empty,
        ),

        Layer.provide(
          gitStatus === undefined && forkOptions === undefined
            ? Layer.empty
            : Layer.mock(GitWorkflow.GitWorkflowService)({
                ...(gitStatus === undefined ? {} : { status: gitStatus }),
                ...forkOptions?.git,
              }),
        ),
      ),
    ),
  );
  const sync = yield* ThreadSync.ThreadSync.pipe(Effect.provideContext(context));
  const routing = yield* ThreadRouting.ThreadRouting.pipe(Effect.provideContext(context));
  const transfer = yield* ThreadTransfer.ThreadTransfer.pipe(Effect.provideContext(context));
  const shared = yield* SharedState.SharedState.pipe(Effect.provideContext(context));
  const projectMove = yield* ProjectMove.ProjectMove.pipe(Effect.provideContext(context));
  const remoteCommands = yield* inStores(RemoteThreadCommands.RemoteThreadCommands);
  const remoteLaunch = yield* inStores(RemoteThreadLaunch.RemoteThreadLaunch);
  const sql = yield* machine.run(SqlClient.SqlClient);
  /** A restart of this machine's replication, as after an update. */
  const restartReplication = inStores(Layer.build(Layer.fresh(ThreadReplication.layer))).pipe(
    Effect.asVoid,
  );
  return {
    ...machine,
    engine,
    preparationFinished: Deferred.await(preparationFinished),
    forks:
      forkOptions === undefined
        ? undefined
        : yield* ThreadFork.ThreadFork.pipe(Effect.provideContext(context)),
    worker,
    provider,
    replication,
    sync,
    routing,
    transfer,
    projectMove,
    checkouts,
    bound,
    remotes,
    shared,
    remoteCommands,
    remoteLaunch,
    launched,
    restartReplication,
    sink,
    projections,
    sql,
  };
});

export const threadId = ThreadId.make("thread:on-laptop");

/** An event as it travels in a replication batch. */
export const encodeEvent = (event: OrchestrationV2DomainEvent) =>
  encodeEventJson(event) as Schema.Json;
const encodeEventJson = Schema.encodeSync(OrchestrationV2DomainEventJson);

export const threadCreated = (
  id: string,
  at: DateTime.Utc,
  title = "On the laptop",
): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "thread.created",
  threadId,
  occurredAt: at,
  payload: { ...idleThreadProjection(liveThreadShell(threadId)).thread, title },
});

export const userMessage = (
  id: string,
  at: DateTime.Utc,
  text: string,
  thread: ThreadId = threadId,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "message.updated",
  threadId: thread,
  occurredAt: at,
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: MessageId.make(`message:${id}`),
    threadId: thread,
    runId: null,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  },
});
