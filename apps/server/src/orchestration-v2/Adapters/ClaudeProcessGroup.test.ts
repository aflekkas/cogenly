// @effect-diagnostics nodeBuiltinImport:off - exercises kernel descriptor cleanup after a server crash.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { spawnClaudeProcessGroup } from "./ClaudeAdapterV2.ts";
import { signalProcessGroup } from "@cogenly/provider-core/server/processGroup";

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "stops Claude's process group after its server is killed",
  () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cogenly-claude-owner-"));
      const fifo = NodePath.join(directory, "alive");
      NodeChildProcess.execFileSync("mkfifo", [fifo]);
      const moduleUrl = new URL("./ClaudeAdapterV2.ts", import.meta.url).href;
      const code = [
        "const spawnClaudeProcessGroup = (await import(process.argv[1]))[process.argv[3]];",
        "const child = spawnClaudeProcessGroup({ command: '/bin/sh', args: ['-c', 'sleep 600 > \"$1\"', 'fake-claude', process.argv[2]], cwd: process.cwd(), env: process.env, signal: new AbortController().signal });",
        "process.stdout.write(String(child.pid) + '\\n');",
      ].join("\n");
      const server = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "-e", code, moduleUrl, fifo, spawnClaudeProcessGroup.name],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let cliPid = 0;
      const alive = NodeFS.createReadStream(fifo);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          server.kill("SIGKILL");
          if (cliPid > 0) {
            try {
              signalProcessGroup(cliPid, "SIGKILL");
            } catch {
              /* Group already stopped. */
            }
          }
          alive.destroy();
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
      );
      const started = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const stopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();
      const pid = yield* Effect.promise(
        () => new Promise<Buffer>((resolve) => server.stdout.once("data", resolve)),
      );
      cliPid = Number(String(pid).trim());
      expect(cliPid).toBeGreaterThan(0);
      yield* Effect.promise(() => started);

      server.kill("SIGKILL");
      yield* Effect.promise(() => stopped);
      expect(alive.closed).toBe(true);
    }).pipe(Effect.scoped),
);
