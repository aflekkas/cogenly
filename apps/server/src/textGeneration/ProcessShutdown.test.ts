// @effect-diagnostics nodeBuiltinImport:off - observes real child exits through an owned socket.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ClaudeSettings, CodexSettings, ProviderInstanceId } from "@cogenly/contracts";
import { writeFakeCli } from "@cogenly/provider-testing/fakeCli";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const layer = ProcessRunner.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "cogenly-helper-shutdown-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.live.each(["runner", "claude", "codex-exec", "codex-mcp"] as const)(
  "force kills a SIGTERM-ignoring %s helper when its request is interrupted",
  (route) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-helper-shutdown-" });
      const started = yield* Deferred.make<void>();
      const exited = yield* Deferred.make<void>();
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer((socket) => {
        sockets.add(socket);
        socket.once("data", () => Deferred.doneUnsafe(started, Effect.void));
        socket.once("close", () => {
          sockets.delete(socket);
          Deferred.doneUnsafe(exited, Effect.void);
        });
      });
      yield* Effect.acquireRelease(
        Effect.callback<void, Error>((resume) => {
          server.once("error", (error) => resume(Effect.fail(error)));
          server.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () =>
          Effect.sync(() => {
            for (const socket of sockets) socket.destroy();
            server.close();
          }),
      );
      const address = server.address();
      if (address === null || typeof address === "string")
        return yield* Effect.die("No probe port");
      const source = [
        'const isMcp = process.argv.includes("mcp");',
        route === "codex-exec" ? 'if (isMcp) { process.stdout.write("[]"); process.exit(0); }' : "",
        'process.on("SIGTERM", () => {});',
        'const { createConnection } = await import("node:net");',
        "const socket = createConnection(" +
          address.port +
          ', "127.0.0.1", () => socket.write("ready"));',
      ].join("\n");
      const binary = writeFakeCli({ directory, name: "stubborn", source });
      const runner = yield* ProcessRunner.ProcessRunner;
      const work =
        route === "runner"
          ? runner.run({ command: binary, args: [] })
          : (yield* route === "claude"
              ? makeClaudeTextGeneration(decodeClaudeSettings({ binaryPath: binary }))
              : makeCodexTextGeneration(
                  decodeCodexSettings({ binaryPath: binary }),
                )).generateThreadTitle({
              cwd: directory,
              message: "Name this work",
              modelSelection: {
                instanceId: ProviderInstanceId.make(route === "claude" ? "claude" : "codex"),
                model: route === "claude" ? "claude-sonnet-4-6" : "gpt-5.4",
              },
            });
      const fiber = yield* work.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Deferred.await(exited);
      yield* Fiber.join(interrupt);
      const result = yield* Fiber.await(fiber);
      expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
