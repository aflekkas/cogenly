import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectConfigFileLoader from "./ProjectConfigFileLoader.ts";

const TestLayer = ProjectConfigFileLoader.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** A workspace holding the given files, loaded through the service. */
const loadWith = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-project-config-" });
    for (const [name, contents] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(root, name), contents);
    }
    const loader = yield* ProjectConfigFileLoader.ProjectConfigFileLoader;
    return Option.getOrNull(yield* loader.load(root));
  });

describe("ProjectConfigFileLoader", () => {
  it.effect("reads cogenly.json", () =>
    Effect.gen(function* () {
      const file = yield* loadWith({ "cogenly.json": '{ "iconPath": "new.png" }' });
      expect(file?.iconPath).toBe("new.png");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("falls back to t3.json when cogenly.json is absent", () =>
    Effect.gen(function* () {
      const file = yield* loadWith({ "t3.json": '{ "iconPath": "old.png" }' });
      expect(file?.iconPath).toBe("old.png");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("prefers cogenly.json, even an invalid one, over t3.json", () =>
    Effect.gen(function* () {
      const both = yield* loadWith({
        "cogenly.json": '{ "iconPath": "new.png" }',
        "t3.json": '{ "iconPath": "old.png" }',
      });
      expect(both?.iconPath).toBe("new.png");
      const invalid = yield* loadWith({
        "cogenly.json": "{ not json",
        "t3.json": '{ "iconPath": "old.png" }',
      });
      expect(invalid).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
