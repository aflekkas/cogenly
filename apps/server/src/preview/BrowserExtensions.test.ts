// @effect-diagnostics nodeBuiltinImport:off - Writes extension fixtures, including a symlink.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeFSP from "node:fs/promises";

import { makeBrowserExtensions } from "./BrowserExtensions.ts";

const requested: string[] = [];
const webStore = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    requested.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response("not a package", { status: 200 })),
    );
  }),
);

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-extensions-" });
  const extensions = yield* makeBrowserExtensions({ rootDir: path.join(root, "store") });
  const folder = path.join(root, "my-extension");
  const writeExtension = (version: string, manifest: Record<string, unknown> = {}) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.join(folder, "_locales", "en"), { recursive: true });
      yield* fs.writeFileString(
        path.join(folder, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "__MSG_name__",
          default_locale: "en",
          version,
          permissions: ["storage", "tabs"],
          host_permissions: ["https://example.com/*"],
          content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
          action: { default_popup: "popup.html" },
          ...manifest,
        }),
      );
      yield* fs.writeFileString(
        path.join(folder, "_locales", "en", "messages.json"),
        JSON.stringify({ NAME: { message: "Highlighter" } }),
      );
      yield* fs.writeFileString(path.join(folder, "content.js"), "");
      yield* fs.writeFileString(path.join(folder, "popup.html"), "<p>hi</p>");
    });
  return { fs, path, root, extensions, folder, writeExtension };
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | HttpClient.HttpClient | import("effect/Scope").Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, webStore)));

describe("BrowserExtensions", () => {
  it.effect("installs an unpacked folder with a stable ID and reads its manifest", () =>
    run(
      Effect.gen(function* () {
        const { fs, path, extensions, folder, writeExtension } = yield* setup;
        yield* writeExtension("1.0.0");
        const first = yield* extensions.install({ source: folder });
        expect(first.profileId).toBe("default");
        expect(first.updated).toBe(false);
        expect(first.extension).toMatchObject({
          name: "Highlighter",
          version: "1.0.0",
          enabled: true,
          source: { type: "folder", path: folder },
          permissions: ["storage", "tabs"],
          hostPermissions: ["https://example.com/*", "<all_urls>"],
          popupPage: "popup.html",
        });
        expect(first.extension.id).toMatch(/^[a-p]{32}$/);

        // The copy carries the key that fixes its ID on every host.
        const [loaded] = yield* extensions.loadable("default");
        const copied = JSON.parse(
          yield* fs.readFileString(path.join(loaded!.path, "manifest.json")),
        );
        expect(typeof copied.key).toBe("string");

        yield* writeExtension("1.1.0");
        const second = yield* extensions.install({ source: folder });
        expect(second.extension.id).toBe(first.extension.id);
        expect(second).toMatchObject({
          updated: true,
          previousVersion: "1.0.0",
          extension: { version: "1.1.0" },
        });
        const reloaded = yield* extensions.loadable("default");
        expect(reloaded).toHaveLength(1);
        expect(reloaded[0]!.path).not.toBe(loaded!.path);
        // The old version's files are gone.
        expect(yield* fs.exists(loaded!.path)).toBe(false);
        // The test clock has not advanced: rebuilding the same version still
        // gets a new directory, which forces both runtimes to drop cached files.
        yield* writeExtension("1.1.0");
        yield* extensions.install({ source: folder });
        const rebuilt = yield* extensions.loadable("default");
        expect(rebuilt[0]!.path).not.toBe(reloaded[0]!.path);
        expect(yield* fs.exists(reloaded[0]!.path)).toBe(false);
      }),
    ),
  );

  it.effect("reports a load failure on install and list, and clears it after reinstall", () =>
    run(
      Effect.gen(function* () {
        const { extensions, folder, writeExtension } = yield* setup;
        let loads = 0;
        let error: string | undefined =
          "Could not load javascript 'missing.js' for content script.";
        yield* extensions.registerLoader((profileId) =>
          Effect.gen(function* () {
            loads++;
            for (const extension of yield* extensions.loadable(profileId)) {
              yield* extensions.reportLoad(profileId, extension.path, error);
            }
          }),
        );
        yield* writeExtension("1.0.0");
        const installed = yield* extensions.install({ source: folder });
        expect(installed.extension.loadError).toContain("Highlighter");
        expect(installed.extension.loadError).toContain("missing.js");
        expect((yield* extensions.list({})).extensions[0]?.loadError).toBe(
          installed.extension.loadError,
        );
        expect(
          (yield* Effect.flip(extensions.pageUrl({ id: installed.extension.id, page: "popup" })))
            .message,
        ).toContain("missing.js");
        expect(loads).toBe(1);
        error = undefined;
        yield* writeExtension("1.1.0");
        const updated = yield* extensions.install({ source: folder });
        expect(updated.extension).toMatchObject({ id: installed.extension.id, version: "1.1.0" });
        expect(updated.extension.loadError).toBeUndefined();
        expect((yield* extensions.list({})).extensions[0]?.loadError).toBeUndefined();
      }),
    ),
  );

  it.effect("turns an extension off and removes it", () =>
    run(
      Effect.gen(function* () {
        const { fs, extensions, folder, writeExtension } = yield* setup;
        yield* writeExtension("1.0.0");
        const { extension } = yield* extensions.install({ source: folder, profileId: "work" });
        const installed = (yield* extensions.loadable("work"))[0]!.path;

        const off = yield* extensions.toggle({
          profileId: "work",
          id: extension.id,
          enabled: false,
        });
        expect(off.enabled).toBe(false);
        expect(yield* extensions.loadable("work")).toEqual([]);
        expect((yield* extensions.list({ profileId: "work" })).extensions).toHaveLength(1);
        expect((yield* extensions.list({})).extensions).toEqual([]);

        const remaining = yield* extensions.remove({ profileId: "work", id: extension.id });
        expect(remaining.extensions).toEqual([]);
        expect(yield* fs.exists(installed)).toBe(false);
      }),
    ),
  );

  it.effect("opens the popup and options pages it has, and says why it cannot open the rest", () =>
    run(
      Effect.gen(function* () {
        const { extensions, folder, writeExtension } = yield* setup;
        yield* writeExtension("1.0.0");
        const { extension } = yield* extensions.install({ source: folder });
        expect(yield* extensions.pageUrl({ id: extension.id, page: "popup" })).toBe(
          `chrome-extension://${extension.id}/popup.html`,
        );
        expect(yield* extensions.pageUrl({ id: extension.id, page: "/stats.html" })).toBe(
          `chrome-extension://${extension.id}/stats.html`,
        );
        const options = yield* Effect.exit(
          extensions.pageUrl({ id: extension.id, page: "options" }),
        );
        expect(Exit.isFailure(options) && String(options.cause)).toMatch(/no options page/);

        yield* writeExtension("1.0.1", { action: {} });
        yield* extensions.install({ source: folder });
        const popup = yield* Effect.exit(extensions.pageUrl({ id: extension.id, page: "popup" }));
        expect(Exit.isFailure(popup) && String(popup.cause)).toMatch(/no extension toolbar/);
      }),
    ),
  );

  it.effect("installs only from the Chrome Web Store, and only a verified package", () =>
    run(
      Effect.gen(function* () {
        const { extensions } = yield* setup;
        const elsewhere = yield* Effect.exit(
          extensions.install({ source: "https://example.com/extension.crx" }),
        );
        expect(Exit.isFailure(elsewhere) && String(elsewhere.cause)).toMatch(
          /Chrome Web Store link/,
        );

        requested.length = 0;
        const id = "ddkjiahejlhfcafbddmgiahcphecmpfh";
        const unsigned = yield* Effect.exit(
          extensions.install({ source: `https://chromewebstore.google.com/detail/x/${id}` }),
        );
        expect(Exit.isFailure(unsigned) && String(unsigned.cause)).toMatch(
          /not a Chrome extension package/,
        );
        expect(new URL(requested[0]!).hostname).toBe("clients2.google.com");
        expect((yield* extensions.list({})).extensions).toEqual([]);
      }),
    ),
  );

  it.effect("refuses incognito and folders that link outside themselves", () =>
    run(
      Effect.gen(function* () {
        const { path, root, extensions, folder, writeExtension } = yield* setup;
        yield* writeExtension("1.0.0");
        const incognito = yield* Effect.exit(
          extensions.install({ source: folder, profileId: "incognito" }),
        );
        expect(Exit.isFailure(incognito) && String(incognito.cause)).toMatch(/Incognito/);

        yield* Effect.promise(() => NodeFSP.symlink(root, path.join(folder, "escape")));
        const linked = yield* Effect.exit(extensions.install({ source: folder }));
        expect(Exit.isFailure(linked) && String(linked.cause)).toMatch(/symbolic link/);
      }),
    ),
  );
});
