import { EnvironmentId, ProjectId, ProjectLabelId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "../../types";
import {
  buildSettingsProjectFolders,
  resolveSettingsScope,
  validateSettingsScopeSearch,
} from "./settingsScope";
import { selectMachineScope, selectProjectScope } from "./settingsScopeAxis";

const laptopId = EnvironmentId.make("laptop");
const serverId = EnvironmentId.make("server");
const environments = [
  { environmentId: laptopId, label: "MacBook", connection: { phase: "connected" as const } },
  { environmentId: serverId, label: "VPS", connection: { phase: "connected" as const } },
];

function project(id: string, environmentId: EnvironmentId): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: id,
    workspaceRoot: `/repos/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

const cogenlyMac = project("cogenly-mac", laptopId);
const docsMac = project("docs-mac", laptopId);
const cogenlyVps = project("cogenly-vps", serverId);
const scratch = project("scratch", laptopId);
const projects = [cogenlyMac, docsMac, cogenlyVps, scratch];

function label(id: string, name: string, repositoryIds: readonly ProjectId[]) {
  return { id: ProjectLabelId.make(id), name, color: undefined, repositoryIds };
}

// The same folder id on both machines, as paired machines sync it.
const folders = buildSettingsProjectFolders(
  [
    {
      environmentId: laptopId,
      label: label("label:cogenly", "Cogenly", [cogenlyMac.id, docsMac.id]),
    },
    { environmentId: serverId, label: label("label:cogenly", "Cogenly", [cogenlyVps.id]) },
    { environmentId: laptopId, label: label("label:empty", "Empty", []) },
    // A repository id the environment no longer has is not a member.
    { environmentId: serverId, label: label("label:gone", "Gone", [ProjectId.make("removed")]) },
  ],
  projects,
);

describe("settings project folders", () => {
  it("dedupes a folder across machines and collects every repository it holds", () => {
    expect(folders).toEqual([
      {
        id: "label:cogenly",
        name: "Cogenly",
        color: undefined,
        members: [cogenlyMac, docsMac, cogenlyVps],
      },
    ]);
  });

  it("leaves out folders without a repository, which cannot hold overrides", () => {
    expect(folders.map((folder) => folder.id)).not.toContain("label:empty");
    expect(folders.map((folder) => folder.id)).not.toContain("label:gone");
  });
});

describe("settings scope search", () => {
  it("ignores the retired scope key from older links", () => {
    expect(validateSettingsScopeSearch({ scope: "device", project: "label:cogenly" })).toEqual({
      project: "label:cogenly",
    });
    expect(validateSettingsScopeSearch({ scope: "all" })).toEqual({});
  });

  it("keeps the repository page key apart from the scope", () => {
    expect(validateSettingsScopeSearch({ repository: "group", unused: true })).toEqual({
      repository: "group",
    });
  });

  it("choosing a project or machine drops a legacy checkout", () => {
    const legacy = { project: "label:cogenly", machine: laptopId, checkout: "old" };
    expect(selectProjectScope(legacy, "all")).toEqual({ machine: laptopId });
    expect(selectMachineScope(legacy, serverId)).toEqual({
      project: "label:cogenly",
      machine: serverId,
    });
  });
});

describe("settings scope resolution", () => {
  const options = { primaryEnvironmentId: laptopId };

  it("defaults to All projects on every machine, read from the primary", () => {
    expect(resolveSettingsScope({}, folders, environments, options)).toMatchObject({
      kind: "all",
      label: "All projects",
      members: [],
      environmentIds: [laptopId, serverId],
      machineId: laptopId,
    });
  });

  it("keeps every machine at All projects when a machine is picked for machine-local rows", () => {
    expect(
      resolveSettingsScope({ machine: serverId }, folders, environments, options),
    ).toMatchObject({ kind: "all", environmentIds: [laptopId, serverId], machineId: serverId });
  });

  it("scopes a project to its repositories on every machine", () => {
    expect(
      resolveSettingsScope({ project: "label:cogenly" }, folders, environments, options),
    ).toMatchObject({
      kind: "project",
      label: "Cogenly",
      members: [cogenlyMac, docsMac, cogenlyVps],
      environmentIds: [laptopId, serverId],
    });
  });

  it("falls back to a connected machine when the primary is offline", () => {
    const offlinePrimary = [
      { ...environments[0]!, connection: { phase: "offline" as const } },
      environments[1]!,
    ];
    expect(resolveSettingsScope({}, folders, offlinePrimary, options)).toMatchObject({
      machineId: serverId,
    });
  });

  it("resolves a machine page to one machine and ignores the project", () => {
    expect(
      resolveSettingsScope({ project: "label:cogenly", machine: serverId }, folders, environments, {
        ...options,
        machinePage: true,
      }),
    ).toMatchObject({
      kind: "environment",
      environmentId: serverId,
      environmentIds: [serverId],
      members: [],
    });
    expect(
      resolveSettingsScope({}, folders, environments, { ...options, machinePage: true }),
    ).toMatchObject({ kind: "environment", environmentId: laptopId });
  });

  it.each([
    // A repository group key from an older link is not a project folder.
    { project: "t3code" },
    { project: "label:empty" },
    { machine: "removed" },
    { project: "label:cogenly", machine: "removed" },
    // Older checkout links never widen to the whole project or All projects.
    { checkout: `${laptopId}:/repos/cogenly-mac` },
    { project: "label:cogenly", checkout: `${laptopId}:/repos/cogenly-mac` },
  ])("never widens an invalid or legacy target: %j", (search) => {
    expect(resolveSettingsScope(search, folders, environments, options)).toMatchObject({
      kind: "unavailable",
      members: [],
      environmentIds: [],
      machineId: null,
    });
  });
});
