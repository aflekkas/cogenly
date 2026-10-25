import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ProcessRunner from "../processRunner.ts";
import * as ReadOnlySandbox from "./ReadOnlySandbox.ts";
import * as Manager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";

it.effect("Windows refuses chat terminals without attempting a launch", () =>
  Effect.gen(function* () {
    const sandbox = yield* ReadOnlySandbox.make;
    expect(sandbox.status.available).toBe(false);
    const error = yield* sandbox
      .prepare({ shell: "cmd.exe", args: [], cwd: "." })
      .pipe(Effect.flip);
    expect(error.message).toContain("supported only on macOS and Linux");
  }).pipe(
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: () => Effect.die("Unsupported platforms must never spawn"),
      }),
    ),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);

it.effect("a failed startup probe never falls back to an unconstrained shell", () =>
  Effect.gen(function* () {
    let probes = 0;
    const sandbox = yield* ReadOnlySandbox.make.pipe(
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: () => {
            probes++;
            return Effect.succeed({
              stdout: "",
              stderr: "sandbox unavailable",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
      ),
    );
    expect(probes).toBe(1);
    expect(sandbox.status.available).toBe(false);
    const error = yield* sandbox
      .prepare({ shell: "/bin/sh", args: ["-c", "touch file"], cwd: "/" })
      .pipe(Effect.flip);
    expect(error.message).toContain("Chat commands are unavailable");
    expect(probes).toBe(1);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);

it.effect.each(["missing bwrap", "user namespace probe denied"])(
  "Linux fails closed: %s",
  (failure) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-bwrap-test-" });
      if (failure !== "missing bwrap") {
        yield* fs.writeFileString(`${directory}/bwrap`, "");
        yield* fs.chmod(`${directory}/bwrap`, 0o755);
      }
      let probes = 0;
      const sandbox = yield* ReadOnlySandbox.make.pipe(
        Effect.provideService(HostProcess.Environment, { PATH: directory }),
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: (input) => {
              probes++;
              expect(input.args).toContain("--unshare-user");
              return Effect.succeed({
                stdout: "",
                stderr: "",
                code: null,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
        ),
      );
      expect(probes).toBe(failure === "missing bwrap" ? 0 : 1);
      expect(sandbox.status.available).toBe(false);
      const error = yield* sandbox
        .prepare({ shell: "/bin/sh", args: [], cwd: "/" })
        .pipe(Effect.flip);
      expect(error.message).toContain("bubblewrap and working user namespaces");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Architecture, "x64"),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
);

describe.skipIf(HostProcess.Platform.defaultValue() !== "darwin")(
  "macOS behavioral sandbox (requires macOS sandbox-exec; skipped on other platforms)",
  () => {
    it.effect(
      "reads a project but denies writes, including descendants started through terminal input",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* ReadOnlySandbox.ReadOnlySandbox;
          expect(sandbox.status).toEqual({ available: true, backend: "sandbox-exec" });
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "cogenly-sandbox-project-",
          });
          const cwd = yield* fs.realPath(directory);
          yield* fs.writeFileString(`${cwd}/existing`, "project contents");
          const manager = yield* Manager.makeWithOptions({
            logsDir: `${cwd}/logs`,
            ptyAdapter: yield* PtyAdapter.PtyAdapter,
            processTable: Effect.succeed([]),
            processKillGraceMs: 0,
          });
          const started = yield* manager.runAgent({
            threadId: "chat-sandbox",
            cwd,
            terminalPolicy: "readOnlyLookup",
            background: true,
            command:
              'cat existing; ! (printf bad >existing); printf allowed >"$TMPDIR/scratch"; read command; /bin/sh -c "$command"',
          });
          yield* manager.write({
            threadId: "chat-sandbox",
            terminalId: started.terminalId,
            data: "printf bad >changed; cat existing\n",
          });
          const result = yield* manager.waitAgent({
            threadId: "chat-sandbox",
            terminalId: started.terminalId,
          });
          expect(result.exitCode).toBe(0);
          expect(result.output).toContain("project contents");
          expect(result.output).toMatch(/Operation not permitted|Permission denied/);
          expect(yield* fs.readFileString(`${cwd}/existing`)).toBe("project contents");
          expect(yield* fs.exists(`${cwd}/changed`)).toBe(false);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(ReadOnlySandbox.layer, ProcessRunner.layer, NodePtyAdapter.layer).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
          Effect.scoped,
        ),
    );
  },
);
