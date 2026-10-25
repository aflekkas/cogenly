/**
 * `cogenly health` (and `cogenly doctor --health`): the running server's
 * machine health report, from the same MachineHealth method as the RPC and the
 * `machine_health` MCP tool. Exits non-zero when the report fails.
 */
import {
  AuthOrchestrationReadScope,
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
  readonly machine: Option.Option<string>;
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
      scopes: [AuthOrchestrationReadScope],
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
