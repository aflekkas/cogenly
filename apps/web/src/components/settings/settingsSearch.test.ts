import { describe, expect, it, vi } from "vite-plus/test";

import {
  filterAvailableSettingsSearchItems,
  getSettingsSearchTargetScope,
  isSettingsSearchScopeAvailable,
  movedGeneralSettingsPath,
  searchableSetting,
  searchSettings,
  SETTINGS_DETAIL_PARENTS,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  settingsNavPathFor,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
    searchTerms: ["long lines in code previews"],
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it.each(["OTel", "OTLP", "telemetry export", "Grafana"])(
    "finds environment telemetry settings for %s",
    (query) => {
      expect(searchSettings(query)).toContainEqual(
        expect.objectContaining({
          id: "telemetry-export",
          to: "/settings/diagnostics",
          targetId: "telemetry-export",
          scope: "environment",
        }),
      );
    },
  );
  it.each(["send shortcut", "multiline", "new line"])("finds Send shortcut for %s", (query) => {
    expect(searchSettings(query).map((item) => item.id)).toContain("send-shortcut");
  });

  it("matches titles, sections, and remembered setting details", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
    expect(searchSettings("long lines", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass")).toEqual([]);
    expect(searchSettings("panel animations")).toEqual([]);
    expect(searchSettings("thè\u{1ab0}mes")).toEqual([]);
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("gıt");
    try {
      expect(searchSettings("GIT")[0]?.id).toBe("git-fetch-interval");
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it("lists thread confirmations in panel order", () => {
    expect(searchSettings("confirmation").map((item) => item.id)).toEqual([
      "archive-confirmation",
      "delete-confirmation",
    ]);
  });

  it.each(["usage providers", "CLIProxyAPI", "CLI proxy hub", "management key"])(
    "finds usage-provider management by %s",
    (query) => {
      expect(searchSettings(query)[0]).toMatchObject({
        id: "usage-providers",
        to: "/settings/providers",
      });
    },
  );

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("hold to quit")).toEqual([]);
    expect(searchSettings("wsl")).toEqual([]);
    expect(searchSettings("update track")).toEqual([]);
  });

  it("finds the About update rows", () => {
    expect(searchSettings("check for updates").map((item) => item.id)).toContain("app-version");
    expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === "update-track")).toMatchObject({
      title: "Update track",
      to: "/settings/general",
      hostedChannelOnly: true,
    });
  });

  it("hides macOS-only settings on other platforms", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    try {
      expect(searchSettings("font smoothing")).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("registers the WSL backend as a desktop-only setting", () => {
    expect(SETTINGS_SEARCH_ITEMS.find((item) => item.id === "wsl-backend")).toMatchObject({
      id: "wsl-backend",
      title: "WSL backend",
      to: "/settings/connections",
      desktopOnly: true,
      windowsOnly: true,
    });
  });

  it("hides settings whose controls are unavailable", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
    });

    const gatedIds = new Set<string>([
      "follow-change-request-templates",
      "git-fetch-interval",
      "network-access",
      "publish-agent-activity",
      "provider-health-check-interval",
      "cursor-keychain-usage",
      "source-control-writer-model",
      "review-guide-model",
      "review-guide-instructions",
      "source-control-writing-style",
      "t3-connect",
      "hold-webhooks-while-offline",
      "tailscale-https",
      "wsl-backend",
    ]);
    expect(available.map((item) => item.id).filter((id) => gatedIds.has(id))).toEqual([]);
  });

  it("keeps the local toggle searchable without offering hidden host publishing controls", () => {
    const availability = {
      hasCloudPublicConfig: true,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
    };
    const remoteOnly = filterAvailableSettingsSearchItems({
      ...availability,
      localEnvironmentDisabled: true,
    }).map((item) => item.id);
    expect(remoteOnly).toContain("local-environment");
    expect(remoteOnly).not.toContain("t3-connect");
    expect(remoteOnly).not.toContain("publish-agent-activity");
    expect(remoteOnly).not.toContain("wsl-backend");
    // Browsers without access:write still render CloudLinkRow for their host.
    const browser = filterAvailableSettingsSearchItems(availability).map((item) => item.id);
    expect(browser).toContain("publish-agent-activity");
  });

  it("offers webhook holding only while the managed tunnel is on, like its row", () => {
    const availability = {
      hasCloudPublicConfig: true,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: true,
      isWslSettingsRowVisible: false,
    };
    const itemIds = (managedTunnelActive: boolean) =>
      filterAvailableSettingsSearchItems({ ...availability, managedTunnelActive }).map(
        (item) => item.id,
      );
    expect(itemIds(false)).not.toContain("hold-webhooks-while-offline");
    expect(itemIds(true)).toContain("hold-webhooks-while-offline");
  });

  it("finds keybinding commands by label, command id, and default key", () => {
    expect(searchSettings("toggle sidebar")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("sidebar.toggle")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("mod+b")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("copy link")[0]).toMatchObject({
      id: "keybinding-thread.copyReference",
      to: "/settings/keybindings",
    });
  });

  it("ranks keybinding commands after other settings", () => {
    const ids = searchSettings("model").map((item) => item.id);
    expect(ids[0]).toBe("default-model");
    expect(ids.indexOf("keybinding-modelPicker.toggle")).toBeGreaterThan(
      ids.indexOf("text-generation-model"),
    );
  });

  it("sends commands without a default binding to the section", () => {
    expect(searchSettings("thread.stop")[0]).toMatchObject({
      id: "keybinding-thread.stop",
      targetId: "keybindings",
    });
    expect(searchSettings("sidebar.toggle")[0]?.targetId).toBeUndefined();
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("color-scheme")).toEqual({
      id: "color-scheme",
      title: "Color scheme",
    });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "Archived threads" });
  });

  it("routes the appearance mode control to settings", () => {
    expect(searchSettings("color scheme")[0]).toMatchObject({
      id: "color-scheme",
      to: "/settings/appearance",
    });
  });

  it("routes browser recording quality to integrations", () => {
    const result = searchSettings("recording frame rate")[0];
    expect(result).toMatchObject({
      id: "browser-recording-frame-rate",
      to: "/settings/integrations",
    });
    expect(result).not.toHaveProperty("targetId");
  });

  it("routes where links open to integrations", () => {
    expect(searchSettings("open links in")[0]).toMatchObject({
      id: "browser-link-target",
      to: "/settings/integrations",
    });
    expect(searchSettings("external links")[0]).toMatchObject({ id: "browser-link-target" });
  });

  it("finds the default browser profile action in the profiles list", () => {
    expect(searchSettings("default profile")[0]).toMatchObject({
      id: "browser-default-profile",
      to: "/settings/integrations",
      targetId: "browser-profiles",
    });
  });

  it.each([
    ["default model", "default-model", "/settings/models"],
    ["text generation model", "text-generation-model", "/settings/models"],
    ["new threads", "project-defaults", "/settings/new-threads"],
    ["workspace", "new-threads", "/settings/new-threads"],
    ["projects folder", "projects-folder", "/settings/new-threads"],
    ["live processes", "diagnostics", "/settings/diagnostics"],
    ["agent browser access", "agent-browser-access", "/settings/integrations"],
    ["connect a machine", "remote-environments", "/settings/connections"],
    ["private access", "machines", "/settings/machines"],
    ["orphan folders", "project-folders", "/settings/project-tags"],
    ["automatically pull", "automatic-pull", "/settings/source-control"],
    ["actions", "project-actions", "/settings/new-threads"],
    ["project overview", "project-overview", "/settings/projects"],
  ])("routes %s to its owning category", (query, id, to) => {
    expect(searchSettings(query)[0]).toMatchObject({ id, to });
  });

  it("finds machine pairing on the Machines page", () => {
    expect(searchSettings("add a machine")[0]).toMatchObject({
      id: "add-machine",
      to: "/settings/machines",
      targetId: "machines",
    });
    expect(searchSettings("unpair")[0]).toMatchObject({ id: "machines", to: "/settings/machines" });
    expect(searchSettings("pair machines").map((item) => item.id)).toEqual([
      "machines",
      "add-machine",
    ]);
    expect(getSettingsSearchTargetScope("add-machine")).toEqual({
      title: "Add a machine",
      scope: null,
    });
  });

  it("keeps environment settings discoverable without a primary environment", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
    });
    expect(searchSettings("writing style", available)[0]?.id).toBe("source-control-writing-style");
  });
});

describe("settings search targets", () => {
  it("requires an environment for the resolved telemetry export destination", () => {
    const result = searchSettings("OpenTelemetry export").find(
      (item) => item.id === "telemetry-export",
    )!;
    const target = getSettingsSearchTargetScope(result.targetId ?? result.id)!;
    expect(isSettingsSearchScopeAvailable(target.scope, "all")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "project")).toBe(false);
    expect(isSettingsSearchScopeAvailable(target.scope, "environment")).toBe(true);
  });
  it("treats device-local rows as reachable from every selection", () => {
    const setting = getSettingsSearchTargetScope("time-format")!;
    expect(setting).toEqual({ title: "Time format", scope: null });
    expect(isSettingsSearchScopeAvailable(setting.scope, "project")).toBe(true);
    expect(isSettingsSearchScopeAvailable(setting.scope, "all")).toBe(true);
    expect(getSettingsSearchTargetScope("appearance")).toMatchObject({ scope: null });
    expect(getSettingsSearchTargetScope("missing-setting")).toBeNull();
  });

  it.each(["all", "environment", "project"] as const)(
    "makes browser access editable at the %s scope",
    (kind) => {
      const setting = getSettingsSearchTargetScope("agent-browser-access")!;
      expect(isSettingsSearchScopeAvailable(setting.scope, kind)).toBe(true);
      expect(isSettingsSearchScopeAvailable(setting.scope, "unavailable")).toBe(false);
    },
  );

  it("lets project-scopable rows resolve at every server-backed scope", () => {
    const model = getSettingsSearchTargetScope("text-generation-model")!;
    expect(isSettingsSearchScopeAvailable(model.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(model.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(model.scope, "project")).toBe(true);
  });

  it("reaches source control discovery and git fetch interval from the default scope", () => {
    for (const id of ["source-control", "git-fetch-interval"]) {
      const item = getSettingsSearchTargetScope(id)!;
      expect(isSettingsSearchScopeAvailable(item.scope, "all")).toBe(true);
      expect(isSettingsSearchScopeAvailable(item.scope, "environment")).toBe(true);
      expect(isSettingsSearchScopeAvailable(item.scope, "project")).toBe(false);
    }
  });

  it("keeps environment-wide settings out of project scopes", () => {
    const updates = getSettingsSearchTargetScope("provider-update-checks")!;
    expect(updates.scope).toBe("environment-defaults");
    expect(isSettingsSearchScopeAvailable(updates.scope, "environment")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "all")).toBe(true);
    expect(isSettingsSearchScopeAvailable(updates.scope, "project")).toBe(false);
    const streaming = getSettingsSearchTargetScope("response-streaming")!;
    expect(streaming.scope).toBe("project-defaults");
    expect(isSettingsSearchScopeAvailable(streaming.scope, "project")).toBe(true);
    for (const id of ["legacy-plan-mode", "legacy-context-window-indicator", "legacy-sidebar"]) {
      expect(getSettingsSearchTargetScope(id)!.scope).toBeNull();
    }
  });
});

describe("settings sidebar scope", () => {
  it("keeps project actions to a project scope", () => {
    const actions = getSettingsSearchTargetScope("project-actions")!;
    expect(isSettingsSearchScopeAvailable(actions.scope, "project")).toBe(true);
    expect(isSettingsSearchScopeAvailable(actions.scope, "all")).toBe(false);
    expect(isSettingsSearchScopeAvailable(actions.scope, "environment")).toBe(false);
  });
});

describe("settings navigation", () => {
  it("lists every page once, in the sidebar or as a detail page", () => {
    const navPaths = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);
    const detailPaths = Object.keys(SETTINGS_DETAIL_PARENTS);
    expect(new Set(navPaths).size).toBe(navPaths.length);
    expect(
      [...navPaths, ...detailPaths.filter((path) => path in SETTINGS_SECTION_LABELS)].toSorted(),
    ).toEqual(Object.keys(SETTINGS_SECTION_LABELS).toSorted());
  });

  it.each([
    ["/settings/models", "/settings/models"],
    ["/settings/diagnostics", "/settings/diagnostics"],
    ["/settings/projects", "/settings/project-tags"],
    ["/settings/open-source-licenses", "/settings/general"],
    ["/settings/general/", "/settings/general"],
    ["/threads", null],
  ])("highlights %s as %s", (pathname, expected) => {
    expect(settingsNavPathFor(pathname)).toBe(expected);
  });

  it.each([
    ["#default-model", "/settings/models"],
    ["text-generation-model", "/settings/models"],
    ["project-defaults", "/settings/new-threads"],
    ["projects-folder", "/settings/new-threads"],
    ["project-actions", "/settings/new-threads"],
    ["diagnostics", "/settings/diagnostics"],
    ["send-shortcut", null],
    ["", null],
  ])("sends the old General anchor %s to %s", (hash, expected) => {
    expect(movedGeneralSettingsPath(hash)).toBe(expected);
  });

  it("moves every General anchor that no search result still places on General", () => {
    const items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS;
    for (const item of items) {
      const moved = movedGeneralSettingsPath(item.targetId ?? item.id);
      if (moved) expect(item.to).toBe(moved);
    }
  });
});
