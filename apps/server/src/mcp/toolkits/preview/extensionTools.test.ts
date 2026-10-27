import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type BrowserExtension,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as BrowserExtensions from "../../../preview/BrowserExtensions.ts";
import * as ServerBrowser from "../../../preview/ServerBrowser.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewHandlers from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";

const live = ThreadId.make("thread:live");
const ended = ThreadId.make("thread:ended");
const shells = new Map([
  [live, liveThreadShell(live, { runtimeMode: "full-access" })],
  [ended, liveThreadShell(ended, { activeRunId: null })],
]);
const id = "a".repeat(32);
const extension: BrowserExtension = {
  id,
  name: "Greeter",
  version: "1.0.0",
  description: "",
  manifestVersion: 3,
  enabled: true,
  source: { type: "webStore" },
  permissions: [],
  hostPermissions: [],
  popupPage: "popup.html",
  installedAt: "2026-10-26T00:00:00.000Z",
};

const thread = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
});
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["preview"]),
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

const installs: string[] = [];
const opened: unknown[] = [];
const server = McpHttpServer.toolkitRegistration(
  PreviewStandardToolkit,
  PreviewHandlers.layerStandard,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      }),
      Layer.mock(BrowserExtensions.BrowserExtensions)({
        list: () => Effect.succeed({ profileId: "default", extensions: [extension] }),
        install: (input) =>
          Effect.sync(() => {
            installs.push(input.source);
            return { profileId: "default", extension, updated: false };
          }),
        pageUrl: (input) => Effect.succeed(`chrome-extension://${input.id}/popup.html`),
      }),
      Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
        invoke: <A>(request: { readonly input: unknown }) =>
          Effect.sync(() => {
            opened.push(request.input);
            return {
              available: true,
              visible: true,
              tabId: "tab-1",
              url: null,
              title: null,
              loading: false,
            } as A;
          }),
      }),
      Layer.mock(ServerBrowser.ServerBrowser)({}),
      ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-extension-tools-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((mcp) => mcp.callTool({ name: tool, arguments: args })),
    Effect.map(({ content, isError }) => ({
      isError: isError === true,
      text: content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provide(server),
  );

it.effect("lets an agent manage extensions in its live turn, without asking the owner", () =>
  Effect.gen(function* () {
    installs.length = 0;
    const installed = yield* call("browser_extension_install", thread(live), { source: id });
    expect(installed.text).toContain('"updated":false');
    expect(installs).toEqual([id]);
    const listed = yield* call("browser_extensions_list", thread(live));
    expect(listed.text).toContain("Greeter");
  }),
);

it.effect("keeps installs to a live thread turn, while a finished turn can still list", () =>
  Effect.gen(function* () {
    installs.length = 0;
    const late = yield* call("browser_extension_install", thread(ended), { source: id });
    expect(late.text).toContain("no longer owns an active thread run");
    const outside = yield* call("browser_extension_remove", client, { id });
    expect(outside.text).toContain("needs an agent running inside Cogenly");
    expect(installs).toEqual([]);
    const listed = yield* call("browser_extensions_list", thread(ended));
    expect(listed.text).toContain("Greeter");
  }),
);

it.effect("opens an extension's popup as a new tab through the preview broker", () =>
  Effect.gen(function* () {
    opened.length = 0;
    const result = yield* call("browser_extension_open", thread(live), { id, page: "popup" });
    expect(result.text).toContain('"tabId":"tab-1"');
    expect(opened).toEqual([
      { url: `chrome-extension://${id}/popup.html`, reuseExistingTab: false, profileId: "default" },
    ]);
  }),
);
