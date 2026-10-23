import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreatePeerDpopKey, removePeerDpopKey } from "./peerCrypto.ts";

const keyStore = Effect.gen(function* () {
  const writing = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let value: Uint8Array | undefined;
  let first = true;
  const store = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: () => Effect.sync(() => Option.fromUndefinedOr(value)),
    set: (_, bytes) =>
      Effect.gen(function* () {
        if (first) {
          first = false;
          yield* Deferred.succeed(writing, undefined);
          yield* Deferred.await(release);
        }
        value = bytes;
      }),
    remove: () =>
      Effect.sync(() => {
        value = undefined;
      }),
  });
  return { writing, release, store };
});

it.effect("concurrent first-time peer identities share the persisted proof key", () =>
  Effect.gen(function* () {
    const { writing, release, store } = yield* keyStore;
    yield* Effect.gen(function* () {
      const first = yield* getOrCreatePeerDpopKey.pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const second = yield* getOrCreatePeerDpopKey.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      const a = yield* Fiber.join(first);
      const b = yield* Fiber.join(second);
      const persisted = yield* getOrCreatePeerDpopKey;
      assert.strictEqual(a.thumbprint, b.thumbprint);
      assert.strictEqual(a.thumbprint, persisted.thumbprint);
    }).pipe(Effect.provide(store));
  }),
);

it.effect("removing a peer key waits for an in-flight creation", () =>
  Effect.gen(function* () {
    const { writing, release, store } = yield* keyStore;
    yield* Effect.gen(function* () {
      const creating = yield* getOrCreatePeerDpopKey.pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const removing = yield* removePeerDpopKey.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const old = yield* Fiber.join(creating);
      yield* Fiber.join(removing);
      assert.notStrictEqual((yield* getOrCreatePeerDpopKey).thumbprint, old.thumbprint);
    }).pipe(Effect.provide(store));
  }),
);
