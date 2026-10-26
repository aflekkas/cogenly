import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@cogenly/shared/HostProcess";
import { readProviderAccountIdentities } from "./providerAccountIdentity.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
it.effect(
  "identifies accounts by user and workspace and preserves the native default home semantics",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const personal = path.join(home, ".claude_personal");
      yield* fs.makeDirectory(personal);
      yield* fs.writeFileString(
        path.join(home, ".claude.json"),
        json({ oauthAccount: { accountUuid: "same-user", organizationUuid: "university" } }),
      );
      yield* fs.writeFileString(
        path.join(personal, ".claude.json"),
        json({ oauthAccount: { accountUuid: "same-user", organizationUuid: "personal" } }),
      );
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("claude-personal")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { homePath: "~/.claude_personal" },
          },
        },
      };
      const accounts = yield* readProviderAccountIdentities(settings).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      expect(accounts.size).toBe(2);
      expect(accounts.get("claudeAgent")?.homePath).toBe("");
      expect(accounts.get("claude-personal")?.homePath).toBe("~/.claude_personal");
      expect(accounts.get("claudeAgent")?.identity).not.toBe(
        accounts.get("claude-personal")?.identity,
      );
      expect(accounts.get("claudeAgent")?.identity).toMatch(/^[a-f0-9]{64}$/);
      expect(yield* fs.readFileString(path.join(home, ".claude.json"))).toBe(
        json({ oauthAccount: { accountUuid: "same-user", organizationUuid: "university" } }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
