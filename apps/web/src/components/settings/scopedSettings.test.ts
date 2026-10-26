import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerSettings } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  planScopedSettingsPatch,
  resolveScopedSettingsTargets,
  selectMachineLocalSettingsTargets,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

const macId = EnvironmentId.make("mac");
const vpsId = EnvironmentId.make("vps");

function environment(
  environmentId: EnvironmentId,
  label: string,
  settings: Partial<ServerSettings> = {},
  phase: "connected" | "offline" = "connected",
) {
  return {
    environmentId,
    label,
    connection: { phase },
    serverConfig: { settings: { ...DEFAULT_SERVER_SETTINGS, ...settings } },
  };
}

const mac = environment(macId, "MacBook");
const vps = environment(vpsId, "VPS");
const environments = [mac, vps];
const options = { primaryEnvironmentId: macId };
const all = resolveSettingsScope({}, environments, options);

function writtenTo(plan: ReturnType<typeof planScopedSettingsPatch>) {
  return plan.serverWrites.map((write) => [write.environmentId, write.patch]);
}

describe("scoped settings writes", () => {
  it("keeps a machine-local editor's reads on the selected machine", () => {
    const scope = resolveSettingsScope({ machine: vpsId }, environments, options);
    const targets = resolveScopedSettingsTargets(scope, environments);
    expect(
      selectMachineLocalSettingsTargets(scope, targets).map((target) => target.environmentId),
    ).toEqual([vpsId]);
    // An unavailable selected machine must not silently edit a different machine.
    expect(
      selectMachineLocalSettingsTargets(
        scope,
        targets.filter((target) => target.environmentId !== vpsId),
      ),
    ).toEqual([]);
  });

  it("writes lifecycle scripts only to the selected machine", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "echo local",
        icon: "play" as const,
        runOnWorktreeCreate: true,
        runOnSettle: true,
      },
    ];
    expect(
      writtenTo(planScopedSettingsPatch(all, environments, { defaultProjectScripts: scripts })),
    ).toEqual([[macId, { defaultProjectScripts: scripts }]]);
  });

  it("writes a universal setting to every connected machine", () => {
    const plan = planScopedSettingsPatch(all, environments, { defaultAutoPull: false });
    expect(writtenTo(plan)).toEqual([
      [macId, { defaultAutoPull: false }],
      [vpsId, { defaultAutoPull: false }],
    ]);
  });

  it("writes universal settings from a machine page to every machine too", () => {
    const machinePage = resolveSettingsScope({ machine: vpsId }, environments, {
      ...options,
      machinePage: true,
    });
    const plan = planScopedSettingsPatch(machinePage, environments, {
      defaultAutoPull: false,
      worktreesDirectory: "/disk/worktrees",
    });
    expect(writtenTo(plan)).toEqual([
      [macId, { defaultAutoPull: false }],
      [vpsId, { defaultAutoPull: false, worktreesDirectory: "/disk/worktrees" }],
    ]);
  });

  it("writes a machine-local setting only to the scope's machine", () => {
    const plan = planScopedSettingsPatch(all, environments, { projectsRoot: "~/code" });
    expect(writtenTo(plan)).toEqual([[macId, { projectsRoot: "~/code" }]]);
    const onVps = resolveSettingsScope({ machine: vpsId }, environments, options);
    expect(
      writtenTo(planScopedSettingsPatch(onVps, environments, { projectsRoot: "~/code" })),
    ).toEqual([[vpsId, { projectsRoot: "~/code" }]]);
  });

  it("refuses a write whose machine-local part cannot reach its machine", () => {
    const offline = [mac, environment(vpsId, "VPS", {}, "offline")];
    const onVps = resolveSettingsScope({ machine: vpsId }, offline, options);
    const plan = planScopedSettingsPatch(onVps, offline, {
      defaultAutoPull: false,
      projectsRoot: "~/code",
    });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.unavailableReason).toBe("Connect VPS to save this setting.");
  });

  it("never writes through a removed machine", () => {
    const scope = resolveSettingsScope({ machine: "removed" }, environments, options);
    const plan = planScopedSettingsPatch(scope, environments, { defaultAutoPull: false });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.unavailableReason).not.toBeNull();
  });
});

describe("scoped settings reads", () => {
  it("reads from the scope's machine only", () => {
    const onVps = resolveSettingsScope({ machine: vpsId }, environments, options);
    expect(resolveScopedSettingsTargets(onVps, environments).map((target) => target.label)).toEqual(
      ["VPS"],
    );
  });
});
