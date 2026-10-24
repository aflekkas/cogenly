import type { EnvironmentId, MachineInfo, MachineListResult, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import {
  describeOfflineLaunch,
  mergeRunOnOptions,
  resolveDraftLaunchTarget,
  resolveRunOnPick,
} from "./launchMachine.logic";

const env = (id: string) => id as EnvironmentId;

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

// The MacBook spoke's view: itself, its always-on hub, and another spoke.
const macbookView: MachineListResult = {
  machines: [
    machine("mac", "MacBook", "this"),
    machine("vps", "VPS", "hub", { kind: "cloud-server", hardware: "server" }),
    machine("mini", "Mac mini", "peer", { online: false }),
  ],
  link: {
    _tag: "spoke",
    hubEnvironmentId: env("vps"),
    status: "online",
    route: null,
    lastError: null,
  },
};

const connected = (id: string, label: string, isPrimary = false): EnvironmentOption => ({
  environmentId: env(id),
  projectId: `project-${id}` as ProjectId,
  label,
  isPrimary,
  machine: "laptop",
});

describe("mergeRunOnOptions", () => {
  it("adds the draft environment's paired machines after its connected environments", () => {
    const options = mergeRunOnOptions({
      environments: [connected("mac", "MacBook", true)],
      machines: macbookView,
      pickedMachine: null,
    });
    expect(options.map((option) => [option.label, option.pairedMachine ?? null])).toEqual([
      ["MacBook", null],
      ["Mac mini", { online: false }],
      ["VPS", { online: true }],
    ]);
    expect(options.find((option) => option.label === "VPS")?.machine).toBe("cloud");
  });

  it("lists a paired machine that is also a connected environment once, as that environment", () => {
    const options = mergeRunOnOptions({
      environments: [connected("mac", "MacBook", true), connected("vps", "VPS server")],
      machines: macbookView,
      pickedMachine: null,
    });
    expect(options.map((option) => option.environmentId)).toEqual([
      env("mac"),
      env("vps"),
      env("mini"),
    ]);
    expect(options[1]?.pairedMachine).toBeUndefined();
  });

  it("leaves a standalone machine's choices unchanged", () => {
    const environments = [connected("mac", "MacBook", true)];
    expect(mergeRunOnOptions({ environments, machines: null, pickedMachine: null })).toBe(
      environments,
    );
  });

  it("keeps a picked machine visible before the pairing list arrives", () => {
    const options = mergeRunOnOptions({
      environments: [connected("mac", "MacBook", true)],
      machines: null,
      pickedMachine: env("vps"),
    });
    expect(options.at(-1)).toMatchObject({
      environmentId: "vps",
      label: "Paired machine",
      pairedMachine: { online: false },
    });
  });
});

describe("resolveRunOnPick", () => {
  const options = mergeRunOnOptions({
    environments: [connected("mac", "MacBook", true)],
    machines: macbookView,
    pickedMachine: null,
  });

  it("moves the draft for a connected environment and names a paired-only machine", () => {
    expect(resolveRunOnPick(options, env("mac"))).toMatchObject({ kind: "environment" });
    expect(resolveRunOnPick(options, env("vps"))).toEqual({
      kind: "machine",
      environmentId: "vps",
    });
    expect(resolveRunOnPick(options, env("gone"))).toBeNull();
  });
});

describe("resolveDraftLaunchTarget", () => {
  it("defaults to the draft environment, where the project is checked out", () => {
    expect(
      resolveDraftLaunchTarget({ draftEnvironmentId: env("mac"), launchMachine: undefined }),
    ).toEqual({ environmentId: "mac" });
  });

  it("launches on the draft environment naming a paired-only pick", () => {
    expect(
      resolveDraftLaunchTarget({ draftEnvironmentId: env("mac"), launchMachine: env("vps") }),
    ).toEqual({ environmentId: "mac", machine: "vps" });
  });

  it("names no machine when the pick is the draft environment itself", () => {
    expect(
      resolveDraftLaunchTarget({ draftEnvironmentId: env("mac"), launchMachine: env("mac") }),
    ).toEqual({ environmentId: "mac" });
  });

  it("runs the offline fallback on the draft environment once the pick is cleared", () => {
    const fallback = resolveDraftLaunchTarget({
      draftEnvironmentId: env("mac"),
      launchMachine: null,
    });
    expect(fallback).toEqual({ environmentId: "mac" });
    expect(describeOfflineLaunch({ machineName: "VPS", hereName: "MacBook" })).toEqual({
      title: "VPS is offline",
      description: "Nothing was started or queued. Your draft is unchanged.",
      actionLabel: "Run on MacBook",
    });
  });
});
