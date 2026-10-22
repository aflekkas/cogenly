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

    it.effect("finds a Next app icon in a monorepo's web app, past brand folders elsewhere", () =>
      Effect.gen(function* () {
        // The shape of a real monorepo whose Work header showed initials.
        const cwd = yield* makeWorkspace({
          "apps/web/src/app/favicon.ico": "",
          "apps/web/src/app/icon.svg": "",
          "apps/web/src/ui/assets/brand/icon.svg": "",
          "packages/auth/src/index.ts": "",
          "packages/booking/src/index.ts": "",
          "services/worker/src/main.ts": "",
          "tools/video/public/client/favicon.svg": "",
          "docs/deliverables/logo.svg": "",
          "package.json": '{"name":"platform","private":true}',
        });
        expect(yield* resolveRelative(cwd)).toBe("apps/web/src/app/icon.svg");
      }),
    );

    it.effect("ranks any package's web icon above an app icon at the root", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({
          "assets/icon.png": "",
          "build/icon.png": "",
          "apps/marketing/public/favicon.ico": "",
        });
        expect(yield* resolveRelative(cwd)).toBe("apps/marketing/public/favicon.ico");
      }),
    );

    it.effect("reads the icon an Expo app.json declares", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({
          "app.json": JSON.stringify({ expo: { name: "Bartr", icon: "./assets/brand/app.png" } }),
          "assets/brand/app.png": "",
          "assets/icon.png": "",
        });
        expect(yield* resolveRelative(cwd)).toBe("assets/brand/app.png");
      }),
    );

    it.effect("reads electron-builder's icon from package.json, without an extension", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({
          "apps/desktop/package.json": JSON.stringify({ build: { icon: "resources/app" } }),
          "apps/desktop/resources/app.png": "",
        });
        expect(yield* resolveRelative(cwd)).toBe("apps/desktop/resources/app.png");
      }),
    );

    it.effect("picks the largest image of an Xcode AppIcon set", () =>
      Effect.gen(function* () {
        const appIconSet = "ios/Bartr/Images.xcassets/AppIcon.appiconset";
        const cwd = yield* makeWorkspace({
          "ios/Bartr.xcodeproj/project.pbxproj": "",
          [`${appIconSet}/Contents.json`]: JSON.stringify({
            images: [
              { filename: "icon-40@2x.png", size: "20x20", scale: "2x" },
              { filename: "icon-1024.png", size: "1024x1024", scale: "1x" },
              { filename: "icon-60@3x.png", size: "60x60", scale: "3x" },
              { size: "29x29", scale: "2x" },
            ],
          }),
          [`${appIconSet}/icon-40@2x.png`]: "",
          [`${appIconSet}/icon-1024.png`]: "",
          [`${appIconSet}/icon-60@3x.png`]: "",
        });
        expect(yield* resolveRelative(cwd)).toBe(`${appIconSet}/icon-1024.png`);
      }),
    );

    it.effect("uses a saved icon path over everything it would detect", () =>
      Effect.gen(function* () {
        const cwd = yield* makeWorkspace({
          "public/favicon.svg": "",
          "brand/mark.png": "",
        });
        const resolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
        const path = yield* Path.Path;
        const resolved = yield* resolver.resolvePath(cwd, "brand/mark.png");
        expect(resolved === null ? null : path.relative(cwd, resolved)).toBe("brand/mark.png");
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

describe("extractManifestIconPath", () => {
  it("reads Expo, electron-builder and package.json declarations", () => {
    expect(
      ProjectFaviconResolver.extractManifestIconPath("app.json", '{"expo":{"icon":"./a.png"}}'),
    ).toBe("./a.png");
    expect(
      ProjectFaviconResolver.extractManifestIconPath(
        "package.json",
        '{"build":{"mac":{"icon":"build/icon.icns"}}}',
      ),
    ).toBe("build/icon.icns");
    expect(
      ProjectFaviconResolver.extractManifestIconPath(
        "electron-builder.yml",
        "appId: x\nicon: build/app\n",
      ),
    ).toBe("build/app");
    expect(
      ProjectFaviconResolver.extractManifestIconPath("package.json", '{"name":"x"}'),
    ).toBeNull();
    expect(ProjectFaviconResolver.extractManifestIconPath("app.json", "not json")).toBeNull();
  });
});
