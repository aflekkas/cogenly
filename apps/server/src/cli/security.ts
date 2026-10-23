/**
 * `cogenly security status`: read-only posture of this machine, from the
 * running server's MachineSecurity service (same method as the RPC and MCP tool).
 */
import {
  AuthOrchestrationReadScope,
  WS_METHODS,
  type MachineSecurityStatus,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
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

class SecurityCliError extends Schema.TaggedError<SecurityCliError>()("SecurityCliError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const describeStatus = (status: MachineSecurityStatus): string =>
  [
    `State: ${status.state} (observed ${String(status.observedAt)})`,
    status.summary,
    `Cogenly bind: ${status.cogenlyBind.host}:${status.cogenlyBind.port}${status.cogenlyBind.loopback ? " (loopback)" : " (NOT loopback)"}`,
    ...status.findings.map(
      (f) => `- [${f.status}] ${f.title}: ${f.detail} [evidence: ${f.evidence}]`,
    ),
  ].join("\n");

const runStatus = (flags: { readonly baseDir: Option.Option<string>; readonly json: boolean }) =>
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
      return yield* new SecurityCliError({
        reason: "Cogenly isn't running. Start it, then run this again.",
      });
    }
    const issued = yield* environmentAuth.issueSession({
      scopes: [AuthOrchestrationReadScope],
      label: "cogenly security cli",
    });
    yield* Effect.addFinalizer(() =>
      environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const first = yield* liveWebSocketUrl(recorded.value.origin, issued.token).pipe(
      Effect.provideContext(authContext),
      Effect.mapError(
        (cause) => new SecurityCliError({ reason: "Couldn't reach the running Cogenly.", cause }),
      ),
    );
    const client = yield* makeLiveRpcClient(
      liveWebSocketUrlSource({ origin: recorded.value.origin, token: issued.token, first }).pipe(
        Effect.provideContext(authContext),
      ),
    );
    const status = yield* client[WS_METHODS.machineSecurityStatus]({}).pipe(
      Effect.mapError(
        (cause) =>
          new SecurityCliError({
            reason: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      ),
    );
    yield* Console.log(
      flags.json
        ? yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(status).pipe(
            Effect.orDie,
          )
        : describeStatus(status),
    );
  }).pipe(Effect.scoped);

const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the result as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Show this machine's read-only security posture."),
  Command.withHandler((flags) => runStatus(flags)),
);

export const securityCommand = Command.make("security").pipe(
  Command.withDescription("Machine security checks."),
  Command.withSubcommands([statusCommand]),
);
