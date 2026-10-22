import * as NodeOS from "node:os";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationErrorCode,
  type DesktopAppActivationPlatform,
  type DesktopAppActivationRequest,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

import { sendDesktopAppRequest } from "../environment/DesktopAppControl.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

export class DesktopAppSshUnsupportedError extends Schema.TaggedError<DesktopAppSshUnsupportedError>()(
  "DesktopAppSshUnsupportedError",
  { command: Schema.String },
) {
  override get message(): string {
    return `\`${this.command}\` only controls a desktop app on the same machine. It cannot run over SSH.`;
  }
}

export class DesktopAppPlatformUnsupportedError extends Schema.TaggedError<DesktopAppPlatformUnsupportedError>()(
  "DesktopAppPlatformUnsupportedError",
  { command: Schema.String, platform: Schema.String },
) {
  override get message(): string {
    return `\`${this.command}\` is not supported on ${this.platform}.`;
  }
}

export class DesktopAppUnreachableError extends Schema.TaggedError<DesktopAppUnreachableError>()(
  "DesktopAppUnreachableError",
  {
    candidateAddresses: Schema.Array(Schema.String),
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not reach the Cogenly desktop app. Start or update the desktop app on this machine, then run `cogenly app` again. A running Cogenly server is not enough.";
  }
}

export class DesktopAppRequestFailedError extends Schema.TaggedError<DesktopAppRequestFailedError>()(
  "DesktopAppRequestFailedError",
  {
    code: DesktopAppActivationErrorCode,
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cogenly could not open ${this.workspaceRoot} (${this.code}).`;
  }
}

function isDesktopPlatform(platform: NodeJS.Platform): platform is DesktopAppActivationPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

const appEnvironment = Config.all({
  t3Home: Config.String("COGENLY_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  sshConnection: Config.String("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.String("SSH_TTY").pipe(Config.option),
});

/**
 * The control addresses of the desktop app on this machine for a `--base-dir` (default: the
 * Cogenly home, with the dev build's as a fallback). Refuses SSH sessions, where the desktop
 * app is on another machine.
 */
export const resolveLocalDesktopApp = Effect.fn("cli.app.resolveLocalDesktopApp")(function* (
  baseDirFlag: Option.Option<string>,
  command: string,
) {
  const environment = yield* appEnvironment;
  const hostPlatform = yield* HostProcess.Platform;
  if (Option.isSome(environment.sshConnection) || Option.isSome(environment.sshTty)) {
    return yield* new DesktopAppSshUnsupportedError({ command });
  }
  if (!isDesktopPlatform(hostPlatform)) {
    return yield* new DesktopAppPlatformUnsupportedError({ command, platform: hostPlatform });
  }
  const path = yield* Path.Path;
  const configuredBaseDir = Option.getOrUndefined(baseDirFlag) ?? environment.t3Home;
  const baseDir = yield* resolveBaseDir(configuredBaseDir);
  const allowDevFallback = Option.isNone(baseDirFlag) && !environment.t3Home?.trim();
  const userId = yield* HostProcess.UserId;
  const resolveAddress = (stateSubdirectory: "userdata" | "dev") =>
    resolveDesktopAppControlAddress({
      stateDir: path.join(baseDir, stateSubdirectory),
      platform: hostPlatform,
      tempDir: NodeOS.tmpdir(),
      userId,
      joinPath: path.join,
    }).address;
  const address = resolveAddress("userdata");
  return {
    platform: hostPlatform,
    addresses: allowDevFallback ? { address, fallbackAddress: resolveAddress("dev") } : { address },
  };
});

const runAppCommand = Effect.fn("cli.app")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly workspaceRoot: Option.Option<string>;
}) {
  const { platform: hostPlatform, addresses } = yield* resolveLocalDesktopApp(
    flags.baseDir,
    "cogenly app",
  );
  const path = yield* Path.Path;
  const rawWorkspaceRoot =
    Option.getOrUndefined(flags.workspaceRoot) ?? (yield* HostProcess.WorkingDirectory);
  const workspaceRoot = path.resolve(yield* expandHomePath(rawWorkspaceRoot));
  const crypto = yield* Crypto.Crypto;
  const requestId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  const request: DesktopAppActivationRequest = {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    type: "open-workspace",
    workspaceRoot,
    platform: hostPlatform,
  };
  const { address, fallbackAddress } = addresses;

  const response = yield* Effect.tryPromise({
    try: () => sendDesktopAppRequest({ ...addresses, request }),
    catch: (cause) =>
      new DesktopAppUnreachableError({
        candidateAddresses: fallbackAddress === undefined ? [address] : [address, fallbackAddress],
        requestId: request.requestId,
        workspaceRoot,
        cause,
      }),
  });
  if (!response.ok) {
    return yield* new DesktopAppRequestFailedError({
      code: response.code,
      requestId: response.requestId,
      workspaceRoot,
      cause: response,
    });
  }

  yield* Console.log(`Opened ${workspaceRoot} in Cogenly.`);
});

export const appCommand = Command.make("app", {
  baseDir: baseDirFlag,
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription("Project directory. Default: current directory."),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription("Open a project in the running Cogenly desktop app."),
  Command.withHandler(runAppCommand),
);
