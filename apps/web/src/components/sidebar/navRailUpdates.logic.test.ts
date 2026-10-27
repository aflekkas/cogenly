import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type DesktopUpdateState,
  type ServerProvider,
} from "@cogenly/contracts";

import {
  collectProviderUpdateRows,
  describeDesktopUpdateRow,
  describeServerUpdateRow,
  describeUpdatesHeroStatus,
  formatCheckedAgo,
  holdDesktopUpdateStateWhileChecking,
  latestCheckedAt,
  rowNeedsUpdate,
  shortenVersionPair,
} from "./navRailUpdates.logic";

function provider(
  driver: string,
  overrides: Partial<ServerProvider> = {},
  advisory: Partial<NonNullable<ServerProvider["versionAdvisory"]>> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(`${driver}-default`),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-20T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "current",
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      updateCommand: "npm i -g cli",
      canUpdate: true,
      checkedAt: null,
      message: null,
      ...advisory,
    },
    ...overrides,
  } as ServerProvider;
}

const behind = { status: "behind_latest", latestVersion: "1.1.0" } as const;

describe("collectProviderUpdateRows", () => {
  it("shows current, available and manual providers with their versions", () => {
    const rows = collectProviderUpdateRows([
      provider("codex"),
      provider("claudeAgent", {}, behind),
      provider("muse", {}, { ...behind, canUpdate: false, updateCommand: null }),
      provider("disabled", { enabled: false }, behind),
    ]);
    expect(
      rows.map(({ driver, status, currentVersion, latestVersion, oneClick }) => ({
        driver,
        status,
        currentVersion,
        latestVersion,
        oneClick,
      })),
    ).toEqual([
      {
        driver: "claudeAgent",
        status: "available",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        oneClick: true,
      },
      {
        driver: "codex",
        status: "current",
        currentVersion: "1.0.0",
        latestVersion: null,
        oneClick: false,
      },
      {
        driver: "muse",
        status: "available",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        oneClick: false,
      },
    ]);
    expect(rows.filter(rowNeedsUpdate)).toHaveLength(2);
  });

  it("reports the server's running and failed updates", () => {
    const state = (status: "running" | "failed", message: string | null = null) => ({
      status,
      startedAt: null,
      finishedAt: null,
      message,
      output: null,
    });
    const [running] = collectProviderUpdateRows([
      provider("codex", { updateState: state("running") }, behind),
    ]);
    const [failed] = collectProviderUpdateRows([
      provider("codex", { updateState: state("failed", "npm exited 1") }, behind),
    ]);
    expect(running).toMatchObject({ status: "updating", oneClick: false });
    expect(failed).toMatchObject({ status: "failed", detail: "npm exited 1", oneClick: true });
  });

  it("shares one row between instances of a driver", () => {
    const rows = collectProviderUpdateRows([
      provider("codex"),
      provider("codex", { instanceId: ProviderInstanceId.make("codex-work") }, behind),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "available", instanceId: "codex-work" });
  });
});

describe("describeDesktopUpdateRow", () => {
  const base: DesktopUpdateState = {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "2.0.0",
    appArch: "arm64",
    hostArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };

  it("walks from available through downloading to restart", () => {
    expect(describeDesktopUpdateRow(base)).toMatchObject({ status: "current", action: null });
    expect(
      describeDesktopUpdateRow({ ...base, status: "available", availableVersion: "2.1.0" }),
    ).toMatchObject({ status: "available", latestVersion: "2.1.0", action: "download" });
    expect(
      describeDesktopUpdateRow({
        ...base,
        status: "downloading",
        availableVersion: "2.1.0",
        downloadPercent: 42.7,
      }),
    ).toMatchObject({ status: "updating", detail: "Downloading · 42%", percent: 42.7 });
    expect(
      describeDesktopUpdateRow({
        ...base,
        status: "downloaded",
        availableVersion: "2.1.0",
        downloadedVersion: "2.1.0",
      }),
    ).toMatchObject({ status: "available", action: "install" });
  });

  it("retries a failed download, or the check when nothing was found", () => {
    expect(
      describeDesktopUpdateRow({
        ...base,
        status: "error",
        errorContext: "download",
        availableVersion: "2.1.0",
        message: "network down",
      }),
    ).toMatchObject({ status: "failed", detail: "network down", action: "download" });
    expect(
      describeDesktopUpdateRow({ ...base, status: "error", errorContext: "check" }),
    ).toMatchObject({ status: "failed", action: "check" });
  });
});

describe("describeServerUpdateRow", () => {
  it("shows a server only while it is behind or updating", () => {
    const idle = { status: "idle" } as const;
    expect(
      describeServerUpdateRow({ currentVersion: "2.0.0", behindVersion: null, state: idle }),
    ).toBeNull();
    expect(
      describeServerUpdateRow({ currentVersion: "2.0.0", behindVersion: "2.1.0", state: idle }),
    ).toMatchObject({ status: "available", latestVersion: "2.1.0" });
    expect(
      describeServerUpdateRow({
        currentVersion: "2.0.0",
        behindVersion: null,
        state: {
          status: "failed",
          stage: "downloading",
          fromVersion: "2.0.0",
          targetVersion: "2.1.0",
          message: "rolled back",
        },
      }),
    ).toMatchObject({ status: "failed", detail: "rolled back" });
  });

  it("always shows the server that stands in for the app", () => {
    expect(
      describeServerUpdateRow({
        currentVersion: "2.0.0",
        behindVersion: null,
        state: { status: "idle" },
        name: "Cogenly",
        always: true,
      }),
    ).toMatchObject({ name: "Cogenly", status: "current", currentVersion: "2.0.0" });
  });
});

describe("describeUpdatesHeroStatus", () => {
  const app = (
    status: "current" | "available" | "updating" | "failed",
    detail: string | null = null,
  ) => ({ status, detail, latestVersion: status === "current" ? null : "0.1.3" }) as const;
  const base = { ready: false, restarting: false, checking: false };
  const component = (name: string, status: "current" | "available" | "updating" | "failed") => ({
    name,
    status,
  });

  it("speaks for the app first", () => {
    expect(
      describeUpdatesHeroStatus({ ...base, app: app("available"), ready: true, components: [] }),
    ).toEqual({ tone: "pending", label: "v0.1.3 is ready. Restart to finish." });
    expect(describeUpdatesHeroStatus({ ...base, app: app("available"), components: [] })).toEqual({
      tone: "pending",
      label: "v0.1.3 is available",
    });
    expect(
      describeUpdatesHeroStatus({
        ...base,
        app: app("updating", "Downloading · 64%"),
        components: [component("Codex", "updating")],
      }),
    ).toEqual({ tone: "busy", label: "Downloading · 64%" });
    expect(
      describeUpdatesHeroStatus({ ...base, app: app("failed", "network down"), components: [] }),
    ).toEqual({ tone: "failed", label: "network down" });
    expect(
      describeUpdatesHeroStatus({
        ...base,
        app: app("available"),
        components: [],
        restarting: true,
      }),
    ).toEqual({ tone: "busy", label: "Restarting soon" });
  });

  it("names what is updating, failed or waiting instead of counting it", () => {
    const current = app("current");
    expect(
      describeUpdatesHeroStatus({
        ...base,
        app: app("available"),
        components: [component("Claude", "updating"), component("Muse Code", "updating")],
      }),
    ).toEqual({ tone: "busy", label: "Updating Claude and Muse Code…" });
    expect(
      describeUpdatesHeroStatus({
        ...base,
        app: current,
        components: [
          component("Claude", "available"),
          component("Codex", "available"),
          component("Muse Code", "available"),
          component("Cogenly server", "available"),
        ],
      }),
    ).toEqual({ tone: "pending", label: "Updates for Claude, Codex and 2 more" });
    expect(
      describeUpdatesHeroStatus({
        ...base,
        app: current,
        components: [component("Codex", "failed"), component("Claude", "available")],
      }),
    ).toEqual({ tone: "failed", label: "Codex didn't update" });
  });

  it("reports checking, then everything current", () => {
    const components = [component("Codex", "current")];
    expect(
      describeUpdatesHeroStatus({ ...base, app: app("current"), components, checking: true }),
    ).toEqual({ tone: "busy", label: "Checking for updates…" });
    expect(describeUpdatesHeroStatus({ ...base, app: app("current"), components })).toEqual({
      tone: "current",
      label: "Everything is up to date",
    });
  });
});

describe("shortenVersionPair", () => {
  it("drops build suffixes", () => {
    expect(shortenVersionPair("1.4.13-R6996.1", "1.4.14-R7309.1")).toEqual({
      current: "1.4.13",
      next: "1.4.14",
    });
    expect(shortenVersionPair("1.4.13-R6996.1", null)).toEqual({
      current: "1.4.13",
      next: null,
    });
  });

  it("keeps prereleases, plain versions, and pairs that differ only in their build", () => {
    expect(shortenVersionPair("1.0.0-beta.1", "1.0.0-rc.2")).toEqual({
      current: "1.0.0-beta.1",
      next: "1.0.0-rc.2",
    });
    expect(shortenVersionPair("2.1.311", "2.1.312")).toEqual({
      current: "2.1.311",
      next: "2.1.312",
    });
    expect(shortenVersionPair("1.4.13-R6996.1", "1.4.13-R7309.1")).toEqual({
      current: "1.4.13-R6996.1",
      next: "1.4.13-R7309.1",
    });
  });
});

describe("checked at", () => {
  it("takes the newest valid instant", () => {
    expect(latestCheckedAt([null, "nope", "2026-10-22T10:00:00Z", "2026-10-22T09:00:00Z"])).toBe(
      Date.parse("2026-10-22T10:00:00Z"),
    );
    expect(latestCheckedAt([undefined, null])).toBeNull();
  });

  it("reads as plain words", () => {
    const now = Date.parse("2026-10-22T10:00:00Z");
    expect(formatCheckedAgo(now - 30_000, now)).toBe("just now");
    expect(formatCheckedAgo(now - 60_000, now)).toBe("1 minute ago");
    expect(formatCheckedAgo(now - 2 * 60_000, now)).toBe("2 minutes ago");
    expect(formatCheckedAgo(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(formatCheckedAgo(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(formatCheckedAgo(now - 72 * 3_600_000, now)).toBe("3 days ago");
  });
});

describe("holdDesktopUpdateStateWhileChecking", () => {
  const idle: DesktopUpdateState = {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "0.1.5",
    appArch: "arm64",
    hostArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: "2026-10-22T10:00:00.000Z",
    message: null,
    errorContext: null,
    canRetry: false,
  };
  const available: DesktopUpdateState = { ...idle, status: "available", availableVersion: "0.1.9" };
  const checking: DesktopUpdateState = {
    ...available,
    status: "checking",
    checkedAt: "2026-10-22T10:05:00.000Z",
  };

  it("keeps a known update, its button and its version through a re-check", () => {
    const shown = holdDesktopUpdateStateWhileChecking(checking, available);
    expect(shown).toMatchObject({ status: "available", checkedAt: checking.checkedAt });
    expect(describeDesktopUpdateRow(shown!)).toMatchObject({
      status: "available",
      latestVersion: "0.1.9",
      action: "download",
    });
  });

  it("passes settled states and a first check straight through", () => {
    expect(holdDesktopUpdateStateWhileChecking(available, idle)).toBe(available);
    expect(holdDesktopUpdateStateWhileChecking(checking, null)).toBe(checking);
    expect(holdDesktopUpdateStateWhileChecking(null, available)).toBeNull();
  });

  it("holds nothing across a different build", () => {
    const restarted = { ...checking, currentVersion: "0.1.9" };
    expect(holdDesktopUpdateStateWhileChecking(restarted, available)).toBe(restarted);
  });
});
