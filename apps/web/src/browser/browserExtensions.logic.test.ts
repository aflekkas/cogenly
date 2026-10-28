import type { BrowserExtension } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  browserExtensionErrorMessage,
  browserExtensionInstalledMessage,
  browserExtensionPermissionLines,
  browserExtensionPermissionSummary,
  browserExtensionReinstallSource,
  isFolderInstallSource,
} from "./browserExtensions.logic";

const summary = (permissions: string[], hostPermissions: string[]) =>
  browserExtensionPermissionSummary({ permissions, hostPermissions });

describe("browserExtensionPermissionSummary", () => {
  it.each([["<all_urls>"], ["*://*/*"], ["https://*/*"]])("reads %s as all sites", (pattern) => {
    expect(summary([], ["https://github.com/*", pattern]).sites).toBe(
      "Reads and changes: all sites",
    );
  });

  it("names a few sites, folds subdomains, and counts the rest", () => {
    expect(
      summary(
        [],
        [
          "https://*.github.com/*",
          "https://github.com/*",
          "https://linear.app/*",
          "https://example.com/*",
          "https://news.ycombinator.com/*",
        ],
      ).sites,
    ).toBe("Reads and changes: github.com, linear.app, example.com and 1 more");
  });

  it("counts Manifest V2 site permissions as sites, not APIs", () => {
    expect(summary(["storage", "tabs", "<all_urls>"], [])).toEqual({
      sites: "Reads and changes: all sites",
      apis: "Uses: storage, tabs",
    });
  });

  it("says when an extension asks for nothing", () => {
    expect(browserExtensionPermissionLines({ permissions: [], hostPermissions: [] })).toEqual([
      "No special permissions",
    ]);
  });
});

describe("browserExtensionInstalledMessage", () => {
  const extension: BrowserExtension = {
    id: "a".repeat(32),
    name: "uBlock",
    version: "1.2",
    description: "",
    manifestVersion: 3,
    hasAction: false,
    state: "loaded",
    enabled: true,
    source: { type: "webStore" },
    permissions: [],
    hostPermissions: [],
    installedAt: "2026-10-26T00:00:00.000Z",
  };
  const profileId = "default";
  it("tells an install from an update", () => {
    expect(browserExtensionInstalledMessage({ profileId, extension, updated: false })).toBe(
      "Installed uBlock 1.2",
    );
    expect(
      browserExtensionInstalledMessage({
        profileId,
        extension,
        updated: true,
        previousVersion: "1.1",
      }),
    ).toBe("Updated uBlock from 1.1 to 1.2");
    expect(
      browserExtensionInstalledMessage({
        profileId,
        extension,
        updated: true,
        previousVersion: "1.2",
      }),
    ).toBe("Reinstalled uBlock 1.2");
  });
});

describe("install sources", () => {
  it("reinstalls from the store by ID and a folder by its path", () => {
    const id = "a".repeat(32);
    expect(browserExtensionReinstallSource({ id, source: { type: "webStore" } })).toBe(id);
    expect(
      browserExtensionReinstallSource({ id, source: { type: "folder", path: "/ext/one" } }),
    ).toBe("/ext/one");
  });

  it("tells folder paths from store links and IDs", () => {
    expect(isFolderInstallSource("/Users/me/ext")).toBe(true);
    expect(isFolderInstallSource("C:\\ext")).toBe(true);
    expect(isFolderInstallSource("https://chromewebstore.google.com/detail/x/abc")).toBe(false);
    expect(isFolderInstallSource("a".repeat(32))).toBe(false);
  });

  it("prefers the server's message over the fallback", () => {
    expect(browserExtensionErrorMessage({ message: "Not a Web Store link." }, "fallback")).toBe(
      "Not a Web Store link.",
    );
    expect(browserExtensionErrorMessage(undefined, "fallback")).toBe("fallback");
  });
});
