import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { T3ImportReport, T3ImportResult } from "@cogenly/contracts";

import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  describeSetupFailure,
  jsonProgressOutput,
  runT3ImportStep,
  SetupStoppedError,
} from "./setup.ts";
import { openSetupBackend } from "./setupBackend.ts";

const encodeReport = Schema.encodeEffect(Schema.fromJsonString(T3ImportReport));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(T3ImportResult));

/**
 * Import from T3 Code without prompts, for scripts and agents. Uses the
 * running Cogenly when one owns the home (the same job Settings → Import
 * runs), else the home directly. T3 Code may stay open. Progress goes to
 * stderr; stdout is the JSON report (dry run) or result (`--apply`), counts
 * only, no content. `cogenly setup` is the guided version.
 */
export const t3ImportCommand = Command.make("t3-import", {
  ...projectLocationFlags,
  source: Flag.String("source").pipe(
    Flag.withDescription(
      "T3 Code userdata directory (defaults to ~/.t3/userdata). Only while Cogenly isn't running.",
    ),
    Flag.optional,
  ),
  projects: Flag.String("projects").pipe(
    Flag.withDescription(
      "Comma-separated T3 Code project ids, titles or folders. Defaults to every non-scratch project with threads.",
    ),
    Flag.optional,
  ),
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("Import. Without it this is a dry run that reports what would happen."),
    Flag.withDefault(false),
  ),
  settings: Flag.Boolean("settings").pipe(
    Flag.withDescription("Also bring over default models, favorites and keybindings."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Import projects and threads from a local T3 Code install."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const sourceDir = Option.getOrUndefined(flags.source);
      const backend = yield* openSetupBackend(config, {
        label: "cogenly t3-import cli",
        ...(sourceDir === undefined ? {} : { sourceDir }),
      });
      if (sourceDir !== undefined && backend.target._tag === "live") {
        return yield* new SetupStoppedError({
          reason:
            "--source only works while Cogenly isn't running; the running server imports from its own T3 Code install.",
        });
      }
      yield* jsonProgressOutput.log(
        backend.target._tag === "live"
          ? `Using the running Cogenly at ${backend.target.origin}.`
          : `Cogenly isn't running; importing into ${backend.target.baseDir} directly.`,
      );
      const outcome = yield* runT3ImportStep(backend, {
        interactive: false,
        projects: Option.match(flags.projects, {
          onNone: () => [],
          onSome: (value) =>
            value
              .split(",")
              .map((id) => id.trim())
              .filter((id) => id.length > 0),
        }),
        includeSettings: flags.settings,
        dryRun: !flags.apply,
        output: jsonProgressOutput,
      });
      switch (outcome._tag) {
        case "Scanned":
          return yield* Console.log(yield* encodeReport(outcome.report));
        case "Imported":
          return yield* Console.log(yield* encodeResult(outcome.result));
        case "Unavailable":
          return yield* new SetupStoppedError({ reason: outcome.reason });
        case "Declined":
          return;
      }
    }).pipe(
      Effect.scoped,
      Effect.catchTags({
        SetupBackendError: (error) =>
          Effect.fail(new SetupStoppedError({ reason: describeSetupFailure(error) })),
        T3ImportError: (error) => Effect.fail(new SetupStoppedError({ reason: error.detail })),
      }),
    ),
  ),
);
