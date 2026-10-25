import { assert, describe, it } from "@effect/vitest";
import {
  AuthPeerDelegateScope,
  AuthSyncReplicateScope,
  EnvironmentId,
  makePeerChannel,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PeerChannels from "./PeerChannels.ts";

const Replicate = makePeerChannel({
  name: "test.replicate",
  scope: AuthSyncReplicateScope,
  payload: Schema.Struct({ cursor: Schema.Number }),
  success: Schema.Struct({ next: Schema.Number }),
  error: Schema.Struct({ reason: Schema.String }),
});
const caller = {
  environmentId: EnvironmentId.make("paired-spoke"),
  scopes: [AuthSyncReplicateScope],
};

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(PeerChannels.layer), Effect.scoped);

describe("PeerChannels", () => {
  it.effect("checks the channel scope before decoding or running its handler", () =>
    run(
      Effect.gen(function* () {
        const channels = yield* PeerChannels.PeerChannels;
        let called = false;
        yield* channels.register(Replicate, () =>
          Effect.sync(() => {
            called = true;
            return { next: 1 };
          }),
        );
        const denied = yield* channels
          .dispatch({
            channel: Replicate.name,
            payload: { cursor: "invalid" },
            caller: { ...caller, scopes: [AuthPeerDelegateScope] },
          })
          .pipe(Effect.flip);
        assert.strictEqual(denied.reason, "forbidden");
        assert.isFalse(called);
        const invalid = yield* channels
          .dispatch({
            channel: Replicate.name,
            payload: { cursor: "invalid" },
            caller,
          })
          .pipe(Effect.flip);
        assert.strictEqual(invalid.reason, "invalid-payload");
        assert.isFalse(called);
        assert.deepStrictEqual(
          yield* channels.dispatch({
            channel: Replicate.name,
            payload: { cursor: 2 },
            caller,
          }),
          { next: 1 },
        );
        assert.isTrue(called);
      }),
    ),
  );

  it.effect(
    "encodes only a declared channel error and removes handlers when their scope ends",
    () =>
      run(
        Effect.gen(function* () {
          const channels = yield* PeerChannels.PeerChannels;
          const request = { channel: Replicate.name, payload: { cursor: 2 }, caller };
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* channels.register(Replicate, () => Effect.fail({ reason: "bad-cursor" }));
              const failed = yield* channels.dispatch(request).pipe(Effect.flip);
              assert.strictEqual(failed.reason, "handler-failed");
              assert.deepStrictEqual(failed.error, { reason: "bad-cursor" });
            }),
          );
          assert.strictEqual(
            (yield* channels.dispatch(request).pipe(Effect.flip)).reason,
            "unknown-channel",
          );
        }),
      ),
  );
});
