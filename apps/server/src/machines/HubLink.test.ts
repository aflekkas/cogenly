import { assert, it } from "@effect/vitest";
import { PEER_IDENTITY_PATH, PEER_JOIN_PATH, PEER_TICKET_PATH } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { startMachine } from "./testkit.ts";

it.effect.each([PEER_IDENTITY_PATH, PEER_JOIN_PATH, PEER_TICKET_PATH])(
  "the %s deadline includes its body and aborts the request",
  (path) =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      let aborted = false;
      const hub = yield* startMachine("hub", "cloud-server");
      const spoke = yield* startMachine("spoke", "computer", undefined, {
        fetch: async (input, init) => {
          // @effect-diagnostics-next-line globalFetch:off -- This is the injected FetchHttpClient transport; other requests use the real transport.
          if (new URL(String(input)).pathname !== path) return globalThis.fetch(input, init);
          return new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    controller.error(new Error("request aborted"));
                  },
                  { once: true },
                );
              },
              pull() {
                Deferred.doneUnsafe(reading, Effect.void);
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      });
      const identity = yield* spoke.machines.prepareJoin;
      const code = yield* hub.machines.createPeerGrant({
        spokeKeyThumbprint: identity.keyThumbprint,
      });
      const joining = yield* spoke.machines
        .joinHub({ hubUrls: [hub.url], code })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(reading);
      yield* TestClock.adjust("15 seconds");
      assert.isTrue(aborted, "the body must share the request's deadline and abort signal");
      const result = yield* Fiber.join(joining);
      assert.strictEqual(result._tag, path === PEER_TICKET_PATH ? "Success" : "Failure");
    }).pipe(Effect.scoped),
);
