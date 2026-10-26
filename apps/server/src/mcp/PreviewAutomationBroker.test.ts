import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  PreviewTabId,
  type PreviewAutomationStatus,
} from "@cogenly/contracts";
import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Broker from "./PreviewAutomationBroker.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

const environmentId = EnvironmentId.make("env:browser");
const tabId = PreviewTabId.make("tab:signed-in");
const scope: McpThreadInvocationScope = {
  environmentId,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread:browser"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

it.effect(
  "reconnects an evicted host, cancels old work, and accepts a fresh open without replay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* Broker.PreviewAutomationBroker;
        const firstReady = yield* Deferred.make<void>();
        const nextReady = yield* Deferred.make<void>();
        const requestSeen = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        let connections = 0;
        const operations: string[] = [];
        yield* broker
          .serve({ clientId: "server-browser", environmentId }, (event) => {
            if (event.type === "connected")
              return Deferred.succeed(++connections === 1 ? firstReady : nextReady, undefined).pipe(
                Effect.asVoid,
              );
            operations.push(event.request.operation);
            if (connections === 1)
              return Deferred.succeed(requestSeen, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(cancelled, undefined)),
              );
            return broker
              .respond({
                clientId: "server-browser",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result: { available: true, tabId },
              })
              .pipe(Effect.orDie);
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(firstReady);
        const pending = yield* broker
          .invoke({ scope, operation: "snapshot", tabId, input: {}, timeoutMs: 10 })
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(requestSeen);
        yield* TestClock.adjust(1010);
        const timedOut = yield* Fiber.join(pending);
        expect(timedOut._tag).toBe("Failure");
        if (timedOut._tag === "Failure") {
          expect(timedOut.failure._tag).toBe("PreviewAutomationTimeoutError");
          expect(timedOut.failure.message).toContain(tabId);
          expect(timedOut.failure.message).toContain("do not reload or recreate");
        }
        yield* Deferred.await(cancelled);
        const unavailable = yield* broker
          .invoke({ scope, operation: "status", input: {} })
          .pipe(Effect.result);
        expect(unavailable._tag).toBe("Failure");
        if (unavailable._tag === "Failure")
          expect(unavailable.failure._tag).toBe("PreviewAutomationNoAvailableHostError");
        yield* TestClock.adjust(1000);
        yield* Deferred.await(nextReady);
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false },
        });
        expect(opened.tabId).toBe(tabId);
        expect(operations).toEqual(["snapshot", "open"]);
      }),
    ).pipe(Effect.provide(Broker.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("includes bounded tab state in a browser timeout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const ready = yield* Deferred.make<void>();
      yield* broker
        .serve({ clientId: "server-browser", environmentId }, (event) => {
          if (event.type === "connected")
            return Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
          return broker
            .respond({
              clientId: "server-browser",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationTimeoutError",
                message: "timed out",
                detail: {
                  tabId,
                  rendering: "panel",
                  visible: true,
                  loading: false,
                  automationConnected: false,
                },
              },
            })
            .pipe(Effect.orDie);
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      const result = yield* broker
        .invoke({ scope, operation: "evaluate", tabId, input: {} })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain(
          "rendering=panel, visible=true, loading=false, automationConnected=false",
        );
      }
    }),
  ).pipe(Effect.provide(Broker.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);
