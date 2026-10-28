import { EnvironmentId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectUpdateAllTargets,
  groupUpdatesByComponent,
  type MachineUpdates,
  summarizeComponent,
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

describe("summarizeComponent", () => {
  const on = (...rows: ReadonlyArray<UpdateRowView>) =>
    rows.map((entry, index) => ({ id: `m${index}`, machineLabel: `Machine ${index}`, row: entry }));
  const none = new Set<string>();

  it("collapses machines on one version into one plain row", () => {
    expect(
      summarizeComponent(
        on(row("codex", "current", "0.165.0"), row("codex", "current", "0.165.0")),
        none,
      ),
    ).toEqual({ current: "0.165.0", next: null, split: false, percent: null, failure: null });
    expect(
      summarizeComponent(
        on(
          row("claudeAgent", "available", "2.1.311", "2.1.312"),
          row("claudeAgent", "available", "2.1.311", "2.1.312"),
        ),
        none,
      ),
    ).toMatchObject({ current: "2.1.311", next: "2.1.312", split: false });
  });

  it("keeps one machine's own pair and its failure reason", () => {
    expect(
      summarizeComponent(on(row("muse", "failed", "1.4.12", "1.4.13", "npm exited 1")), none),
    ).toEqual({
      current: "1.4.12",
      next: "1.4.13",
      split: false,
      percent: null,
      failure: "npm exited 1",
    });
  });

  it("splits when machines disagree", () => {
    // Different versions, each current by its own check.
    expect(
      summarizeComponent(
        on(row("codex", "current", "0.50.0"), row("codex", "current", "0.49.0")),
        none,
      ),
    ).toMatchObject({ current: "0.50.0", split: true });
    // One behind, one already there.
    expect(
      summarizeComponent(
        on(row("codex", "available", "0.49.0", "0.50.0"), row("codex", "current", "0.50.0")),
        none,
      ),
    ).toMatchObject({ current: "0.49.0", next: "0.50.0", split: true });
    // One failed, one still waiting.
    expect(
      summarizeComponent(
        on(row("codex", "failed", "1", "2", "npm exited 1"), row("codex", "available", "1", "2")),
        none,
      ),
    ).toMatchObject({ split: true, failure: "Failed on Machine 0" });
    // Behind from different versions: only the target.
    expect(
      summarizeComponent(
        on(
          row("codex", "available", "0.48.0", "0.50.0"),
          row("codex", "available", "0.49.0", "0.50.0"),
        ),
        none,
      ),
    ).toMatchObject({ current: null, next: "0.50.0", split: true });
  });

  it("stays one row while a batch updates, filling one bar as machines finish", () => {
    const batch = new Set(["m0", "m1"]);
    expect(
      summarizeComponent(
        on(row("claudeAgent", "updating", "1", "2"), row("claudeAgent", "updating", "1", "2")),
        batch,
      ),
    ).toEqual({ current: "1", next: "2", split: false, percent: 0, failure: null });
    expect(
      summarizeComponent(
        on(row("claudeAgent", "current", "2"), row("claudeAgent", "updating", "1", "2")),
        batch,
      ),
    ).toEqual({ current: "1", next: "2", split: false, percent: 50, failure: null });
  });

  it("passes a lone update's own progress through", () => {
    expect(
      summarizeComponent(
        on({ ...row("muse", "updating", "1", "2"), percent: 41 }),
        new Set(["m0"]),
      ),
    ).toMatchObject({ percent: 41 });
  });

  it("counts failures across several machines", () => {
    expect(
      summarizeComponent(
        on(
          row("codex", "failed", "1", "2"),
          row("codex", "failed", "1", "2"),
          row("codex", "current", "2"),
        ),
        none,
      ),
    ).toMatchObject({ failure: "Failed on 2 machines", split: true });
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
