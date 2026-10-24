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

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import type * as ServerConfig from "../config.ts";
import * as TailscaleServeMode from "../tailscale/TailscaleServeMode.ts";

export interface ServeDropIn {
  /** Null when the file sets only the port. */
  readonly enabled: boolean | null;
  readonly servePort: number | null;
  /** The file sets nothing but Serve, so removing it changes nothing else. */
  readonly onlyServe: boolean;
}

const SERVE_ENV = /^Environment="?COGENLY_TAILSCALE_SERVE=([^"\s]*)"?\s*$/u;
const SERVE_PORT_ENV = /^Environment="?COGENLY_TAILSCALE_SERVE_PORT=(\d+)"?\s*$/u;

/** Reads a systemd drop-in; null when it sets neither Serve variable. */
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
  return enabled === null && servePort === null ? null : { enabled, servePort, onlyServe };
};

/**
 * Why moving the setting now could take Serve away from the running service,
 * or null when it is safe. The service has to read this home's setting: a
 * unit for another home, or a release from before the setting existed, would
 * start without Serve once the drop-in is gone.
 */
export const serveMigrationBlocker = (
  status: BootService.BootServiceStatus,
  context: { readonly baseDir: string; readonly cliVersion: string },
  resolvePath: (path: string) => string,
): string | null => {
  if (!status.supported || !status.installed) {
    return "The background service isn't installed, so nothing reads the drop-in. Remove it yourself, or run `cogenly service install --tailscale-serve`.";
  }
  if (
    status.installedBaseDir !== undefined &&
    resolvePath(status.installedBaseDir) !== resolvePath(context.baseDir)
  ) {
    return `The background service serves ${status.installedBaseDir}, not this Cogenly home. Run \`cogenly doctor --base-dir ${status.installedBaseDir}\` instead.`;
  }
  if (
    status.installedVersion !== undefined &&
    compareExactServiceVersions(status.installedVersion, context.cliVersion) < 0
  ) {
    return `The background service runs cogenly@${status.installedVersion}, which doesn't read this setting. Run \`cogenly service install\` first, then \`cogenly doctor\` again.`;
  }
  return null;
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
  // systemd applies drop-ins in name order, so the last file to set a variable wins.
  const setting = found.findLast((entry) => entry.dropIn.enabled !== null);
  if (setting === undefined) return;
  const enabled = setting.dropIn.enabled === true;
  const servePort =
    found.findLast((entry) => entry.dropIn.servePort !== null)?.dropIn.servePort ??
    DEFAULT_TAILSCALE_SERVE_PORT;
  // Removing only some files would change what the rest set, the port above all.
  const removable = found.every((entry) => entry.dropIn.onlyServe);
  const files = found.map((entry) => entry.file).join(", ");

  yield* Console.log(
    `\nKeep Tailscale Serve in Cogenly's settings (recommended)\n  ${files} ${found.length === 1 ? "sets" : "set"} COGENLY_TAILSCALE_SERVE. Cogenly keeps this setting itself now, so setup and \`cogenly service status\` can see it and Serve stays on across restarts.${removable ? ` ${found.length === 1 ? "The drop-in sets" : "The drop-ins set"} nothing else and ${found.length === 1 ? "is" : "are"} removed.` : " A drop-in sets other things too, so they all stay; remove their COGENLY_TAILSCALE_SERVE lines yourself."}\n  Restarts the background service.`,
  );
  const service = yield* BootService.BootService;
  const blocker = serveMigrationBlocker(
    yield* service.status,
    { baseDir: config.baseDir, cliVersion: packageJson.version },
    path.resolve,
  );
  if (blocker !== null) {
    yield* Console.log(`  Skipped: ${blocker}`);
    return;
  }
  if (options.dryRun) return;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!options.fix && !interactive) {
    yield* Console.log("  Run in a terminal to choose it, or pass --fix.");
    return;
  }
  const wanted =
    options.fix ||
    (yield* Prompt.run(
      Prompt.Confirm({
        message: "Move Tailscale Serve into Cogenly's settings?",
        initial: true,
      }),
    ).pipe(Effect.orElseSucceed(() => false)));
  if (!wanted) return;

  // Saved first: the service must find it before the drop-in stops setting it.
  const filePath = yield* TailscaleServeMode.servePreferencePath(config.stateDir);
  yield* TailscaleServeMode.writeServePreference(filePath, { enabled, servePort });
  if (removable) {
    for (const entry of found) yield* fs.remove(entry.file);
    yield* runQuiet("systemctl", ["--user", "daemon-reload"]);
  }
  const restarted = yield* service.restart;
  yield* Console.log(
    `Tailscale Serve is ${enabled ? `on (HTTPS port ${String(servePort)})` : "off"} in Cogenly's settings${restarted ? "; restarted the service" : ""}.`,
  );
});
