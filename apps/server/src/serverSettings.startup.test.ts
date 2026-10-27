import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettings from "./serverSettings.ts";

const layer = ServerSettings.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SqlitePersistence.layerMemory, ServerSecretStore.layer)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-settings-start-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("ServerSettings.start", () => {
  // VaultSync.project reads settings inside its writer transaction, through
  // Machines.list and MachineIdentity.self. Startup's settings reload must not
  // queue for the writer behind it, or neither ever finishes.
  it.effect("reloads while a writer transaction is waiting on settings", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* ServerSettings.ServerSettingsService;
      const holdingWriter = yield* Deferred.make<void>();
      const reloaded = yield* Deferred.make<void>();

      const writer = yield* Effect.gen(function* () {
        yield* sql`SELECT 1`;
        yield* Deferred.succeed(holdingWriter, undefined);
        yield* Deferred.await(reloaded);
        return yield* settings.getSettings;
      }).pipe(sql.withTransaction, Effect.forkChild);

      yield* Deferred.await(holdingWriter);
      yield* settings.start;
      yield* Deferred.succeed(reloaded, undefined);
      const read = yield* Fiber.join(writer);
      expect(read.continueThreadsAfterServerUpdate).toBeTypeOf("boolean");
    }).pipe(Effect.provide(layer)),
  );
});
