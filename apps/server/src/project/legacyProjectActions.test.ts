import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  LEGACY_PROJECT_ACTIONS_FILE_NAME,
  LegacyProjectActionsJson,
  legacyProjectActionsTarget,
  readLegacyProjectActions,
} from "./legacyProjectActions.ts";

const action = (command: string) => ({
  id: "check",
  name: "Check",
  command,
  icon: "play" as const,
  runOnWorktreeCreate: false,
});
const repo = ProjectId.make("repo-a");
const other = ProjectId.make("repo-b");

describe("readLegacyProjectActions", () => {
  it("reads both legacy shapes, the newer record winning, and skips invalid lists", () => {
    expect(
      readLegacyProjectActions({
        projectSettingsFolded: true,
        projectScriptOverrides: { [repo]: [action("old")], [other]: null, broken: [{ id: 1 }] },
        projectSettingsOverrides: {
          [repo]: { defaultProjectScripts: [action("new")], defaultAutoPull: true },
          "repo-c": { defaultAutoPull: true },
        },
      }),
    ).toEqual({ folded: true, scripts: { [repo]: [action("new")], [other]: null } });
  });

  it("finds nothing in a settings file from this build", () => {
    expect(readLegacyProjectActions({ defaultAutoPull: true })).toBeNull();
    expect(readLegacyProjectActions(undefined)).toBeNull();
  });
});

describe("legacyProjectActionsTarget", () => {
  const project = (id: ProjectId, scripts: ReturnType<typeof action>[] = []) => ({ id, scripts });

  it("after the fold, gives each repository its own list or none", () => {
    const legacy = { folded: true, scripts: { [repo]: [action("lint")] } };
    expect(legacyProjectActionsTarget(legacy, project(repo))).toEqual([action("lint")]);
    // Followed the machine's actions: stale record scripts must not resurface.
    expect(legacyProjectActionsTarget(legacy, project(other, [action("stale")]))).toEqual([]);
    expect(legacyProjectActionsTarget(legacy, project(other))).toBeNull();
    expect(legacyProjectActionsTarget(legacy, project(repo, [action("lint")]))).toBeNull();
  });

  it("before the fold, applies only the old map's entries", () => {
    const legacy = { folded: false, scripts: { [repo]: [action("lint")], [other]: null } };
    expect(legacyProjectActionsTarget(legacy, project(repo))).toEqual([action("lint")]);
    expect(legacyProjectActionsTarget(legacy, project(other, [action("own")]))).toEqual([]);
    expect(
      legacyProjectActionsTarget(legacy, project(ProjectId.make("repo-c"), [action("own")])),
    ).toBeNull();
  });
});

const layer = Layer.mergeAll(SqlitePersistence.layerMemory, ServerSecretStore.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-legacy-actions-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("loading settings with pre-0.3.2 project overrides", () => {
  it.effect(
    "keeps actions through another migration and later updates when the sidecar write fails",
    () =>
      Effect.gen(function* () {
        const { settingsPath } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
        const sidecarPath = path.join(path.dirname(settingsPath), LEGACY_PROJECT_ACTIONS_FILE_NAME);
        yield* fs.writeFileString(
          settingsPath,
          JSON.stringify({
            deviceOnboardingCompleted: true,
            projectSettingsFolded: true,
            projectScriptOverrides: { [repo]: [action("lint")] },
          }),
        );
        // A directory at the destination makes the atomic rename fail.
        yield* fs.makeDirectory(sidecarPath);
        // exists must be false so this exercises a failed write, not an existing sidecar.
        const failingFs = {
          ...fs,
          exists: (file: string) =>
            file === sidecarPath ? Effect.succeed(false) : fs.exists(file),
        };
        yield* Effect.gen(function* () {
          const service = yield* ServerSettings.ServerSettingsService;
          const settings = yield* service.getSettings;
          expect(settings.deviceOnboardingCompleted).toBe(false);
          expect(
            readLegacyProjectActions(JSON.parse(yield* fs.readFileString(settingsPath))),
          ).toEqual({ folded: true, scripts: { [repo]: [action("lint")] } });
          yield* service.updateSettings({ defaultAutoPull: true });
          expect(
            readLegacyProjectActions(JSON.parse(yield* fs.readFileString(settingsPath))),
          ).toEqual({ folded: true, scripts: { [repo]: [action("lint")] } });
        }).pipe(
          Effect.provide(ServerSettings.layer),
          Effect.provideService(FileSystem.FileSystem, failingFs),
        );
        yield* fs.remove(sidecarPath, { recursive: true });
        yield* ServerSettings.ServerSettingsService.pipe(
          Effect.flatMap((service) => service.getSettings),
          Effect.provide(ServerSettings.layer),
        );
        expect(
          readLegacyProjectActions(JSON.parse(yield* fs.readFileString(settingsPath))),
        ).toBeNull();
        expect(
          yield* fs
            .readFileString(sidecarPath)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(LegacyProjectActionsJson))),
        ).toEqual({ folded: true, scripts: { [repo]: [action("lint")] } });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("decodes, saves the actions beside the file, and rewrites it without them", () =>
    Effect.gen(function* () {
      const { settingsPath } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
      yield* fs.writeFileString(
        settingsPath,
        JSON.stringify({
          defaultAutoPull: true,
          projectSettingsFolded: true,
          projectSettingsOverrides: {
            [repo]: { defaultProjectScripts: [action("lint")], defaultRuntimeMode: "bogus" },
          },
          projectAutoPullOverrides: { [repo]: false },
        }),
      );
      const settings = yield* ServerSettings.ServerSettingsService.pipe(
        Effect.flatMap((service) => service.getSettings),
        Effect.provide(ServerSettings.layer),
      );
      expect(settings.defaultAutoPull).toBe(true);
      const rewritten = JSON.parse(yield* fs.readFileString(settingsPath));
      expect(rewritten.defaultAutoPull).toBe(true);
      for (const key of [
        "projectSettingsFolded",
        "projectSettingsOverrides",
        "projectAutoPullOverrides",
      ])
        expect(rewritten).not.toHaveProperty(key);
      const sidecar = yield* fs
        .readFileString(path.join(path.dirname(settingsPath), LEGACY_PROJECT_ACTIONS_FILE_NAME))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(LegacyProjectActionsJson)));
      expect(sidecar).toEqual({ folded: true, scripts: { [repo]: [action("lint")] } });
    }).pipe(Effect.provide(layer)),
  );
});
