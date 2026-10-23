import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as Runner from "./LocalMcpRunner.ts";

const layer = Runner.layerWith({ restartDelayMs: 10, requestTimeoutMs: 1000 }).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = new URL("./fixtures/fake-mcp.mjs", import.meta.url).pathname;
const decodeEcho = Schema.decodeUnknownSync(
  Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
);
const decodePid = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number })),
);
const specFor = (transport: "http" | "stdio") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const port = yield* Runner.freeLoopbackPort;
    return {
      id: "account",
      runtime: process.execPath,
      args: [fixture],
      version: "1.0.0",
      directory,
      transport,
      port,
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_TRANSPORT: transport,
        FIXTURE_PORT: String(port),
        FIXTURE_SECRET: "private-client-secret",
      },
      secrets: ["private-client-secret"],
    } satisfies Runner.LocalMcpSpec;
  });

describe("LocalMcpRunner", () => {
  it.live.each(["http", "stdio"] as const)(
    "routes %s, restarts a crash, redacts chunked secrets and stops",
    (transport) =>
      Effect.gen(function* () {
        const runner = yield* Runner.LocalMcpRunner;
        const spec = yield* specFor(transport);
        const changes = yield* Queue.unbounded<Runner.LocalMcpStatus>();
        yield* runner.changes.pipe(
          Stream.runForEach((event) => Queue.offer(changes, event.status)),
          Effect.forkScoped,
        );
        yield* runner.start(spec);
        const tools = yield* runner.rpc(spec.id, "tools/list", {});
        expect(tools).toMatchObject({ tools: [{ name: "echo" }] });
        expect((yield* runner.status(spec.id))?.state).toBe("running");
        const response = yield* runner.rpc(spec.id, "tools/call", {
          name: "echo",
          arguments: { text: "hello" },
        });
        expect(JSON.stringify(response)).toContain('secretPresent\\\":true');
        expect(JSON.stringify(response)).not.toContain("private-client-secret");
        expect(JSON.stringify(response)).toContain("hello");
        const originalPid = decodePid(decodeEcho(response).content[0]!.text).pid;
        const crash = yield* runner
          .rpc(spec.id, "tools/call", { name: "crash" })
          .pipe(Effect.result, Effect.forkScoped);
        const failed = yield* Stream.fromQueue(changes).pipe(
          Stream.filter((status) => status.state === "failed"),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(failed[0]?.stderrTail).toContain("[redacted]");
        expect(failed[0]?.stderrTail).not.toContain("private-client-secret");
        yield* Stream.fromQueue(changes).pipe(
          Stream.filter((status) => status.state === "running"),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(yield* runner.rpc(spec.id, "tools/list", {})).toMatchObject({
          tools: [{ name: "echo" }],
        });
        const restarted = yield* runner.rpc(spec.id, "tools/call", { name: "echo" });
        const restartedPid = decodePid(decodeEcho(restarted).content[0]!.text).pid;
        expect(restartedPid).not.toBe(originalPid);
        yield* Fiber.join(crash);
        if (transport === "http")
          expect(yield* runner.callback(spec.id, "state=test&code=test")).toBe(true);
        yield* runner.stop(spec.id);
        expect(() => process.kill(restartedPid, 0)).toThrow();
        expect(yield* runner.status(spec.id)).toBeUndefined();
        expect((yield* runner.rpc(spec.id, "tools/list", {}).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
    15_000,
  );
  it.live.each(["uvx", "npx"])("reports how to install missing %s", (runtime) =>
    Effect.gen(function* () {
      const runner = yield* Runner.LocalMcpRunner;
      const spec = yield* specFor("http");
      const result = yield* runner
        .start({ ...spec, runtime, env: { PATH: spec.directory } })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* runner.status(spec.id)).toMatchObject({
        state: "missing_runtime",
        message: expect.stringContaining(
          runtime === "uvx" ? "brew install uv" : "Install Node.js LTS",
        ),
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("terminates its process when the owning server layer shuts down", () =>
    Effect.gen(function* () {
      const pid = yield* Effect.gen(function* () {
        const runner = yield* Runner.LocalMcpRunner;
        const spec = yield* specFor("http");
        yield* runner.start(spec);
        const result = yield* runner.rpc(spec.id, "tools/call", { name: "echo" });
        return decodePid(decodeEcho(result).content[0]!.text).pid;
      }).pipe(Effect.scoped, Effect.provide(layer));
      expect(() => process.kill(pid, 0)).toThrow();
    }),
  );

  it.live("fails calls immediately after a state directory cannot be created", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.LocalMcpRunner;
      const fs = yield* FileSystem.FileSystem;
      const spec = yield* specFor("http");
      const file = `${spec.directory}/not-a-directory`;
      yield* fs.writeFileString(file, "existing file");
      expect((yield* runner.start({ ...spec, directory: file }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* runner.rpc(spec.id, "tools/list", {}).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* runner.status(spec.id))?.state).toBe("failed");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
