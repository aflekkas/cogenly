import { describe, expect, it, vi } from "vite-plus/test";

import {
  filterAvailableSettingsSearchItems,
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
  it("finds AI greetings on General without restoring the moved model picker", () => {
    expect(searchSettings("AI greetings")).toContainEqual(
      expect.objectContaining({
        id: "ai-greetings",
        to: "/settings/general",
      }),
    );
    expect(searchSettings("text generation model")).toContainEqual(
      expect.objectContaining({
        id: "text-generation-model",
        to: "/settings/models",
      }),
    );
  });
  it.each(["OTel", "OTLP", "telemetry export", "Grafana"])(
    "finds environment telemetry settings for %s",
    (query) => {
      expect(searchSettings(query)).toContainEqual(
        expect.objectContaining({
          id: "telemetry-export",
          to: "/settings/diagnostics",
          targetId: "telemetry-export",
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
      "source-control-writer-model",
      "source-control-writing-style",
      "worktree-branch-naming",
      "github-accounts",
      "t3-connect",
      "hold-webhooks-while-offline",
      "wsl-backend",
    ]);
    // A renamed or removed id would make the check below pass vacuously.
    const catalogIds = new Set<string>(SETTINGS_SEARCH_ITEMS.map((item) => item.id));
    expect([...gatedIds].filter((id) => !catalogIds.has(id))).toEqual([]);
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
    ["new threads", "new-threads", "/settings/new-threads"],
    ["workspace", "project-defaults", "/settings/new-threads"],
    ["projects folder", "projects-folder", "/settings/project-tags"],
    ["folder browser", "add-project-starts-in", "/settings/project-tags"],
    ["live processes", "diagnostics", "/settings/diagnostics"],
    ["agent browser access", "agent-browser-access", "/settings/integrations"],
    ["computer use", "agent-computer-use", "/settings/integrations"],
    ["connect a service", "integration-add", "/settings/integrations"],
    ["add integration", "integration-add", "/settings/integrations"],
    ["tab size", "browser-default-viewport", "/settings/integrations"],
    ["browser viewport", "browser-default-viewport", "/settings/integrations"],
    ["show clicks", "browser-recording-mouse-presses", "/settings/integrations"],
    ["chrome web store", "browser-extensions", "/settings/integrations"],
    ["screen recording", "agent-computer-use", "/settings/integrations"],
    ["connect a machine", "remote-environments", "/settings/connections"],
    ["private access", "machines", "/settings/machines"],
    ["orphan folders", "project-folders", "/settings/project-tags"],
    ["leftover folders", "project-folders", "/settings/project-tags"],
    ["automatically pull", "automatic-pull", "/settings/source-control"],
    ["background fetch", "git-fetch-interval", "/settings/source-control"],
    ["pull request templates", "follow-change-request-templates", "/settings/source-control"],
    ["branch naming", "worktree-branch-naming", "/settings/source-control"],
    ["actions", "project-actions", "/settings/projects"],
    ["project overview", "project-overview", "/settings/projects"],
    ["time format", "time-format", "/settings/appearance"],
    ["chat width", "chat-width", "/settings/appearance"],
    ["color blind", "diff-colors", "/settings/appearance"],
    ["auto-resume limited threads", "auto-resume-limited-threads", "/settings/general"],
  ])("routes %s to its owning category", (query, id, to) => {
    expect(searchSettings(query)[0]).toMatchObject({ id, to });
  });

  it("finds the one Tailscale switch on the Machines page", () => {
    const results = searchSettings("tailscale serve");
    expect(results[0]?.id).toBe("machines");
    expect(results.every((item) => item.to === "/settings/machines")).toBe(true);
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
  });

  it("finds Scheduled tasks by the words people use for automations", () => {
    expect(searchSettings("cron")[0]).toMatchObject({
      id: "scheduled-tasks",
      to: "/settings/scheduled-tasks",
    });
    expect(searchSettings("webhook deliveries")[0]?.id).toBe("scheduled-tasks");
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
    ["projects-folder", "/settings/project-tags"],
    ["project-actions", "/settings/projects"],
    ["diagnostics", "/settings/diagnostics"],
    ["#time-format", "/settings/appearance"],
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
