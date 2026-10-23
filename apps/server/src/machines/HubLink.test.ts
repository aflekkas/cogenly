import { assert, it } from "@effect/vitest";
import { PEER_IDENTITY_PATH, PEER_JOIN_PATH, PEER_TICKET_PATH } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { startMachine, pair } from "./testkit.ts";

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

it.live("leave awaits a reconnect's pending write before removing its credential and key", () =>
  Effect.gen(function* () {
    const writing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const stored = new Map<string, Uint8Array>();
    let armed = false;
    let removed = false;
    let socket: WebSocket | undefined;
    const hub = yield* startMachine("hub", "cloud-server");
    const spoke = yield* startMachine(
      "spoke",
      "computer",
      (url) => {
        socket = new globalThis.WebSocket(url);
        return socket;
      },
      {
        secrets: (secrets) => ({
          ...secrets,
          get: (name) =>
            name.startsWith("machine-")
              ? Effect.sync(() => Option.fromUndefinedOr(stored.get(name)))
              : secrets.get(name),
          set: (name, value) =>
            name.startsWith("machine-")
              ? Effect.gen(function* () {
                  if (armed && name === "machine-hub-link") {
                    yield* Deferred.succeed(writing, undefined);
                    yield* Deferred.await(release);
                  }
                  stored.set(name, value);
                }).pipe(Effect.uninterruptible)
              : secrets.set(name, value),
          remove: (name) =>
            name.startsWith("machine-")
              ? Effect.sync(() => {
                  removed = true;
                  stored.delete(name);
                })
              : secrets.remove(name),
        }),
      },
    );
    yield* Effect.gen(function* () {
      const originalIdentity = yield* spoke.machines.prepareJoin;
      yield* pair(hub, spoke);
      armed = true;
      socket?.close();
      yield* Deferred.await(writing);
      // The synchronous store lets leave run through deletion on the old code.
      // A fixed leave suspends while joining the reconnect's uninterruptible write.
      const leaving = yield* spoke.hubLink.leave.pipe(Effect.forkChild({ startImmediately: true }));
      assert.isFalse(removed, "secrets must survive until the connect attempt has stopped");
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(yield* Fiber.join(leaving));
      assert.isFalse(stored.has("machine-hub-link"));
      assert.isFalse(stored.has("machine-peer-dpop-key"));
      assert.isTrue(Option.isNone(yield* spoke.hubLink.view));
      armed = false;
      const replacementIdentity = yield* spoke.machines.prepareJoin;
      assert.notStrictEqual(replacementIdentity.keyThumbprint, originalIdentity.keyThumbprint);
      // Joining the cancelled attempt must leave the dial loop available for a new pairing.
      yield* pair(hub, spoke);
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  }).pipe(Effect.scoped),
);
