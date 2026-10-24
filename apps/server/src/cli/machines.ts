/**
 * `cogenly machines`: pair Cogenly servers from a terminal, for headless
 * machines and when no app is signed in to both. The app brokers pairing
 * itself; this is the fallback. On the hub, `pair` prints a one-time join
 * code bound to the prepared spoke key; `join <hub-url>` privately reads it and makes the server
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
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type MachineInfo,
  MachineJoinCode,
  MachineRole,
  type MachineListResult,
  ThreadId,
  type ThreadMoveResult,
  type MachineSetupStatus,
  MachineSetupStepId,
  WS_METHODS,
} from "@cogenly/contracts";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { liveWebSocketUrl, liveWebSocketUrlSource, makeLiveRpcClient } from "./liveServer.ts";

/** Read machines, pair or unpair them (access management), and move threads between them. */
const MACHINES_CLI_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
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
      () =>
        new MachinesCliError({
          reason:
            "That join code is not valid. Copy the whole code `cogenly machines pair` printed.",
        }),
    ),
  );

/** Keep pairing secrets out of argv, history, and terminal echo. */
export const readMachineJoinCode = (codeStdin: boolean) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    if (!codeStdin && !(yield* stdio.stdinIsTerminal)) {
      return yield* new MachinesCliError({
        reason: "Use --code-stdin to read a join code from a pipe.",
      });
    }
    const text = codeStdin
      ? yield* stdio.stdin.pipe(
          Stream.decodeText(),
          Stream.runFoldEffect(
            () => "",
            (text, chunk) =>
              text.length + chunk.length > 16_384
                ? Effect.fail(new MachinesCliError({ reason: "That join code is too long." }))
                : Effect.succeed(text + chunk),
          ),
          Effect.mapError(
            () => new MachinesCliError({ reason: "Could not read the join code from stdin." }),
          ),
        )
      : Redacted.value(
          yield* Prompt.run(Prompt.Hidden({ message: "Join code" })).pipe(
            Effect.mapError(() => new MachinesCliError({ reason: "Join canceled." })),
          ),
        );
    return yield* decodeJoinCode(text);
  });

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

/**
 * The hub command `prepare` prints. Fingerprints are base64url and can start
 * with `-`, which a separate argument would parse as a flag, so join with `=`.
 */
export const pairCommandHint = (keyThumbprint: string) =>
  `cogenly machines pair --spoke-key=${keyThumbprint}`;

const prepareCommand = Command.make("prepare", { ...projectLocationFlags }).pipe(
  Command.withDescription("On the joining machine: prepare the key the hub will bind its code to."),
  Command.withHandler((flags) =>
    runLive(flags, (client) =>
      Effect.gen(function* () {
        const identity = yield* client[WS_METHODS.machinesPrepareJoin]({}).pipe(
          Effect.mapError(describe),
        );
        yield* Console.log(
          [
            `Prepared ${identity.name} (${identity.environmentId}).`,
            `Spoke key fingerprint: ${identity.keyThumbprint}`,
            "On the hub, run:",
            `  ${pairCommandHint(identity.keyThumbprint)}`,
          ].join("\n"),
        );
      }),
    ),
  ),
);

const pairCommand = Command.make("pair", {
  ...projectLocationFlags,
  spokeKey: Flag.String("spoke-key").pipe(
    Flag.withDescription("The intended joining machine's fingerprint from machines prepare."),
  ),
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
        const code = yield* client[WS_METHODS.machinesCreatePeerGrant]({
          spokeKeyThumbprint: flags.spokeKey,
          ...(Option.isSome(flags.name) ? { spokeName: flags.name.value } : {}),
        }).pipe(Effect.mapError(describe));
        const encoded = yield* encodeJoinCode(code).pipe(Effect.orDie);
        const hubUrl = code.routes[0] ?? "<this server's URL>";
        yield* Console.log(
          [
            `Join code for ${code.hubName} (one use, expires ${code.expiresAt.toString()}):`,
            "",
            encoded,
            "",
            "On the other machine, with Cogenly running, run:",
            `  cogenly machines join ${hubUrl}`,
            "Paste the code into the hidden prompt, or provide it on stdin with --code-stdin.",
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
  codeStdin: Flag.Boolean("code-stdin").pipe(
    Flag.withDescription("Read the join code from stdin instead of a hidden prompt."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Pair this machine with a hub, using a join code from the hub."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const code = yield* readMachineJoinCode(flags.codeStdin);
      return yield* runLive(flags, (client) =>
        Effect.gen(function* () {
          const result = yield* client[WS_METHODS.machinesJoinHub]({
            hubUrls: [flags.hubUrl],
            code,
          }).pipe(Effect.mapError(describe));
          yield* Console.log(`Paired with ${code.hubName}.\n${describeMachines(result)}`);
        }),
      );
    }),
  ),
);

const STEP_MARKS: Record<MachineSetupStatus["steps"][number]["state"], string> = {
  done: "✓",
  todo: "·",
  working: "…",
  waiting: "…",
  blocked: " ",
};

/** The setup checklist, with the exact thing to do next for each open step. */
export const describeSetup = (status: MachineSetupStatus) => {
  const lines = status.steps.flatMap((step) => [
    `${STEP_MARKS[step.state]} ${step.title}: ${step.detail}`,
    ...(step.action === null || step.state === "working" || step.state === "waiting"
      ? []
      : [`    Run: cogenly machines setup ${step.id}`]),
    ...(step.handoff === null
      ? []
      : step.handoff._tag === "open-url"
        ? [`    Open: ${step.handoff.url}`]
        : [`    ${step.handoff.reason}`, `      ${step.handoff.command}`]),
  ]);
  return [
    status.ready
      ? `Ready to pair. Other machines reach this one at ${status.joinUrl ?? "its tailnet address"}.`
      : "Getting this machine ready to pair:",
    ...lines,
    ...(status.problem === null ? [] : ["", status.problem]),
  ].join("\n");
};

const setupCommand = Command.make("setup", {
  ...projectLocationFlags,
  step: Argument.Literals("step", MachineSetupStepId.literals).pipe(
    Argument.withDescription("A step to run now. Omit it to see the checklist."),
    Argument.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Get this machine ready to pair: install and sign in to Tailscale, and put this Cogenly on your private tailnet.",
  ),
  Command.withHandler((flags) =>
    runLive(flags, (client) =>
      (Option.isSome(flags.step)
        ? client[WS_METHODS.machinesSetupRunStep]({ step: flags.step.value })
        : client[WS_METHODS.machinesSetupStatus]({})
      ).pipe(
        Effect.mapError(describe),
        Effect.flatMap((status) =>
          flags.json
            ? encodeJson(status).pipe(Effect.orDie)
            : Effect.succeed(describeSetup(status)),
        ),
        Effect.flatMap(Console.log),
      ),
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

/** A machine by name or environment id; `allowThis` also matches this machine. */
const findMachine = (machines: ReadonlyArray<MachineInfo>, wanted: string, allowThis: boolean) => {
  const trimmed = wanted.trim();
  const matches = machines.filter(
    (machine) =>
      (allowThis || machine.relation !== "this") &&
      (machine.environmentId === trimmed || machine.name.toLowerCase() === trimmed.toLowerCase()),
  );
  const match = matches[0];
  return match !== undefined && matches.length === 1
    ? Effect.succeed(match)
    : Effect.fail(
        new MachinesCliError({
          reason:
            matches.length > 1
              ? `More than one machine is named "${trimmed}". Use its environment id.`
              : `No ${allowThis ? "" : "paired "}machine matches "${trimmed}". Run \`cogenly machines list\`.`,
        }),
      );
};

/** At most this many skipped threads are listed; --json has them all. */
const SKIPS_SHOWN = 20;

const describeMove = (target: string, result: ThreadMoveResult) =>
  [
    `${result.moved.length} ${result.moved.length === 1 ? "thread runs" : "threads run"} on ${target} now.`,
    ...(result.skipped.length === 0
      ? []
      : [
          `Skipped ${result.skipped.length}; moving them again retries:`,
          ...result.skipped
            .slice(0, SKIPS_SHOWN)
            .map((skip) => `  ${skip.threadId}: ${skip.detail}`),
          ...(result.skipped.length > SKIPS_SHOWN
            ? [`  …and ${result.skipped.length - SKIPS_SHOWN} more (use --json).`]
            : []),
        ]),
  ].join("\n");

const moveCommand = Command.make("move", {
  ...projectLocationFlags,
  to: Flag.String("to").pipe(
    Flag.withDescription(
      "The paired machine that runs them from now on: its name or environment id.",
    ),
  ),
  from: Flag.String("from").pipe(
    Flag.withDescription("Move every thread this machine runs (a name, an id, or this machine's)."),
    Flag.optional,
  ),
  project: Flag.String("project").pipe(
    Flag.withDescription(
      "Move a project: clone its repositories on the target, then move its threads and agents.",
    ),
    Flag.optional,
  ),
  threads: Flag.String("threads").pipe(
    Flag.withDescription("Comma-separated thread ids to move."),
    Flag.optional,
  ),
  leaveLocalChanges: Flag.Boolean("leave-local-changes").pipe(
    Flag.withDescription(
      "Also move Work with uncommitted or unpushed changes; those changes stay on the old machine.",
    ),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Move threads, a project, or everything one machine runs to another paired machine. Every machine keeps showing them; the target runs them.",
  ),
  Command.withHandler((flags) =>
    runLive(flags, (client) =>
      Effect.gen(function* () {
        const chosen = [flags.from, flags.project, flags.threads].filter(Option.isSome).length;
        if (chosen !== 1)
          return yield* new MachinesCliError({
            reason: "Choose what to move: --from <machine>, --project <name> or --threads <ids>.",
          });
        const { machines } = yield* client[WS_METHODS.machinesList]({}).pipe(
          Effect.mapError(describe),
        );
        const target = yield* findMachine(machines, flags.to, false);
        const options = flags.leaveLocalChanges ? { leaveLocalChanges: true } : {};
        const print = (result: unknown, text: string) =>
          (flags.json ? encodeJson(result).pipe(Effect.orDie) : Effect.succeed(text)).pipe(
            Effect.flatMap(Console.log),
          );
        if (Option.isSome(flags.project)) {
          const named = flags.project.value.trim();
          const { labels } = yield* client[WS_METHODS.projectLabelsList]({}).pipe(
            Effect.mapError(describe),
          );
          const label = labels.find(
            (candidate) =>
              candidate.id === named || candidate.name.toLowerCase() === named.toLowerCase(),
          );
          if (label === undefined)
            return yield* new MachinesCliError({ reason: `No project is named "${named}".` });
          const result = yield* client[WS_METHODS.projectLabelsMoveToMachine]({
            id: label.id,
            target: target.environmentId,
            ...options,
          }).pipe(Effect.mapError(describe));
          return yield* print(
            result,
            [
              ...result.repositories.map(
                (repository) =>
                  `${repository.remote}: ${repository.status}${repository.detail ? ` (${repository.detail})` : ""}`,
              ),
              describeMove(target.name, result.threads),
            ].join("\n"),
          );
        }
        const result = Option.isSome(flags.from)
          ? yield* client[WS_METHODS.machinesMoveAllThreads]({
              from: (yield* findMachine(machines, flags.from.value, true)).environmentId,
              target: target.environmentId,
              ...options,
            }).pipe(Effect.mapError(describe))
          : yield* client[WS_METHODS.machinesMoveThreads]({
              threadIds: Option.getOrElse(flags.threads, () => "")
                .split(",")
                .map((id) => ThreadId.make(id.trim()))
                .filter((id) => id.length > 0),
              target: target.environmentId,
              ...options,
            }).pipe(Effect.mapError(describe));
        return yield* print(result, describeMove(target.name, result));
      }),
    ),
  ),
);

export const machinesCommand = Command.make("machines").pipe(
  Command.withDescription("Pair this Cogenly with your other machines."),
  Command.withSubcommands([
    listCommand,
    setupCommand,
    prepareCommand,
    pairCommand,
    joinCommand,
    unpairCommand,
    renameCommand,
    moveCommand,
  ]),
);
