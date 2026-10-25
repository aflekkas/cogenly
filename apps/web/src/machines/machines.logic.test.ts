import type {
  EnvironmentId,
  MachineInfo,
  MachineListResult,
  ThreadId,
  ThreadMoveSkip,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chunkThreadIds,
  machineMoveTargets,
  machineMoveTargetsForThreads,
  summarizeProjectMove,
  summarizeThreadMove,
  threadOwnerMachine,
  threadsRunOnName,
} from "./machines.logic";

const env = (id: string) => id as EnvironmentId;
const thread = (id: string) => id as ThreadId;

function machine(
  id: string,
  name: string,
  relation: MachineInfo["relation"],
  overrides: Partial<MachineInfo> = {},
): MachineInfo {
  return {
    environmentId: env(id),
    name,
    kind: relation === "this" ? "this-computer" : "other-computer",
    hardware: "laptop",
    platform: "darwin",
    relation,
    online: true,
    lastSeenAt: null,
    pairedAt: null,
    pairing: relation === "this" ? "self" : "paired",
    providers: [],
    ...overrides,
  };
}

// A MacBook spoke as it sees the pairing: itself, its hub, and another spoke.
const macbookView: MachineListResult = {
  machines: [
    machine("mac", "MacBook", "this"),
    machine("vps", "VPS", "hub", { kind: "cloud-server", hardware: "server" }),
    machine("mini", "Mac mini", "peer"),
  ],
  link: {
    _tag: "spoke",
    hubEnvironmentId: env("vps"),
    status: "online",
    route: null,
    lastError: null,
  },
};

// The hub's view: itself and two spokes, one offline, one revoked.
const hubView: MachineListResult = {
  machines: [
    machine("vps", "VPS", "this"),
    machine("mac", "MacBook", "spoke"),
    machine("mini", "Mac mini", "spoke", { online: false }),
    machine("old", "Old laptop", "spoke", { pairing: "revoked" }),
  ],
  link: { _tag: "hub", spokes: 3 },
};

const skip = (
  id: string,
  reason: ThreadMoveSkip["reason"],
  detail: string = reason,
): ThreadMoveSkip => ({
  threadId: thread(id),
  reason,
  detail,
});

describe("machineMoveTargets", () => {
  it("offers paired machines, not this one unless asked", () => {
    expect(machineMoveTargets(macbookView).map((target) => target.name)).toEqual([
      "Mac mini",
      "VPS",
    ]);
    expect(machineMoveTargets(macbookView, undefined, true).map((target) => target.name)).toEqual([
      "Mac mini",
      "MacBook",
      "VPS",
    ]);
    expect(machineMoveTargets(hubView)).toEqual([
      { environmentId: "mini", name: "Mac mini", online: false, icon: "laptop" },
      { environmentId: "mac", name: "MacBook", online: true, icon: "laptop" },
    ]);
  });

  it("offers nothing standalone or before the list arrives", () => {
    expect(machineMoveTargets(null)).toEqual([]);
    expect(
      machineMoveTargets({
        machines: [machine("mac", "MacBook", "this")],
        link: { _tag: "standalone" },
      }),
    ).toEqual([]);
    expect(
      machineMoveTargets(
        { machines: [machine("mac", "MacBook", "this")], link: { _tag: "standalone" } },
        undefined,
        true,
      ),
    ).toEqual([]);
  });

  it("leaves out the machine that already runs every selected thread", () => {
    // Every selected thread runs elsewhere, so this machine can take them.
    expect(machineMoveTargetsForThreads(hubView, [env("mac")]).map((t) => t.name)).toEqual([
      "Mac mini",
      "VPS",
    ]);
    // Mixed owners keep every target: some threads still need to move there.
    expect(machineMoveTargetsForThreads(hubView, [env("mac"), null]).map((t) => t.name)).toEqual([
      "Mac mini",
      "MacBook",
    ]);
    expect(machineMoveTargetsForThreads(macbookView, [env("vps")]).map((t) => t.name)).toEqual([
      "Mac mini",
      "MacBook",
    ]);
  });
});

describe("threadOwnerMachine", () => {
  it("names the paired machine that runs a replica, and nothing for local threads", () => {
    expect(threadOwnerMachine(macbookView, env("vps"))?.name).toBe("VPS");
    expect(threadOwnerMachine(macbookView, null)).toBeNull();
    expect(threadOwnerMachine(macbookView, env("mac"))).toBeNull();
    expect(threadOwnerMachine(null, env("vps"))).toBeNull();
  });

  it("names where held-back changes stay only when one machine runs every thread", () => {
    expect(threadsRunOnName(hubView, [null, null])).toBe("VPS");
    expect(threadsRunOnName(hubView, [env("mac"), env("mac")])).toBe("MacBook");
    expect(threadsRunOnName(hubView, [env("mac"), null])).toBeNull();
  });
});

describe("chunkThreadIds", () => {
  it("splits a large selection into request-sized chunks", () => {
    const ids = Array.from({ length: 2_430 }, (_, index) => thread(`t${index}`));
    expect(chunkThreadIds(ids).map((chunk) => chunk.length)).toEqual([1000, 1000, 430]);
  });
});

describe("summarizeThreadMove", () => {
  it("reports a clean move", () => {
    expect(summarizeThreadMove({ moved: [thread("a")], skipped: [] }, "VPS")).toMatchObject({
      type: "success",
      title: "Moved to VPS",
      localChanges: [],
    });
    expect(
      summarizeThreadMove({ moved: [thread("a"), thread("b")], skipped: [] }, "VPS").title,
    ).toBe("Moved 2 threads to VPS");
  });

  it("shows a single skip's own detail", () => {
    const summary = summarizeThreadMove(
      { moved: [], skipped: [skip("a", "busy", "It is running a turn.")] },
      "VPS",
    );
    expect(summary).toMatchObject({
      type: "error",
      title: "Could not move to VPS",
      description: "It is running a turn.",
    });
  });

  it("counts skips by reason and offers to retry the ones held back by changes", () => {
    const summary = summarizeThreadMove(
      {
        moved: [thread("a")],
        skipped: [
          skip("b", "local-changes"),
          skip("c", "busy"),
          skip("d", "local-changes"),
          skip("e", "rejected"),
        ],
      },
      "VPS",
    );
    expect(summary).toEqual({
      type: "warning",
      title: "Moved 1 of 5 threads to VPS",
      description: "Skipped 2 with unpushed changes, 1 busy, 1 refused.",
      localChanges: ["b", "d"],
    });
  });
});

describe("summarizeProjectMove", () => {
  it("names cloning repositories and moved threads", () => {
    expect(
      summarizeProjectMove(
        {
          repositories: [
            { remote: "github.com/a/one", status: "cloning" },
            { remote: "github.com/a/two", status: "present" },
          ],
          threads: { moved: [thread("a"), thread("b")], skipped: [] },
        },
        "Spawn",
        "VPS",
      ),
    ).toEqual({
      type: "success",
      title: "Moved Spawn to VPS",
      description: "VPS is cloning 1 repository. Moved 2 threads.",
      localChanges: [],
    });
  });

  it("warns about a failed clone and skipped threads", () => {
    const summary = summarizeProjectMove(
      {
        repositories: [{ remote: "github.com/a/one", status: "failed", detail: "No access." }],
        threads: { moved: [thread("a")], skipped: [skip("b", "local-changes", "Unpushed.")] },
      },
      "Spawn",
      "VPS",
    );
    expect(summary).toEqual({
      type: "warning",
      title: "Moved Spawn to VPS",
      description: "Could not clone github.com/a/one: No access. Moved 1 thread. Unpushed.",
      localChanges: ["b"],
    });
  });
});
