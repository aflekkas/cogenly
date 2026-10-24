import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopAppControl from "../../../environment/DesktopAppControl.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as MachineSecurity from "../../../security/MachineSecurity.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const fullAccessThreadId = ThreadId.make("thread:full-access");
const planThreadId = ThreadId.make("thread:plan");
const endedThreadId = ThreadId.make("thread:ended");
const shells = new Map([
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
  [planThreadId, liveThreadShell(planThreadId, { interactionMode: "plan" })],
  [endedThreadId, liveThreadShell(endedThreadId, { activeRunId: null })],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
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

const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** The environment toolkit on an MCP server whose desktop app records what it was asked. */
const makeServer = (
  addEnvironment: DesktopAppControl.DesktopAppControl["Service"]["addEnvironment"],
) =>
  McpHttpServer.toolkitRegistration(EnvironmentToolkit, EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({}),
        Layer.mock(Settings.ServerSettingsService)({}),
        Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
        Layer.succeed(DesktopAppControl.DesktopAppControl, {
          addEnvironment,
          pairMachines: () => Effect.die("machine_pair is not exercised here"),
        }),
        Layer.succeed(MachineSecurity.MachineSecurity, {
          status: Effect.die("machine_security_status is not exercised here"),
        }),
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
      ),
    ),
  );

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ label: Schema.String }),
      Schema.Struct({ code: Schema.String, message: Schema.String }),
    ]),
  ),
);

const call = (scope: McpInvocationContext.McpInvocationScope, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "environment_add", arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const added = (input: { readonly ssh: string; readonly name?: string | undefined }) =>
  Effect.succeed({
    version: 1 as const,
    requestId: "request",
    ok: true as const,
    environmentId: EnvironmentId.make("environment-vps"),
    label: input.name ?? "VPS",
  });

it.effect.each([
  ["a full-access thread", threadCaller(fullAccessThreadId), { label: "Contabo VPS" }],
  ["a plan-mode thread", threadCaller(planThreadId), { code: "capability_denied" }],
  ["a thread whose turn ended", threadCaller(endedThreadId), { code: "parent_not_active" }],
  ["a read-only client", readOnlyClient, { code: "capability_denied" }],
] as const)("environment_add from %s", ([, scope, expected]) =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const outcome = yield* call(scope, { ssh: "t3vps", name: "Contabo VPS" }).pipe(
      Effect.provide(
        makeServer((input) => {
          calls.push(input);
          return added(input);
        }),
      ),
    );
    expect(outcome).toMatchObject(expected);
    expect(calls).toEqual("label" in expected ? [{ ssh: "t3vps", name: "Contabo VPS" }] : []);
  }),
);

it.effect("environment_add says when no desktop app runs beside this environment", () =>
  call(threadCaller(fullAccessThreadId), { ssh: "t3vps" }).pipe(
    Effect.map((outcome) =>
      expect(outcome).toMatchObject({
        code: "capability_denied",
        message: expect.stringContaining("Could not reach the Cogenly desktop app"),
      }),
    ),
    Effect.provide(
      makeServer(() =>
        Effect.fail(
          new DesktopAppControl.DesktopAppControlUnreachableError({
            candidateAddresses: ["/tmp/missing.sock"],
            cause: new Error("ENOENT"),
          }),
        ),
      ),
    ),
  ),
);

it.effect("environment_preferences_update sets the projects root", () =>
  Effect.gen(function* () {
    const patches: Array<unknown> = [];
    const server = McpHttpServer.toolkitRegistration(
      EnvironmentToolkit,
      EnvironmentHandlers.layer,
    ).pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("environment"),
            } as never),
          }),
          Layer.mock(Settings.ServerSettingsService)({
            updateSettings: (patch) =>
              Effect.sync(() => {
                patches.push(patch);
                return { ...DEFAULT_SERVER_SETTINGS, ...patch } as never;
              }),
          }),
          Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({
            withLock: (_threadId, effect) => effect,
          }),
          Layer.succeed(DesktopAppControl.DesktopAppControl, {
            addEnvironment: () => Effect.die("unused"),
            pairMachines: () => Effect.die("unused"),
          }),
          Layer.succeed(MachineSecurity.MachineSecurity, { status: Effect.die("unused") }),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
        ),
      ),
    );
    const text = yield* McpServer.McpServer.pipe(
      Effect.flatMap((mcp) =>
        mcp.callTool({
          name: "environment_preferences_update",
          arguments: { projectsRoot: "~/Work/projects" },
        }),
      ),
      Effect.map(({ content }) =>
        content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        threadCaller(fullAccessThreadId),
      ),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provide(server),
    );
    expect(patches).toEqual([{ projectsRoot: "~/Work/projects" }]);
    expect(JSON.parse(text)).toMatchObject({ projectsRoot: "~/Work/projects" });
  }),
);
