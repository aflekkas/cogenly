import { expect, it } from "@effect/vitest";
import { NodeCrypto } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectLabelId,
  ProviderInstanceId,
  ThreadId,
  type VaultListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AgentStore from "../../../agents/AgentStore.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as Vault from "../../../vault/Vault.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as Handlers from "./handlers.ts";
import { VaultToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:in-a");
const labelA = ProjectLabelId.make("label:a");
const labelB = ProjectLabelId.make("label:b");

const stored = new Map<string, Uint8Array>();
const vaultLayer = Vault.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provide(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (name) => Effect.succeed(Option.fromUndefinedOr(stored.get(name))),
      create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    }),
  ),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env:test")),
    }),
  ),
);

const scope: Invocation.McpInvocationScope = {
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
};

const dependencies = Layer.mergeAll(
  Layer.succeed(Invocation.McpInvocationContext, scope),
  Layer.mock(Threads.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
  }),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
  Layer.mock(AgentStore.AgentStore)({}),
  Layer.mock(ProjectFiles.ProjectFiles)({
    folderForThread: () =>
      Effect.succeed({
        labelId: labelA,
        name: "A",
        dir: "/projects/A",
        instructions: "",
        projectChatThreadId: null,
      }),
  }),
);

it.effect("vault_list lists the calling thread's project, whatever scope it asks for", () =>
  Effect.gen(function* () {
    const vault = yield* Vault.Vault;
    yield* vault.create({
      name: "B token",
      type: "api_key",
      scopeProjectId: labelB,
      secretFields: { value: "b-token-value-123" },
    });
    yield* vault.create({
      name: "A token",
      type: "api_key",
      scopeProjectId: labelA,
      secretFields: { value: "a-token-value-123" },
    });
    const toolkit = yield* VaultToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const results = yield* toolkit
      .handle("vault_list", { scopeProjectId: labelB })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    const listed = results.at(-1)?.result as VaultListResult;
    expect(listed.items.map((item) => item.name)).toEqual(["A token"]);
  }).pipe(Effect.provide(vaultLayer)),
);
