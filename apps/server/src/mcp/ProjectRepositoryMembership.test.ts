import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  RunId,
  ServerProvider,
  ThreadId,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Ids from "@cogenly/provider-core/server/IdAllocator";
import * as Projects from "../project/ProjectService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as GitDriver from "../vcs/GitVcsDriver.ts";
import * as Repositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Config from "../config.ts";
import * as Text from "../textGeneration/TextGeneration.ts";
import * as AgentStore from "../agents/AgentStore.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Vault from "../vault/Vault.ts";
import * as Accounts from "../accounts/AccountConnections.ts";
import * as Work from "../work/WorkHandoffService.ts";
import { toolkit as WorkToolkit, handlers as WorkHandlers } from "../work/WorkMcp.ts";
import * as OrchestratorMcp from "./OrchestratorMcpService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import { HandlersLayer } from "./McpToolAccess.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { layer as ProjectHandlers } from "./toolkits/project/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { layer as OrchestratorHandlers } from "./toolkits/orchestrator/handlers.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

it.effect(
  "thread_launch, work_start and create_threads refuse an unrelated explicit project through their MCP handlers",
  () => {
    const projectId = ProjectId.make("repo:cogenly");
    const projectFolderId = ProjectLabelId.make("label:spawn");
    const threadId = ThreadId.make("thread:caller");
    const shell = {
      ...liveThreadShell(threadId),
      projectId,
      projectFolderId,
      projectFolderSource: "explicit" as const,
    };
    const projection = {
      ...idleThreadProjection(shell),
      runs: [
        {
          id: RunId.make("run:caller"),
          threadId,
          ordinal: 1,
          providerInstanceId: shell.providerInstanceId,
          modelSelection: shell.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:caller"),
          rootNodeId: NodeId.make("node:caller"),
          activeAttemptId: null,
          status: "running",
          requestedAt: DateTime.makeUnsafe("2026-01-01"),
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      ] satisfies ReadonlyArray<import("@cogenly/contracts").OrchestrationV2Run>,
    };
    const provider = decodeProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
    });
    const boundaries = Layer.mergeAll(
      Layer.mock(Projects.ProjectService)({}),
      Layer.mock(Tracker.WorktreeSetupTracker)({}),
      Layer.mock(Terminals.TerminalManager)({}),
      Layer.mock(Git.GitWorkflowService)({}),
      Layer.mock(GitDriver.GitVcsDriver)({}),
      Layer.mock(Repositories.SourceControlRepositoryService)({}),
      Layer.mock(Setup.ProjectSetupScriptRunner)({}),
      Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      Layer.mock(Adapters.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([ProviderInstanceId.make("codex")]),
      }),
      Settings.layerTest(),
      Layer.mock(Text.TextGeneration)({}),
      Layer.mock(Receipts.CommandReceiptStoreV2)({}),
      Ids.layer,
      Layer.mock(Folders.ManagedProjectFolders)({}),
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        getThreadRecords: () => Effect.succeed(projection),
        assertProviderInstanceEnabled: () => Effect.void,
      }),
      Layer.mock(AgentStore.AgentStore)({}),
      Layer.mock(Tasks.ScheduledTaskService)({}),
      Layer.mock(Secrets.SecretRequests)({}),
      Layer.mock(Vault.Vault)({}),
      Layer.mock(Accounts.AccountConnections)({}),
    );
    const launches = Launch.layer.pipe(Layer.provide(boundaries));
    const services = Layer.mergeAll(
      Work.layer.pipe(Layer.provide(Layer.merge(launches, boundaries))),
      OrchestratorMcp.layer.pipe(Layer.provide(Layer.merge(launches, boundaries))),
      launches,
      boundaries,
    );
    const handlers = Layer.mergeAll(
      HandlersLayer.layer(ProjectHandlers),
      HandlersLayer.layer(WorkHandlers),
      HandlersLayer.layer(OrchestratorHandlers),
    ).pipe(Layer.provide(services));
    const scope: Invocation.McpInvocationScope = {
      environmentId: EnvironmentId.make("test"),
      requestNamespace: "membership",
      issuedAt: 0,
      thread: {
        threadId,
        providerInstanceId: shell.providerInstanceId,
        providerSessionId: "caller",
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
    };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO project_labels(label_id,name,created_at,updated_at) VALUES (${projectFolderId},'Spawn Partners','2026-01-01','2026-01-01')`;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'cogenly','/repos/cogenly','[]','2026-01-01','2026-01-01')`;
      const project = yield* ProjectToolkit;
      const work = yield* WorkToolkit;
      const orchestrator = yield* OrchestratorToolkit;
      const results = [
        yield* project
          .handle("thread_launch", { projectId, projectFolderId, title: "New work" })
          .pipe(Effect.flatMap(Stream.runCollect)),
        yield* work
          .handle("work_start", {
            commandId: "work:1",
            targetProjectId: projectId,
            projectFolderId,
            title: "New work",
            scopeSummary: "Fix the bug",
          })
          .pipe(Effect.flatMap(Stream.runCollect)),
        yield* orchestrator
          .handle("create_threads", { clientRequestId: "new", threads: [{}] })
          .pipe(Effect.flatMap(Stream.runCollect)),
      ];
      for (const result of results)
        expect(JSON.stringify(result)).toContain(
          "cogenly is not in the Spawn Partners project. Add it to the project first, or start without a project.",
        );
      expect(yield* sql`SELECT 1 FROM orchestration_v2_projection_threads`).toEqual([]);
      expect(yield* sql`SELECT 1 FROM label_repositories`).toEqual([]);
    }).pipe(
      Effect.provide(
        handlers.pipe(
          Layer.provideMerge(services),
          Layer.provideMerge(Layer.succeed(Invocation.McpInvocationContext, scope)),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "membership-mcp-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  },
);
