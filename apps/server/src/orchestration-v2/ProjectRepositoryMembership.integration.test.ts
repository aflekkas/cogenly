import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as Launch from "./ThreadLaunchService.ts";
import * as Threads from "./ThreadManagementService.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as Ids from "@cogenly/provider-core/server/IdAllocator";
import * as Projects from "../project/ProjectService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Text from "../textGeneration/TextGeneration.ts";
import * as Agents from "../agents/AgentService.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import { layerIdentity } from "../sync/testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { makeControllableProvider } from "./testkit/ControllableProvider.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("repo:cogenly");
const projectFolderId = ProjectLabelId.make("label:spawn");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const message =
  "cogenly is not in the Spawn Partners project. Add it to the project first, or start without a project.";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_labels(label_id,name,created_at,updated_at) VALUES (${projectFolderId},'Spawn Partners','2026-01-01','2026-01-01')`;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'cogenly','/repos/cogenly','[]','2026-01-01','2026-01-01')`;
});
const create = (id: string) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${id}`),
  threadId: ThreadId.make(id),
  projectId,
  projectFolderId,
  title: "New work",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

it.effect(
  "the RPC command boundary refuses mismatches, accepts linked and unfiled starts, and replays accepted receipts",
  () => {
    const database = Sqlite.layerMemory;
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    const runtime = layerWithRegistry({ name: "project-membership-command" }, provider.registry, {
      databaseLayer: database,
      runEffectWorker: false,
    });
    return Effect.gen(function* () {
      yield* seed;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const error = yield* Effect.flip(orchestrator.dispatch(create("thread:bad")));
      expect(error._tag).toBe("ProjectRepositoryMismatchError");
      expect(error.message).toBe(message);
      expect(yield* orchestrator.getThreadShell(ThreadId.make("thread:bad"))).toBeNull();
      yield* orchestrator.dispatch({ ...create("thread:unfiled"), projectFolderId: null });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${projectFolderId},${projectId})`;
      const accepted = yield* orchestrator.dispatch(create("thread:linked"));
      yield* sql`DELETE FROM label_repositories`;
      expect((yield* orchestrator.dispatch(create("thread:linked"))).sequence).toBe(
        accepted.sequence,
      );
    }).pipe(
      Effect.provide(runtime.pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer))),
    );
  },
);

it.effect(
  "replica event application retains history even when local filing does not link its repository",
  () => {
    const database = Sqlite.layerMemory;
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    const runtime = layerWithRegistry({ name: "project-membership-replica" }, provider.registry, {
      databaseLayer: database,
      runEffectWorker: false,
    });
    return Effect.gen(function* () {
      yield* seed;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const accepted = yield* orchestrator.dispatch({
        ...create("thread:source"),
        projectFolderId: null,
      });
      const created = accepted.storedEvents.find(
        ({ event }) => event.type === "thread.created",
      )?.event;
      if (created?.type !== "thread.created") return yield* Effect.die("Missing created event");
      const threadId = ThreadId.make("thread:replica");
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO thread_owners(thread_id,owner_env,local,epoch,updated_at) VALUES (${threadId},'machine:peer',0,0,'2026-01-01')`;
      yield* sink.writeReplica({
        commandId: CommandId.make("command:replica:test"),
        owners: [{ threadId, owner: EnvironmentId.make("machine:peer"), epoch: 0 }],
        events: [
          {
            ...created,
            id: EventId.make("replica:created"),
            threadId,
            payload: { ...created.payload, id: threadId },
          },
        ],
      });
      yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${projectFolderId})`;
      expect(yield* orchestrator.getThreadShell(threadId)).toMatchObject({
        projectId,
        projectFolderId,
      });
      expect(yield* sql`SELECT 1 FROM label_repositories`).toEqual([]);
    }).pipe(
      Effect.provide(runtime.pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer))),
    );
  },
);

it.effect(
  "checks a filed draft's first turn while allowing existing history to continue unchanged",
  () => {
    const database = Sqlite.layerMemory;
    const provider = makeControllableProvider(CodexProviderCapabilitiesV2);
    const runtime = layerWithRegistry(
      { name: "project-membership-first-turn" },
      provider.registry,
      { databaseLayer: database, runEffectWorker: false },
    );
    return Effect.gen(function* () {
      yield* seed;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:draft");
      yield* orchestrator.dispatch({ ...create(threadId), projectFolderId: null });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${projectFolderId})`;
      const send = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("first-turn"),
        threadId,
        messageId: MessageId.make("message:first"),
        text: "Build it",
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      expect((yield* Effect.flip(orchestrator.dispatch(send))).message).toBe(message);
      yield* sql`DELETE FROM thread_project_labels`;
      yield* orchestrator.dispatch(send);
      yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${projectFolderId})`;
      yield* orchestrator.dispatch({
        ...send,
        commandId: CommandId.make("existing-history"),
        messageId: MessageId.make("message:second"),
        dispatchMode: { type: "queue_after_active" },
      });
      expect((yield* orchestrator.getThreadProjection(threadId)).runs).toHaveLength(2);
      expect(yield* sql`SELECT 1 FROM label_repositories`).toEqual([]);
    }).pipe(
      Effect.provide(runtime.pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer))),
    );
  },
);

it.effect(
  "schedule create and update refuse bad bindings; a removed link fails a firing with its clear error",
  () => {
    const database = Sqlite.layerMemory;
    // Only external launch dependencies are stubbed: membership, schedules and launch intake are real.
    const boundaries = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({}),
      Layer.mock(Tracker.WorktreeSetupTracker)({}),
      Layer.mock(Terminals.TerminalManager)({}),
      Layer.mock(Git.GitWorkflowService)({}),
      Layer.mock(Setup.ProjectSetupScriptRunner)({}),
      Layer.mock(Providers.ProviderRegistry)({}),
      Layer.mock(Settings.ServerSettingsService)({}),
      Layer.mock(Text.TextGeneration)({}),
      Layer.mock(Receipts.CommandReceiptStoreV2)({}),
      Ids.layer,
      Layer.mock(Folders.ManagedProjectFolders)({}),
      Layer.mock(Threads.ThreadManagementService)({}),
      Layer.mock(Agents.AgentService)({}),
      Layer.mock(AgentStore.AgentStore)({}),
      Layer.mock(Secrets.SecretRequests)({}),
      Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
    );
    const launches = Launch.layer.pipe(Layer.provide(boundaries));
    const tasks = Tasks.layer.pipe(
      Layer.provide(Layer.merge(launches, boundaries)),
      Layer.provide(layerIdentity),
    );
    return Effect.gen(function* () {
      yield* seed;
      const service = yield* Tasks.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const input = {
        id: ScheduledTaskId.make("task:project"),
        title: "Daily check",
        prompt: "Check the repository",
        enabled: true,
        schedule: { type: "interval" as const, everyMs: 3600000 },
        projectId,
        projectFolderId,
        workspaceStrategy: { type: "root" as const },
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      };
      expect((yield* Effect.flip(service.upsert(input))).message).toBe(message);
      expect(yield* sql`SELECT 1 FROM scheduled_tasks`).toEqual([]);
      yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${projectFolderId},${projectId})`;
      expect((yield* service.upsert(input)).task.projectFolderId).toBe(projectFolderId);
      yield* sql`DELETE FROM label_repositories`;
      expect(
        (yield* Effect.flip(service.upsert({ ...input, title: "Invalid edit" }))).message,
      ).toBe(message);
      const result = yield* service.runNow({ id: input.id });
      expect(result.task).toMatchObject({
        title: "Daily check",
        lastRunStatus: "failed",
        lastRunError: message,
        runCount: 1,
      });
    }).pipe(
      Effect.provide(tasks.pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer))),
    );
  },
);
