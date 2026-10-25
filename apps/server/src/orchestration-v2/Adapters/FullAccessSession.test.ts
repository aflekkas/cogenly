import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as CodexClient from "effect-codex-app-server/client";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as RuntimeRepository from "../../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as CodexAdapter from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "../testkit/ProviderReplayHarness.ts";
import * as ClaudeAdapter from "./ClaudeAdapterV2.ts";

const decodeRuntimeMode = Schema.decodeEffect(RuntimeMode);
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeAppThread = Schema.decodeEffect(OrchestrationV2AppThread);

const legacyThread = (
  threadId: ThreadId,
  modelSelection: { instanceId: ProviderInstanceId; model: string },
) =>
  Effect.gen(function* () {
    return yield* decodeAppThread({
      id: threadId,
      projectId: ProjectId.make("test"),
      title: "Legacy thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: yield* DateTime.now,
      updatedAt: yield* DateTime.now,
      archivedAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    });
  });

it.effect("starts a legacy Claude thread with full access and never emits a tool approval", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-full-access-" });
    const opened = yield* Deferred.make<ClaudeAdapter.ClaudeAgentSdkQueryOpenInput>();
    const offered = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const queryRunner: ClaudeAdapter.ClaudeAgentSdkQueryRunnerShape = {
      allocateSessionId: Effect.succeed("native-full-access"),
      open: (input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(opened, input);
          return {
            messages: Stream.fromEffect(Deferred.await(closed)).pipe(Stream.drain),
            offer: () => Deferred.succeed(offered, undefined).pipe(Effect.asVoid),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            stopTask: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            interrupt: Effect.void,
            close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
          };
        }),
      forkSession: () => Effect.die("unexpected fork"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    };
    const instanceId = ProviderInstanceId.make("claude");
    const threadId = ThreadId.make("full-access");
    const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
    const runtimePolicy = {
      runtimeMode: yield* decodeRuntimeMode("approval-required"),
      interactionMode: "default" as const,
      cwd: root,
      approvalPolicy: "on-request",
    };
    const adapter = yield* ClaudeAdapter.makeClaudeAdapterV2({
      instanceId,
      settings: yield* decodeClaudeSettings({
        launchArgs: "--permission-mode default",
      }),
      environment: { HOME: root },
      attachmentsDir: root,
      fileSystem: fs,
      path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner,
    });
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("full-access"),
      modelSelection,
      runtimePolicy,
    });
    const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
    const boundary = yield* Deferred.make<void>();
    yield* session.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.terminal") {
            yield* Deferred.succeed(boundary, undefined);
          }
        }),
      ),
      Effect.forkChild,
    );
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    const appThread = yield* legacyThread(threadId, modelSelection);
    yield* session.startTurn({
      appThread,
      threadId,
      runId: RunId.make("test"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("test"),
      rootNodeId: NodeId.make("test"),
      providerThread,
      modelSelection,
      runtimePolicy,
      message: {
        messageId: MessageId.make("test"),
        text: "Write a file",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
    yield* Deferred.await(offered);
    const { options } = yield* Deferred.await(opened);
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.isTrue(options.allowDangerouslySkipPermissions);
    assert.isFunction(options.canUseTool);
    const toolInput = { file_path: path.join(root, "test.txt"), content: "ok" };
    const result = yield* Effect.promise(() =>
      options.canUseTool!("Write", toolInput, {
        signal: new AbortController().signal,
        toolUseID: "write-test",
        requestId: "request-test",
        suggestions: [],
      }),
    );
    assert.deepEqual(result, {
      behavior: "allow",
      updatedInput: toolInput,
      toolUseID: "write-test",
    });
    // The terminal event follows the callback's events, draining the queue without polling.
    yield* Deferred.succeed(closed, undefined);
    yield* Deferred.await(boundary);
    assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
    assert.isFalse(
      events.some(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
      ),
    );
  }).pipe(Effect.provide([McpProviderSessions.layer, IdAllocator.layer, NodeServices.layer])),
);

// The CLI can report `default` on init although it was opened in bypass
// (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 forces this), as in pingdotgg/t3code#22483.
const runClaudeTurnWhereInitReportsDefault = (input: { readonly rejectBypass: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-full-access-init-" });
    const opened = yield* Deferred.make<ClaudeAdapter.ClaudeAgentSdkQueryOpenInput>();
    const offered = yield* Deferred.make<void>();
    const modeRequested = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const requestedModes: Array<string> = [];
    const init = {
      type: "system",
      subtype: "init",
      permissionMode: "default",
      session_id: "native-full-access-init",
      uuid: "00000000-0000-4000-8000-000000000001",
    } as unknown as SDKMessage;
    const queryRunner: ClaudeAdapter.ClaudeAgentSdkQueryRunnerShape = {
      allocateSessionId: Effect.succeed("native-full-access-init"),
      open: (openInput) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(opened, openInput);
          return {
            messages: Stream.concat(
              Stream.fromEffect(Deferred.await(offered).pipe(Effect.as(init))),
              Stream.fromEffect(Deferred.await(closed)).pipe(Stream.drain),
            ),
            offer: () => Deferred.succeed(offered, undefined).pipe(Effect.asVoid),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: (mode) =>
              Effect.gen(function* () {
                requestedModes.push(mode);
                yield* Deferred.succeed(modeRequested, undefined);
                if (input.rejectBypass) {
                  return yield* new ClaudeAdapter.ClaudeAgentSdkQueryRunnerError({
                    method: "setPermissionMode",
                    cause: new Error("bypassPermissions is disabled"),
                  });
                }
              }),
            stopTask: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            interrupt: Effect.void,
            close: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
          };
        }),
      forkSession: () => Effect.die("unexpected fork"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    };
    const instanceId = ProviderInstanceId.make("claude");
    const threadId = ThreadId.make("full-access-init");
    const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
    const runtimePolicy = {
      runtimeMode: yield* decodeRuntimeMode("full-access"),
      interactionMode: "default" as const,
      cwd: root,
    };
    const adapter = yield* ClaudeAdapter.makeClaudeAdapterV2({
      instanceId,
      settings: yield* decodeClaudeSettings({}),
      environment: { HOME: root },
      attachmentsDir: root,
      fileSystem: fs,
      path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner,
    });
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("full-access-init"),
      modelSelection,
      runtimePolicy,
    });
    const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
    const boundary = yield* Deferred.make<void>();
    yield* session.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.terminal") yield* Deferred.succeed(boundary, undefined);
        }),
      ),
      Effect.forkChild,
    );
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* session.startTurn({
      appThread: yield* legacyThread(threadId, modelSelection),
      threadId,
      runId: RunId.make("test-init"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("test-init"),
      rootNodeId: NodeId.make("test-init"),
      providerThread,
      modelSelection,
      runtimePolicy,
      message: {
        messageId: MessageId.make("test-init"),
        text: "Run a command",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
    const { options } = yield* Deferred.await(opened);
    assert.equal(options.permissionMode, "bypassPermissions");
    yield* Deferred.await(modeRequested);
    // While Claude runs below bypass, every tool call reaches the callback.
    const toolInput = { command: "printf ok" };
    const result = yield* Effect.promise(() =>
      options.canUseTool!("Bash", toolInput, {
        signal: new AbortController().signal,
        toolUseID: "bash-test",
        requestId: "request-test",
        suggestions: [],
      }),
    );
    yield* Deferred.succeed(closed, undefined);
    yield* Deferred.await(boundary);
    return { requestedModes, result, toolInput, events };
  });

it.effect("puts a Claude query back in bypass when init reports a lower mode", () =>
  Effect.gen(function* () {
    const { requestedModes, result, toolInput } = yield* runClaudeTurnWhereInitReportsDefault({
      rejectBypass: false,
    });
    assert.deepEqual(requestedModes, ["bypassPermissions"]);
    assert.deepEqual(result, {
      behavior: "allow",
      updatedInput: toolInput,
      toolUseID: "bash-test",
    });
  }).pipe(Effect.provide([McpProviderSessions.layer, IdAllocator.layer, NodeServices.layer])),
);

it.effect("keeps approving tool calls when Claude refuses the bypass restore", () =>
  Effect.gen(function* () {
    const { requestedModes, result, toolInput, events } =
      yield* runClaudeTurnWhereInitReportsDefault({ rejectBypass: true });
    assert.deepEqual(requestedModes, ["bypassPermissions"]);
    assert.deepEqual(result, {
      behavior: "allow",
      updatedInput: toolInput,
      toolUseID: "bash-test",
    });
    assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
  }).pipe(Effect.provide([McpProviderSessions.layer, IdAllocator.layer, NodeServices.layer])),
);

it.effect("starts a legacy Codex thread with full access and auto-approves native requests", () =>
  Effect.gen(function* () {
    const serverConfig = yield* makeReplayServerConfig("full-access");
    const requests: Array<{ method: string; payload: unknown }> = [];
    const handlers = new Map<string, (payload: unknown) => Effect.Effect<unknown>>();
    const notifications = new Map<string, (payload: unknown) => Effect.Effect<unknown>>();
    const request = (method: string, payload: unknown) =>
      Effect.sync(() => {
        requests.push({ method, payload });
        switch (method) {
          case "initialize":
            return {};
          case "app/list":
            return {
              data: [
                { id: "connector_gmail", name: "Gmail", isAccessible: true },
                { id: "connector_spotify", name: "Spotify", isAccessible: true },
              ],
              nextCursor: null,
            };
          case "config/read":
            return {
              config: { mcp_servers: { linear: { url: "https://mcp.linear.app/mcp" } } },
              origins: {},
            };
          case "thread/start":
            return { thread: { id: "native-codex", createdAt: 1, updatedAt: 1 } };
          case "turn/start":
            return { turn: { id: "native-turn", startedAt: 1 } };
          default:
            throw new Error(`Unexpected request: ${method}`);
        }
      });
    // The transport fixture supplies only the protocol fields read by these paths.
    const client = {
      request,
      notify: () => Effect.void,
      handleServerRequest: (
        method: string,
        handler: (payload: unknown) => Effect.Effect<unknown>,
      ) =>
        Effect.sync(() => {
          handlers.set(method, handler);
        }),
      handleServerNotification: (
        method: string,
        handler: (payload: unknown) => Effect.Effect<unknown>,
      ) =>
        Effect.sync(() => {
          notifications.set(method, handler);
        }),
      handleUnknownServerRequest: () => Effect.void,
      handleUnknownServerNotification: () => Effect.void,
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const instanceId = ProviderInstanceId.make("codex");
    const threadId = ThreadId.make("full-access-codex");
    const modelSelection = { instanceId, model: "gpt-5.5" };
    const runtimePolicy = {
      runtimeMode: yield* decodeRuntimeMode("auto-accept-edits"),
      interactionMode: "default" as const,
      cwd: serverConfig.baseDir,
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly" },
    };
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    yield* mcpSessions.set({
      environmentId: EnvironmentId.make("test"),
      threadId,
      providerInstanceId: instanceId,
      providerSessionId: "test",
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer test",
      browserToolsAvailable: true,
    });
    const adapter = yield* CodexAdapter.makeCodexAdapterV2({
      instanceId,
      settings: yield* decodeCodexSettings({}),
      environment: {},
      clientFactory: { open: () => Effect.succeed(client) },
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig,
    });
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("codex-test"),
      modelSelection,
      runtimePolicy,
    });
    const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
    const boundary = yield* Deferred.make<void>();
    yield* session.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.terminal") yield* Deferred.succeed(boundary, undefined);
        }),
      ),
      Effect.forkChild,
    );
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    yield* session.startTurn({
      appThread: yield* legacyThread(threadId, modelSelection),
      threadId,
      runId: RunId.make("test"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("test"),
      rootNodeId: NodeId.make("test"),
      providerThread,
      modelSelection,
      runtimePolicy,
      message: {
        messageId: MessageId.make("test"),
        text: "Write a file",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
    assert.deepInclude(requests.find(({ method }) => method === "turn/start")?.payload, {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    assert.nestedPropertyVal(
      requests.find(({ method }) => method === "thread/start")?.payload,
      "config.mcp_servers.cogenly.default_tools_approval_mode",
      "approve",
    );
    // Codex's own Gmail app and Linear server duplicate Cogenly integrations.
    const threadStart = requests.find(({ method }) => method === "thread/start");
    assert.isDefined(threadStart);
    const threadConfig = (threadStart.payload as { readonly config: Record<string, unknown> })
      .config;
    assert.equal(threadConfig["apps.connector_gmail.enabled"], false);
    assert.equal(threadConfig["mcp_servers.linear.enabled"], false);
    assert.notProperty(threadConfig, "apps.connector_spotify.enabled");
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]) {
      assert.deepEqual(
        yield* handlers.get(method)!({ threadId: "native-codex", turnId: "native-turn" }),
        { decision: "acceptForSession" },
      );
    }
    assert.deepEqual(
      yield* handlers.get("item/permissions/requestApproval")!({
        permissions: { fileSystem: { read: ["/tmp"] } },
      }),
      { permissions: { fileSystem: { read: ["/tmp"] } }, scope: "session" },
    );
    assert.propertyVal(
      yield* handlers.get("mcpServer/elicitation/request")!({
        serverName: "cogenly",
        mode: "form",
        message: "Allow?",
        requestedSchema: { type: "object", properties: {} },
      }),
      "action",
      "accept",
    );
    yield* notifications.get("turn/completed")!({
      threadId: "native-codex",
      turn: { id: "native-turn", status: "completed", completedAt: 2, error: null },
    });
    yield* Deferred.await(boundary);
    assert.isFalse(events.some((event) => event.type === "runtime_request.updated"));
    assert.isFalse(
      events.some(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
      ),
    );
  }).pipe(Effect.provide([McpProviderSessions.layer, IdAllocator.layer, NodeServices.layer])),
);

it.effect("reads legacy persisted threads and sessions and rewrites canonical runtime modes", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* RuntimeRepository.ProviderSessionRuntimeRepository;
    const sql = yield* SqlClient.SqlClient;
    const instanceId = ProviderInstanceId.make("codex");
    const threadId = ThreadId.make("persisted-legacy");
    const thread = yield* legacyThread(threadId, { instanceId, model: "gpt-5.5" });
    yield* store.apply({
      id: EventId.make("thread-created"),
      type: "thread.created",
      threadId,
      occurredAt: thread.createdAt,
      payload: thread,
    });
    yield* runtimes.upsert({
      threadId,
      providerName: "codex",
      providerInstanceId: instanceId,
      adapterKey: "codex",
      runtimeMode: "full-access",
      status: "stopped",
      lastSeenAt: "2026-10-20T00:00:00Z",
      resumeCursor: null,
      runtimePayload: null,
    });
    for (const mode of ["approval-required", "auto-accept-edits", "auto", "full-access"]) {
      // Simulate pre-upgrade SQLite rows, bypassing the current write codecs.
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET runtime_mode = ${mode}, payload_json = json_set(payload_json, '$.runtimeMode', ${mode})
        WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE provider_session_runtime SET runtime_mode = ${mode} WHERE thread_id = ${threadId}`;
      const loaded = yield* store.getThread(threadId);
      assert.equal(loaded.runtimeMode, "full-access");
      assert.equal((yield* store.getThreadShell(threadId))?.runtimeMode, "full-access");
      const runtime = Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }));
      assert.equal(runtime.runtimeMode, "full-access");
      assert.equal((yield* runtimes.list())[0]?.runtimeMode, "full-access");
      yield* runtimes.upsert(runtime);
      yield* store.apply({
        id: EventId.make(`update-${mode}`),
        type: "thread.runtime-mode-updated",
        threadId,
        occurredAt: loaded.updatedAt,
        payload: loaded,
      });
      const rows = yield* sql<{
        runtime_mode: string;
        payload_json: string;
      }>`SELECT runtime_mode, payload_json
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      assert.equal(rows[0]?.runtime_mode, "full-access");
      assert.propertyVal(JSON.parse(rows[0]!.payload_json), "runtimeMode", "full-access");
      const sessions = yield* sql<{
        runtime_mode: string;
      }>`SELECT runtime_mode FROM provider_session_runtime WHERE thread_id = ${threadId}`;
      assert.equal(sessions[0]?.runtime_mode, "full-access");
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ProjectionStore.layer, RuntimeRepository.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
