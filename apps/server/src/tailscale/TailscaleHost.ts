/**
 * TailscaleHost: the adapter between machine setup and this machine's
 * Tailscale CLI, package installers, and `open`. Everything that spawns a
 * process for setup lives here, so tests replace this one service.
 *
 * Commands that wait on the user (`tailscale up`, `tailscale serve` before the
 * tailnet allows HTTPS) print a Tailscale link and keep running until the user
 * finishes. `run` hands that link back at once and leaves the command running
 * in the background, so setup completes by itself once the user is done.
 * Output is matched only for Tailscale's own links and failure kinds; it is
 * never logged, since it can carry auth keys and node names.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeOS from "node:os";

import type { MachineSetupHost, MachineSetupOperation } from "./machineSetupSteps.ts";
import { TAILSCALE_INSTALL_SCRIPT, TAILSCALE_MAC_APP_STORE_URL } from "./machineSetupSteps.ts";
import {
  findTailscaleControlUrl,
  parseServeMappings,
  parseTailscaleStatusSnapshot,
  type ServePortMapping,
  type TailscaleStatusSnapshot,
} from "./tailscaleState.ts";

/** The App Store and standalone Mac apps keep the CLI inside the bundle, off PATH. */
export const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const READ_TIMEOUT = Duration.seconds(4);
/** How long `run` waits for a link or an exit before reporting the command as underway. */
const LINK_WAIT = Duration.seconds(20);
/** How long a command may wait on the user, such as an open sign-in page. */
const USER_WAIT = Duration.minutes(30);
const INSTALL_TIMEOUT = Duration.minutes(10);

export interface TailscaleProbe {
  readonly installed: boolean;
  readonly version: string | null;
  /** Null when the daemon or app does not answer. */
  readonly status: TailscaleStatusSnapshot | null;
  readonly serveMappings: ReadonlyArray<ServePortMapping> | null;
}

export type TailscaleCommandOutcome =
  | { readonly _tag: "ok" }
  | {
      readonly _tag: "failed";
      readonly reason: "permission-denied" | "timed-out" | "not-found" | "other";
    };

export interface TailscaleRun {
  /** A Tailscale page the user has to open before the command can finish. */
  readonly url: string | null;
  /** The command's end. Already settled when it finished without the user. */
  readonly done: Effect.Effect<TailscaleCommandOutcome>;
}

export type TailscaleHostOperation = MachineSetupOperation | "set-operator";

export interface TailscaleRunInput {
  readonly localPort: number;
  readonly servePort: number;
}

export class TailscaleHost extends Context.Service<
  TailscaleHost,
  {
    readonly host: Effect.Effect<MachineSetupHost>;
    readonly probe: Effect.Effect<TailscaleProbe>;
    readonly run: (
      operation: TailscaleHostOperation,
      input: TailscaleRunInput,
    ) => Effect.Effect<TailscaleRun>;
  }
>()("cogenly-server/tailscale/TailscaleHost") {}

const PERMISSION_DENIED =
  /permission denied|access denied|must be root|operation not permitted|sudo: a password is required|checkprefs/i;

export const classifyFailure = (output: string): "permission-denied" | "other" =>
  PERMISSION_DENIED.test(output) ? "permission-denied" : "other";

interface Exec {
  readonly code: number;
  readonly stdout: string;
}

/** The argv for one operation, or null when it has no command on this platform. */
export const operationCommand = (
  operation: TailscaleHostOperation,
  context: {
    readonly cli: string;
    readonly host: MachineSetupHost;
    readonly user: string;
    readonly input: TailscaleRunInput;
  },
): readonly [string, ReadonlyArray<string>] | null => {
  const { cli, host, user, input } = context;
  // Only Linux prefs need root. `sudo -n` fails rather than prompting.
  const elevated = (args: ReadonlyArray<string>): readonly [string, ReadonlyArray<string>] =>
    host.platform === "linux" && !host.root ? ["sudo", ["-n", ...args]] : [args[0]!, args.slice(1)];
  switch (operation) {
    case "install-script":
      return host.platform === "linux" ? elevated(["sh", "-c", TAILSCALE_INSTALL_SCRIPT]) : null;
    case "open-app-store":
      return host.platform === "darwin"
        ? ["open", [TAILSCALE_MAC_APP_STORE_URL.replace(/^https:/u, "macappstore:")]]
        : null;
    case "start-daemon":
      return host.platform === "linux"
        ? elevated(["systemctl", "enable", "--now", "tailscaled"])
        : null;
    case "open-app":
      return host.platform === "darwin" ? ["open", ["-a", "Tailscale"]] : null;
    case "connect":
    case "login":
      // Plain `up` keeps the node's other prefs; `up` with any new flag would
      // demand every non-default flag be restated.
      return host.platform === "linux" && !host.root && host.passwordlessSudo
        ? elevated([cli, "up"])
        : [cli, ["up"]];
    case "set-operator":
      // Making this user Tailscale's operator lets Cogenly run `serve` without sudo.
      return host.platform === "linux" && !host.root
        ? elevated([cli, "set", `--operator=${user}`])
        : null;
    case "serve":
      return [
        cli,
        [
          "serve",
          "--bg",
          `--https=${String(input.servePort)}`,
          `http://127.0.0.1:${String(input.localPort)}`,
        ],
      ];
  }
};

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  const layerScope = yield* Effect.scope;

  const exec = (command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, [...args], { stdin: "ignore" }),
        );
        const [stdout, , code] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.runDrain),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { code: Number(code), stdout } satisfies Exec;
      }),
    ).pipe(
      Effect.timeout(READ_TIMEOUT),
      // A missing binary can also surface as a defect (ENOENT, ENOTDIR on PATH).
      Effect.catchDefect(() => Effect.succeed(null)),
      Effect.orElseSucceed(() => null),
    );

  const user = (() => {
    try {
      return NodeOS.userInfo().username;
    } catch {
      return process.env.USER ?? "root";
    }
  })();

  const host = yield* Effect.cached(
    Effect.gen(function* () {
      const root = userId === 0;
      const passwordlessSudo =
        platform === "linux" && !root ? (yield* exec("sudo", ["-n", "true"]))?.code === 0 : false;
      const homebrew =
        platform === "darwin" ? (yield* exec("brew", ["--version"]))?.code === 0 : false;
      return { platform, root, passwordlessSudo, homebrew } satisfies MachineSetupHost;
    }),
  );

  /** The CLI to call, or null when Tailscale isn't installed. */
  const locate = Effect.gen(function* () {
    const onPath = platform === "win32" ? "tailscale.exe" : "tailscale";
    const version = yield* exec(onPath, ["version"]);
    if (version !== null && version.code === 0) return { cli: onPath, version };
    if (
      platform === "darwin" &&
      (yield* fs.exists(MAC_APP_CLI).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return { cli: MAC_APP_CLI, version: yield* exec(MAC_APP_CLI, ["version"]) };
    }
    return null;
  });

  const probe: TailscaleHost["Service"]["probe"] = Effect.gen(function* () {
    const located = yield* locate;
    if (located === null) {
      return { installed: false, version: null, status: null, serveMappings: null };
    }
    const version =
      located.version?.code === 0
        ? (located.version.stdout.split(/\r?\n/u)[0]?.trim() ?? null)
        : null;
    const [status, serve] = yield* Effect.all(
      [exec(located.cli, ["status", "--json"]), exec(located.cli, ["serve", "status", "--json"])],
      { concurrency: "unbounded" },
    );
    // `status --json` still prints JSON while logged out; an unreachable daemon prints none.
    const snapshot = status === null ? null : parseTailscaleStatusSnapshot(status.stdout);
    return {
      installed: true,
      version: version === "" ? null : version,
      status: snapshot,
      serveMappings: serve === null || serve.code !== 0 ? null : parseServeMappings(serve.stdout),
    };
  }).pipe(Effect.withSpan("TailscaleHost.probe"));

  /** Spawns a command that may wait on the user, in the background. */
  const runInBackground = (
    command: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Duration,
  ) =>
    Effect.gen(function* () {
      const link = yield* Deferred.make<string>();
      const done = yield* Deferred.make<TailscaleCommandOutcome>();
      const output = yield* Ref.make("");
      const watch = <E>(stream: Stream.Stream<Uint8Array, E>) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Ref.updateAndGet(output, (text) => (text + chunk).slice(-16_384)).pipe(
              Effect.flatMap((text) => {
                const url = findTailscaleControlUrl(text);
                return url === null ? Effect.void : Deferred.succeed(link, url);
              }),
            ),
          ),
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, [...args], { stdin: "ignore" }),
          );
          const [, , code] = yield* Effect.all(
            [watch(child.stdout), watch(child.stderr), child.exitCode],
            { concurrency: "unbounded" },
          );
          return Number(code) === 0
            ? ({ _tag: "ok" } as const)
            : ({ _tag: "failed", reason: classifyFailure(yield* Ref.get(output)) } as const);
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.succeed({ _tag: "failed", reason: "timed-out" } as const),
        }),
        Effect.catchDefect(() => Effect.succeed({ _tag: "failed", reason: "not-found" } as const)),
        Effect.orElseSucceed(() => ({ _tag: "failed", reason: "not-found" }) as const),
        Effect.flatMap((outcome) => Deferred.succeed(done, outcome)),
        Effect.forkIn(layerScope),
      );
      const url = yield* Effect.raceFirst(
        Deferred.await(link),
        Deferred.await(done).pipe(Effect.as(null)),
      ).pipe(Effect.timeoutOrElse({ duration: LINK_WAIT, orElse: () => Effect.succeed(null) }));
      return { url, done: Deferred.await(done) } satisfies TailscaleRun;
    });

  const run: TailscaleHost["Service"]["run"] = (operation, input) =>
    Effect.gen(function* () {
      const located = yield* locate;
      const command = operationCommand(operation, {
        cli: located?.cli ?? (platform === "win32" ? "tailscale.exe" : "tailscale"),
        host: yield* host,
        user,
        input,
      });
      if (command === null) {
        return {
          url: null,
          done: Effect.succeed({ _tag: "failed", reason: "not-found" } as const),
        } satisfies TailscaleRun;
      }
      const [executable, args] = command;
      return yield* runInBackground(
        executable,
        args,
        operation === "install-script" ? INSTALL_TIMEOUT : USER_WAIT,
      );
    }).pipe(Effect.withSpan("TailscaleHost.run", { attributes: { operation } }));

  return TailscaleHost.of({ host, probe, run });
});

export const layer = Layer.effect(TailscaleHost, make);
