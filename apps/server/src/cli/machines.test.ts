import * as NetService from "@cogenly/shared/Net";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { Command } from "effect/cli";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import {
  decodeJoinCode,
  encodeJoinCode,
  readMachineJoinCode,
  machinesCommand,
  pairCommandHint,
} from "./machines.ts";

it.layer(Layer.merge(NodeServices.layer, NetService.layer))("machine join codes", (it) => {
  const code = {
    grant: "grant-secret",
    hubEnvironmentId: EnvironmentId.make("environment-hub"),
    hubName: "Cloud server · Contabo",
    hubPublicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----",
    routes: ["https://hub.example/"],
    expiresAt: DateTime.makeUnsafe("2026-10-23T12:00:00.000Z"),
  };

  it.effect("round-trips as one copyable token", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeJoinCode(code);
      assert.match(encoded, /^cogenly-join:[A-Za-z0-9_-]+$/);
      assert.deepStrictEqual(yield* decodeJoinCode(`  ${encoded}\n`), code);
    }),
  );

  it.effect("reads a code split across stdin chunks, with surrounding whitespace", () =>
    Effect.gen(function* () {
      const encoded = yield* encodeJoinCode(code);
      const bytes = new TextEncoder().encode(`  ${encoded}\n`);
      const decoded = yield* readMachineJoinCode(true).pipe(
        Effect.provide(
          Stdio.layerTest({ stdin: Stream.make(bytes.slice(0, 20), bytes.slice(20)) }),
        ),
      );
      assert.deepStrictEqual(decoded, code);
    }),
  );

  it.effect(
    "requires explicit stdin mode and rejects empty or oversized input without echoing it",
    () =>
      Effect.gen(function* () {
        const implicit = yield* readMachineJoinCode(false).pipe(
          Effect.provide(Stdio.layerTest({})),
          Effect.flip,
        );
        assert.include(implicit.message, "--code-stdin");
        for (const text of ["", "secret".repeat(3000)]) {
          const error = yield* readMachineJoinCode(true).pipe(
            Effect.provide(
              Stdio.layerTest({ stdin: Stream.succeed(new TextEncoder().encode(text)) }),
            ),
            Effect.flip,
          );
          assert.notInclude(error.message, "secret");
          assert.isUndefined(error.cause);
        }
      }),
  );

  it.effect("refuses a positional join secret and pairing without a prepared key", () =>
    Effect.gen(function* () {
      for (const argv of [["join", "https://hub.example", "secret-code"], ["pair"]]) {
        const exit = yield* Command.runWith(machinesCommand, {
          version: "test",
          renderErrors: false,
        })(argv).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
      }
    }),
  );

  it.effect("prints a pair command that parses a fingerprint starting with '-'", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const argv = pairCommandHint("-cUSt8zWd8ZVdkR4AwqENryufw9tdVjUlXqxyFXp66Y").split(" ");
      const error = yield* Command.runWith(machinesCommand, {
        version: "test",
        renderErrors: false,
      })([...argv.slice(2), "--base-dir", baseDir]).pipe(Effect.flip);
      // Parsing succeeded: the handler ran and found no server in the empty home.
      assert.include(error.message, "isn't running");
    }),
  );

  it.effect("refuses anything that is not a join code", () =>
    Effect.gen(function* () {
      const error = yield* decodeJoinCode("cogenly-join:not-json").pipe(Effect.flip);
      assert.include(error.message, "not valid");
    }),
  );
});

it.layer(Layer.merge(NodeServices.layer, NetService.layer))("migration CLI", (it) => {
  it.effect("parses dry-run moves and explicit adoption without starting offline work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      for (const argv of [
        ["move", "--from", "MacBook", "--to", "Hub", "--dry-run"],
        ["adopt", "--dry-run"],
        ["adopt", "--from", "lost-environment"],
      ]) {
        const error = yield* Command.runWith(machinesCommand, {
          version: "test",
          renderErrors: false,
        })([...argv, "--base-dir", baseDir]).pipe(Effect.flip);
        assert.include(error.message, "isn't running");
      }
    }),
  );
});
