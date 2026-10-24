import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "../../types";
import {
  groupProjectOverridesByFolder,
  listProjectOverrides,
  listProviderInstanceOverrides,
  planProviderInstanceOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  resolveScopedSettingsTargets,
} from "./scopedSettings";
import { buildSettingsProjectFolders, resolveSettingsScope } from "./settingsScope";

const macId = EnvironmentId.make("mac");
const vpsId = EnvironmentId.make("vps");
const codex = ProviderInstanceId.make("codex");

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
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  };
}

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

const appMac = project("app-mac", macId);
const appVps = project("app-vps", vpsId);
const loose = project("loose", macId);
const folders = buildSettingsProjectFolders(
  [
    {
      environmentId: macId,
      label: {
        id: ProjectLabelId.make("label:app"),
        name: "App",
        color: undefined,
        repositoryIds: [appMac.id],
      },
    },
    {
      environmentId: vpsId,
      label: {
        id: ProjectLabelId.make("label:app"),
        name: "App",
        color: undefined,
        repositoryIds: [appVps.id],
      },
    },
  ],
  [appMac, appVps, loose],
);

const mac = environment(macId, "MacBook");
const vps = environment(vpsId, "VPS");
const environments = [mac, vps];
const options = { primaryEnvironmentId: macId };
const all = resolveSettingsScope({}, folders, environments, options);

function writtenTo(plan: ReturnType<typeof planScopedSettingsPatch>) {
  return plan.serverWrites.map((write) => [write.environmentId, write.patch]);
}

describe("scoped settings writes", () => {
  it("writes a universal setting to every connected machine", () => {
    const plan = planScopedSettingsPatch(all, environments, { defaultAutoPull: false });
    expect(writtenTo(plan)).toEqual([
      [macId, { defaultAutoPull: false }],
      [vpsId, { defaultAutoPull: false }],
    ]);
  });

  it("writes universal settings from a machine page to every machine too", () => {
    const machinePage = resolveSettingsScope({ machine: vpsId }, folders, environments, {
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
    const onVps = resolveSettingsScope({ machine: vpsId }, folders, environments, options);
    expect(
      writtenTo(planScopedSettingsPatch(onVps, environments, { projectsRoot: "~/code" })),
    ).toEqual([[vpsId, { projectsRoot: "~/code" }]]);
  });

  it("refuses a write whose machine-local part cannot reach its machine", () => {
    const offline = [mac, environment(vpsId, "VPS", {}, "offline")];
    const onVps = resolveSettingsScope({ machine: vpsId }, folders, offline, options);
    const plan = planScopedSettingsPatch(onVps, offline, {
      defaultAutoPull: false,
      projectsRoot: "~/code",
    });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.unavailableReason).toBe("Connect VPS to save this setting.");
  });

  it("writes a project override into every repository of the folder, on every machine", () => {
    const scope = resolveSettingsScope({ project: "label:app" }, folders, environments, options);
    const plan = planScopedSettingsPatch(scope, environments, { defaultAutoPull: false });
    expect(writtenTo(plan)).toEqual([
      [macId, { projectSettingsOverrides: { [appMac.id]: { defaultAutoPull: false } } }],
      [vpsId, { projectSettingsOverrides: { [appVps.id]: { defaultAutoPull: false } } }],
    ]);
  });

  it("does not let a project override a setting that only exists for all projects", () => {
    const scope = resolveSettingsScope({ project: "label:app" }, folders, environments, options);
    const plan = planScopedSettingsPatch(scope, environments, { projectsRoot: "~/code" });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.unavailableReason).toContain("All projects");
  });

  it("never writes through a legacy or missing target", () => {
    for (const search of [{ project: "repo-group-key" }, { checkout: "mac:/repos/app" }]) {
      const scope = resolveSettingsScope(search, folders, environments, options);
      const plan = planScopedSettingsPatch(scope, environments, { defaultAutoPull: false });
      expect(plan.serverWrites).toEqual([]);
      expect(plan.unavailableReason).not.toBeNull();
    }
  });

  it("resets a project override on every repository of the folder", () => {
    const overridden = [
      environment(macId, "MacBook", {
        projectSettingsOverrides: { [appMac.id]: { defaultAutoPull: false } },
      }),
      environment(vpsId, "VPS", {
        projectSettingsOverrides: { [appVps.id]: { defaultAutoPull: false } },
      }),
    ];
    const scope = resolveSettingsScope({ project: "label:app" }, folders, overridden, options);
    const plan = planScopedSettingsClear(scope, overridden, ["defaultAutoPull"]);
    expect(plan.serverWrites.map((write) => write.environmentId)).toEqual([macId, vpsId]);
    expect(planScopedSettingsClear(all, overridden, ["defaultAutoPull"]).serverWrites).toEqual([]);
  });
});

describe("scoped settings reads", () => {
  it("reads All projects from the scope's machine only", () => {
    const onVps = resolveSettingsScope({ machine: vpsId }, folders, environments, options);
    expect(resolveScopedSettingsTargets(onVps, environments).map((target) => target.label)).toEqual(
      ["VPS"],
    );
  });

  it("reads a project from each of its repositories", () => {
    const scope = resolveSettingsScope({ project: "label:app" }, folders, environments, options);
    expect(
      resolveScopedSettingsTargets(scope, environments).map((target) => target.projectId),
    ).toEqual([appMac.id, appVps.id]);
  });

  it("names overriding projects by folder and still counts repositories in no folder", () => {
    const overridden = [
      environment(macId, "MacBook", {
        projectSettingsOverrides: {
          [appMac.id]: { defaultAutoPull: false },
          [loose.id]: { defaultAutoPull: false },
        },
      }),
      environment(vpsId, "VPS", {
        projectSettingsOverrides: { [appVps.id]: { defaultAutoPull: false } },
      }),
    ];
    const grouped = groupProjectOverridesByFolder(
      listProjectOverrides(overridden, ["defaultAutoPull"]),
      folders,
    );
    expect(grouped).toEqual([
      {
        folder: folders[0],
        entries: [
          { environmentId: macId, projectId: appMac.id },
          { environmentId: vpsId, projectId: appVps.id },
        ],
      },
      { folder: null, entries: [{ environmentId: macId, projectId: loose.id }] },
    ]);
  });
});

describe("overrides edited outside a project scope", () => {
  const overridden = [
    environment(macId, "MacBook", {
      projectSettingsOverrides: {
        [appMac.id]: {
          defaultAutoPull: false,
          providerInstances: { [codex]: { enabled: false } },
        },
        [loose.id]: { providerInstances: { [codex]: { enabled: true } } },
      },
    }),
    environment(vpsId, "VPS", {
      projectSettingsOverrides: {
        [appVps.id]: {
          providerInstances: { [codex]: { enabled: false } },
          worktreeCleanup: { mode: "off" },
        },
      },
    }),
  ];

  it("lists a provider's project overrides on every machine", () => {
    expect(listProviderInstanceOverrides(overridden, codex)).toEqual([
      { environmentId: macId, projectId: appMac.id },
      { environmentId: macId, projectId: loose.id },
      { environmentId: vpsId, projectId: appVps.id },
    ]);
  });

  it("resets a provider's project overrides on each machine holding one, keeping other overrides", () => {
    const plan = planProviderInstanceOverridesClear(
      overridden,
      listProviderInstanceOverrides(overridden, codex),
      codex,
    );
    expect(writtenTo(plan)).toEqual([
      [
        macId,
        {
          projectSettingsOverrides: {
            [appMac.id]: { defaultAutoPull: false, providerInstances: {} },
            [loose.id]: null,
          },
        },
      ],
      [
        vpsId,
        {
          projectSettingsOverrides: {
            [appVps.id]: { worktreeCleanup: { mode: "off" }, providerInstances: {} },
          },
        },
      ],
    ]);
  });

  it("lists worktree cleanup overrides so a machine page can reset them", () => {
    expect(listProjectOverrides(overridden, ["worktreeCleanup"])).toEqual([
      { environmentId: vpsId, projectId: appVps.id },
    ]);
  });
});
