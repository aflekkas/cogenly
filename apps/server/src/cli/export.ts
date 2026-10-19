import * as Schema from "effect/Schema";
import { ExportResult } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command, GlobalFlag } from "effect/cli";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Exports from "../export/ExportService.ts";

const encodeResult = Schema.encodeEffect(Schema.fromJsonString(ExportResult));

export const exportCommand = Command.make("export", { ...projectLocationFlags }).pipe(
  Command.withDescription(
    "Export portable workspace history as JSONL and Markdown. Import is not supported.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const layer = Exports.layer.pipe(
        Layer.provide(Sqlite.layerFromPath(config.dbPath)),
        Layer.provide(ServerConfig.layer(config)),
      );
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Exports.ExportService).export({
          include: ["chats", "work", "agents", "commitments", "projects", "memory"],
        });
      }).pipe(Effect.provide(layer));
      yield* Console.log(yield* encodeResult(result));
    }),
  ),
);
