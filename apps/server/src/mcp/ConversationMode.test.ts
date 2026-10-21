import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SourceControlRepositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as TerminalMcpService from "./TerminalMcpService.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as WorkHandoff from "../work/WorkHandoffService.ts";
import * as ImageSearchService from "../images/ImageSearchService.ts";
import { ImageToolkit } from "./toolkits/images/tools.ts";
import { layer as ImageHandlers } from "./toolkits/images/handlers.ts";
import { TerminalToolkit } from "./toolkits/terminal/tools.ts";
import { layer as TerminalHandlers } from "./toolkits/terminal/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import { layer as WorktreeHandlers } from "./toolkits/worktree/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { layer as OrchestratorHandlers } from "./toolkits/orchestrator/handlers.ts";
import { toolkit as WorkToolkit, handlers as WorkHandlers } from "../work/WorkMcp.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { layer as ProjectHandlers } from "./toolkits/project/handlers.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const chatThreadId = ThreadId.make("thread:conversation");
const workThreadId = ThreadId.make("thread:conversation-work");

const shells = new Map([
  [chatThreadId, { ...liveThreadShell(chatThreadId), surface: "chat" as const }],
  [workThreadId, liveThreadShell(workThreadId)],
]);

const threadLayers = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null),
});

const neverCall = (tool: string) => Effect.die(new Error(`${tool} must not run for a chat caller`));

// The single-param Layer<X> constructors leave their requirements as
// unknown, which does not satisfy precise consumers below; narrowing here is
// sound because these layers build with no requirements at runtime.
const nodeFileSystem: Layer.Layer<FileSystem.FileSystem, never, never> = NodeFileSystem.layer;
const nodePath: Layer.Layer<Path.Path, never, never> = NodePath.layer;
const nodeCrypto: Layer.Layer<Crypto.Crypto, never, never> = NodeCrypto.layer;

// Ordered provision like the probe harness: every stub lands before use.
const serverLayer = Layer.mergeAll(
  McpHttpServer.toolkitRegistration(TerminalToolkit, TerminalHandlers),
  McpHttpServer.toolkitRegistration(WorktreeToolkit, WorktreeHandlers),
  McpHttpServer.toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers),
  McpHttpServer.toolkitRegistration(WorkToolkit, WorkHandlers),
  McpHttpServer.toolkitRegistration(ProjectToolkit, ProjectHandlers),
  McpHttpServer.toolkitRegistration(ImageToolkit, ImageHandlers),
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(threadLayers),
  Layer.provideMerge(
    Layer.mock(TerminalMcpService.TerminalMcpService)({
      run: () =>
        Effect.succeed({
          terminalId: "terminal-conversation",
          status: "exited" as const,
          exitCode: 0,
          timedOut: false,
          output: "",
          nextOffset: 0,
          truncated: false,
        }),
      write: () => neverCall("terminal service"),
      kill: () => neverCall("terminal service"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(WorktreeMcpService.WorktreeMcpService)({
      handoff: () => neverCall("worktree service"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      delegateTask: () => neverCall("orchestrator service"),
      createThreads: () => neverCall("orchestrator service"),
    }),
  ),
  Layer.provideMerge(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
  Layer.provideMerge(
    Layer.mock(WorkHandoff.WorkHandoffService)({
      start: () => neverCall("work service"),
      proposeHandoff: () =>
        Effect.succeed({
          title: "Chat draft",
          scopeSummary: "Drafted from the chat.",
          suggestedProjectId: null,
        }),
    }),
  ),
  Layer.provideMerge(Layer.mock(Project.ProjectService)({})),
  Layer.provideMerge(
    Layer.mock(ImageSearchService.ImageSearchService)({
      search: () =>
        Effect.succeed({
          results: [
            {
              url: "https://upload.wikimedia.org/wikipedia/commons/1/2/Red_fox.jpg",
              title: "Red fox",
            },
          ],
        }),
    }),
  ),
  Layer.provideMerge(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
  Layer.provideMerge(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/unused",
    }),
  ),
  Layer.provideMerge(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provideMerge(Layer.mock(GitWorkflow.GitWorkflowService)({})),
  Layer.provideMerge(Layer.mock(SourceControlRepositories.SourceControlRepositoryService)({})),
  Layer.provideMerge(nodeCrypto),
  Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "conversation-probe" })),
  Layer.provideMerge(ServerSettings.layerTest({})),
  // Provision order matters: these real Node layers build after their
  // consumers in the chain above.
  Layer.provideMerge(nodeFileSystem),
  Layer.provideMerge(nodePath),
);

const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "conversation-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "conversation-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** The tool result's JSON text for one caller. */
const callText = (tool: string, threadId: ThreadId, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.map(({ content }) =>
      content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, threadScope(threadId)),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provide(serverLayer),
  );

const refusalOf = (text: string) =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ code: Schema.String, message: Schema.String })),
  )(text);

describe("conversation-mode MCP boundary", () => {
  it.effect.each([
    ["terminal_run", { command: "echo chat-probe" }],
    ["terminal_write", { terminalId: "terminal-probe", input: "x" }],
    ["terminal_kill", { terminalId: "terminal-probe" }],
    ["t3_worktree_handoff", { branch: "probe/chat" }],
    ["delegate_task", { task: "probe task" }],
    ["create_threads", { threads: [{}] }],
    [
      "work_start",
      {
        commandId: "probe-1",
        targetProjectId: "project:probe",
        title: "Probe work",
        scopeSummary: "Probe scope",
      },
    ],
    ["t3_thread_launch", { title: "Probe launch" }],
  ] as const)("%s refuses a chat-surface caller", ([tool, args]) =>
    callText(tool, chatThreadId, args).pipe(
      Effect.flatMap(refusalOf),
      Effect.map((refusal) => {
        assert.equal(refusal.code, "capability_denied");
        assert.include(refusal.message, "conversation mode");
      }),
    ),
  );

  it.effect("terminal_run still serves a work-surface caller", () =>
    callText("terminal_run", workThreadId, { command: "echo work-probe" }).pipe(
      Effect.map((text) => {
        assert.equal(
          (JSON.parse(text) as { terminalId: string }).terminalId,
          "terminal-conversation",
        );
      }),
    ),
  );

  it.effect("work_propose_handoff still serves a chat-surface caller", () =>
    callText("work_propose_handoff", chatThreadId, {}).pipe(
      Effect.map((text) => {
        assert.equal((JSON.parse(text) as { title: string }).title, "Chat draft");
      }),
    ),
  );

  it.effect("image_search serves a chat-surface caller", () =>
    callText("image_search", chatThreadId, { query: "red fox" }).pipe(
      Effect.map((text) => {
        assert.deepEqual(JSON.parse(text), {
          results: [
            {
              url: "https://upload.wikimedia.org/wikipedia/commons/1/2/Red_fox.jpg",
              title: "Red fox",
            },
          ],
        });
      }),
    ),
  );

  it.effect("image_search serves a work-surface caller", () =>
    callText("image_search", workThreadId, { query: "red fox" }).pipe(
      Effect.map((text) => {
        assert.equal(
          (JSON.parse(text) as { results: Array<{ title?: string }> }).results[0]?.title,
          "Red fox",
        );
      }),
    ),
  );
});
