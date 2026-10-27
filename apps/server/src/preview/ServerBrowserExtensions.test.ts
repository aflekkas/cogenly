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
    await expect
      .poll(() =>
        before
          .locator("#extension-banner")
          .textContent()
          .catch(() => null),
      )
      .toBe("no greeting yet");

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByRole("button", { name: "Save greeting" }).click();
    await expect.poll(() => popup.locator("#status").textContent()).toBe("saved");

    await before.reload();
    await expect
      .poll(() =>
        before
          .locator("#extension-banner")
          .textContent()
          .catch(() => null),
      )
      .toBe("hello from the popup");
  }, 60_000);

  it("keeps extensions out of a profile that has none", async () => {
    const context = await contexts.contextFor("work");
    const page = await context.newPage();
    await page.goto(siteUrl);
    await page.waitForLoadState("load");
    expect(await page.locator("#extension-banner").count()).toBe(0);
  }, 60_000);
});
