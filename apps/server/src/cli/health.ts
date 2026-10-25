/**
 * `cogenly health` (and `cogenly doctor --health`): the running server's
 * machine health report, from the same MachineHealth method as the RPC and the
 * `machine_health` MCP tool. Exits non-zero when the report fails.
 */
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  MachineHealthReport,
  WS_METHODS,
} from "@cogenly/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { liveWebSocketUrl, liveWebSocketUrlSource, makeLiveRpcClient } from "./liveServer.ts";

class HealthCliError extends Schema.TaggedError<HealthCliError>()("HealthCliError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const ReportJson = Schema.fromJsonString(Schema.toCodecJson(MachineHealthReport));
const encodeReportJson = Schema.encodeEffect(ReportJson);

/** The process exit code for a report: only an overall `fail` is an error. */
export const healthExitCode = (report: MachineHealthReport): 0 | 1 =>
  report.status === "fail" ? 1 : 0;

/** The human-readable report: a header, then one line per check and its problems. */
export const describeHealthReport = (report: MachineHealthReport): string => {
  const idWidth = Math.max(0, ...report.checks.map((check) => check.id.length));
  return [
    `${report.machineName}: ${report.status} (observed ${DateTime.formatIso(report.observedAt)})`,
    ...(report.reachable
      ? []
      : ["Not reachable: this report is built from what this machine last saw of it."]),
    ...report.checks.flatMap((check) => [
      `${check.status.padEnd(7)}  ${check.id.padEnd(idWidth)}  ${check.summary}`.trimEnd(),
      ...(check.status === "ok"
        ? []
        : check.items.flatMap((item) =>
            item.status === "ok"
              ? []
              : [
                  `  - ${item.title}`,
                  ...(item.detail.trim() === "" ? [] : [`      ${item.detail.trim()}`]),
                ],
          )),
    ]),
  ].join("\n");
};

export const runHealth = (flags: {
  readonly baseDir: Option.Option<string>;
  readonly json: boolean;
  readonly fix?: boolean;
  readonly machine: Option.Option<string>;
  readonly storage?: { readonly fix: boolean; readonly dryRun: boolean };
}) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    const authContext = yield* Layer.build(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    );
    const environmentAuth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
    const recorded = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(recorded)) {
      return yield* new HealthCliError({
        reason: "Cogenly isn't running. Start it, then run this again.",
      });
    }
    const issued = yield* environmentAuth.issueSession({
      scopes:
        flags.fix || flags.storage?.fix || flags.storage?.dryRun
          ? [AuthOrchestrationReadScope, AuthSettingsWriteScope]
          : [AuthOrchestrationReadScope],
      label: "cogenly health cli",
    });
    yield* Effect.addFinalizer(() =>
      environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const first = yield* liveWebSocketUrl(recorded.value.origin, issued.token).pipe(
      Effect.provideContext(authContext),
      Effect.mapError(
        (cause) => new HealthCliError({ reason: "Couldn't reach the running Cogenly.", cause }),
      ),
    );
    const client = yield* makeLiveRpcClient(
      liveWebSocketUrlSource({ origin: recorded.value.origin, token: issued.token, first }).pipe(
        Effect.provideContext(authContext),
      ),
    );
    if (flags.storage !== undefined) {
      const status = yield* client[WS_METHODS.serverGetStorageStatus]({});
      yield* Console.log(
        status.complete ? "Storage usage:" : "Storage measurement incomplete; try again.",
      );
      for (const volume of status.volumes)
        yield* Console.log(
          `  Volume ${volume.path}: ${(volume.usedBytes / 1024 ** 3).toFixed(2)} GiB used, ${(volume.availableBytes / 1024 ** 3).toFixed(2)} GiB available`,
        );
      if (status.databaseBytes !== null)
        yield* Console.log(
          `  Database file: ${(status.databaseBytes / 1024 ** 3).toFixed(2)} GiB. Cleanup keeps conversation history; no compaction is performed.`,
        );
      for (const category of status.categories) {
        yield* Console.log(
          `  ${category.category}: ${category.bytes === null ? "shared blocks; exact size unavailable" : `${(category.bytes / 1024 ** 3).toFixed(2)} GiB`}, ${category.files} files`,
        );
      }
      if (flags.storage.fix || flags.storage.dryRun) {
        const report = yield* client[WS_METHODS.serverRunStorageCleanup]({
          dryRun: !flags.storage.fix || flags.storage.dryRun,
        });
        yield* Console.log(
          `${report.dryRun ? "Dry run" : "Cleanup"}: ${report.counts.removed} ${report.dryRun ? "eligible" : "removed"}, ${report.counts.kept} kept, ${report.counts.failed} failed.`,
        );
        for (const entry of report.entries)
          yield* Console.log(`  ${entry.path ?? entry.kind}: ${entry.reason}`);
      } else
        yield* Console.log(
          "Use --dry-run to preview cleanup, or --fix to run it. Settings → Storage has the same controls.",
        );
      return;
    }
    if (flags.fix) {
      if (Option.isSome(flags.machine))
        return yield* new HealthCliError({
          reason:
            "Run health --fix on the affected machine, or use its Fix action in Settings → Machines.",
        });
      const result = yield* client[WS_METHODS.machineSandboxSetup]({});
      if (!flags.json) yield* Console.log(result.message);
    }
    const report = yield* client[WS_METHODS.machinesHealth](
      Option.match(flags.machine, {
        onNone: () => ({}),
        onSome: (environmentId) => ({ environmentId: EnvironmentId.make(environmentId.trim()) }),
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new HealthCliError({
            reason: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      ),
    );
    yield* Console.log(
      flags.json
        ? yield* encodeReportJson(report).pipe(Effect.orDie)
        : describeHealthReport(report),
    );
    const exitCode = healthExitCode(report);
    if (exitCode !== 0)
      yield* Effect.sync(() => {
        process.exitCode = exitCode;
      });
  }).pipe(Effect.scoped);

export const healthCommand = Command.make("health", {
  ...projectLocationFlags,
  fix: Flag.Boolean("fix").pipe(
    Flag.withDescription("Provision the chat command sandbox using root or passwordless sudo."),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the report as JSON."),
    Flag.withDefault(false),
  ),
  machine: Flag.String("machine").pipe(
    Flag.withDescription("Environment ID of a paired machine to read instead of this one."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Show this machine's health: server, database, disk, providers, machine links, sync, integrations, scheduled tasks and more. Exits 1 when a check fails.",
  ),
  Command.withHandler((flags) => runHealth(flags)),
);
