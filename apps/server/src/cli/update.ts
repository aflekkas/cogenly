import * as HostProcess from "@cogenly/shared/HostProcess";
import {
  CLI_RELEASE_BASE_URL_ENV,
  CLI_RELEASE_CHANNELS,
  CLI_RELEASES_UNAVAILABLE_MESSAGE,
  cliReleaseIndexPageUrl,
  cliReleaseChannelOf,
  newestCliReleaseVersion,
  type CliReleaseChannel,
} from "@cogenly/shared/cliRelease";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import {
  ensurePinnedRuntimeInstalled,
  PINNED_RUNTIME_ARCHIVE_MISSING_STEP,
  PINNED_RUNTIME_CHECKSUMS_STEP,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  PinnedRuntimePreflightBlockedError,
  pinnedRuntimePaths,
  type PinnedRuntimePaths,
  resolvePinnedRuntimeEntry,
} from "../cloud/pinnedRuntime.ts";
import {
  compareExactServiceVersions,
  isExactServiceVersion,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../cloud/serviceProtocol.ts";
import { decodeServicePreflightResult } from "../cloud/servicePreflight.ts";
import * as ReadOnlySandbox from "../terminal/ReadOnlySandbox.ts";
import * as ProcessRunner from "../processRunner.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { createUpdateProgress } from "./updateProgress.ts";
import * as CliService from "./service.ts";

export class CliUpdateError extends Schema.TaggedError<CliUpdateError>()("CliUpdateError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);
// Enough to walk past a long run of nightlies without hammering the API when
// a channel genuinely has nothing published.
const RELEASE_INDEX_MAX_PAGES = 10;

/** Asks GitHub for the newest published version on a channel, page by page. */
const resolveNewestVersion = Effect.fn("cli.update.resolve_newest")(function* (
  channel: CliReleaseChannel,
) {
  const httpClient = yield* HttpClient.HttpClient;
  for (let page = 1; page <= RELEASE_INDEX_MAX_PAGES; page += 1) {
    const pageUrl = cliReleaseIndexPageUrl(page);
    if (pageUrl === null) {
      return yield* new CliUpdateError({ reason: CLI_RELEASES_UNAVAILABLE_MESSAGE });
    }
    const body = yield* httpClient
      .execute(
        HttpClientRequest.get(pageUrl).pipe(
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.mapError(() => new CliUpdateError({ reason: "Could not list Cogenly releases." })),
        Effect.timeoutOrElse({
          duration: RELEASE_INDEX_TIMEOUT,
          orElse: () =>
            Effect.fail(new CliUpdateError({ reason: "Timed out listing Cogenly releases." })),
        }),
      );
    const releases = yield* decodeReleaseIndex(body).pipe(
      Effect.mapError(
        () => new CliUpdateError({ reason: "The Cogenly release index had an unexpected shape." }),
      ),
    );
    const version = newestCliReleaseVersion(releases, channel);
    if (version !== undefined) return version;
    if (releases.length === 0) break;
  }
  return yield* new CliUpdateError({ reason: `No published ${channel} release was found.` });
});

/** Whether a launcher target lives inside `<baseDir>/runtime/versions`. */
export function launcherOwnsVersionsDir(
  path: Path.Path,
  versionsDir: string,
  candidate: string,
): boolean {
  const relative = path.relative(versionsDir, path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Whether a launcher (a symlink on POSIX, a `.cmd` shim on Windows) points
 * into this home's `runtime/versions` tree, and so is ours to rewrite or remove.
 */
const launcherIsOwned = Effect.fn("cli.update.launcher_is_owned")(function* (
  launcher: string,
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if ((yield* HostProcess.Platform) === "win32") {
    const contents = yield* fs.readFileString(launcher).pipe(Effect.option);
    const target = Option.isSome(contents) ? /^"([^"]+)"/m.exec(contents.value)?.[1] : undefined;
    return target !== undefined && launcherOwnsVersionsDir(path, versionsDir, target);
  }
  const linkTarget = yield* fs.readLink(launcher).pipe(Effect.option);
  return (
    Option.isSome(linkTarget) &&
    launcherOwnsVersionsDir(
      path,
      versionsDir,
      path.resolve(path.dirname(launcher), linkTarget.value),
    )
  );
});

/** Points a launcher at `targetEntryPath`, replacing whatever is at `launcher` atomically on POSIX. */
const writeLauncher = Effect.fn("cli.update.write_launcher")(function* (
  launcher: string,
  targetEntryPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const write =
    (yield* HostProcess.Platform) === "win32"
      ? fs.writeFileString(launcher, `@echo off\r\n"${targetEntryPath}" %*`)
      : fs
          .symlink(targetEntryPath, `${launcher}.${process.pid}.tmp`)
          .pipe(Effect.andThen(fs.rename(`${launcher}.${process.pid}.tmp`, launcher)));
  yield* write.pipe(
    Effect.mapError(
      () =>
        new CliUpdateError({ reason: `Could not repoint the cogenly launcher at ${launcher}.` }),
    ),
  );
});

/**
 * The launcher the install scripts leave behind: a symlink at `<bin>/cogenly`
 * on POSIX, a `cogenly.cmd` shim on Windows. `cogenly update` repoints it so
 * the next `cogenly` invocation is the new version. Only a launcher that
 * already points into this home's `runtime/versions` tree is touched; a plain
 * copy of the executable, or a launcher for some other install, is left alone.
 */
export const repointLauncher = Effect.fn("cli.update.repoint_launcher")(function* (input: {
  /** Path the current process was started through, if known. */
  readonly launchedAs: string | undefined;
  /** `<baseDir>/runtime/versions` of the home being updated. */
  readonly versionsDir: string;
  readonly targetEntryPath: string;
}) {
  if (input.launchedAs === undefined) return Option.none<string>();
  const fs = yield* FileSystem.FileSystem;
  // Never point a launcher at a runtime that is not on disk: the symlink
  // would replace a working command with a dangling one.
  if (!(yield* fs.exists(input.targetEntryPath).pipe(Effect.orElseSucceed(() => false)))) {
    return Option.none<string>();
  }
  // On Windows the shim runs the executable by absolute path, so the
  // executable sees itself as argv0. Find the shim by searching the
  // directories that would resolve `cogenly` on this shell's PATH.
  const launcher =
    (yield* HostProcess.Platform) === "win32"
      ? yield* findWindowsShim(input.launchedAs)
      : input.launchedAs;
  if (launcher === undefined || !(yield* launcherIsOwned(launcher, input.versionsDir))) {
    return Option.none<string>();
  }
  yield* writeLauncher(launcher, input.targetEntryPath);
  return Option.some(launcher);
});

/**
 * Release installs used to name the launcher `t3` (`t3.cmd` on Windows).
 * Finds such launchers of ours next to the one this process ran through, in
 * `COGENLY_INSTALL_BIN_DIR`, and on PATH. A `t3` that does not point into this
 * home's `runtime/versions` belongs to something else and is not returned.
 */
export const findLegacyLaunchers = Effect.fn("cli.update.find_legacy_launchers")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
}) {
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const windows = (yield* HostProcess.Platform) === "win32";
  const directories = new Set(
    [
      ...(input.launchedAs === undefined || windows ? [] : [path.dirname(input.launchedAs)]),
      environment["COGENLY_INSTALL_BIN_DIR"] ?? "",
      ...(environment["PATH"] ?? environment["Path"] ?? "").split(windows ? ";" : ":"),
    ]
      .filter((entry) => entry.trim().length > 0)
      .map((entry) => path.resolve(entry)),
  );
  const found: Array<string> = [];
  for (const directory of directories) {
    const legacy = path.join(directory, windows ? "t3.cmd" : "t3");
    if (yield* launcherIsOwned(legacy, input.versionsDir)) found.push(legacy);
  }
  return found;
});

/**
 * Replaces each legacy `t3` launcher of ours with a `cogenly` one in the same
 * directory and removes the `t3` one. One whose directory already holds a
 * `cogenly` that is not ours stays, so the install keeps a working command.
 * Returns the `cogenly` launchers that took over.
 */
export const retireLegacyLauncher = Effect.fn("cli.update.retire_legacy_launcher")(
  function* (input: {
    readonly launchedAs: string | undefined;
    readonly versionsDir: string;
    readonly targetEntryPath: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const windows = (yield* HostProcess.Platform) === "win32";
    // Removing `t3` is only safe once `cogenly` will resolve to a runtime
    // that exists; otherwise the machine loses its only working command.
    if (!(yield* fs.exists(input.targetEntryPath).pipe(Effect.orElseSucceed(() => false)))) {
      return [];
    }
    const replaced: Array<string> = [];
    for (const legacy of yield* findLegacyLaunchers(input)) {
      const launcher = path.join(path.dirname(legacy), windows ? "cogenly.cmd" : "cogenly");
      const occupied =
        (yield* fs.exists(launcher).pipe(Effect.orElseSucceed(() => false))) ||
        Option.isSome(yield* fs.readLink(launcher).pipe(Effect.option));
      if (occupied && !(yield* launcherIsOwned(launcher, input.versionsDir))) continue;
      yield* writeLauncher(launcher, input.targetEntryPath);
      yield* fs
        .remove(legacy, { force: true })
        .pipe(
          Effect.mapError(
            () =>
              new CliUpdateError({ reason: `Could not remove the old t3 launcher at ${legacy}.` }),
          ),
        );
      replaced.push(launcher);
    }
    return replaced;
  },
);

/**
 * The path the executable was started through. Node keeps the shell's
 * spelling in argv0: a launcher symlink or `./cogenly` resolves against the
 * working directory, while a bare `cogenly` was found on PATH and has to be
 * looked up there again, or the launcher symlink is never seen.
 */
export const resolveLauncherPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const invokedAs = yield* HostProcess.InvokedAs;
  const cwd = yield* HostProcess.WorkingDirectory;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  if (invokedAs.includes("/") || invokedAs.includes("\\")) {
    return path.resolve(cwd, invokedAs);
  }
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of (environment["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, invokedAs);
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return undefined;
});

/**
 * On Windows a `.cmd` shim is what PATH resolves, but the executable it runs
 * only ever sees its own path. Walk PATH for a `cogenly.cmd` whose target is the
 * running executable; that is the launcher the install script wrote.
 */
export const findWindowsShim = Effect.fn("cli.update.find_windows_shim")(function* (
  executablePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const candidates = [
    ...(environment["COGENLY_INSTALL_BIN_DIR"] ? [environment["COGENLY_INSTALL_BIN_DIR"]] : []),
    ...(environment["PATH"] ?? environment["Path"] ?? "").split(";"),
  ].filter((entry) => entry.trim().length > 0);
  for (const directory of candidates) {
    const shimPath = path.join(directory, "cogenly.cmd");
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.option);
    if (Option.isNone(contents)) continue;
    const target = /^"([^"]+)"/m.exec(contents.value)?.[1];
    if (
      target !== undefined &&
      path.resolve(target).toLowerCase() === path.resolve(executablePath).toLowerCase()
    ) {
      return shimPath;
    }
  }
  return undefined;
});

const updateFlags = {
  ...projectLocationFlags,
  channel: Flag.Literals("channel", CLI_RELEASE_CHANNELS).pipe(
    Flag.withDescription(
      "Release channel to follow. Defaults to the channel this cogenly was published on.",
    ),
    Flag.optional,
  ),
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow moving to an older version than the one running."),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Restart the background service without asking. Required to restart it from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
};

const versionArgument = Argument.String("version").pipe(
  Argument.withDescription(
    "Exact version to install. Defaults to the newest release on the channel.",
  ),
  Argument.optional,
);

export const updateCommand = Command.make("update", {
  ...updateFlags,
  version: versionArgument,
}).pipe(
  Command.withDescription(
    "Download a newer Cogenly and switch this machine to it, including the background service when one is installed.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUpdate({
        baseDir: config.baseDir,
        dbPath: config.dbPath,
        logsDir: config.logsDir,
        serverRuntimeStatePath: config.serverRuntimeStatePath,
        channel: Option.getOrUndefined(flags.channel),
        requestedVersion: Option.getOrUndefined(flags.version),
        allowDowngrade: flags.allowDowngrade,
        assumeYes: flags.yes,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(CliService.layer(config), ProcessRunner.layer, FetchHttpClient.layer),
        ),
      );
    }),
  ),
);

/**
 * A `cogenly serve` or `t3` someone started by hand, as opposed to the one the
 * background service supervises. The server records its pid on startup; a
 * stale file from a crashed server is ignored by checking the pid is alive.
 *
 * Servers from before `serviceManaged` was recorded cannot be told apart by
 * the file alone, so the launcher-supervised case is also recognised by
 * lineage: a service server's parent is the launcher, and on Linux that
 * launcher runs inside the unit's cgroup.
 */
const findForegroundServer = Effect.fn("cli.update.find_foreground_server")(function* (input: {
  readonly serverRuntimeStatePath: string;
  readonly serviceInstalled: boolean;
}) {
  const state = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
  if (Option.isNone(state) || state.value.serviceManaged || !isProcessAlive(state.value.pid)) {
    return undefined;
  }
  if (input.serviceInstalled && (yield* belongsToBootService(state.value.pid))) return undefined;
  return state.value;
});

const belongsToBootService = Effect.fn("cli.update.belongs_to_boot_service")(function* (
  pid: number,
) {
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  if (platform === "linux") {
    const cgroup = yield* fs.readFileString(`/proc/${pid}/cgroup`).pipe(Effect.option);
    return Option.isSome(cgroup) && cgroup.value.includes("/cogenly.service");
  }
  if (platform === "darwin") {
    // The service server's parent is the launcher process.
    const parent = yield* runner
      .run({
        command: "ps",
        args: ["-o", "ppid=", "-p", String(pid)],
        timeout: Duration.seconds(5),
      })
      .pipe(Effect.option);
    const ppid = Option.isSome(parent) && parent.value.code === 0 ? parent.value.stdout.trim() : "";
    if (!/^\d+$/.test(ppid)) return false;
    const command = yield* runner
      .run({ command: "ps", args: ["-o", "command=", "-p", ppid], timeout: Duration.seconds(5) })
      .pipe(
        Effect.map((result) => (result.code === 0 ? result.stdout : "")),
        Effect.orElseSucceed(() => ""),
      );
    return /__service-launcher/.test(command);
  }
  return false;
});

export const runUpdate = Effect.fn("cli.update.run")(function* (input: {
  readonly baseDir: string;
  readonly dbPath?: string;
  readonly logsDir: string;
  readonly serverRuntimeStatePath: string;
  readonly channel: CliReleaseChannel | undefined;
  readonly requestedVersion: string | undefined;
  readonly allowDowngrade: boolean;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const httpClient = yield* HttpClient.HttpClient;
  const service = yield* BootService.BootService;

  yield* ReadOnlySandbox.provisionLocal;

  const currentVersion = packageJson.version;
  const channel = input.channel ?? cliReleaseChannelOf(currentVersion);
  // Without a published release origin there is nothing to update to. An
  // exact version from a configured mirror is the only way through.
  if (
    cliReleaseIndexPageUrl(1) === null &&
    (input.requestedVersion === undefined || !environment[CLI_RELEASE_BASE_URL_ENV]?.trim())
  ) {
    return yield* new CliUpdateError({ reason: CLI_RELEASES_UNAVAILABLE_MESSAGE });
  }
  if (input.requestedVersion !== undefined && !isExactServiceVersion(input.requestedVersion)) {
    return yield* new CliUpdateError({
      reason: `'${input.requestedVersion}' is not an exact Cogenly version.`,
    });
  }
  const progress = createUpdateProgress();
  progress.status("Checking for updates...");
  const targetVersion = yield* (
    input.requestedVersion === undefined
      ? resolveNewestVersion(channel)
      : Effect.succeed(input.requestedVersion)
  ).pipe(Effect.ensuring(Effect.sync(progress.finish)));
  const targetChannel = cliReleaseChannelOf(targetVersion);

  // Work out everything that will be touched before touching anything, so the
  // user sees one plan and one question rather than a surprise restart.
  const status = yield* service.status;
  // The unit name is per user, not per Cogenly home. Only touch the service when it
  // serves the home this update targets; otherwise it belongs to another
  // install on this machine and restarting it would take that server down.
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const serviceInstalled = status.supported && status.installed && servesThisHome;
  const foreground = yield* findForegroundServer({
    serverRuntimeStatePath: input.serverRuntimeStatePath,
    serviceInstalled,
  });
  // What this machine runs is the executable behind the launcher and, when a
  // service is installed for this home, the version that service runs. Either
  // being stale is an update to do, and the newest of the two is what the
  // downgrade check protects.
  const serviceVersion = serviceInstalled ? status.installedVersion : undefined;
  const executableCurrent = targetVersion === currentVersion;
  // A service whose recorded version is missing or unreadable is not known
  // to be current, so it gets the update rather than being skipped. Nor is
  // one on the right version that is stopped, disabled, or still running the
  // version before it (an earlier update where the restart was declined):
  // `status.current` covers all of that when the target is this executable,
  // and the problem list is what can be judged for any other target.
  const restartPending = status.problems?.includes("restart-pending") === true;
  const serviceCurrent =
    !serviceInstalled ||
    (serviceVersion === targetVersion &&
      (executableCurrent ? status.current : (status.problems ?? []).length === 0));
  const newestInstalled =
    serviceVersion !== undefined && compareExactServiceVersions(serviceVersion, currentVersion) > 0
      ? serviceVersion
      : currentVersion;

  const dbPath = input.dbPath ?? path.join(input.baseDir, "userdata", "statev2.sqlite");
  const validateRuntime = (paths: PinnedRuntimePaths) =>
    runner
      .run({
        command: pinnedRuntimeCommand(paths).command,
        args: [...pinnedRuntimeCommand(paths).args, "--version"],
        timeout: Duration.seconds(30),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "verifying the downloaded cogenly", cause }),
        ),
        Effect.flatMap((result) =>
          result.code === 0 && /\bv(\S+)\s*$/.exec(result.stdout)?.[1] === targetVersion
            ? Effect.void
            : Effect.fail(
                new PinnedRuntimeInstallError({
                  step: "verifying the downloaded cogenly",
                  exitCode: Number(result.code),
                }),
              ),
        ),
        Effect.andThen(() =>
          serviceInstalled
            ? runner
                .run({
                  command: pinnedRuntimeCommand(paths).command,
                  args: [
                    ...pinnedRuntimeCommand(paths).args,
                    "__service-preflight",
                    "--database-path",
                    dbPath,
                    "--launcher-protocol",
                    String(SERVICE_LAUNCHER_PROTOCOL),
                  ],
                  timeout: Duration.seconds(30),
                })
                .pipe(
                  Effect.mapError(
                    () =>
                      new PinnedRuntimeInstallError({
                        step: "running the service update preflight",
                      }),
                  ),
                  Effect.flatMap((result) => {
                    let preflight;
                    try {
                      preflight = decodeServicePreflightResult(JSON.parse(result.stdout.trim()));
                    } catch {
                      /* Invalid output is refused below. */
                    }
                    return result.code === 0 &&
                      preflight?.version === targetVersion &&
                      preflight.status === "ready"
                      ? Effect.void
                      : Effect.fail(
                          new PinnedRuntimePreflightBlockedError({
                            version: targetVersion,
                            reason:
                              preflight?.status === "blocked"
                                ? preflight.reason
                                : "The service update preflight failed. The current install was left in place.",
                          }),
                        );
                  }),
                )
            : Effect.void,
        ),
      );

  if (executableCurrent && serviceCurrent) {
    // Already current is not a reason to skip the launchers: a machine
    // whose only command is still `t3` gets its `cogenly` here.
    const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
    const targetPaths = yield* resolvePinnedRuntimeEntry(
      fs,
      path,
      pinnedRuntimePaths(path, input.baseDir, targetVersion, platform),
      platform,
    ).pipe(
      Effect.mapError(
        () => new CliUpdateError({ reason: `Could not inspect cogenly@${targetVersion}.` }),
      ),
    );
    // The running executable being current does not mean this home has
    // that runtime pinned (it may only hold an older one). Install it
    // before touching any launcher, so `cogenly` never replaces `t3`
    // with a pointer at a runtime that is not there.
    const sentinelMatches = yield* fs.readFileString(targetPaths.sentinelPath).pipe(
      Effect.map((sentinel) => sentinel.trim() === targetVersion),
      Effect.orElseSucceed(() => false),
    );
    const entryExists = yield* fs
      .exists(targetPaths.entryPath)
      .pipe(Effect.orElseSucceed(() => false));
    const targetInstalled = sentinelMatches && entryExists;
    const runtimePaths = targetInstalled
      ? targetPaths
      : yield* ensurePinnedRuntimeInstalled({
          onProgress: progress.report,
          baseDir: input.baseDir,
          version: targetVersion,
          fs,
          path,
          runner,
          httpClient,
          platform,
          arch,
          releaseBaseUrl: environment[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined,
          validate: validateRuntime,
        }).pipe(Effect.ensuring(Effect.sync(progress.finish)));
    const launcherInput = {
      launchedAs,
      versionsDir: path.dirname(runtimePaths.versionDir),
      targetEntryPath: runtimePaths.entryPath,
    };
    yield* repointLauncher(launcherInput);
    const retired = yield* retireLegacyLauncher(launcherInput);
    yield* Console.log(
      serviceVersion !== undefined
        ? `cogenly and its background service are already on ${targetVersion} (${targetChannel}).`
        : `cogenly is already on ${targetVersion} (${targetChannel}).`,
    );
    for (const launcher of retired) {
      yield* Console.log(`  The t3 command is now cogenly (${launcher}).`);
    }
    return;
  }
  if (!input.allowDowngrade && compareExactServiceVersions(targetVersion, newestInstalled) < 0) {
    return yield* new CliUpdateError({
      reason: `cogenly@${targetVersion} is older than the installed ${newestInstalled}. Pass --allow-downgrade to install it anyway.`,
    });
  }

  const alreadyOnDisk = yield* fs
    .readFileString(pinnedRuntimePaths(path, input.baseDir, targetVersion, platform).sentinelPath)
    .pipe(
      Effect.map((sentinel) => sentinel.trim() === targetVersion),
      Effect.orElseSucceed(() => false),
    );

  progress.heading(
    executableCurrent && restartPending
      ? `The background service is still running the version before ${targetVersion} (${targetChannel}).`
      : executableCurrent
        ? `Updating the background service ${serviceVersion ?? "(unknown version)"} -> ${targetVersion} (${targetChannel}).`
        : alreadyOnDisk
          ? "Switching Cogenly"
          : "Updating Cogenly",
    executableCurrent
      ? ""
      : `${currentVersion} → ${targetVersion}${targetChannel === "prod" ? "" : ` (${targetChannel})`}`,
  );
  let restartService = false;
  if (serviceInstalled && !serviceCurrent) {
    yield* Console.log(
      "  A background service is installed for this Cogenly home. Restarting it interrupts anything running in it: agent turns, terminals, remote clients.",
    );
    if (input.assumeYes) {
      restartService = true;
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      restartService = yield* Prompt.run(
        Prompt.Confirm({
          message: "Restart the background service once the download is verified?",
          initial: true,
        }),
      ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    } else {
      yield* Console.log(
        "  Not a terminal, so the service keeps running its current version. Rerun with --yes to restart it now, or run `cogenly service restart` later.",
      );
    }
  }

  const runtime = yield* ensurePinnedRuntimeInstalled({
    onProgress: progress.report,
    baseDir: input.baseDir,
    version: targetVersion,
    fs,
    path,
    runner,
    httpClient,
    platform,
    arch,
    releaseBaseUrl: environment[CLI_RELEASE_BASE_URL_ENV]?.trim() || undefined,
    validate: validateRuntime,
  }).pipe(
    Effect.ensuring(Effect.sync(progress.finish)),
    Effect.catchIf(
      // Releases before the Linux archives shipped have a SHA256SUMS without them.
      (error): error is PinnedRuntimeInstallError =>
        error._tag === "PinnedRuntimeInstallError" &&
        ((error.step.startsWith(PINNED_RUNTIME_CHECKSUMS_STEP) &&
          String(error.cause).includes("404")) ||
          error.step.startsWith(PINNED_RUNTIME_ARCHIVE_MISSING_STEP)),
      () =>
        Effect.fail(
          new CliUpdateError({
            reason: `No ${platform}-${arch} release archive was published for cogenly@${targetVersion}.`,
          }),
        ),
    ),
  );

  const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  const launcherInput = {
    launchedAs,
    versionsDir: path.dirname(runtime.versionDir),
    targetEntryPath: runtime.entryPath,
  };
  const repointed = yield* repointLauncher(launcherInput);
  const retired = yield* retireLegacyLauncher(launcherInput);

  // The service records a pending candidate, so its launcher backs up the
  // database and rolls back if the trial fails to become ready.
  let serviceUpdated = false;
  if (serviceInstalled && !serviceCurrent) {
    yield* Console.log(
      restartService
        ? "Restarting the background service..."
        : "Updating the background service...",
    );
    yield* BootService.BootService.pipe(
      Effect.flatMap((target) =>
        target.install({
          allowDowngrade: input.allowDowngrade,
          start: restartService,
          trialDatabasePath: dbPath,
        }),
      ),
      Effect.provide(
        BootService.layer({
          baseDir: input.baseDir,
          logsDir: input.logsDir,
          cliVersion: targetVersion,
        }),
      ),
      Effect.mapError(
        (error) =>
          new CliUpdateError({
            reason: `cogenly@${targetVersion} is installed but the background service could not be ${restartService ? "updated" : "pointed at it"}: ${error.message}`,
          }),
      ),
    );
    serviceUpdated = restartService;
  }

  progress.success(`Installed Cogenly ${targetVersion}`);
  for (const launcher of retired) {
    yield* Console.log(`  The t3 command is now cogenly (${launcher}).`);
  }
  if (Option.isSome(repointed) || retired.length > 0) {
    yield* Console.log("  Run cogenly to get started.\n");
  } else {
    yield* Console.log(`  Run ${runtime.entryPath}\n`);
  }
  if (serviceUpdated) {
    yield* Console.log(`  Background service restarted for a trial of ${targetVersion}`);
  } else if (serviceInstalled && serviceCurrent) {
    yield* Console.log(`  Background service already on ${targetVersion}`);
  } else if (serviceInstalled) {
    yield* Console.log(
      `  Background service still running ${serviceVersion ?? "an unknown version"}. Run \`cogenly service restart\` when you are ready to switch it to ${targetVersion}.`,
    );
  } else if (status.installed && !servesThisHome) {
    yield* Console.log(
      `  The background service serves ${status.installedBaseDir ?? "another Cogenly home"} and was left unchanged.`,
    );
  }
  if (foreground !== undefined) {
    yield* Console.log(
      `  A server started by hand is still running at ${foreground.origin} (pid ${foreground.pid}). Stop it and start it again to pick up ${targetVersion}.`,
    );
  }
});
