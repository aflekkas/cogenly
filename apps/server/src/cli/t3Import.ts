import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag, GlobalFlag } from "effect/cli";
import {
  T3ImportError,
  type T3ImportJob,
  T3ImportReport,
  T3ImportResult,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as T3Import from "../t3Import/T3ImportService.ts";
import { layerOffline } from "../t3Import/T3ImportOfflineLayer.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const encodeReport = Schema.encodeEffect(Schema.fromJsonString(T3ImportReport));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(T3ImportResult));

/**
 * Offline Import from T3 Code against a Cogenly home that no server is using.
 * T3 Code may stay open: the scan reads a snapshot of its database.
 * The app's Settings → Import (or onboarding) is the normal entry point; this exists for
 * rehearsals against a copied home. Prints JSON (counts only, no content).
 */
export const t3ImportCommand = Command.make("t3-import", {
  ...projectLocationFlags,
  source: Flag.String("source").pipe(
    Flag.withDescription("T3 Code userdata directory (defaults to ~/.t3/userdata)."),
    Flag.optional,
  ),
  projects: Flag.String("projects").pipe(
    Flag.withDescription(
      "Comma-separated T3 project ids. Defaults to every non-scratch project with threads.",
    ),
    Flag.optional,
  ),
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("Import. Without it this is a dry run that reports what would happen."),
    Flag.optional,
  ),
  settings: Flag.Boolean("settings").pipe(
    Flag.withDescription("Also bring over default models, favorites and keybindings."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Import projects and threads from a local T3 Code install."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      // Never write behind a running server.
      yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
        Effect.provide(ProcessRunner.layer),
      );
      const source = Option.getOrUndefined(flags.source);
      const layer = layerOffline(source === undefined ? {} : { sourceDir: source }).pipe(
        Layer.provideMerge(ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        Layer.provideMerge(SqlitePersistence.layerConfig),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      );
      const scope = {
        sourceProjectIds: Option.match(flags.projects, {
          onNone: () => [],
          onSome: (value) =>
            value
              .split(",")
              .map((id) => id.trim())
              .filter((id) => id.length > 0),
        }),
      };
      yield* Effect.gen(function* () {
        const service = yield* T3Import.T3ImportService;
        // The Settings → Import job API: scan, then run what the scan reported.
        const settle = (done: (job: T3ImportJob) => boolean) =>
          service.status.pipe(
            Stream.map((status) => status.job),
            Stream.filter(done),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
        const failed = (detail: string) =>
          new T3ImportError({ reason: "source-unavailable", detail });
        yield* service.scan({ scope });
        const scanned = yield* settle((job) => job._tag === "Scanned" || job._tag === "Failed");
        if (scanned._tag !== "Scanned") {
          return yield* failed(scanned._tag === "Failed" ? scanned.message : "The check stopped.");
        }
        if (!Option.getOrElse(flags.apply, () => false)) {
          return yield* Console.log(yield* encodeReport(scanned.report));
        }
        yield* service.run({
          reportId: scanned.report.reportId,
          includeSettings: Option.getOrElse(flags.settings, () => false),
        });
        const finished = yield* settle(
          (job) => job._tag === "Completed" || job._tag === "Failed" || job._tag === "Cancelled",
        );
        if (finished._tag !== "Completed") {
          return yield* failed(
            finished._tag === "Failed" ? finished.message : "The import stopped.",
          );
        }
        yield* Console.log(yield* encodeResult(finished.result));
      }).pipe(Effect.provide(layer));
    }),
  ),
);
