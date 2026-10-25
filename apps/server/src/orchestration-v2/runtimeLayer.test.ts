import { expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  IntegrationName,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as VisualStates from "../htmlRender/VisualState.ts";
import * as Integrations from "../integrations/Integrations.ts";
import { IntegrationEndpointPolicy } from "../integrations/RemoteEndpoint.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

type ProductionRequirements = Layer.Services<typeof RuntimeLayer.layerProduction>;
type ProductionOutputs = Layer.Success<typeof RuntimeLayer.layerProduction>;

// The production layer builds thread management itself. Demanding it as an
// input leaks the requirement into every CLI command through runServer and
// breaks the server typecheck at binCli.ts.
type DemandsThreadManagement = Extract<
  ProductionRequirements,
  ThreadManagement.ThreadManagementService
>;

const demandsThreadManagement: [DemandsThreadManagement] extends [never] ? true : false = true;

// The visual state feature needs its service in the production scope (the
// websocket handlers read it there), so the fix must keep providing it.
type ProvidesVisualStates = Extract<ProductionOutputs, VisualStates.VisualStateService>;

const providesVisualStates: [ProvidesVisualStates] extends [never] ? false : true = true;

it("provides visual states without demanding thread management", () => {
  expect(demandsThreadManagement).toBe(true);
  expect(providesVisualStates).toBe(true);
});

/** A remote MCP server at the network boundary: answers the handshake and lists one tool. */
const fakeMcpFetch: typeof globalThis.fetch = (input, init) =>
  new Request(input, init).text().then((text) => {
    const body = JSON.parse(text) as { readonly id?: number; readonly method: string };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === "tools/list"
        ? { tools: [{ name: "search", inputSchema: { type: "object" } }] }
        : { protocolVersion: "2025-03-26" };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });

const storedSecrets = new Map<string, Uint8Array>();

// The runtime policy and gateway exactly as the orchestrator gets them; only
// leaf infrastructure is supplied here. Merged as siblings, so the gateway the
// test writes through reaches the policy only if production wires it there.
const layerProductionPolicy = Layer.mergeAll(
  RuntimeLayer.layerRuntimePolicyProvided,
  RuntimeLayer.layerIntegrationsProvided,
).pipe(
  Layer.provide(Layer.succeed(IntegrationEndpointPolicy, () => Effect.succeed(fakeMcpFetch))),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: () => Effect.succeed(undefined),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provideMerge(ServerSettings.layer),
  Layer.provide(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.succeed(Option.fromUndefinedOr(storedSecrets.get(name))),
      create: (name, value) => Effect.sync(() => void storedSecrets.set(name, value)),
    }),
  ),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-runtime-layer-" })),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(NodeServices.layer),
);

const unfiledThread = (now: DateTime.Utc): OrchestrationV2AppThread => {
  const id = ThreadId.make("thread:runtime-layer");
  const instanceId = ProviderInstanceId.make("claude");
  return {
    surface: "work",
    createdBy: "user",
    creationSource: "web",
    id,
    projectId: ProjectId.make("project:runtime-layer"),
    title: "Runtime layer",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-opus-4-1" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/repo/worktree",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

it.effect("production runtime policy names connected integrations in turn context", () =>
  Effect.gen(function* () {
    const integrations = yield* Integrations.Integrations;
    const { integration } = yield* integrations.create({
      name: IntegrationName.make("acme"),
      displayName: "Acme Docs",
      transport: "http",
      url: "https://mcp.acme.test/mcp",
      headers: {},
      hint: "",
      enabled: true,
      scope: { type: "all" },
    });
    const check = yield* integrations.testConnection(integration.id);
    expect(check.status).toBe("connected");

    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const thread = unfiledThread(yield* DateTime.now);
    const pendingImport = yield* policy.resolve({ thread, modelSelection: thread.modelSelection });
    expect(pendingImport.useProviderConnectors).toBe(true);
    yield* settings.updateSettings({ nativeMcpImportReviewed: true });
    const resolved = yield* policy.resolve({ thread, modelSelection: thread.modelSelection });
    expect(resolved.projectManifest).toContain("Connected integrations: acme (Acme Docs).");
    expect(resolved.projectManifest).toContain("Use integration_tools / integration_call.");
    expect(resolved.useProviderConnectors).toBeUndefined();
    expect(resolved.projectManifest).toContain("Native MCP servers, plugins and apps");
    expect(resolved.projectManifest).toContain("turned off for supported providers");

    yield* settings.updateSettings({ useProviderConnectors: true });
    const optedIn = yield* policy.resolve({ thread, modelSelection: thread.modelSelection });
    expect(optedIn.projectManifest).toContain("Connected integrations: acme (Acme Docs).");
    expect(optedIn.useProviderConnectors).toBe(true);
    expect(optedIn.projectManifest).not.toContain("Native MCP servers, plugins and apps");
  }).pipe(Effect.provide(layerProductionPolicy)),
);
