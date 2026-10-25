// @effect-diagnostics nodeBuiltinImport:off - Tests own all files under a temporary synthetic browser home.
import * as NodeSqlite from "node:sqlite";
import * as NetService from "@cogenly/shared/Net";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import { browserImportCookiesCommand } from "./browserCookies.ts";

it.layer(Layer.merge(NodeServices.layer, NetService.layer))("browser cookie CLI", (it) => {
  it.effect("lists synthetic profiles and prints a scoped dry run without cookie values", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(home, ".mozilla", "firefox", "fixture.default");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(path.join(directory, "cookies.sqlite"));
        try {
          db.exec(`pragma user_version=16;
          create table moz_cookies (host text, name text, value text, path text, expiry integer, isSecure integer, isHttpOnly integer, sameSite integer, originAttributes text);
          insert into moz_cookies values ('github.com','session','synthetic-cli-secret','/',4102444800000,1,1,1,'');
          insert into moz_cookies values ('linear.app','session','synthetic-cli-secret','/',4102444800000,1,1,1,'');`);
        } finally {
          db.close();
        }
      });
      const output: unknown[] = [];
      const console = yield* Console.Console;
      for (const args of [
        ["--list"],
        [
          "--from",
          "firefox",
          "--profile",
          "fixture.default",
          "--to",
          "work",
          "--domain",
          "github.com",
          "--dry-run",
        ],
      ]) {
        yield* Command.runWith(browserImportCookiesCommand, {
          version: "test",
          renderErrors: false,
        })(args).pipe(
          Effect.provideService(Console.Console, {
            ...console,
            log: (...values) => {
              output.push(...values);
            },
          }),
          Effect.provideService(HostProcess.Environment, { HOME: home }),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
      }
      expect(output).toHaveLength(2);
      expect(String(output[0])).toContain("fixture.default");
      expect(String(output[1])).toContain('"available":1');
      expect(String(output[1])).toContain('"dryRun":true');
      expect(String(output[1])).not.toContain("linear.app");
      expect(output.join(" ")).not.toContain("synthetic-cli-secret");
    }),
  );

  it.effect("rejects malformed domain filters before opening any browser store", () =>
    Effect.gen(function* () {
      const error = yield* Command.runWith(browserImportCookiesCommand, {
        version: "test",
        renderErrors: false,
      })(["--domain", "https://github.com", "--dry-run"]).pipe(Effect.flip);
      expect(error.message).toContain("comma-separated domain names");
    }),
  );
});
