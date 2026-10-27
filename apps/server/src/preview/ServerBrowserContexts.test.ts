// @effect-diagnostics nodeBuiltinImport:off - Stubs the Playwright process boundary.
import { afterEach, expect, it, vi } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { BrowserContext } from "playwright-core";
import { browserErrorMessage, ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const { chromium } = NodeModule.createRequire(import.meta.url)(
  "playwright-core",
) as typeof import("playwright-core");
afterEach(() => vi.restoreAllMocks());

it("reports disconnected extension Chrome as unloaded when ordinary browsing takes over", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cogenly-context-fallback-"));
  let connected = true;
  const errors: (string | undefined)[] = [];
  const session = { send: async () => ({}), detach: async () => {} };
  const extensionContext = Object.assign(new NodeEvents.EventEmitter(), {
    browser: () => ({ isConnected: () => connected, newBrowserCDPSession: async () => session }),
    pages: () => [],
    newPage: async () => ({}),
    newCDPSession: async () => session,
    close: async () => {
      connected = false;
    },
  });
  const shellContext = Object.assign(new NodeEvents.EventEmitter(), {
    pages: () => [],
    close: async () => {},
  });
  vi.spyOn(chromium, "launchPersistentContext")
    .mockResolvedValueOnce(extensionContext as unknown as BrowserContext)
    .mockResolvedValueOnce(shellContext as unknown as BrowserContext);
  const contexts = new ServerBrowserContexts({
    profilesDir: root,
    executable: async () => "/shell",
    extensionsExecutable: async () => "/chrome",
    extensionsFor: async () => [{ id: "a".repeat(32), path: "/extension" }],
    onExtensionLoad: async (_profile, _path, error) => {
      errors.push(error);
      // Chrome disappears immediately after the load command succeeded.
      connected = false;
    },
  });
  try {
    expect(await contexts.contextFor("default")).toBe(shellContext);
    expect(errors).toEqual([
      undefined,
      "The extension browser disconnected; extensions are not running.",
    ]);
    expect(contexts.extensionFallbackProfiles()).toEqual(["default"]);
    expect(await contexts.restartProfile("default", ["/extension"])).toBe(true);
  } finally {
    await contexts.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("keeps the extension failure when the shell also fails to launch", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cogenly-context-errors-"));
  const errors: (string | undefined)[] = [];
  const contexts = new ServerBrowserContexts({
    profilesDir: root,
    executable: async () => {
      throw new Error("shell failed");
    },
    extensionsExecutable: async () => {
      throw new Error("Chrome failed");
    },
    extensionsFor: async () => [{ id: "a".repeat(32), path: "/extension" }],
    onExtensionLoad: async (_profile, _path, error) => {
      errors.push(error);
    },
  });
  try {
    await expect(contexts.contextFor("default")).rejects.toThrow("shell failed");
    expect(errors).toEqual(["Chrome failed"]);
  } finally {
    await contexts.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("strips the Playwright wrapper from extension load errors", () => {
  expect(
    browserErrorMessage(
      new Error(
        "cdpSession.send: Protocol error (Extensions.loadUnpacked): Could not load missing.js",
      ),
    ),
  ).toBe("Could not load missing.js");
});
