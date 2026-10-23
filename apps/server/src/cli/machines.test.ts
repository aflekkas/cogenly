import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { decodeJoinCode, encodeJoinCode } from "./machines.ts";

describe("machine join codes", () => {
  const code = {
    grant: "grant-secret",
    hubEnvironmentId: EnvironmentId.make("environment-hub"),
    hubName: "Cloud server · Contabo",
    hubPublicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----",
    routes: ["http://100.64.0.2:3773/"],
    expiresAt: DateTime.makeUnsafe("2026-10-23T12:00:00.000Z"),
  };

  it.effect("round-trips as one copyable token", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeJoinCode(code);
      assert.match(encoded, /^cogenly-join:[A-Za-z0-9_-]+$/);
      assert.deepStrictEqual(yield* decodeJoinCode(`  ${encoded}\n`), code);
    }),
  );

  it.effect("refuses anything that is not a join code", () =>
    Effect.gen(function* () {
      const error = yield* decodeJoinCode("cogenly-join:not-json").pipe(Effect.flip);
      assert.include(error.message, "not valid");
    }),
  );
});
