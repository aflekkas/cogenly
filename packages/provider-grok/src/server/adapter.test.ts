import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeGrokAdapterV2 } from "./adapter.ts";
import type { GrokAcpHost } from "./acp.ts";
import { GrokSettings } from "../settings.ts";

const decodeSettings = Schema.decodeEffect(GrokSettings);
const INSTANCE_ID = ProviderInstanceId.make("grok-test");
const THREAD_ID = ThreadId.make("thread:grok");
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
  conversationMode: true,
});
const modelSelection = (instanceId = INSTANCE_ID) => ({ instanceId, model: "grok-4.7" });
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  Layer.mock(ProviderHost.ProviderHost)({
    resolveAttachmentPath: () => null,
    settings: {
      get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    paths: {
      cwd: process.cwd(),
      baseDir: "/unused",
      stateDir: "/unused",
      providerStatusCacheDir: "/unused",
      attachmentsDir: "/unused",
    },
  }),
);

const turnInput = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  runOrdinal = 1,
  policy = runtimePolicy,
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2TurnInput> {
  const now = yield* DateTime.now;
  const threadId = providerThread.appThreadId ?? THREAD_ID;
  const selection = modelSelection(providerThread.providerInstanceId);
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project-grok-test"),
    title: "Grok test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: providerThread.providerInstanceId,
    modelSelection: selection,
    runtimeMode: policy.runtimeMode,
    interactionMode: policy.interactionMode,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    appThread,
    threadId,
    runId: RunId.make(`run-${runOrdinal}`),
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`attempt-${runOrdinal}`),
    rootNodeId: NodeId.make(`root-${runOrdinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message-${runOrdinal}`),
      text: "Hello Grok",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection,
    runtimePolicy: policy,
  };
});

it.effect.each([
  { terminal: true, builder: false, mcpHttp: true },
  { terminal: false, builder: false, mcpHttp: true },
  { terminal: true, builder: true, mcpHttp: true },
  { terminal: true, builder: false, mcpHttp: false },
])(
  "selects authorized Grok conversation instructions (terminal=$terminal builder=$builder mcpHttp=$mcpHttp)",
  ({ terminal, builder, mcpHttp }) =>
    Effect.gen(function* () {
      let prompt: unknown;
      const host: GrokAcpHost = {
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, image: false, mcpHttp },
          authMethodIds: [],
          agentVersion: "test",
          modelState: { currentModelId: "grok-4.7", models: [] },
        },
        account: { email: undefined, subscriptionTier: undefined },
        connection: {
          request: async (method, params) => {
            if (method === "session/prompt") {
              prompt = params;
              return new Promise<unknown>(() => {});
            }
            return {
              sessionId: "grok-session",
              models: { currentModelId: "grok-4.7", availableModels: [] },
            };
          },
          notify: () => {},
          onNotification: () => {},
          onRequest: () => {},
          onProtocolError: () => {},
          closed: new Promise<void>(() => {}),
        },
        exited: new Promise(() => {}),
        stderrTail: () => [],
        close: async () => {},
      };
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("test"),
        threadId: THREAD_ID,
        providerSessionId: "mcp-test",
        providerInstanceId: INSTANCE_ID,
        endpoint: "http://127.0.0.1:1/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: false,
        terminalToolsAvailable: terminal,
      });
      const policy = { ...runtimePolicy, builderMode: builder };
      const adapter = yield* makeGrokAdapterV2({
        instanceId: INSTANCE_ID,
        settings: yield* decodeSettings({ enabled: true }),
        environment: {},
        createHost: async () => host,
      });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: ProviderSessionId.make("grok-test"),
        modelSelection: modelSelection(),
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection(),
        runtimePolicy: policy,
      });
      yield* runtime.startTurn(yield* turnInput(providerThread, 1, policy));
      const text = JSON.stringify(prompt);
      expect(prompt).toBeDefined();
      if (builder) {
        expect(text).toContain("<builder_mode>");
        expect(text).toContain("propose_agent");
        expect(text).not.toContain("terminal_run");
        expect(text).not.toContain("work_task");
      } else if (terminal && mcpHttp) {
        expect(text).toContain("Look things up yourself with the cogenly terminal_run tool");
      } else {
        expect(text).toContain("you cannot run commands");
        expect(text).not.toContain("terminal_run");
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
