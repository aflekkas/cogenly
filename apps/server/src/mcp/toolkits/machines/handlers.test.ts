import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type MachineInfo,
  type MachineListResult,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as DesktopAppControl from "../../../environment/DesktopAppControl.ts";
import * as Machines from "../../../machines/Machines.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as MachineSetup from "../../../tailscale/MachineSetup.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as MachinesHandlers from "./handlers.ts";
import { MachinesToolkit } from "./tools.ts";

const fullAccessThreadId = ThreadId.make("thread:full-access");
const planThreadId = ThreadId.make("thread:plan");
const shells = new Map([
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
  [planThreadId, liveThreadShell(planThreadId, { interactionMode: "plan" })],
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

const machine = (
  name: string,
  relation: MachineInfo["relation"],
  overrides: Partial<MachineInfo> = {},
): MachineInfo => ({
  environmentId: EnvironmentId.make(`env-${name.toLowerCase()}`),
  name,
  kind: relation === "this" ? "this-computer" : "other-computer",
  hardware: "laptop",
  platform: "darwin",
  providers: [],
  relation,
  online: true,
  lastSeenAt: null,
  pairedAt: null,
  pairing: relation === "this" ? "self" : "paired",
  ...overrides,
});

const hubList: MachineListResult = {
  machines: [machine("VPS", "this"), machine("MacBook", "spoke")],
  link: { _tag: "hub", spokes: 1 },
};

const makeServer = (options: {
  readonly pairMachines?: DesktopAppControl.DesktopAppControl["Service"]["pairMachines"];
  readonly unpaired?: Array<EnvironmentId>;
}) =>
  McpHttpServer.toolkitRegistration(MachinesToolkit, MachinesHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
        Layer.mock(DesktopAppControl.DesktopAppControl)({
          pairMachines: options.pairMachines ?? (() => Effect.die("unused")),
        }),
        Layer.mock(Machines.Machines)({
          list: Effect.succeed(hubList),
          unpair: (input) =>
            Effect.sync(() => {
              options.unpaired?.push(input.environmentId);
              return { unpaired: true };
            }),
        }),
        Layer.mock(MachineSetup.MachineSetup)({}),
      ),
    ),
  );

const call = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map(({ content }) =>
      content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

it.effect("machine_pair asks the desktop app to pair and hears only the machines back", () =>
  Effect.gen(function* () {
    const asked: Array<unknown> = [];
    const text = yield* call(threadCaller(fullAccessThreadId), "machine_pair", {
      hub: "VPS",
      joining: "MacBook",
    }).pipe(
      Effect.provide(
        makeServer({
          pairMachines: (input) =>
            Effect.sync(() => {
              asked.push(input);
              return {
                version: 1 as const,
                requestId: "request",
                ok: true as const,
                hub: { environmentId: EnvironmentId.make("env-vps"), name: "VPS" },
                joining: { environmentId: EnvironmentId.make("env-macbook"), name: "MacBook" },
              };
            }),
        }),
      ),
    );
    expect(asked).toEqual([{ hub: "VPS", joining: "MacBook" }]);
    expect(JSON.parse(text)).toEqual({
      hub: { environmentId: "env-vps", name: "VPS" },
      joining: { environmentId: "env-macbook", name: "MacBook" },
    });
  }),
);

it.effect("machine_pair refuses a plan-mode caller before reaching the desktop app", () =>
  Effect.gen(function* () {
    const text = yield* call(threadCaller(planThreadId), "machine_pair", {
      hub: "VPS",
      joining: "MacBook",
    }).pipe(Effect.provide(makeServer({})));
    expect(JSON.parse(text)).toMatchObject({ code: "capability_denied" });
  }),
);

it.effect("machine_pair says to use Settings when no desktop app runs beside this agent", () =>
  Effect.gen(function* () {
    const text = yield* call(threadCaller(fullAccessThreadId), "machine_pair", {
      hub: "VPS",
      joining: "MacBook",
    }).pipe(
      Effect.provide(
        makeServer({
          pairMachines: () =>
            Effect.fail(
              new DesktopAppControl.DesktopAppControlUnreachableError({
                candidateAddresses: ["/tmp/missing.sock"],
                cause: new Error("ENOENT"),
              }),
            ),
        }),
      ),
    );
    expect(JSON.parse(text)).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("Settings → Machines"),
    });
  }),
);

it.effect("machine_unpair unpairs a machine named in this machine's list", () =>
  Effect.gen(function* () {
    const unpaired: Array<EnvironmentId> = [];
    const text = yield* call(threadCaller(fullAccessThreadId), "machine_unpair", {
      machine: "macbook",
    }).pipe(Effect.provide(makeServer({ unpaired })));
    expect(JSON.parse(text)).toEqual({ unpaired: true });
    expect(unpaired).toEqual(["env-macbook"]);
  }),
);

it.effect.each([
  ["this machine", "VPS", "this machine"],
  ["a machine it doesn't know", "Studio", "machines_list"],
] as const)("machine_unpair refuses %s", ([, name, hint]) =>
  Effect.gen(function* () {
    const unpaired: Array<EnvironmentId> = [];
    const text = yield* call(threadCaller(fullAccessThreadId), "machine_unpair", {
      machine: name,
    }).pipe(Effect.provide(makeServer({ unpaired })));
    expect(JSON.parse(text)).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining(hint),
    });
    expect(unpaired).toEqual([]);
  }),
);
