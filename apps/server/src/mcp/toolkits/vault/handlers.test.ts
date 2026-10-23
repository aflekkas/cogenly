import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
const tabId = PreviewTabId.make("tab:vault-handler");

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
      let evaluated = 0;
      let failTyping = false;
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
        PreviewAutomationBroker.layer.pipe(Layer.provide(NodeCrypto.layer)),
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
      const broker = Context.get(context, PreviewAutomationBroker.PreviewAutomationBroker);
      const scope = Context.get(context, Invocation.McpInvocationContext);
      if (scope.thread === undefined) return yield* Effect.die("Missing test thread");
      const threadScope = { ...scope, thread: scope.thread };
      const attachHost = Effect.fnUntraced(function* () {
        const connected = yield* Deferred.make<void>();
        const events = yield* broker.connect({
          clientId: "test-browser",
          environmentId: scope.environmentId,
        });
        const fiber = yield* events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "connected") return Deferred.succeed(connected, undefined);
            const request = event.request;
            if (request.operation === "type") typed.push(request.input);
            if (request.operation === "evaluate") evaluated += 1;
            return broker.respond({
              clientId: "test-browser",
              connectionId: event.connectionId,
              requestId: request.requestId,
              ...(request.operation === "type" && failTyping
                ? {
                    ok: false,
                    error: {
                      _tag: "PreviewAutomationExecutionError",
                      message: "Typing failed after input",
                    },
                  }
                : {
                    ok: true,
                    result:
                      request.operation === "evaluate"
                        ? "321-drowssap-otco"
                        : {
                            available: true,
                            visible: true,
                            tabId: request.tabId ?? tabId,
                            url: pageUrl,
                            title: "Login",
                            loading: false,
                          },
                  }),
            });
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(connected);
        return fiber;
      });
      let host = yield* attachHost();
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

      // Ordinary evaluation works until the vault sends a value to this tab.
      yield* broker.invoke({
        scope: threadScope,
        operation: "evaluate",
        input: { expression: "1 + 1" },
        tabId,
      });
      expect(evaluated).toBe(1);

      const asked = yield* call("vault_fill", { name: "GitHub", field: "password" });
      expect(asked).toMatchObject({ status: "approval_required" });
      expect(typed).toHaveLength(0);
      const savedItem = (yield* Context.get(context, Vault.Vault).list({})).items[0]!;
      yield* Context.get(context, Vault.Vault).update({
        id: savedItem.id,
        policy: { mode: "allow", allowedAgentIds: [], allowedDomains: ["github.com"] },
      });

      const filled = yield* call("vault_fill", {
        name: "GitHub",
        field: "password",
        locator: "input[name=password]",
      });
      expect(filled).toMatchObject({ status: "filled", field: "password", domain: "github.com" });
      expect(JSON.stringify(filled)).not.toContain("octo-password-123");
      expect(typed).toEqual([
        {
          expectedOrigin: "https://github.com",
          text: "octo-password-123",
          locator: "input[name=password]",
          clear: true,
        },
      ]);

      for (const expression of [
        "document.querySelector('input').value.split('').map(c => c.charCodeAt(0))",
        "document.querySelector('input').value.split('').reverse().join('')",
        "btoa(document.querySelector('input').value)",
      ]) {
        for (const target of [{ tabId }, {}]) {
          const blocked = yield* broker
            .invoke({ scope: threadScope, operation: "evaluate", input: { expression }, ...target })
            .pipe(Effect.result);
          expect(blocked._tag).toBe("Failure");
          if (blocked._tag === "Failure")
            expect(blocked.failure.message).toContain("disabled on this tab after a vault fill");
        }
      }
      // Navigation, a new provider session and host reconnection cannot clear the seal.
      yield* broker.invoke({
        scope: threadScope,
        operation: "navigate",
        input: { url: "https://github.com/other" },
        tabId,
      });
      yield* Fiber.interrupt(host);
      host = yield* attachHost();
      const nextScope = {
        ...threadScope,
        thread: { ...threadScope.thread, providerSessionId: "next-session" },
      };
      for (const target of [{ tabId }, {}]) {
        expect(
          (yield* broker
            .invoke({
              scope: nextScope,
              operation: "evaluate",
              input: { expression: "document.querySelector('input').value" },
              ...target,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      expect(evaluated).toBe(1);
      expect(
        yield* broker.invoke({ scope: nextScope, operation: "snapshot", input: {}, tabId }),
      ).toMatchObject({ tabId });
      const freshTab = PreviewTabId.make("tab:fresh");
      yield* broker.invoke({
        scope: nextScope,
        operation: "evaluate",
        input: { expression: "1 + 1" },
        tabId: freshTab,
      });
      expect(evaluated).toBe(2);

      // A failed fill may already have typed, so it seals the destination too.
      failTyping = true;
      yield* call("vault_fill", { name: "GitHub", field: "password", tabId: freshTab });
      expect(
        (yield* broker
          .invoke({
            scope: threadScope,
            operation: "evaluate",
            input: { expression: "btoa(document.querySelector('input').value)" },
            tabId: freshTab,
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(evaluated).toBe(2);
      failTyping = false;

      pageUrl = "https://evil.test/login";
      const denied = yield* call("vault_fill", {
        name: "GitHub",
        field: "password",
        locator: "input[name=password]",
      });
      expect(denied).toMatchObject({ status: "denied" });
      expect(typed).toHaveLength(2);

      // The scrub hook in McpToolAccess redacts stored values from any result.
      const vault = Context.get(context, Vault.Vault);
      expect(
        yield* vault.scrubText("echo octo-password-123").pipe(Effect.provideContext(context)),
      ).toBe("echo [redacted vault secret]");
      yield* Fiber.interrupt(host);
    }),
  ),
);

it.effect("vault_fill fills card fields by field and never returns them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const typed: Array<unknown> = [];
      let pageUrl = "https://shop.test/checkout";
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
                  tabId: "tab-checkout",
                  url: pageUrl,
                  title: "Checkout",
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
        name: "Visa",
        type: "card",
        policy: { mode: "allow", allowedAgentIds: [], allowedDomains: ["shop.test"] },
        allowedDomains: ["shop.test"],
        secretFields: {
          cardNumber: "4242 4242 4242 4242",
          cardExpiryMonth: "08",
          cardExpiryYear: "2027",
          cardCvc: "987",
          cardholderName: "Ada Cardholder",
        },
      });
      expect(JSON.stringify(saved)).not.toContain("4242 4242");
      expect(JSON.stringify(saved)).not.toContain("Ada Cardholder");
      expect(saved).toMatchObject({ item: { cardLast4: "4242" } });

      for (const [field, text] of [
        ["cardNumber", "4242 4242 4242 4242"],
        ["cardExpiry", "08/27"],
        ["cardCvc", "987"],
        ["cardholderName", "Ada Cardholder"],
      ] as const) {
        const filled = yield* call("vault_fill", {
          name: "Visa",
          field,
          locator: `input[name=${field}]`,
        });
        expect(filled).toMatchObject({ status: "filled", field, domain: "shop.test" });
        expect(JSON.stringify(filled)).not.toContain(text);
      }
      expect(typed).toEqual([
        {
          expectedOrigin: "https://shop.test",
          text: "4242 4242 4242 4242",
          locator: "input[name=cardNumber]",
          clear: true,
        },
        {
          expectedOrigin: "https://shop.test",
          text: "08/27",
          locator: "input[name=cardExpiry]",
          clear: true,
        },
        {
          expectedOrigin: "https://shop.test",
          text: "987",
          locator: "input[name=cardCvc]",
          clear: true,
        },
        {
          expectedOrigin: "https://shop.test",
          text: "Ada Cardholder",
          locator: "input[name=cardholderName]",
          clear: true,
        },
      ]);

      pageUrl = "https://evil.test/checkout";
      const denied = yield* call("vault_fill", {
        name: "Visa",
        field: "cardNumber",
        locator: "input[name=cardNumber]",
      });
      expect(denied).toMatchObject({ status: "denied" });
      expect(typed).toHaveLength(4);
    }),
  ),
);
