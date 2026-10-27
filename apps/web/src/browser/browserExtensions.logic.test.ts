import type { BrowserExtension } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  browserExtensionErrorMessage,
  browserExtensionInstalledMessage,
  browserExtensionPermissionLines,
  browserExtensionPermissionSummary,
  browserExtensionPopupSize,
  browserExtensionReinstallSource,
  browserExtensionSidePanelTarget,
  browserExtensionStatus,
  browserExtensionTabGap,
  browserExtensionToolbarLayout,
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

const extensionFixture = (id: string, overrides: Partial<BrowserExtension> = {}) =>
  ({
    id: id.repeat(32),
    name: id,
    version: "1",
    description: "",
    manifestVersion: 3,
    hasAction: true,
    state: "loaded",
    enabled: true,
    source: { type: "webStore" },
    permissions: [],
    hostPermissions: [],
    installedAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  }) satisfies BrowserExtension;

describe("browserExtensionToolbarLayout", () => {
  const ids = (list: ReadonlyArray<BrowserExtension>) => list.map((extension) => extension.name);
  const all = [
    extensionFixture("a"),
    extensionFixture("b", { enabled: false }),
    extensionFixture("c", { hasAction: false }),
    extensionFixture("d"),
    extensionFixture("e", { state: "failed" }),
    extensionFixture("f"),
    extensionFixture("g"),
  ];

  it("shows enabled extensions with an action, three inline and the rest in the menu", () => {
    const layout = browserExtensionToolbarLayout(all);
    expect(ids(layout.inline)).toEqual(["a", "d", "e"]);
    expect(ids(layout.overflow)).toEqual(["f", "g"]);
  });

  it("brings an overflowed extension with an open popup into the last inline slot", () => {
    const layout = browserExtensionToolbarLayout(all, { promoteId: "g".repeat(32) });
    expect(ids(layout.inline)).toEqual(["a", "d", "g"]);
    expect(ids(layout.overflow)).toEqual(["e", "f"]);
  });

  it("leaves the order alone when the promoted extension is already inline", () => {
    const layout = browserExtensionToolbarLayout(all, { promoteId: "a".repeat(32) });
    expect(ids(layout.inline)).toEqual(["a", "d", "e"]);
  });
});

describe("browserExtensionStatus", () => {
  it("says nothing about a running extension", () => {
    expect(browserExtensionStatus(extensionFixture("a"))).toBeNull();
  });

  it("names a load failure with the browser's own words", () => {
    expect(
      browserExtensionStatus(
        extensionFixture("a", { state: "failed", loadError: "Manifest is not valid JSON." }),
      ),
    ).toEqual({
      tone: "destructive",
      label: "Failed to load",
      detail: "Manifest is not valid JSON.",
    });
  });

  it("tells loading and off apart", () => {
    expect(browserExtensionStatus(extensionFixture("a", { state: "installing" }))?.label).toBe(
      "Loading",
    );
    expect(browserExtensionStatus(extensionFixture("a", { enabled: false }))?.label).toBe("Off");
    expect(browserExtensionStatus(extensionFixture("a", { state: "pending" }))).toEqual({
      tone: "muted",
      label: "Starts with its first tab",
      detail: null,
    });
  });
});

describe("browserExtensionTabGap", () => {
  const gap = (input: Partial<Parameters<typeof browserExtensionTabGap>[0]>) =>
    browserExtensionTabGap({
      snapshot: { runtime: "server" },
      rendersNatively: false,
      remoteEnvironmentLabel: null,
      incognito: false,
      ...input,
    });

  it("runs extensions in a streamed server tab", () => {
    expect(gap({})).toBeNull();
    expect(gap({ remoteEnvironmentLabel: "Contabo" })).toBeNull();
  });

  it("points a remote machine's desktop tab at that machine's browser", () => {
    expect(gap({ snapshot: { runtime: "desktop" }, remoteEnvironmentLabel: "Contabo" })).toBe(
      "Extensions run in Contabo's browser.",
    );
  });

  it("asks for a new tab when the desktop app draws this tab natively", () => {
    expect(gap({ rendersNatively: true })).toBe(
      "Extensions run in Cogenly's built-in Chrome. Open a new tab to use them.",
    );
    expect(gap({ snapshot: { runtime: "desktop" } })).toBe(
      "Extensions run in Cogenly's built-in Chrome. Open a new tab to use them.",
    );
  });

  it("keeps Incognito free of extensions", () => {
    expect(gap({ incognito: true })).toBe("Incognito tabs run without extensions.");
  });
});

describe("browserExtensionPopupSize", () => {
  it("takes the surface's size within Chrome's popup bounds", () => {
    expect(browserExtensionPopupSize({ _tag: "freeform", width: 320, height: 180 })).toEqual({
      width: 320,
      height: 180,
    });
    expect(browserExtensionPopupSize({ _tag: "freeform", width: 10, height: 2000 })).toEqual({
      width: 25,
      height: 600,
    });
    expect(browserExtensionPopupSize({ _tag: "freeform", width: 1200, height: 12 })).toEqual({
      width: 800,
      height: 25,
    });
  });

  it("starts at a default size until the page reports one", () => {
    expect(browserExtensionPopupSize(undefined)).toEqual({ width: 360, height: 480 });
    expect(browserExtensionPopupSize({ _tag: "fill" })).toEqual({ width: 360, height: 480 });
  });
});

describe("browserExtensionSidePanelTarget", () => {
  const withPanel = (id: string, overrides: Partial<BrowserExtension> = {}) =>
    extensionFixture(id, { sidePanelPage: "panel.html", ...overrides });

  it("prefers the side panel that opened last, then the first that has one", () => {
    const list = [extensionFixture("a"), withPanel("b"), withPanel("c")];
    expect(browserExtensionSidePanelTarget(list, "c".repeat(32))?.name).toBe("c");
    expect(browserExtensionSidePanelTarget(list, null)?.name).toBe("b");
  });

  it("opens a side panel for an extension still waiting for its first tab", () => {
    expect(
      browserExtensionSidePanelTarget([withPanel("a", { state: "pending" })], null)?.name,
    ).toBe("a");
  });

  it("skips extensions that are off or failed to load", () => {
    const list = [withPanel("a", { enabled: false }), withPanel("b", { state: "failed" })];
    expect(browserExtensionSidePanelTarget(list, "a".repeat(32))).toBeNull();
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
