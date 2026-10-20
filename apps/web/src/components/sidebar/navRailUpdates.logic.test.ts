import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type DesktopUpdateState,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  collectProviderUpdateRows,
  describeDesktopUpdateRow,
  describeServerUpdateRow,
  describeUpdatesSummary,
  rowNeedsUpdate,
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
    ).toMatchObject({ status: "updating", detail: "Downloading 42%", percent: 42.7 });
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

describe("describeUpdatesSummary", () => {
  const rows = (...statuses: Array<"current" | "available" | "updating" | "failed">) =>
    statuses.map((status, index) => ({ key: String(index), status }));

  it("counts updates on through a batch", () => {
    expect(
      describeUpdatesSummary({ rows: rows("updating", "updating"), batchSize: 2, checking: false }),
    ).toBe("Updating 1 of 2…");
    expect(
      describeUpdatesSummary({ rows: rows("current", "updating"), batchSize: 2, checking: false }),
    ).toBe("Updating 2 of 2…");
    // A row updated on its own, beside one that is still available.
    expect(
      describeUpdatesSummary({
        rows: rows("updating", "available"),
        batchSize: 1,
        checking: false,
      }),
    ).toBe("Updating…");
  });

  it("reports checking, then the result", () => {
    expect(describeUpdatesSummary({ rows: rows("current"), batchSize: 0, checking: true })).toBe(
      "Checking…",
    );
    expect(
      describeUpdatesSummary({ rows: rows("available", "failed"), batchSize: 0, checking: false }),
    ).toBe("2 updates available");
    expect(describeUpdatesSummary({ rows: rows("current"), batchSize: 0, checking: false })).toBe(
      "Everything is up to date",
    );
  });
});
