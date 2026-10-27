// @effect-diagnostics nodeBuiltinImport:off - Drives a real Chromium through Playwright, outside Effect.
/**
 * Loads a real extension into the server browser and uses it the way an agent
 * does: its popup opens as a tab and is clicked, and its content script shows
 * the result on a site. Needs a Chromium that can load extensions (not the
 * headless shell): Playwright's own, or COGENLY_TEST_EXTENSION_CHROME.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import type { Page } from "playwright-core";
import { makeBrowserExtensions } from "./BrowserExtensions.ts";

import { extensionIdFromPublicKey } from "./BrowserExtensionCrx.ts";
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const chromium = (() => {
  const configured = process.env.COGENLY_TEST_EXTENSION_CHROME;
  if (configured) return configured;
  try {
    const require = NodeModule.createRequire(import.meta.url);
    const bundled = (
      require("playwright-core") as typeof import("playwright-core")
    ).chromium.executablePath();
    return NodeFS.existsSync(bundled) ? bundled : undefined;
  } catch {
    return undefined;
  }
})();

const POPUP = `<!doctype html><button id="save">Save greeting</button><p id="status">idle</p><script src="popup.js"></script>`;
const POPUP_JS = `document.getElementById("save").addEventListener("click", () => {
  chrome.storage.local.set({ greeting: "hello from the popup" }, () => {
    document.getElementById("status").textContent = "saved";
  });
});`;
const CONTENT_JS = `chrome.storage.local.get("greeting", ({ greeting }) => {
  const banner = document.createElement("p");
  banner.id = "extension-banner";
  banner.textContent = greeting ?? "no greeting yet";
  document.body.append(banner);
});`;

/** Resolves on a DOM mutation, without timers or polling. */
const textChanged = (page: Page, selector: string, expected: string) =>
  page.evaluate<void>(`new Promise((resolve) => {
    const selector = ${JSON.stringify(selector)};
    const expected = ${JSON.stringify(expected)};
    const check = () => {
      if (document.querySelector(selector)?.textContent !== expected) return;
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(check);
    observer.observe(document, { childList: true, subtree: true, characterData: true });
    check();
  })`);

const extensionRig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-extension-regression-" });
  const store = yield* makeBrowserExtensions({ rootDir: path.join(root, "store") });
  let extensions: ReadonlyArray<{ readonly id: string; readonly path: string }> = [];
  const results = new Map<string, string | undefined>();
  const contexts = new ServerBrowserContexts({
    profilesDir: path.join(root, "profiles"),
    executable: async () => chromium!,
    extensionsExecutable: async () => chromium!,
    extensionsFor: async () => extensions.map((extension) => extension.path),
    onExtensionLoad: async (_profileId, directory, error) => {
      results.set(directory, error);
    },
    env: { ...process.env, COGENLY_SERVER_BROWSER_SANDBOX: "0" },
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => contexts.close()));
  yield* store.registerLoader((profileId) =>
    Effect.gen(function* () {
      extensions = yield* store.loadable(profileId);
      yield* Effect.promise(() =>
        contexts.restartProfile(
          profileId,
          extensions.map((extension) => extension.path),
        ),
      );
      if (extensions.length > 0) yield* Effect.promise(() => contexts.contextFor(profileId));
      for (const [directory, error] of results)
        yield* store.reportLoad(profileId, directory, error);
    }),
  );
  const folder = path.join(root, "source");
  const write = (version: string, pageText = version, broken = false) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(folder, { recursive: true });
      yield* fs.writeFileString(
        path.join(folder, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Regression extension",
          version,
          permissions: ["storage", "sidePanel"],
          background: { service_worker: "worker.js", type: "module" },
          side_panel: { default_path: "options.html" },
          options_page: "options.html",
          ...(broken
            ? { content_scripts: [{ matches: ["http://localhost/*"], js: ["missing.js"] }] }
            : {}),
        }),
      );
      yield* fs.writeFileString(
        path.join(folder, "worker.js"),
        "chrome.runtime.onInstalled.addListener(() => {});",
      );
      yield* fs.writeFileString(
        path.join(folder, "options.html"),
        `<title>Options</title><p>${pageText}</p>`,
      );
    });
  return { root, fs, path, store, contexts, folder, write };
});

describe.skipIf(chromium === undefined)("server browser extensions", () => {
  let root: string;
  let site: NodeHttp.Server;
  let siteUrl: string;
  let extensionId: string;
  let contexts: ServerBrowserContexts;

  beforeAll(async () => {
    root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cogenly-extension-load-"));
    const extension = NodePath.join(root, "extension");
    await NodeFSP.mkdir(extension);
    const { publicKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = publicKey.export({ format: "der", type: "spki" });
    extensionId = extensionIdFromPublicKey(key);
    await NodeFSP.writeFile(
      NodePath.join(extension, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Greeter",
        version: "1.0.0",
        key: key.toString("base64"),
        permissions: ["storage"],
        action: { default_popup: "popup.html" },
        content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
      }),
    );
    await NodeFSP.writeFile(NodePath.join(extension, "popup.html"), POPUP);
    await NodeFSP.writeFile(NodePath.join(extension, "popup.js"), POPUP_JS);
    await NodeFSP.writeFile(NodePath.join(extension, "content.js"), CONTENT_JS);

    site = NodeHttp.createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Site</title><h1>A site</h1>");
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    siteUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;

    contexts = new ServerBrowserContexts({
      profilesDir: NodePath.join(root, "profiles"),
      executable: async () => chromium!,
      extensionsExecutable: async () => chromium!,
      extensionsFor: async (profileId) => (profileId === "default" ? [extension] : []),
      // CI runners block Chromium's user-namespace sandbox; this covers extensions, not sandboxing.
      env: { ...process.env, COGENLY_SERVER_BROWSER_SANDBOX: "0" },
    });
  });

  afterAll(async () => {
    await contexts?.close();
    await new Promise((resolve) => site?.close(resolve));
    if (root) await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("opens the popup as a tab, clicks it, and sees the content script use the result", async () => {
    const context = await contexts.contextFor("default");
    const before = await context.newPage();
    await before.goto(siteUrl);
    await textChanged(before, "#extension-banner", "no greeting yet");

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByRole("button", { name: "Save greeting" }).click();
    await textChanged(popup, "#status", "saved");

    await before.reload();
    await textChanged(before, "#extension-banner", "hello from the popup");
  }, 60_000);

  it("keeps extensions out of a profile that has none", async () => {
    const context = await contexts.contextFor("work");
    const page = await context.newPage();
    await page.goto(siteUrl);
    await page.waitForLoadState("load");
    expect(await page.locator("#extension-banner").count()).toBe(0);
  }, 60_000);

  it.live(
    "skips a broken extension, reports Chrome's reason on install and list, and keeps the browser usable",
    () =>
      Effect.gen(function* () {
        const r = yield* extensionRig;
        yield* r.write("1.0.0", "broken", true);
        const installed = yield* r.store.install({ source: r.folder });
        expect(installed.extension.loadError).toContain("Regression extension");
        expect(installed.extension.loadError).toContain("missing.js");
        expect((yield* r.store.list({})).extensions[0]?.loadError).toBe(
          installed.extension.loadError,
        );
        const context = yield* Effect.promise(() => r.contexts.contextFor("default"));
        const page = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() => page.goto(siteUrl));
        expect(yield* Effect.promise(() => page.title())).toBe("Site");
        // A healthy extension in the same profile still runs.
        const healthy = r.path.join(r.root, "healthy");
        yield* r.write("1.0.0", "working");
        yield* r.fs.copy(r.folder, healthy);
        const good = yield* r.store.install({ source: healthy });
        expect(good.extension.loadError).toBeUndefined();
        const active = yield* Effect.promise(() => r.contexts.contextFor("default"));
        const options = yield* Effect.promise(() => active.newPage());
        const url = yield* r.store.pageUrl({ id: good.extension.id, page: "options" });
        yield* Effect.promise(() => options.goto(url));
        expect(yield* Effect.promise(() => options.locator("p").textContent())).toBe("working");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
  );

  it.live(
    "reinstalls rebuilt files and bumped versions from the same folder while keeping the ID and storage",
    () =>
      Effect.gen(function* () {
        const r = yield* extensionRig;
        yield* r.write("1.0.0");
        const first = yield* r.store.install({ source: r.folder });
        expect(first.extension.loadError).toBeUndefined();
        const url = yield* r.store.pageUrl({ id: first.extension.id, page: "options" });
        const firstContext = yield* Effect.promise(() => r.contexts.contextFor("default"));
        const firstPage = yield* Effect.promise(() => firstContext.newPage());
        yield* Effect.promise(() => firstPage.goto(url));
        yield* Effect.promise(() =>
          firstPage.evaluate("chrome.storage.local.set({ greeting: 'retained' })"),
        );
        yield* r.write("1.1.0");
        const second = yield* r.store.install({ source: r.folder });
        expect(second).toMatchObject({
          updated: true,
          previousVersion: "1.0.0",
          extension: { id: first.extension.id, version: "1.1.0" },
        });
        expect(second.extension.loadError).toBeUndefined();
        const secondContext = yield* Effect.promise(() => r.contexts.contextFor("default"));
        expect(secondContext).not.toBe(firstContext);
        const page = yield* Effect.promise(() => secondContext.newPage());
        yield* Effect.promise(() => page.goto(url));
        expect(yield* Effect.promise(() => page.locator("p").textContent())).toBe("1.1.0");
        expect(
          yield* Effect.promise(() => page.evaluate("chrome.storage.local.get('greeting')")),
        ).toEqual({ greeting: "retained" });
        yield* r.write("1.1.0", "rebuilt without a version bump");
        const third = yield* r.store.install({ source: r.folder });
        expect(third.extension.loadError).toBeUndefined();
        expect((yield* r.store.list({})).extensions[0]?.version).toBe("1.1.0");
        const rebuilt = yield* Effect.promise(() =>
          r.contexts.contextFor("default").then((context) => context.newPage()),
        );
        yield* Effect.promise(() => rebuilt.goto(url));
        expect(yield* Effect.promise(() => rebuilt.locator("p").textContent())).toBe(
          "rebuilt without a version bump",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
      ),
  );

  it("keeps browsing available when full Chrome cannot launch", async () => {
    const failures: string[] = [];
    const fallback = new ServerBrowserContexts({
      profilesDir: NodePath.join(root, "fallback-profiles"),
      executable: async () => chromium!,
      extensionsExecutable: async () => {
        throw new Error("full Chrome is unavailable");
      },
      extensionsFor: async () => [NodePath.join(root, "extension")],
      onExtensionLoad: async (_profileId, _path, error) => {
        if (error) failures.push(error);
      },
      env: { ...process.env, COGENLY_SERVER_BROWSER_SANDBOX: "0" },
    });
    try {
      const context = await fallback.contextFor("default");
      const page = await context.newPage();
      await page.goto(siteUrl);
      expect(await page.title()).toBe("Site");
      expect(failures).toEqual(["Error: full Chrome is unavailable"]);
    } finally {
      await fallback.close();
    }
  });
});
