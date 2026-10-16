import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const layerTest = ProjectFaviconResolver.layer.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeWorkspace = Effect.fn("makeWorkspace")(function* (files: Record<string, string | null>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "cogenly-favicon-" }),
  );
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(cwd, relativePath);
    if (contents === null) {
      yield* fileSystem.makeDirectory(absolutePath, { recursive: true });
      continue;
    }
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  }
  return cwd;
});

const resolveRelative = Effect.fn("resolveRelative")(function* (cwd: string) {
  const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
  const path = yield* Path.Path;
  const resolved = yield* resolver.resolvePath(cwd);
  return resolved === null ? null : path.relative(cwd, resolved);
});

it.layer(layerTest)("ProjectFaviconResolver", (it) => {
  describe("resolvePath", () => {
    it.effect("prefers an svg favicon at the root over an ico", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({ "public/favicon.ico": "", "public/favicon.svg": "" });
        expect(yield* resolveRelative(cwd)).toBe("public/favicon.svg");
      }),
    );

    it.effect("finds a SvelteKit static favicon and an apple touch icon", () =>
      Effect.gen(function* () {
        expect(yield* resolveRelative(yield* makeWorkspace({ "static/favicon.png": "" }))).toBe(
          "static/favicon.png",
        );
        expect(
          yield* resolveRelative(yield* makeWorkspace({ "public/apple-touch-icon.png": "" })),
        ).toBe("public/apple-touch-icon.png");
      }),
    );

    it.effect("finds a monorepo app's favicon, user-facing apps first", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({
          "apps/admin/public/favicon.ico": "",
          "apps/web/public/favicon.svg": "",
          "apps/README.md": "",
          "packages/ui/src/index.ts": "",
        });
        expect(yield* resolveRelative(cwd)).toBe("apps/web/public/favicon.svg");
      }),
    );

    it.effect("follows an icon link in a nested app's index.html", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({
          "apps/site/index.html": '<link rel="icon" href="/brand/mark.svg" />',
          "apps/site/public/brand/mark.svg": "",
        });
        expect(yield* resolveRelative(cwd)).toBe("apps/site/public/brand/mark.svg");
      }),
    );

    it.effect("checks a lone frontend folder beside a backend", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({ "frontend/public/favicon.ico": "", server: null });
        expect(yield* resolveRelative(cwd)).toBe("frontend/public/favicon.ico");
      }),
    );

    it.effect("returns null when nothing looks like an icon", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({ "src/index.ts": "", "apps/api/src/main.ts": "" });
        expect(yield* resolveRelative(cwd)).toBeNull();
      }),
    );
  });
});
