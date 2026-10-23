/**
 * `cogenly machines`: pair Cogenly servers from a terminal, for headless
 * machines and when no app is signed in to both. The app brokers pairing
 * itself; this is the fallback. On the hub, `pair` prints a one-time join
 * code; on the other machine, `join <hub-url> <code>` makes that server
 * redeem it and start dialing the hub.
 *
 * Every subcommand is a thin transport over the `machines.*` RPCs on the
 * running server (see `liveServer.ts`), with a short-lived session limited
 * to `MACHINES_CLI_SCOPES`. There is no offline path: the server owns the link.
 *
 * @module cli/machines
 */
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type MachineInfo,
  MachineRole,
  MachineJoinCode,
  type MachineListResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { liveWebSocketUrl, liveWebSocketUrlSource, makeLiveRpcClient } from "./liveServer.ts";

/** Read machines, rename this one, and pair or unpair them: pairing is access management. */
const MACHINES_CLI_SCOPES = [
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthAccessWriteScope,
] as const;

class MachinesCliError extends Schema.TaggedError<MachinesCliError>()("MachinesCliError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const JOIN_CODE_PREFIX = "cogenly-join:";
const JoinCodeJson = Schema.fromJsonString(Schema.toCodecJson(MachineJoinCode));
const encodeJoinCodeJson = Schema.encodeEffect(JoinCodeJson);
const decodeJoinCodeJson = Schema.decodeEffect(JoinCodeJson);

/** One copyable token: the grant plus the hub identity the joiner pins. */
export const encodeJoinCode = (code: MachineJoinCode) =>
  encodeJoinCodeJson(code).pipe(
    Effect.map((json) => `${JOIN_CODE_PREFIX}${Base64Url.encode(json)}`),
  );

export const decodeJoinCode = (text: string) =>
  Effect.gen(function* () {
    const trimmed = text.trim();
    const body = trimmed.startsWith(JOIN_CODE_PREFIX)
      ? trimmed.slice(JOIN_CODE_PREFIX.length)
      : trimmed;
    const json = Base64Url.decodeString(body);
    if (Result.isFailure(json)) return yield* Effect.fail(json.failure);
    return yield* decodeJoinCodeJson(json.success);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new MachinesCliError({
          reason:
            "That join code is not valid. Copy the whole code `cogenly machines pair` printed.",
          cause,
        }),
    ),
  );

const describe = (cause: unknown): MachinesCliError => {
  const tagged =
    typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : undefined;
  if (tagged === "EnvironmentAuthorizationError") {
    return new MachinesCliError({
      reason: "This session isn't allowed to pair machines on that Cogenly.",
      cause,
    });
  }
  if (tagged === "RpcClientError") {
    return new MachinesCliError({ reason: "Lost the connection to Cogenly.", cause });
  }
  return new MachinesCliError({
    reason: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
};

const KIND_LABELS: Record<MachineInfo["kind"], string> = {
  "this-computer": "This computer",
  "cloud-server": "Cloud server",
  "other-computer": "Another computer",
};

const describeMachines = (result: MachineListResult) => {
  const link =
    result.link._tag === "standalone"
      ? "Not paired with other machines."
      : result.link._tag === "hub"
        ? `Hub for ${result.link.spokes} ${result.link.spokes === 1 ? "machine" : "machines"}.`
        : `Paired with a hub: ${result.link.status}${result.link.lastError ? ` (${result.link.lastError})` : ""}.`;
  const rows = result.machines.map(
    (machine) =>
      `${machine.relation === "this" ? "*" : " "} ${machine.name} · ${KIND_LABELS[machine.kind]} · ${machine.online ? "online" : "offline"}${machine.pairing === "revoked" ? " · unpaired by the other side" : ""}  ${machine.environmentId}`,
  );
  return [link, ...rows].join("\n");
};

/** Connect to the running server for the life of the surrounding scope. */
const openLiveClient = Effect.fn("cli.machines.open")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
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
    return yield* new MachinesCliError({
      reason: "Cogenly isn't running. Start it, then run this again; the server owns the link.",
    });
  }
  const origin = recorded.value.origin;
  const issued = yield* environmentAuth.issueSession({
    scopes: [...MACHINES_CLI_SCOPES],
    label: "cogenly machines cli",
  });
  yield* Effect.addFinalizer(() =>
    environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );
  const first = yield* liveWebSocketUrl(origin, issued.token).pipe(
    Effect.provideContext(authContext),
    Effect.mapError(
      (cause) =>
        new MachinesCliError({
          reason: `Couldn't reach the running Cogenly at ${origin}. Start it, then run this again.`,
          cause,
        }),
    ),
  );
  return yield* makeLiveRpcClient(
    liveWebSocketUrlSource({ origin, token: issued.token, first }).pipe(
      Effect.provideContext(authContext),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the result as JSON."),
  Flag.withDefault(false),
);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const runLive = <A>(
  flags: { readonly baseDir: Option.Option<string> },
  run: (
    client: Effect.Success<ReturnType<typeof openLiveClient>>,
  ) => Effect.Effect<A, MachinesCliError>,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    return yield* run(yield* openLiveClient(config));
  }).pipe(Effect.scoped);

const listCommand = Command.make("list", { ...projectLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List this machine, its hub, and the machines paired with it."),
  Command.withHandler((flags) =>
    runLive(flags, (client) =>
      client[WS_METHODS.machinesList]({}).pipe(
        Effect.mapError(describe),
        Effect.flatMap((result) =>
          flags.json
            ? encodeJson(result).pipe(Effect.orDie)
            : Effect.succeed(describeMachines(result)),
        ),
        Effect.flatMap(Console.log),
      ),
    ),
  ),
);

const pairCommand = Command.make("pair", {
  ...projectLocationFlags,
  name: Flag.String("name").pipe(
    Flag.withDescription("What to call the machine that will join, in the pairing list."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "On the hub (the always-on machine): print a one-time code another machine joins with. It expires in 10 minutes.",
  ),
  Command.withHandler((flags) =>
    runLive(flags, (client) =>
      Effect.gen(function* () {
        const code = yield* client[WS_METHODS.machinesCreatePeerGrant](
          Option.isSome(flags.name) ? { spokeName: flags.name.value } : {},
        ).pipe(Effect.mapError(describe));
        const encoded = yield* encodeJoinCode(code).pipe(Effect.orDie);
        const hubUrl = code.routes[0] ?? "<this server's URL>";
        yield* Console.log(
          [
            `Join code for ${code.hubName} (one use, expires ${code.expiresAt.toString()}):`,
            "",
            encoded,
            "",
            "On the other machine, with Cogenly running, run:",
            `  cogenly machines join ${hubUrl} ${encoded}`,
            ...(code.routes.length > 1
              ? ["", `This server also answers on: ${code.routes.slice(1).join(", ")}`]
              : []),
          ].join("\n"),
        );
      }),
    ),
  ),
);

const joinCommand = Command.make("join", {
  ...projectLocationFlags,
  hubUrl: Argument.String("hub-url").pipe(
    Argument.withDescription(
      "An address this machine reaches the hub on, such as its tailnet URL.",
    ),
  ),
  code: Argument.String("code").pipe(
    Argument.withDescription("The join code `cogenly machines pair` printed on the hub."),
  ),
}).pipe(
  Command.withDescription("Pair this machine with a hub, using a join code from the hub."),
  Command.withHandler((flags) =>
    runLive(flags, (client) =>
      Effect.gen(function* () {
        const code = yield* decodeJoinCode(flags.code);
        const result = yield* client[WS_METHODS.machinesJoinHub]({
          hubUrls: [flags.hubUrl],
          code,
        }).pipe(Effect.mapError(describe));
        yield* Console.log(`Paired with ${code.hubName}.\n${describeMachines(result)}`);
      }),
    ),
  ),
);

const unpairCommand = Command.make("unpair", {
  ...projectLocationFlags,
  machine: Argument.String("machine").pipe(
    Argument.withDescription("The machine's name or environment id, from `cogenly machines list`."),
  ),
}).pipe(
  Command.withDescription("Unpair a machine: its credential stops working on both sides."),
  Command.withHandler((flags) =>
    runLive(flags, (client) =>
      Effect.gen(function* () {
        const { machines } = yield* client[WS_METHODS.machinesList]({}).pipe(
          Effect.mapError(describe),
        );
        const wanted = flags.machine.trim();
        const matches = machines.filter(
          (machine) =>
            machine.relation !== "this" &&
            (machine.environmentId === wanted ||
              machine.name.toLowerCase() === wanted.toLowerCase()),
        );
        const target = matches[0];
        if (target === undefined || matches.length > 1) {
          return yield* new MachinesCliError({
            reason:
              matches.length > 1
                ? `More than one machine is named "${wanted}". Use its environment id.`
                : `No paired machine matches "${wanted}". Run \`cogenly machines list\`.`,
          });
        }
        const { unpaired } = yield* client[WS_METHODS.machinesUnpair]({
          environmentId: target.environmentId,
        }).pipe(Effect.mapError(describe));
        yield* Console.log(
          unpaired
            ? `Unpaired ${target.name}.`
            : `${target.name} was not paired with this machine.`,
        );
      }),
    ),
  ),
);

const renameCommand = Command.make("rename", {
  ...projectLocationFlags,
  name: Argument.String("name").pipe(
    Argument.withDescription(
      "The name other machines show for this one. Use `--reset` to go back.",
    ),
    Argument.optional,
  ),
  kind: Flag.Literals("kind", MachineRole.literals).pipe(
    Flag.withDescription("Override the detected kind: computer or cloud-server."),
    Flag.optional,
  ),
  reset: Flag.Boolean("reset").pipe(
    Flag.withDescription("Use the detected name and kind again."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Rename this machine or correct its kind."),
  Command.withHandler((flags) =>
    runLive(flags, (client) =>
      client[WS_METHODS.machinesUpdate](
        flags.reset
          ? { name: null, role: null }
          : {
              ...(Option.isSome(flags.name) ? { name: flags.name.value } : {}),
              ...(Option.isSome(flags.kind) ? { role: flags.kind.value } : {}),
            },
      ).pipe(Effect.mapError(describe), Effect.map(describeMachines), Effect.flatMap(Console.log)),
    ),
  ),
);

export const machinesCommand = Command.make("machines").pipe(
  Command.withDescription("Pair this Cogenly with your other machines."),
  Command.withSubcommands([listCommand, pairCommand, joinCommand, unpairCommand, renameCommand]),
);
