import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import {
  backupDatabase,
  pruneBackups,
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
} from "../persistence/DatabaseBackup.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const backupCommand = Command.make("backup", {
  ...projectLocationFlags,
  out: Flag.String("out").pipe(
    Flag.withDescription(
      "Write the snapshot to this path instead of the default timestamped file.",
    ),
    Flag.optional,
  ),
  keep: Flag.Int("keep").pipe(
    Flag.withDescription(
      "After backing up, keep only the newest N timestamped backups in the output directory.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Back up the Cogenly state database to a consistent SQLite snapshot. Safe to run while the server is up.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const keep = Option.getOrUndefined(flags.keep);
      if (keep !== undefined && keep < 1) {
        return yield* new CliError.UserError({
          cause: `Invalid --keep "${keep}": expected at least 1.`,
        });
      }
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const path = yield* Path.Path;
      const stamp = DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-");
      const outPath =
        Option.getOrUndefined(flags.out) ??
        path.join(config.baseDir, "backups", `${BACKUP_FILE_PREFIX}${stamp}${BACKUP_FILE_SUFFIX}`);
      yield* backupDatabase({ dbPath: config.dbPath, outPath });
      const removed =
        keep === undefined ? [] : yield* pruneBackups({ directory: path.dirname(outPath), keep });
      yield* Console.log(
        `Backed up the state database to ${outPath}.${removed.length > 0 ? ` Pruned ${removed.length} older backup(s).` : ""}`,
      );
    }),
  ),
);
