import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProjectId, type ServerSettings } from "@cogenly/contracts";

import { projectSettingsDocumentId, UNIVERSAL_SETTINGS_DOCUMENT_ID } from "./settingsDocument.ts";
import {
  canonicalJson,
  planSettingsReconcile,
  reconcileProjectSettingsField,
  reconcileSettingsField,
  settingsBaseKey,
} from "./settingsReconcile.ts";

describe("reconcileSettingsField", () => {
  it("publishes a local edit and applies a peer edit", () => {
    expect(reconcileSettingsField({ local: "b", base: "a", remote: "a", unset: false })).toEqual({
      _tag: "publish",
      value: "b",
    });
    expect(reconcileSettingsField({ local: "a", base: "a", remote: "b", unset: false })).toEqual({
      _tag: "apply",
      value: "b",
    });
    expect(reconcileSettingsField({ local: "a", base: "a", remote: "a", unset: false })).toEqual({
      _tag: "none",
    });
  });

  it("keeps an unpublished local edit over a concurrent peer edit", () => {
    expect(
      reconcileSettingsField({ local: "mine", base: "a", remote: "theirs", unset: false }),
    ).toEqual({ _tag: "publish", value: "mine" });
  });

  it("settles when both sides already agree, whatever the base says", () => {
    expect(reconcileSettingsField({ local: "b", base: "a", remote: "b", unset: false })).toEqual({
      _tag: "settle",
      value: "b",
    });
  });

  it("before the first agreement, adopts the shared value and publishes only customized ones", () => {
    expect(
      reconcileSettingsField({ local: "x", base: undefined, remote: "y", unset: false }),
    ).toEqual({ _tag: "apply", value: "y" });
    expect(
      reconcileSettingsField({ local: "x", base: undefined, remote: undefined, unset: false }),
    ).toEqual({ _tag: "publish", value: "x" });
    expect(
      reconcileSettingsField({ local: "default", base: undefined, remote: undefined, unset: true }),
    ).toEqual({ _tag: "settle", value: "default" });
  });

  it("compares objects regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(
      reconcileSettingsField({
        local: { b: 1, a: 2 },
        base: { a: 2, b: 1 },
        remote: undefined,
        unset: false,
      }),
    ).toEqual({ _tag: "none" });
  });
});

describe("reconcileProjectSettingsField", () => {
  it("publishes the first repository's edit and the others follow it", () => {
    const result = reconcileProjectSettingsField({
      remote: { value: "old" },
      repositories: [
        { local: { value: "old" }, base: { value: "old" } },
        { local: { value: "new" }, base: { value: "old" } },
      ],
    });
    expect(result.publish).toEqual({ value: "new" });
    expect(result.repositories).toEqual([
      { _tag: "apply", value: { value: "new" } },
      { _tag: "settle", value: { value: "new" } },
    ]);
  });

  it("a reset on a peer clears every local repository", () => {
    const result = reconcileProjectSettingsField({
      remote: null,
      repositories: [
        { local: { value: true }, base: { value: true } },
        { local: { value: true }, base: { value: true } },
      ],
    });
    expect(result.publish).toBeUndefined();
    expect(result.repositories).toEqual([
      { _tag: "apply", value: null },
      { _tag: "apply", value: null },
    ]);
  });

  it("a repository newly filed in the project takes the project's overrides", () => {
    const result = reconcileProjectSettingsField({
      remote: { value: "feat" },
      repositories: [{ local: null, base: undefined }],
    });
    expect(result.repositories).toEqual([{ _tag: "apply", value: { value: "feat" } }]);
  });
});

describe("planSettingsReconcile", () => {
  const settings = (patch: Partial<ServerSettings>): ServerSettings => ({
    ...DEFAULT_SERVER_SETTINGS,
    ...patch,
  });
  const repository = ProjectId.make("repo-1");
  const universalBase = (input: ServerSettings) =>
    planSettingsReconcile({
      settings: input,
      base: new Map(),
      documents: new Map(),
      projects: new Map(),
    }).base;

  it("ignores lifecycle scripts in older peer documents and preserves local overrides", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "echo peer",
        icon: "play" as const,
        runOnWorktreeCreate: true,
        runOnSettle: true,
      },
    ];
    const local = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [repository]: { defaultProjectScripts: [] },
      },
    };
    const plan = planSettingsReconcile({
      settings: local,
      base: new Map(),
      projects: new Map([["label:app", [repository]]]),
      documents: new Map([
        [UNIVERSAL_SETTINGS_DOCUMENT_ID, { defaultProjectScripts: scripts }],
        [projectSettingsDocumentId("label:app"), { defaultProjectScripts: { value: scripts } }],
      ]),
    });
    expect(plan.settings).toBeNull();
    expect(
      [...plan.publish.values()].every((fields) => !Object.hasOwn(fields, "defaultProjectScripts")),
    ).toBe(true);
  });

  it("never publishes machine-local settings", () => {
    const plan = planSettingsReconcile({
      settings: settings({ projectsRoot: "/srv/projects", worktreesDirectory: "/mnt/wt" }),
      base: new Map(),
      documents: new Map(),
      projects: new Map(),
    });
    expect(plan.publish.size).toBe(0);
    expect(plan.settings).toBeNull();
    expect(plan.base.some((entry) => entry.key === "projectsRoot")).toBe(false);
  });

  it("applies a peer's universal value and keeps local paths", () => {
    const local = settings({ projectsRoot: "/Users/me/Cogenly" });
    const base = new Map(
      universalBase(local).map((entry) => [
        settingsBaseKey(entry.documentId, entry.scope, entry.key),
        entry.value,
      ]),
    );
    const plan = planSettingsReconcile({
      settings: local,
      base,
      documents: new Map([[UNIVERSAL_SETTINGS_DOCUMENT_ID, { branchNamePrefix: "feat" }]]),
      projects: new Map(),
    });
    expect(plan.settings?.branchNamePrefix).toBe("feat");
    expect(plan.settings?.projectsRoot).toBe("/Users/me/Cogenly");
    expect(plan.publish.size).toBe(0);
  });

  it("publishes a customized local value on first run", () => {
    const plan = planSettingsReconcile({
      settings: settings({ defaultAutoPull: true }),
      base: new Map(),
      documents: new Map(),
      projects: new Map(),
    });
    expect(plan.publish.get(UNIVERSAL_SETTINGS_DOCUMENT_ID)).toEqual({ defaultAutoPull: true });
  });

  it("writes a project's override into every local repository in it", () => {
    const other = ProjectId.make("repo-2");
    const plan = planSettingsReconcile({
      settings: settings({}),
      base: new Map(),
      documents: new Map([
        [projectSettingsDocumentId("label-1"), { branchNamePrefix: { value: "proj" } }],
      ]),
      projects: new Map([["label-1", [repository, other]]]),
    });
    expect(plan.settings?.projectSettingsOverrides[repository]).toEqual({
      branchNamePrefix: "proj",
    });
    expect(plan.settings?.projectSettingsOverrides[other]).toEqual({ branchNamePrefix: "proj" });
  });

  it("publishes an override set on one repository and keeps a null override", () => {
    const plan = planSettingsReconcile({
      settings: settings({
        projectSettingsOverrides: { [repository]: { defaultModelSelection: null } },
      }),
      base: new Map(),
      documents: new Map(),
      projects: new Map([["label-1", [repository]]]),
    });
    expect(plan.publish.get(projectSettingsDocumentId("label-1"))).toEqual({
      defaultModelSelection: { value: null },
    });
    expect(plan.settings).toBeNull();
  });
});
