import { EnvironmentId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectUpdateAllTargets,
  describeComponentFailure,
  describeComponentProgress,
  describeComponentVersions,
  formatComponentVersionSummary,
  groupUpdatesByComponent,
  type MachineUpdates,
} from "./navRailUpdateGroups.logic";
import type { UpdateRowStatus, UpdateRowView } from "./navRailUpdates.logic";

function row(
  key: string,
  status: UpdateRowStatus,
  currentVersion: string | null,
  latestVersion: string | null = null,
  detail: string | null = null,
): UpdateRowView {
  const names: Record<string, string> = {
    server: "Cogenly server",
    claudeAgent: "Claude",
    codex: "Codex",
    muse: "Muse Code",
  };
  return { key, name: names[key] ?? key, currentVersion, latestVersion, status, detail };
}

function machine(
  id: string,
  rows: ReadonlyArray<UpdateRowView>,
  canUpdate: (row: UpdateRowView) => boolean = () => true,
): MachineUpdates {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    rows: rows.map((entry) => ({ row: entry, canUpdate: canUpdate(entry) })),
  };
}

const summarize = (machines: ReadonlyArray<{ row: UpdateRowView }>) =>
  formatComponentVersionSummary(describeComponentVersions(machines));

describe("groupUpdatesByComponent", () => {
  it("makes one row per component, server first, with each machine under it", () => {
    const groups = groupUpdatesByComponent([
      machine("vps", [
        row("server", "available", "0.2.2", "0.2.3"),
        row("muse", "updating", "1.4.12", "1.4.13"),
        row("codex", "current", "0.50.0"),
      ]),
      machine("mac", [
        row("codex", "available", "0.49.0", "0.50.0"),
        row("muse", "current", "1.4.13"),
      ]),
    ]);
    expect(
      groups.map((group) => ({
        key: group.key,
        status: group.status,
        machines: group.machines.map((entry) => entry.id),
      })),
    ).toEqual([
      { key: "server", status: "available", machines: ["vps:server"] },
      { key: "codex", status: "available", machines: ["vps:codex", "mac:codex"] },
      { key: "muse", status: "updating", machines: ["vps:muse", "mac:muse"] },
    ]);
  });

  it("lets a failure outrank an available update, and an update in flight outrank both", () => {
    const [failed] = groupUpdatesByComponent([
      machine("a", [row("codex", "available", "1", "2")]),
      machine("b", [row("codex", "failed", "1", "2", "npm exited 1")]),
    ]);
    expect(failed?.status).toBe("failed");
    const [updating] = groupUpdatesByComponent([
      machine("a", [row("codex", "failed", "1", "2")]),
      machine("b", [row("codex", "updating", "1", "2")]),
    ]);
    expect(updating?.status).toBe("updating");
  });
});

describe("describeComponentVersions", () => {
  const on = (...rows: ReadonlyArray<UpdateRowView>) => rows.map((entry) => ({ row: entry }));

  it("keeps one machine's own version pair, with no scope", () => {
    expect(summarize(on(row("muse", "available", "1.4.12", "1.4.13")))).toBe("1.4.12 → 1.4.13");
    expect(summarize(on(row("muse", "current", "1.4.13")))).toBe("1.4.13");
  });

  it("says how many machines a shared update reaches", () => {
    expect(
      summarize(
        on(
          row("muse", "available", "1.4.12", "1.4.13"),
          row("muse", "updating", "1.4.12", "1.4.13"),
        ),
      ),
    ).toBe("1.4.12 → 1.4.13 on 2 machines");
    expect(
      summarize(
        on(
          row("muse", "available", "1.4.12", "1.4.13"),
          row("muse", "current", "1.4.13"),
          row("muse", "current", "1.4.13"),
        ),
      ),
    ).toBe("1.4.12 → 1.4.13 on 1 of 3");
  });

  it("counts machines on the target when the behind ones start from different versions", () => {
    expect(
      summarize(
        on(
          row("server", "current", "0.2.3"),
          row("server", "current", "0.2.3"),
          row("server", "current", "0.2.3"),
          row("server", "available", "0.2.2", "0.2.3"),
          row("server", "available", "0.2.1", "0.2.3"),
        ),
      ),
    ).toBe("0.2.3 on 3 of 5");
  });

  it("is short when every machine agrees", () => {
    expect(
      summarize(on(row("codex", "current", "0.50.0"), row("codex", "current", "0.50.0"))),
    ).toBe("0.50.0 on both machines");
    expect(
      summarize(on(...Array.from({ length: 5 }, () => row("codex", "current", "0.50.0")))),
    ).toBe("0.50.0 on all 5 machines");
    // Current by their own checks, yet on different versions.
    expect(
      summarize(
        on(
          row("codex", "current", "0.50.0"),
          row("codex", "current", "0.49.0"),
          row("codex", "current", "0.50.0"),
        ),
      ),
    ).toBe("0.50.0 on 2 of 3");
  });

  it("falls back to a count when machines head to different versions", () => {
    expect(
      summarize(
        on(
          row("codex", "available", "0.48.0", "0.49.0"),
          row("codex", "available", "0.49.0", "0.50.0"),
          row("codex", "current", "0.50.0"),
        ),
      ),
    ).toBe("Updates on 2 of 3");
  });
});

describe("collectUpdateAllTargets", () => {
  it("takes every pending update this session may start, and skips the rest", () => {
    const groups = groupUpdatesByComponent([
      machine(
        "vps",
        [
          row("server", "available", "0.2.2", "0.2.3"),
          row("codex", "available", "1", "2"),
          row("muse", "updating", "1", "2"),
        ],
        // This session cannot manage the VPS's providers.
        (entry) => entry.key === "server",
      ),
      machine("mac", [
        row("codex", "failed", "1", "2", "npm exited 1"),
        row("claudeAgent", "current", "2.1.0"),
      ]),
      // A manual install: behind, but no one-click update.
      machine("box", [row("muse", "available", "1", "2")], () => false),
    ]);
    expect(collectUpdateAllTargets(groups).map((entry) => entry.id)).toEqual([
      "vps:server",
      "mac:codex",
    ]);
  });
});

describe("describeComponentProgress", () => {
  const entry = (id: string, status: UpdateRowStatus, detail: string | null = null) => ({
    id,
    row: row("muse", status, "1", "2", detail),
  });

  it("counts on through the batch as machines finish", () => {
    const batch = new Set(["a", "b", "c"]);
    expect(
      describeComponentProgress(
        [entry("a", "updating"), entry("b", "updating"), entry("c", "updating")],
        batch,
      ),
    ).toEqual({ label: "Updating 1 of 3", percent: 0 });
    expect(
      describeComponentProgress(
        [entry("a", "current"), entry("b", "updating"), entry("c", "updating")],
        batch,
      ),
    ).toMatchObject({ label: "Updating 2 of 3" });
    expect(
      describeComponentProgress(
        [entry("a", "current"), entry("b", "current"), entry("c", "updating")],
        batch,
      ),
    ).toMatchObject({ label: "Updating 3 of 3" });
  });

  it("settles once nothing is updating, and leaves machines outside the batch out", () => {
    expect(
      describeComponentProgress([entry("a", "current"), entry("b", "failed")], new Set(["a", "b"])),
    ).toBeNull();
    expect(
      describeComponentProgress(
        [entry("a", "updating", "Downloading…"), entry("b", "available")],
        new Set(["a"]),
      ),
    ).toEqual({ label: "Downloading…", percent: null });
  });
});

describe("describeComponentFailure", () => {
  const entry = (label: string, status: UpdateRowStatus, detail: string | null = null) => ({
    machineLabel: label,
    row: row("codex", status, "1", "2", detail),
  });

  it("names the machine that failed, or counts them", () => {
    expect(describeComponentFailure([entry("Mac", "failed", "npm exited 1")])).toBe("npm exited 1");
    expect(
      describeComponentFailure([entry("Mac", "failed", "npm exited 1"), entry("VPS", "current")]),
    ).toBe("Failed on Mac: npm exited 1");
    expect(
      describeComponentFailure([
        entry("Mac", "failed"),
        entry("VPS", "failed"),
        entry("Box", "current"),
      ]),
    ).toBe("Failed on 2 of 3 machines");
    expect(describeComponentFailure([entry("Mac", "current")])).toBeNull();
  });
});
