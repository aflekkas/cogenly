import { DEFAULT_SERVER_SETTINGS } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveNewThreadEnvMode,
  resolveProjectFileBackedSetting,
  resolveProjectFileSettings,
  resolveWorktreeCleanup,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

describe("resolveProjectFileSettings", () => {
  it("walks the setting, then the file, then the built-in for file-backed keys", () => {
    const file = { defaultThreadEnvMode: "worktree" as const };
    const fromSetting = resolveProjectFileSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" },
      file,
    );
    expect(fromSetting.settings.defaultThreadEnvMode).toBe("local");
    expect(fromSetting.sources.defaultThreadEnvMode).toBe("environment");

    const fromFile = resolveProjectFileSettings(DEFAULT_SERVER_SETTINGS, file);
    expect(fromFile.settings.defaultThreadEnvMode).toBe("worktree");
    expect(fromFile.sources.defaultThreadEnvMode).toBe("cogenly.json");

    const builtIn = resolveProjectFileSettings(DEFAULT_SERVER_SETTINGS, null);
    expect(builtIn.settings.defaultThreadEnvMode).toBe("local");
    expect(builtIn.sources.defaultThreadEnvMode).toBe("environment");
    // A file that does not mention the key leaves the source alone too.
    expect(
      resolveProjectFileSettings(DEFAULT_SERVER_SETTINGS, {}).sources.defaultThreadEnvMode,
    ).toBe("environment");
  });

  it("resolves one key from the setting, then the file, then the built-in", () => {
    expect(
      resolveProjectFileBackedSetting("worktreeSubmodules", "none", {
        worktreeSubmodules: "top-level",
      }),
    ).toEqual({ value: "none", source: "environment" });
    expect(
      resolveProjectFileBackedSetting("worktreeSubmodules", null, {
        worktreeSubmodules: "top-level",
      }),
    ).toEqual({ value: "top-level", source: "cogenly.json" });
    expect(resolveProjectFileBackedSetting("worktreeSubmodules", null, null)).toEqual({
      value: "recursive",
      source: "environment",
    });
  });
});

describe("resolveNewThreadEnvMode", () => {
  const worktreeEnvironment = resolveProjectFileSettings(
    { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
    null,
  );
  const newProject = {
    projectSettings: worktreeEnvironment,
    workspaceRoot: "/data/projects/pinball-stats",
    newProjectsRoot: "/data/projects/",
    projectHasThreads: false,
  };

  it("starts a new project's first thread in its checkout", () => {
    expect(resolveNewThreadEnvMode(newProject)).toBe("local");
    expect(
      resolveNewThreadEnvMode({
        ...newProject,
        workspaceRoot: "C:\\Data\\Projects\\Pinball-Stats",
        newProjectsRoot: "c:/data/projects",
      }),
    ).toBe("local");
  });

  it("keeps the configured default once the project has a thread or is not a new project", () => {
    expect(resolveNewThreadEnvMode({ ...newProject, projectHasThreads: true })).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects" })).toBe(
      "worktree",
    );
    expect(
      resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects/a/nested" }),
    ).toBe("worktree");
    expect(resolveNewThreadEnvMode({ ...newProject, workspaceRoot: "/data/projects-old/a" })).toBe(
      "worktree",
    );
    expect(resolveNewThreadEnvMode({ ...newProject, newProjectsRoot: undefined })).toBe("worktree");
  });

  it("lets a cogenly.json the setting defers to keep worktree mode", () => {
    const projectSettings = resolveProjectFileSettings(DEFAULT_SERVER_SETTINGS, {
      defaultThreadEnvMode: "worktree",
    });
    expect(resolveNewThreadEnvMode({ ...newProject, projectSettings })).toBe("worktree");
  });
});

describe("resolveWorktreeCleanup", () => {
  it("reads the machine's storage rules, and turns them off when cleanup is off", () => {
    const machine = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: {
        worktreeAfterDays: 8,
        worktreeSettledAfterDays: 2,
        worktreeKeepWhen: "any-local-files",
        worktreeOnDelete: true,
        logsAfterDays: 3,
      },
    });
    expect(resolveWorktreeCleanup(machine)).toMatchObject({
      worktreeSettledAfterDays: 2,
      worktreeKeepWhen: "any-local-files",
    });
    const off = applyServerSettingsPatch(machine, { worktreeCleanup: { mode: "off" } });
    expect(resolveWorktreeCleanup(off)).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnDelete: false,
      worktreeOnMerge: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "any-local-files",
    });
  });

  it("completes partial machine custom rules and preserves them across edits", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeSettledAfterDays: 0, worktreeOnDelete: true },
    });
    const custom = applyServerSettingsPatch(initial, {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnMerge: true } },
    });
    const edited = applyServerSettingsPatch(custom, {
      worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 15 } },
    });
    expect(resolveWorktreeCleanup(edited)).toEqual({
      worktreeAfterDays: 15,
      worktreeSettledAfterDays: 0,
      worktreeOnDelete: true,
      worktreeOnMerge: true,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
    });
    expect(
      resolveWorktreeCleanup(applyServerSettingsPatch(edited, { worktreeCleanup: null }))
        .worktreeAfterDays,
    ).toBe(8);
  });
});
