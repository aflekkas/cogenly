import { EnvironmentId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsScope, validateSettingsScopeSearch } from "./settingsScope";
import { selectMachineScope } from "./settingsScopeAxis";
import { validateSettingsRouteSearch } from "./settingsScopeNavigation";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "MacBook", connection: { phase: "connected" as const } },
  { environmentId: serverId, label: "VPS", connection: { phase: "connected" as const } },
];

describe("settings scope search", () => {
  it("drops the project and checkout keys of links from before settings were global", () => {
    expect(
      validateSettingsScopeSearch({
        project: "label:cogenly",
        checkout: `${laptopId}:/repos/cogenly`,
        machine: serverId,
      }),
    ).toEqual({ machine: serverId });
    expect(validateSettingsRouteSearch({ project: "label:cogenly" })).toEqual({});
    expect(validateSettingsScopeSearch({ scope: "device" })).toEqual({});
  });

  it("keeps the repository page key", () => {
    expect(validateSettingsScopeSearch({ repository: "group", unused: true })).toEqual({
      repository: "group",
    });
  });

  it("maps a legacy provider link's environment to the machine", () => {
    expect(validateSettingsRouteSearch({ environmentId: serverId })).toEqual({
      machine: serverId,
    });
  });

  it("choosing a machine keeps the repository", () => {
    expect(selectMachineScope({ repository: "group", machine: laptopId }, serverId)).toEqual({
      repository: "group",
      machine: serverId,
    });
  });
});

describe("settings scope resolution", () => {
  const options = { primaryEnvironmentId: laptopId };

  it("writes to every machine, reading from the primary", () => {
    expect(resolveSettingsScope({}, environments, options)).toMatchObject({
      kind: "all",
      environmentIds: [laptopId, serverId],
      machineId: laptopId,
    });
  });

  it("keeps every machine when one is picked for machine-local rows", () => {
    expect(resolveSettingsScope({ machine: serverId }, environments, options)).toMatchObject({
      kind: "all",
      environmentIds: [laptopId, serverId],
      machineId: serverId,
    });
  });

  it("falls back to a connected machine when the primary is offline", () => {
    const offlinePrimary = [
      { ...environments[0]!, connection: { phase: "offline" as const } },
      environments[1]!,
    ];
    expect(resolveSettingsScope({}, offlinePrimary, options)).toMatchObject({
      machineId: serverId,
    });
  });

  it("resolves a machine page to one machine", () => {
    expect(
      resolveSettingsScope({ machine: serverId }, environments, { ...options, machinePage: true }),
    ).toMatchObject({ kind: "environment", environmentId: serverId, environmentIds: [serverId] });
    expect(resolveSettingsScope({}, environments, { ...options, machinePage: true })).toMatchObject(
      { kind: "environment", environmentId: laptopId },
    );
  });

  it("never widens a removed machine to every machine", () => {
    expect(resolveSettingsScope({ machine: "removed" }, environments, options)).toMatchObject({
      kind: "unavailable",
      environmentIds: [],
      machineId: null,
    });
  });
});
