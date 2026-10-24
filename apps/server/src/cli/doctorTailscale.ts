/**
 * `cogenly doctor`'s Tailscale Serve check. Before Cogenly kept the Serve
 * setting in its home, the way to keep a service behind Serve was a systemd
 * drop-in setting `COGENLY_TAILSCALE_SERVE=1`. That still works, but it turns
 * Serve off whenever the service stops and hides the setting from setup. The
 * repair moves it into Cogenly's own setting and removes a drop-in that holds
 * nothing else.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DEFAULT_TAILSCALE_SERVE_PORT } from "@t3tools/tailscale";

import * as BootService from "../cloud/bootService.ts";
import type * as ServerConfig from "../config.ts";
import * as TailscaleServeMode from "../tailscale/TailscaleServeMode.ts";

export interface ServeDropIn {
  readonly enabled: boolean;
  readonly servePort: number | null;
  /** The file sets nothing but Serve, so removing it changes nothing else. */
  readonly onlyServe: boolean;
}

const SERVE_ENV = /^Environment="?COGENLY_TAILSCALE_SERVE=([^"\s]*)"?\s*$/u;
const SERVE_PORT_ENV = /^Environment="?COGENLY_TAILSCALE_SERVE_PORT=(\d+)"?\s*$/u;

/** Reads a systemd drop-in; null when it does not set COGENLY_TAILSCALE_SERVE. */
export const parseServeDropIn = (contents: string): ServeDropIn | null => {
  let enabled: boolean | null = null;
  let servePort: number | null = null;
  let onlyServe = true;
  for (const raw of contents.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    if (line === "[Service]") continue;
    const serve = SERVE_ENV.exec(line);
    if (serve !== null) {
      enabled = /^(1|true|yes|on)$/iu.test(serve[1] ?? "");
      continue;
    }
    const port = SERVE_PORT_ENV.exec(line);
    if (port !== null) {
      servePort = Number(port[1]);
      continue;
    }
    onlyServe = false;
  }
  return enabled === null ? null : { enabled, servePort, onlyServe };
};

const runQuiet = (command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { stdin: "ignore" }),
      );
      return Number(yield* child.exitCode) === 0;
    }),
  ).pipe(Effect.orElseSucceed(() => false));

export const runTailscaleServeDoctor = Effect.fn("runTailscaleServeDoctor")(function* (
  config: ServerConfig.ServerConfig["Service"],
  options: { readonly fix: boolean; readonly dryRun: boolean; readonly interactive?: boolean },
) {
  if ((yield* HostProcess.Platform) !== "linux") return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    yield* HostProcess.HomeDirectory,
    ".config/systemd/user/cogenly.service.d",
  );
  const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const found: Array<{ readonly file: string; readonly dropIn: ServeDropIn }> = [];
  for (const entry of entries.filter((name) => name.endsWith(".conf")).toSorted()) {
    const file = path.join(directory, entry);
    const contents = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    const dropIn = parseServeDropIn(contents);
    if (dropIn !== null) found.push({ file, dropIn });
  }
  const last = found.at(-1);
  if (last === undefined) return;

  yield* Console.log(
    `\nKeep Tailscale Serve in Cogenly's settings (recommended)\n  ${last.file} sets COGENLY_TAILSCALE_SERVE. Cogenly keeps this setting itself now, so setup and \`cogenly service status\` can see it and Serve stays on across restarts.${last.dropIn.onlyServe ? " The drop-in sets nothing else and is removed." : " The drop-in sets other things too, so it stays; remove its COGENLY_TAILSCALE_SERVE lines yourself."}\n  Restarts the background service.`,
  );
  if (options.dryRun) return;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const wanted = options.fix
    ? true
    : interactive
      ? yield* Prompt.run(
          Prompt.Confirm({
            message: "Move Tailscale Serve into Cogenly's settings?",
            initial: true,
          }),
        ).pipe(Effect.orElseSucceed(() => false))
      : false;
  if (!wanted) return;

  const filePath = yield* TailscaleServeMode.servePreferencePath(config.stateDir);
  yield* TailscaleServeMode.writeServePreference(filePath, {
    enabled: last.dropIn.enabled,
    servePort: last.dropIn.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT,
  });
  if (found.every((entry) => entry.dropIn.onlyServe)) {
    for (const entry of found) yield* fs.remove(entry.file);
    yield* runQuiet("systemctl", ["--user", "daemon-reload"]);
  }
  const service = yield* BootService.BootService;
  const restarted = yield* service.restart;
  yield* Console.log(
    `Tailscale Serve is ${last.dropIn.enabled ? "on" : "off"} in Cogenly's settings${restarted ? "; restarted the service" : ""}.`,
  );
});
