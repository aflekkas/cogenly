import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Terminal from "effect/Terminal";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { FetchHttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import type * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { isValidTimeZone, normalizeTimeZoneSetting } from "../scheduling/serverTimeZone.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const layer = (config: ServerConfig.ServerConfig["Service"]) =>
  BootService.layer({
    baseDir: config.baseDir,
    logsDir: config.logsDir,
    cliVersion: packageJson.version,
  }).pipe(
    Layer.provide(ProcessRunner.layer),
    // Archive-distributed versions download the release archive here.
    Layer.provide(FetchHttpClient.layer),
  );

export type ServiceReconcileResult =
  | {
      readonly changed: false;
      readonly status: BootService.BootServiceStatus;
    }
  | {
      readonly changed: true;
      readonly previouslyInstalled: boolean;
      readonly plan: BootService.BootServicePlan;
    };

/** Install, update, or repair the service using the CLI version running this command. */
export const reconcileService = Effect.fn("cli.service.reconcile")(function* (options?: {
  readonly allowDowngrade?: boolean;
  readonly start?: boolean;
  readonly timeZone?: string;
}) {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  if (status.installed && status.current) {
    return { changed: false, status } satisfies ServiceReconcileResult;
  }
  if (
    status.installedVersion !== undefined &&
    options?.allowDowngrade !== true &&
    compareExactServiceVersions(packageJson.version, status.installedVersion) < 0
  ) {
    return yield* new BootService.BootServiceDowngradeRefusedError({
      installedVersion: status.installedVersion,
      targetVersion: packageJson.version,
    });
  }
  const plan = yield* service.install(options);
  return {
    changed: true,
    previouslyInstalled: status.installed,
    plan,
  } satisfies ServiceReconcileResult;
});

export function formatServiceStatus(
  status: BootService.BootServiceStatus,
  cliVersion: string,
): string {
  if (!status.supported) {
    return "Cogenly service\n  Status: unavailable on this machine\n  Supported on: Linux with systemd, macOS with launchd";
  }
  if (!status.installed) {
    return "Cogenly service\n  Status: not installed\n  Next: Run `cogenly service install`.";
  }
  const installedVersion = status.installedVersion ?? cliVersion;
  const problems = (status.problems ?? []).map(
    (problem) => `  [${problem}] ${BootService.formatBootServiceProblem(problem)}`,
  );
  if (
    !status.current &&
    status.installedVersion !== undefined &&
    compareExactServiceVersions(status.installedVersion, cliVersion) > 0
  ) {
    return [
      "Cogenly service",
      `  Status: installed · t3@${installedVersion} (newer than this t3@${cliVersion} CLI)`,
      `  Unit: ${status.unitPath}`,
      `  Logs: ${status.logPath}`,
      ...problems,
      `  Next: Run \`cogenly update ${installedVersion}\` to match it, or pass \`--allow-downgrade\` to \`cogenly service install\` explicitly.`,
    ].join("\n");
  }
  return [
    "Cogenly service",
    `  Status: ${status.current ? `installed · t3@${installedVersion}` : "needs an update or repair"}`,
    `  Unit: ${status.unitPath}`,
    `  Logs: ${status.logPath}`,
    ...problems,
    ...(status.current ? [] : ["  Next: Run `cogenly service install` to repair it."]),
  ].join("\n");
}

const runServiceCommand = Effect.fn("cli.service.run")(function* <A, E>(
  flags: { readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]["baseDir"] },
  run: Effect.Effect<A, E, BootService.BootService | FileSystem.FileSystem>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* run.pipe(Effect.provide(layer(config)));
});

const serviceReconcileFlags = {
  ...projectLocationFlags,
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow replacing a newer installed service with this older CLI version."),
    Flag.withDefault(false),
  ),
};

const serviceInstallFlags = {
  ...serviceReconcileFlags,
  print: Flag.Boolean("print").pipe(
    Flag.withDescription("Print the service unit or plist without installing it."),
    Flag.withDefault(false),
  ),
  format: Flag.String("format").pipe(
    Flag.withDescription(
      'With --print: render "systemd" or "launchd" instead of this host\'s service manager.',
    ),
    Flag.optional,
  ),
  tz: Flag.String("tz").pipe(
    Flag.withDescription(
      "Bake COGENLY_TZ into the unit so fixed-time schedules run in a defined zone. Without it the install shell's COGENLY_TZ is used when set.",
    ),
    Flag.optional,
  ),
};

const serviceInstallCommand = Command.make("install", serviceInstallFlags).pipe(
  Command.withDescription("Install Cogenly as a background service for this user."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const format = Option.getOrUndefined(flags.format);
        if (format !== undefined && format !== "systemd" && format !== "launchd") {
          return yield* new CliError.UserError({
            cause: `Invalid --format "${format}": expected "systemd" or "launchd".`,
          });
        }
        const timeZone = normalizeTimeZoneSetting(Option.getOrUndefined(flags.tz));
        if (timeZone !== undefined && !isValidTimeZone(timeZone)) {
          return yield* new CliError.UserError({
            cause: `Invalid --tz "${timeZone}": expected an IANA time zone name such as "America/New_York" or "UTC".`,
          });
        }
        if (flags.print) {
          const service = yield* BootService.BootService;
          const rendered = yield* service.print({
            ...(format === undefined ? {} : { target: format }),
            ...(timeZone === undefined ? {} : { timeZone }),
          });
          yield* Console.log(rendered.contents.trimEnd());
          return;
        }
        const result = yield* reconcileService({
          allowDowngrade: flags.allowDowngrade,
          ...(timeZone === undefined ? {} : { timeZone }),
        });
        if (!result.changed) {
          yield* Console.log(
            `Cogenly service is already installed with t3@${packageJson.version}.`,
          );
          return;
        }
        yield* Console.log(
          `${result.previouslyInstalled ? "Updated" : "Installed"} Cogenly service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
        );
      }),
    ),
  ),
);

// Kept one release for muscle memory and old docs. It did what `t3 service
// install` does; the way to move to a newer release is `t3 update`.
const serviceUpdateCommand = Command.make("update", serviceReconcileFlags).pipe(
  Command.withDescription("Deprecated. Run `cogenly update` to move to a newer release."),
  Command.unlisted,
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log(
          "`cogenly service update` is deprecated: run `cogenly update` to move to a newer release, or `cogenly service install` to repair the service. Repairing now.",
        );
        const result = yield* reconcileService({ allowDowngrade: flags.allowDowngrade });
        if (!result.changed) {
          yield* Console.log(`Cogenly service is already using t3@${packageJson.version}.`);
          return;
        }
        yield* Console.log(
          `${result.previouslyInstalled ? "Updated" : "Installed"} Cogenly service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
        );
      }),
    ),
  ),
);

const serviceRestartCommand = Command.make("restart", projectLocationFlags).pipe(
  Command.withDescription(
    "Restart the background service. Picks up a version installed by `cogenly update` that was not restarted at the time.",
  ),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const status = yield* service.status;
        const restarted = yield* service.restart;
        yield* Console.log(
          restarted
            ? `Restarted the Cogenly service${status.installedVersion === undefined ? "" : ` on t3@${status.installedVersion}`}.`
            : "Cogenly service is not installed.",
        );
      }),
    ),
  ),
);

const serviceUninstallCommand = Command.make("uninstall", projectLocationFlags).pipe(
  Command.withDescription("Stop and remove the Cogenly background service."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const removed = yield* service.uninstall;
        yield* Console.log(
          removed ? "Removed the Cogenly service." : "Cogenly service is not installed.",
        );
      }),
    ),
  ),
);

const serviceStatusCommand = Command.make("status", projectLocationFlags).pipe(
  Command.withDescription("Show whether the Cogenly background service is installed."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        yield* Console.log(formatServiceStatus(yield* service.status, packageJson.version));
      }),
    ),
  ),
);

/** Last `maxLines` lines of `text`, without a trailing newline. */
export function tailLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return "";
  const lines = text.split("\n");
  // A trailing newline terminates the last line; it is not an empty line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines).join("\n");
}

const serviceLogsCommand = Command.make("logs", {
  ...projectLocationFlags,
  lines: Flag.Int("lines").pipe(
    Flag.withDescription("How many trailing log lines to print."),
    Flag.withDefault(200),
  ),
}).pipe(
  Command.withDescription("Print the tail of the background service log."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        if (flags.lines < 1) {
          return yield* new CliError.UserError({
            cause: `Invalid --lines "${flags.lines}": expected at least 1.`,
          });
        }
        const service = yield* BootService.BootService;
        const status = yield* service.status;
        if (!status.supported) {
          yield* Console.log("The Cogenly background service is unavailable on this machine.");
          return;
        }
        if (!status.installed) {
          yield* Console.log("Cogenly service is not installed.");
          return;
        }
        const fs = yield* FileSystem.FileSystem;
        if (!(yield* fs.exists(status.logPath))) {
          yield* Console.log(`No log file yet at ${status.logPath}.`);
          return;
        }
        const tail = tailLines(yield* fs.readFileString(status.logPath), flags.lines);
        yield* Console.log(tail.length > 0 ? tail : "(log is empty)");
      }),
    ),
  ),
);

export const offerServiceDuringOnboarding = Effect.gen(function* () {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const { supported, installed, current } = status;
  if (!supported) {
    return false;
  }
  if (installed && current) {
    yield* Console.log("Cogenly is already set up to run in the background on this machine.");
    return true;
  }
  for (const problem of status.problems ?? []) {
    yield* Console.warn(`[${problem}] ${BootService.formatBootServiceProblem(problem)}`);
  }
  if (
    installed &&
    status.installedVersion !== undefined &&
    compareExactServiceVersions(status.installedVersion, packageJson.version) > 0
  ) {
    yield* Console.log(
      `A newer t3@${status.installedVersion} background service is installed. Leaving it unchanged.`,
    );
    // This CLI cannot verify the newer service. Keep the manual fallback available.
    return false;
  }
  // A LaunchAgent starts at login and dies at logout; there is no
  // enable-linger equivalent on macOS. Do not promise more than that.
  const platform = yield* HostProcess.Platform;
  const wanted = yield* Prompt.run(
    Prompt.Confirm({
      message: installed
        ? "The installed Cogenly service needs an update or repair. Update it now?"
        : platform === "darwin"
          ? "Run Cogenly in the background whenever you log in to this Mac? " +
            "It stays reachable through Cogenly Connect while you are logged in."
          : "Run Cogenly in the background whenever this machine boots? " +
            "It stays reachable through Cogenly Connect even after you log out.",
      initial: true,
    }),
  );
  if (!wanted) {
    return false;
  }
  const result = yield* reconcileService();
  if (result.changed) {
    yield* Console.log(
      `Background service ${result.previouslyInstalled ? "updated" : "installed"}. Logs: ${result.plan.logPath}`,
    );
  }
  return true;
});

export const recoverServiceOnboardingOffer = <R>(
  offer: Effect.Effect<boolean, BootService.BootServiceError | Terminal.QuitError, R>,
) =>
  offer.pipe(
    Effect.catchTags({
      QuitError: () => Effect.succeed(false),
      BootServiceUnsupportedError: (error) =>
        Console.log(`Skipping background setup: ${error.message}`).pipe(Effect.as(false)),
      BootServiceCommandError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceInstallError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServicePrerequisiteError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceUpdatePendingError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceDowngradeRefusedError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
    }),
  );

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the Cogenly background service."),
  Command.withSubcommands([
    serviceInstallCommand,
    serviceRestartCommand,
    serviceUninstallCommand,
    serviceStatusCommand,
    serviceLogsCommand,
    serviceUpdateCommand,
  ]),
);
