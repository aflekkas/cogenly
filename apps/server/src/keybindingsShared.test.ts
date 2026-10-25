import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { KeybindingsConfig, type KeybindingRule } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as Settings from "./serverSettings.ts";

const layer = Keybindings.layer.pipe(
  Layer.provideMerge(Settings.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "shared-keybindings-" })),
  Layer.provideMerge(NodeServices.layer),
);
const configJson = Schema.fromJsonString(KeybindingsConfig);
const encode = Schema.encodeSync(configJson);
const decode = Schema.decodeUnknownSync(configJson);
const setup = Effect.gen(function* () {
  const service = yield* Keybindings.Keybindings;
  const settings = yield* Settings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { keybindingsConfigPath } = yield* ServerConfig.ServerConfig;
  yield* fs.makeDirectory(path.dirname(keybindingsConfigPath), { recursive: true });
  const read = fs.readFileString(keybindingsConfigPath).pipe(Effect.map(decode));
  const write = (rules: readonly KeybindingRule[]) =>
    fs.writeFileString(keybindingsConfigPath, encode(rules));
  return { service, settings, read, write };
});

it.effect(
  "shared keybindings adopt peer edits and publish upserts and removals through the same service",
  () =>
    Effect.gen(function* () {
      const { service, settings, read } = yield* setup;
      yield* service.syncDefaultKeybindingsOnStartup;
      yield* service.reconcileSharedKeybindings;
      expect((yield* settings.getSettings).sharedKeybindings).toBeNull();
      const peer = [{ key: "mod+shift+k", command: "settings.open" }] as const;
      yield* settings.updateSettings({ sharedKeybindings: peer });
      yield* service.reconcileSharedKeybindings;
      expect(yield* read).toEqual(peer);
      const added = { key: "mod+shift+a", command: "sidebar.toggle" } as const;
      yield* service.upsertKeybindingRule(added);
      expect((yield* settings.getSettings).sharedKeybindings).toEqual([...peer, added]);
      yield* service.removeKeybindingRule(added);
      expect((yield* settings.getSettings).sharedKeybindings).toEqual(peer);
      yield* settings.updateSettings({ sharedKeybindings: [] });
      yield* service.reconcileSharedKeybindings;
      expect(yield* read).toEqual([]);
      yield* service.reconcileSharedKeybindings;
      expect((yield* settings.getSettings).sharedKeybindings).toEqual([]);
    }).pipe(Effect.provide(layer)),
);

it.effect("legacy customizations seed only an unset shared keybinding list", () =>
  Effect.gen(function* () {
    const { service, settings, write, read } = yield* setup;
    const custom = [{ key: "mod+shift+k", command: "settings.open" }] as const;
    yield* write(custom);
    yield* service.reconcileSharedKeybindings;
    expect((yield* settings.getSettings).sharedKeybindings).toEqual(custom);
    const peer = [{ key: "mod+shift+l", command: "settings.open" }] as const;
    yield* settings.updateSettings({ sharedKeybindings: peer });
    yield* service.reconcileSharedKeybindings;
    expect(yield* read).toEqual(peer);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
