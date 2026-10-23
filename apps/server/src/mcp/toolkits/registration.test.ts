import * as GlobalSearch from "../../search/GlobalSearch.ts";
import * as FactService from "../../context/FactService.ts";
import * as ProjectLabels from "../../projectLabels/ProjectLabelService.ts";
import * as ProjectFiles from "../../projectLabels/ProjectFiles.ts";
import * as ProjectHome from "../../projectLabels/ProjectHome.ts";
import * as WorkHandoff from "../../work/WorkHandoffService.ts";
import * as AgentService from "../../agents/AgentService.ts";
import * as AgentWorkspace from "../../agents/AgentWorkspaceService.ts";
import * as AgentMcpPolicy from "../../agents/AgentMcpPolicy.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { agentFixture } from "../../agents/agent.testkit.ts";
import * as AgentStore from "../../agents/AgentStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as ServerConfig from "../../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectLabelId,
  ProviderInstanceId,
  ThreadId,
  OrchestratorMcpFailure,
  type OrchestrationV2ServerCommand,
  type VisualState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { idleThreadProjection, liveThreadShell } from "../McpToolAccess.testkit.ts";
import { HttpBody, HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../../project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as SourceControlRepositoryService from "../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../McpHttpServer.ts";
import * as McpSessionRegistry from "../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";

const threadId = ThreadId.make("thread-scratch");
const shell = liveThreadShell(threadId);
const projection = idleThreadProjection(shell);

// The html_state smoke cases below share one visual: the write lands first so
// the read sees it, both through the real handler stack.
let visualStateRows: Array<VisualState> = [];
const recordVisualStateSet = (command: OrchestrationV2ServerCommand) => {
  if (command.type !== "visual-state.set") {
    return Effect.die(new Error(`Unexpected dispatch in MCP smoke: ${command.type}`));
  }
  const row = {
    threadId: command.threadId,
    renderId: command.renderId,
    title: command.title ?? "",
    state: command.state,
    version: command.expectedVersion + 1,
    locked: false,
    submittedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  } satisfies VisualState;
  visualStateRows = [row];
  return Effect.succeed({ sequence: 1, storedEvents: [] });
};
const project = {
  id: shell.projectId,
  title: "MCP smoke project",
  workspaceRoot: "/workspace/mcp-smoke",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};
const layerStubServices = Layer.mergeAll(
  Layer.mock(GlobalSearch.GlobalSearch)({ query: () => Effect.succeed({ results: [] }) }),
  Layer.mock(ProjectLabels.ProjectLabelService)({ list: () => Effect.succeed({ labels: [] }) }),
  Layer.mock(ProjectFiles.ProjectFiles)({
    folderForThread: () =>
      Effect.succeed({
        labelId: ProjectLabelId.make("label:smoke"),
        name: "MCP smoke",
        dir: "/workspace/mcp-smoke",
        instructions: "",
        projectChatThreadId: null,
      }),
    listResources: () => Effect.succeed({ resources: [], truncated: false }),
  }),
  Layer.mock(ProjectHome.ProjectHome)({
    overview: (id) =>
      Effect.succeed({
        projectFolderId: id,
        name: "MCP smoke",
        instructions: "Ship small.",
        repositories: [],
        sourceLinks: [],
        projectChatThreadId: null,
      }),
  }),
  Layer.mock(WorkHandoff.WorkHandoffService)({
    proposeHandoff: () =>
      Effect.succeed({
        title: "Audit",
        scopeSummary: "Implement audit validation.",
        suggestedProjectId: null,
      }),
  }),
  Layer.mock(AgentWorkspace.AgentWorkspaceService)({
    listOpenItems: () => Effect.succeed({ commitments: [] }),
  }),
  Layer.mock(AgentService.AgentService)({
    recordProposal: (input) => Effect.succeed({ proposal: input.proposal }),
    list: () => Effect.succeed({ agents: [] }),
  }),
  Layer.mock(AgentMcpPolicy.AgentMcpPolicy)({
    beforeTool: (_scope, name) =>
      ["t3_thread_launch", "work_start"].includes(name)
        ? Effect.fail(
            new OrchestratorMcpFailure({
              code: "agent_approval_required",
              message: "Owner approval required: approval:http-test",
            }),
          )
        : Effect.succeed({ handled: false }),
    afterTool: () => Effect.void,
  }),
  Layer.mock(TerminalManager.TerminalManager)({ listAgents: () => Effect.succeed([]) }),
  Layer.mock(AgentStore.AgentStore)({
    forThread: () => Effect.succeed(agentFixture()),
    memory: () => Effect.succeed([]),
  }),
  Layer.mock(Orchestrator.OrchestratorV2)({ getThreadShell: () => Effect.succeed(shell) }),
  Layer.mock(FactService.FactService)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed({
      hostStatus: "ready",
      hostStatuses: {},
      hosts: [],
      devices: [],
      sessions: [],
      onboardingCompleted: true,
      agentAccessEnabled: true,
      hubBasePath: "/api/devices/hub",
      revision: 0,
    }),
  }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(shell),
    getThreadRecords: () => Effect.succeed({ ...projection, visualStates: visualStateRows }),
    getProjectThreadRecords: () => Effect.succeed(projection),
    dispatch: (command) => recordVisualStateSet(command),
  }),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({ list: () => Effect.succeed([]) }),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.some(project)),
    snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
  }),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: Effect.succeed("/unused"),
  }),
  Layer.mock(PreviewManager.PreviewManager)({
    list: () => Effect.succeed({ sessions: [], serverEpoch: "mcp-smoke", revision: 0 }),
  }),
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes).fill(7)),
  }),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({
    search: () =>
      Effect.succeed({
        matches: [
          {
            threadId: ThreadId.make("thread-found"),
            projectId: shell.projectId,
            title: "Likelihood of [AI] Weekly Checks",
            source: "assistant",
            snippet: "weekly checks",
            messageCreatedAt: null,
          },
        ],
      }),
  }),
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputSchema: Schema.Struct({ type: Schema.optional(Schema.String) }),
          annotations: Schema.optional(
            Schema.Struct({
              readOnlyHint: Schema.optional(Schema.Boolean),
              destructiveHint: Schema.optional(Schema.Boolean),
              openWorldHint: Schema.optional(Schema.Boolean),
            }),
          ),
        }),
      ),
    }),
  }),
);
const CallPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.Boolean,
      structuredContent: Schema.Unknown,
    }),
  }),
);
const decodeCallPayload = Schema.decodeUnknownEffect(CallPayload);
const decodeToolsListPayload = Schema.decodeUnknownEffect(ToolsListPayload);

const encodeCall = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeDeniedCall = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        isError: Schema.Boolean,
        content: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    }),
  ),
);

const smokeCases = [
  {
    toolkit: "search",
    names: ["search"],
    tool: "search",
    args: { query: "quartz" },
    expected: { results: [] },
  },
  {
    toolkit: "images",
    names: ["image_search"],
    tool: "image_search",
    args: { query: "red fox" },
    expected: { results: [] },
  },
  {
    toolkit: "work",
    names: ["work_start", "work_propose_handoff", "work_task"],
    tool: "work_propose_handoff",
    args: {},
    expected: {
      title: "Audit",
      scopeSummary: "Implement audit validation.",
      suggestedProjectId: null,
    },
  },
  {
    toolkit: "agentWorkspace",
    names: [
      "list_open_items",
      "propose_commitment",
      "propose_trigger",
      "propose_event_trigger",
      "update_commitment_status",
      "update_own_profile",
      "request_agent_approval",
      "start_agent_work",
    ],
    tool: "list_open_items",
    args: {},
    expected: { commitments: [] },
  },
  {
    toolkit: "agents",
    names: ["list_agents", "start_agent_builder", "update_agent_project"],
    tool: "list_agents",
    args: {},
    expected: { agents: [] },
  },
  {
    toolkit: "builder",
    names: ["propose_agent"],
    tool: "propose_agent",
    args: {
      name: "PR Digest",
      face: { shape: "nuage", color: "bleu", expression: "attentif" },
      responsibility: "Watch my open pull requests and send me a morning summary.",
      triggers: [],
      needs: [],
      permissions: {},
    },
    expected: {
      name: "PR Digest",
      face: { shape: "nuage", color: "bleu", expression: "attentif" },
      responsibility: "Watch my open pull requests and send me a morning summary.",
    },
  },
  {
    toolkit: "agentMemory",
    names: [
      "memory_read",
      "memory_write",
      "memory_remember",
      "memory_forget",
      "fact_search",
      "fact_propose",
      "fact_supersede",
    ],
    tool: "memory_read",
    args: {},
    expected: { notes: [] },
  },
  {
    toolkit: "attachment",
    names: ["t3_attachment_discard", "t3_attachment_prepare_upload", "t3_thread_send_attachments"],
    tool: "t3_attachment_prepare_upload",
    args: {
      upload: {
        type: "file",
        name: "smoke.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
      },
    },
    expected: {
      attachmentId: expect.any(String),
    },
  },
  {
    toolkit: "terminal",
    names: ["terminal_run", "terminal_read", "terminal_write", "terminal_kill", "terminal_list"],
    tool: "terminal_list",
    args: {},
    expected: { terminals: [] },
  },
  {
    toolkit: "worktree",
    names: ["t3_worktree_handoff", "t3_worktree_list", "t3_worktree_status"],
    tool: "t3_worktree_status",
    args: {},
    expected: {
      attached: false,
      projectWorkspaceRoot: "/workspace/mcp-smoke",
    },
  },
  {
    toolkit: "html",
    names: ["html_preview", "html_render"],
    tool: "html_render",
    args: {
      html: "<p>MCP smoke</p>",
      title: "MCP smoke",
      height: 120,
    },
    expected: {
      htmlRender: {
        title: "MCP smoke",
        height: 120,
      },
    },
  },
  {
    // The html_state tools run through the real handler stack against the
    // stubbed thread below; the write lands first so the read sees it.
    toolkit: "htmlState",
    names: ["html_state_read", "html_state_write"],
    tool: "html_state_write",
    args: {
      renderId: "html-render-1",
      title: "MCP smoke",
      state: { answers: [1] },
      expectedVersion: 0,
    },
    expected: {
      state: {
        renderId: "html-render-1",
        title: "MCP smoke",
        state: { answers: [1] },
        version: 1,
        locked: false,
      },
    },
  },
  {
    // Names are pinned once in the write case above; the read reuses its row.
    toolkit: "htmlState",
    names: [],
    tool: "html_state_read",
    args: { renderId: "html-render-1" },
    expected: {
      state: {
        renderId: "html-render-1",
        title: "MCP smoke",
        state: { answers: [1] },
        version: 1,
        locked: false,
      },
    },
  },
  {
    toolkit: "projectFiles",
    names: ["project_files_list", "project_file_read", "project_recall"],
    tool: "project_files_list",
    args: {},
    expected: { resources: [], truncated: false },
  },
  {
    toolkit: "projectHome",
    names: [
      "project_file_remove",
      "project_file_write",
      "project_instructions_get",
      "project_instructions_set",
      "project_overview",
      "project_repository_add",
      "project_repository_remove",
      "project_source_link",
      "project_source_unlink",
    ],
    tool: "project_overview",
    args: {},
    expected: { projectFolderId: "label:smoke", instructions: "Ship small." },
  },
  {
    toolkit: "projectLabels",
    names: [
      "t3_project_label_list",
      "t3_project_label_read",
      "t3_project_label_create",
      "t3_project_label_update",
      "t3_project_label_delete",
      "t3_project_label_archive",
      "t3_project_label_unarchive",
      "t3_project_label_link_source",
      "t3_project_label_unlink_source",
      "t3_project_label_link_repository",
      "t3_project_label_unlink_repository",
      "t3_project_label_clone_repository",
      "t3_project_label_file_thread",
      "t3_thread_move_project_folder",
      "t3_thread_set_project_labels",
    ],
    tool: "t3_project_label_list",
    args: {},
    expected: { labels: [] },
  },
  {
    toolkit: "project",
    names: [
      "t3_project_clone",
      "t3_project_create",
      "t3_project_delete",
      "t3_project_list",
      "t3_project_read",
      "t3_project_update",
      "t3_thread_launch",
    ],
    tool: "t3_project_list",
    args: {},
    expected: {
      projects: [
        {
          title: "MCP smoke project",
        },
      ],
      nextCursor: null,
    },
  },
  {
    toolkit: "previewControls",
    names: ["t3_preview_close", "t3_preview_list"],
    tool: "t3_preview_list",
    args: {},
    expected: {
      sessions: [],
      nextCursor: null,
    },
  },
  {
    toolkit: "environment",
    names: ["t3_environment_add", "t3_environment_preferences_update", "t3_environment_read"],
    tool: "t3_environment_read",
    args: {},
    expected: {
      label: "MCP smoke",
      preferences: { projectsRoot: expect.any(String) },
    },
  },
  {
    toolkit: "preview",
    names: [
      "preview_click",
      "preview_dialog",
      "preview_drag",
      "preview_evaluate",
      "preview_hover",
      "preview_navigate",
      "preview_open",
      "preview_press",
      "preview_recording_start",
      "preview_recording_stop",
      "preview_resize",
      "preview_scroll",
      "preview_select",
      "preview_set_appearance",
      "preview_snapshot",
      "preview_status",
      "preview_type",
      "preview_upload",
      "preview_wait_for",
    ],
    tool: "preview_status",
    args: {},
    expected: {
      available: false,
      tabId: null,
    },
  },
  {
    toolkit: "device",
    names: ["device_close", "device_list", "device_open", "device_screenshot"],
    tool: "device_list",
    args: {},
    expected: {
      devices: [],
      open: [],
    },
  },
  {
    toolkit: "pullRequests",
    names: [
      "link_pull_request",
      "list_thread_pull_requests",
      "unlink_pull_request",
      "unwatch_pull_request",
      "watch_pull_request",
    ],
    tool: "list_thread_pull_requests",
    args: {},
    expected: {
      pullRequests: [],
      chains: [],
    },
  },
  {
    toolkit: "thread",
    names: [
      "run_scheduled_task_now",
      "t3_pending_request_list",
      "t3_pending_request_read",
      "t3_pending_request_respond",
      "t3_queue_cancel",
      "t3_queue_edit",
      "t3_queue_list",
      "t3_queue_promote_to_steer",
      "t3_queue_read",
      "t3_queue_reorder",
      "t3_thread_configuration",
      "t3_thread_configure",
      "t3_thread_fork",
      "t3_thread_merge_back",
      "t3_thread_organize",
      "t3_thread_search",
      "t3_thread_settle",
      "t3_thread_snooze",
      "t3_thread_transfers",
      "t3_thread_unsettle",
      "t3_thread_unsnooze",
    ],
    tool: "t3_thread_configuration",
    args: {},
    expected: {
      threadId: "thread-scratch",
      runtimeMode: "full-access",
    },
  },
  {
    // Search results carry a ready-made Markdown link the agent can paste.
    toolkit: "thread",
    names: [],
    tool: "t3_thread_search",
    args: { query: "weekly checks" },
    expected: {
      matches: [
        {
          threadId: "thread-found",
          link: "[Likelihood of AI Weekly Checks](cogenly-thread://v1/thread-found)",
        },
      ],
    },
  },
  {
    toolkit: "orchestrator",
    names: [
      "create_threads",
      "delegate_task",
      "delete_scheduled_task",
      "list_scheduled_tasks",
      "orchestrator_capabilities",
      "request_secret",
      "schedule_task",
      "t3_thread_interrupt",
      "t3_thread_list",
      "t3_thread_read",
      "t3_thread_send",
      "t3_thread_update",
      "t3_thread_wait",
      "t3_workflow_stop",
      "task_cancel",
      "task_status",
      "update_scheduled_task",
    ],
    tool: "orchestrator_capabilities",
    args: {},
    expected: {
      parentThreadId: "thread-scratch",
      providers: [],
    },
  },
];

it.effect.each(smokeCases)(
  "$toolkit exposes its tool list and handles a happy-path HTTP call",
  (testCase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
        // The images toolkit reaches the real Commons API through HttpClient;
        // the smoke run answers that host in-process so the suite stays
        // hermetic. Everything else delegates to the ambient client.
        const ambientClient = yield* HttpClient.HttpClient;
        const smokeHttpClient: HttpClient.HttpClient = {
          ...ambientClient,
          execute: (request) =>
            request.url.startsWith("https://commons.wikimedia.org")
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(JSON.stringify({ batchcomplete: true }), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    }),
                  ),
                )
              : ambientClient.execute(request),
        };
        yield* HttpRouter.serve(layerRoutes, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, smokeHttpClient)),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-scratch")),
              getDescriptor: Effect.succeed({
                environmentId: EnvironmentId.make("environment-scratch"),
                label: "MCP smoke",
                serverVersion: "0.0.0",
                platform: { os: "linux", arch: "x64" },
                capabilities: { repositoryIdentity: false },
              }),
            }),
          ),
          Layer.provide(
            Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
              invoke: <A>() =>
                Effect.succeed({
                  available: false,
                  visible: false,
                  tabId: null,
                  url: null,
                  title: null,
                  loading: false,
                } as A),
            }),
          ),
          Layer.provide(PreviewBrowser.layer),
          Layer.provide(layerStubServices),
          Layer.build,
        );

        const registry = McpSessionRegistry.issueActiveMcpCredential({
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["preview", "device"]),
        });
        const credential = yield* registry;
        expect(credential).toBeDefined();

        const httpClient = yield* HttpClient.HttpClient;
        const auth = credential!.config.authorizationHeader;
        const initResponse = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: auth,
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
            "application/json",
          ),
        });
        expect(initResponse.status).toBe(200);
        const sessionId = initResponse.headers["mcp-session-id"];

        const listResponse = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: auth,
            "mcp-protocol-version": "2025-06-18",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: HttpBody.text(
            `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
            "application/json",
          ),
        });
        const bodyText = yield* listResponse.text;
        const payload = yield* decodeToolsListPayload(bodyText.match(/\{.*\}/s)![0]);
        const tools = payload.result.tools;
        const toolNames = tools.map((tool) => tool.name);
        expect(toolNames).toContain("t3_worktree_handoff");
        expect(toolNames).toContain("t3_worktree_status");
        // The worktree registration merges alongside the other toolkits rather
        // than replacing them.
        expect(toolNames).toContain("preview_status");
        expect(toolNames).toContain("delegate_task");

        // Names are pinned independently of toolkit construction, including removed tools.
        const catalog = smokeCases.flatMap((entry) => entry.names).toSorted();
        expect(toolNames.toSorted()).toEqual(catalog);
        for (const name of testCase.names) expect(toolNames).toContain(name);
        const callResponse = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: auth,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: HttpBody.text(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: testCase.tool, arguments: testCase.args },
            }),
            "application/json",
          ),
        });
        expect(callResponse.status).toBe(200);
        const callText = yield* callResponse.text;
        const result = yield* decodeCallPayload(callText.match(/\{.*\}/s)![0]);
        expect(result.result.isError).toBe(false);
        expect(result.result.structuredContent).toMatchObject(testCase.expected);
        if (testCase.toolkit === "agentWorkspace") {
          // An authenticated call cannot reach the launch handler after policy refuses it.
          for (const name of ["t3_thread_launch", "work_start"]) {
            const refused = yield* httpClient.post("/mcp", {
              headers: {
                accept: "application/json, text/event-stream",
                authorization: auth,
                ...(sessionId ? { "mcp-session-id": sessionId } : {}),
              },
              body: HttpBody.text(
                encodeCall({
                  jsonrpc: "2.0",
                  id: 4,
                  method: "tools/call",
                  params: { name, arguments: { title: "Unapproved work" } },
                }),
                "application/json",
              ),
            });
            const denied = yield* decodeDeniedCall(yield* refused.text);
            expect(denied.result.isError).toBe(true);
            expect(denied.result.content[0]!.text).toContain("agent_approval_required");
          }
        }
        // Descriptions, including imported guidance, must use the product name.
        expect(
          bodyText.match(/T3 Code|T3-owned|T3 thread|T3 injects|T3's|t3\.chat|Cogenly Connect/g),
        ).toBeNull();

        // The handoff tool mutates thread state, reaches the network (origin
        // fetch), and runs project setup scripts, so its MCP hints must not
        // promise a read-only, closed-world, non-destructive tool.
        const handoff = tools.find((tool) => tool.name === "t3_worktree_handoff");
        expect(handoff?.annotations?.readOnlyHint).toBe(false);
        expect(handoff?.annotations?.destructiveHint).toBe(true);
        expect(handoff?.annotations?.openWorldHint).toBe(true);
        const status = tools.find((tool) => tool.name === "t3_worktree_status");
        expect(status?.annotations?.readOnlyHint).toBe(true);
        expect(status?.annotations?.destructiveHint).toBe(false);

        // MCP requires every tool input schema to be a top-level object schema.
        // A non-object schema (e.g. the anyOf produced by an empty
        // Schema.Struct({})) makes clients reject the entire server.
        for (const tool of tools) {
          expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
        }
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeHttpServer.layerTest,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-mcp-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
        ),
      ),
    ),
);
