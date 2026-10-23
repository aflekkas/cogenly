import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as AgentStore from "../../../agents/AgentStore.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Vault from "../../../vault/Vault.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as Handlers from "./handlers.ts";
import { VaultToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:vault-handler");

const memoryStore = () => {
  const values = new Map<string, Uint8Array>();
  return Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) =>
      Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) =>
      values.has(name)
        ? Effect.die(new Error("exists"))
        : Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        if (!values.has(name)) values.set(name, new Uint8Array(bytes).fill(7));
        return values.get(name)!;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  } as ServerSecretStore.ServerSecretStore["Service"]);
};

it.effect("vault_fill types the value server-side and never returns it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const typed: Array<unknown> = [];
      let pageUrl = "https://github.com/login";
      const dependencies = Layer.mergeAll(
        Layer.succeed(Invocation.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          capabilities: new Set(["preview" as const, "orchestration" as const]),
          requestNamespace: "test",
          issuedAt: 0,
          thread: {
            threadId,
            providerSessionId: "session",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
        }),
        liveThreadsLayer,
        Layer.mock(AgentStore.AgentStore)({ forThread: () => Effect.succeed(null) }),
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
          invoke: (request) =>
            request.operation === "status"
              ? Effect.succeed({
                  available: true,
                  visible: true,
                  tabId: null,
                  url: pageUrl,
                  title: "Login",
                  loading: false,
                } as never)
              : Effect.sync(() => {
                  typed.push(request.input);
                  return {} as never;
                }),
        }),
        Vault.layer.pipe(
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provide(memoryStore()),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("env:test")),
            }),
          ),
        ),
      );
      const context = yield* Layer.build(dependencies);
      const toolkit = yield* VaultToolkit.pipe(
        Effect.provide(Access.HandlersLayer.layer(Handlers.layer)),
        Effect.provideContext(context),
      );
      const call = (name: string, args: object) =>
        toolkit
          .handle(name as never, args as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provideContext(context))
          .pipe(Effect.map((results) => results.at(-1)?.result));

      const saved = yield* call("vault_save", {
        name: "GitHub",
        type: "login",
        allowedDomains: ["github.com"],
        secretFields: { username: "octo-user", password: "octo-password-123" },
      });
      expect(JSON.stringify(saved)).not.toContain("octo-password-123");
      expect(JSON.stringify(saved)).not.toContain("octo-user");

      const listed = yield* call("vault_list", {});
      expect(JSON.stringify(listed)).not.toContain("octo-password-123");

      const filled = yield* call("vault_fill", {
        name: "GitHub",
        field: "password",
        locator: "input[name=password]",
      });
      expect(filled).toMatchObject({ status: "filled", field: "password", domain: "github.com" });
      expect(JSON.stringify(filled)).not.toContain("octo-password-123");
      expect(typed).toEqual([
        { text: "octo-password-123", locator: "input[name=password]", clear: true },
      ]);

      pageUrl = "https://evil.test/login";
      const denied = yield* call("vault_fill", {
        name: "GitHub",
        field: "password",
        locator: "input[name=password]",
      });
      expect(denied).toMatchObject({ status: "denied" });
      expect(typed).toHaveLength(1);

      // The scrub hook in McpToolAccess redacts stored values from any result.
      const vault = Context.get(context, Vault.Vault);
      expect(
        yield* vault.scrubText("echo octo-password-123").pipe(Effect.provideContext(context)),
      ).toBe("echo [redacted vault secret]");
    }),
  ),
);
