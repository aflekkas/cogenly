/**
 * `cogenly environment add --ssh <alias> [--name "…"]`: add a remote environment to the
 * Cogenly desktop app on this machine without opening Settings. The desktop runs its SSH
 * flow (reuse the host's Cogenly, start its service if stopped, pair, save) and shows its
 * progress. The request goes over the desktop's local control socket, so it needs no
 * confirmation; the same request as a `cogenly://environments/add` link does.
 *
 * @module cli/environment
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "@cogenly/contracts";
import { Command, Flag } from "effect/cli";

import * as DesktopAppControl from "../environment/DesktopAppControl.ts";
import { resolveLocalDesktopApp } from "./app.ts";
import { baseDirFlag } from "./config.ts";

export interface EnvironmentAddFlags {
  readonly baseDir: Option.Option<string>;
  readonly ssh: string;
  readonly name: Option.Option<string>;
  readonly json: boolean;
}

const encodeAddedJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ environmentId: EnvironmentId, label: Schema.String })),
);

/** Sends the request to the desktop app on this machine and prints what it saved. */
export const runEnvironmentAdd = Effect.fn("cli.environment.add")(function* (
  flags: EnvironmentAddFlags,
) {
  const { addresses } = yield* resolveLocalDesktopApp(flags.baseDir, "cogenly environment add");
  if (!flags.json) yield* Console.log(`Connecting ${flags.ssh} in the Cogenly desktop app…`);
  const added = yield* DesktopAppControl.DesktopAppControl.pipe(
    Effect.flatMap((control) =>
      control.addEnvironment({ ssh: flags.ssh, name: Option.getOrUndefined(flags.name) }),
    ),
    Effect.provide(DesktopAppControl.layerAt(addresses)),
  );
  yield* Console.log(
    flags.json
      ? encodeAddedJson({ environmentId: added.environmentId, label: added.label })
      : `Connected ${added.label}.`,
  );
});

/** The command tree, with the `add` handler injectable so argument parsing can be tested. */
export const makeEnvironmentCommand = <E, R>(
  add: (flags: EnvironmentAddFlags) => Effect.Effect<void, E, R>,
) =>
  Command.make("environment").pipe(
    Command.withDescription("Manage the environments the Cogenly desktop app connects to."),
    Command.withSubcommands([
      Command.make("add", {
        baseDir: baseDirFlag,
        ssh: Flag.String("ssh").pipe(
          Flag.withDescription("SSH host alias from your SSH config, or user@host."),
        ),
        name: Flag.String("name").pipe(
          Flag.withDescription("Name to show for it. Default: the host's own name, or VPS."),
          Flag.optional,
        ),
        json: Flag.Boolean("json").pipe(
          Flag.withDescription("Print the saved environment as JSON."),
          Flag.withDefault(false),
        ),
      }).pipe(
        Command.withDescription(
          "Connect an SSH host and save it as an environment in the desktop app.",
        ),
        Command.withHandler(add),
      ),
    ]),
  );

export const environmentCommand = makeEnvironmentCommand(runEnvironmentAdd);
