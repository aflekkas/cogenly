import {
  type EnvironmentId,
  ProjectId,
  ProjectLabelId,
  type ProjectLabelRepositoryLink,
  type ProjectLabelWithRepositories,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectMachinesLabel } from "../components/projects/projectPanel.logic";
import {
  possibleDuplicateProjects,
  projectMergeCandidates,
  projectLabelEnvironmentIds,
  projectLabelKey,
  projectLabelOn,
  projectLabelsOn,
  projectRepositoryCount,
  scopedRepositoryKey,
  threadFolderState,
  unifyProjectLabels,
} from "./projectLabels.logic";
import { linkedRepositoryRows } from "./repositoryPicker.logic";

const mac = "mac" as EnvironmentId;
const vps = "vps" as EnvironmentId;

const link = (repositoryId: string, remote: string | null): ProjectLabelRepositoryLink => ({
  repositoryId: ProjectId.make(repositoryId),
  remote,
  directoryName: remote === null ? null : (remote.split("/").at(-1) ?? null),
  checkout: repositoryId.startsWith("remote:") ? "not_cloned" : "ready",
});

function label(
  id: string,
  name: string,
  links: ProjectLabelRepositoryLink[] = [],
  extra: Partial<ProjectLabelWithRepositories> = {},
): ProjectLabelWithRepositories {
  return {
    id: ProjectLabelId.make(id),
    name,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    repositoryIds: links.map((each) => each.repositoryId),
    repositories: links,
    sourceLinks: [],
    threadCount: 0,
    instructions: "",
    projectChatThreadId: null,
    ...extra,
  };
}

// The owner's case: one synced Athens Racing, linked to two repositories on the
// Mac (one without a remote) and one on the VPS, which has the other remote as
// a placeholder only.
const athensOnMac = label("label:athens", "Athens Racing", [
  link("mac-site", "github.com/athens/site"),
  link("mac-notes", null),
]);
const athensOnVps = label("label:athens", "Athens Racing", [
  link("remote:github.com/athens/site", "github.com/athens/site"),
  link("vps-api", "github.com/athens/api"),
]);
const bartrOnVps = label("label:bartr", "Bartr");

describe("unifyProjectLabels", () => {
  const unified = unifyProjectLabels([
    { environmentId: mac, labels: [athensOnMac] },
    { environmentId: vps, labels: [athensOnVps, bartrOnVps] },
  ]);
  const athens = unified.labels.find((entry) => entry.label.name === "Athens Racing")!;

  it("lists a project once however many machines have it", () => {
    expect(unified.labels.map((entry) => entry.label.name)).toEqual(["Athens Racing", "Bartr"]);
    expect(projectLabelEnvironmentIds(athens)).toEqual([mac, vps]);
    expect(athens.environmentId).toBe(mac);
    expect(athens.key).toBe(projectLabelKey(mac, "label:athens"));
  });

  it("finds the one entry by any machine's key and any machine's repository", () => {
    expect(unified.byKey.get(projectLabelKey(vps, "label:athens"))).toBe(athens);
    expect(unified.byKey.get(projectLabelKey(mac, "label:athens"))).toBe(athens);
    expect(unified.folderByRepository.get(scopedRepositoryKey(vps, "vps-api"))).toBe(athens);
    expect(unified.folderByRepository.get(scopedRepositoryKey(mac, "mac-notes"))).toBe(athens);
  });

  it("counts the union of linked repositories, each remote once", () => {
    // site (both), notes (Mac, no remote), api (VPS).
    expect(projectRepositoryCount(athens)).toBe(3);
    const bartr = unified.byKey.get(projectLabelKey(vps, "label:bartr"))!;
    expect(projectRepositoryCount(bartr)).toBe(0);
  });

  it("lists a remote only another machine links as not cloned on the speaking machine", () => {
    const rows = linkedRepositoryRows({ project: athens, localById: new Map() });
    const api = rows.find((row) => row.remote === "github.com/athens/api")!;
    expect(api).toMatchObject({ checkout: "not_cloned", repositoryId: null });
    expect(rows).toHaveLength(3);
  });

  it("gives each machine its own copy, with that machine's repository states", () => {
    const onVps = projectLabelOn(athens, vps)!;
    expect(onVps.key).toBe(athens.key);
    expect(onVps.environmentId).toBe(vps);
    const rows = linkedRepositoryRows({ project: onVps, localById: new Map() });
    expect(rows.find((row) => row.remote === "github.com/athens/site")?.checkout).toBe(
      "not_cloned",
    );
    expect(projectLabelOn(unified.byKey.get(projectLabelKey(vps, "label:bartr"))!, mac)).toBeNull();
    expect(projectLabelsOn(unified.labels, mac).map((entry) => entry.label.name)).toEqual([
      "Athens Racing",
    ]);
  });

  it("names the project as it was most recently edited on any machine", () => {
    const renamed = unifyProjectLabels([
      { environmentId: mac, labels: [athensOnMac] },
      {
        environmentId: vps,
        labels: [
          { ...athensOnVps, name: "Athens Racing Co", updatedAt: "2026-10-02T00:00:00.000Z" },
        ],
      },
    ]);
    expect(renamed.labels[0]?.label.name).toBe("Athens Racing Co");
    expect(renamed.labels[0]?.environmentId).toBe(mac);
  });

  it("works with one machine connected: that machine already has every synced project", () => {
    const vpsOnly = unifyProjectLabels([{ environmentId: vps, labels: [athensOnVps, bartrOnVps] }]);
    expect(vpsOnly.labels.map((entry) => entry.label.name)).toEqual(["Athens Racing", "Bartr"]);
    expect(vpsOnly.labels[0]?.copies).toBeUndefined();
    expect(projectRepositoryCount(vpsOnly.labels[0]!)).toBe(2);
  });

  it("keeps same-name projects with different ids apart", () => {
    const apart = unifyProjectLabels([
      { environmentId: mac, labels: [label("label:a", "Duplicate Demo")] },
      { environmentId: vps, labels: [label("label:b", "Duplicate Demo")] },
    ]);
    expect(apart.labels).toHaveLength(2);
  });
});

describe("threadFolderState across machines", () => {
  it("offers the projects the thread's machine has, as that machine has them", () => {
    const unified = unifyProjectLabels([
      { environmentId: mac, labels: [athensOnMac] },
      { environmentId: vps, labels: [athensOnVps, bartrOnVps] },
    ]);
    const state = threadFolderState(
      {
        environmentId: vps,
        source: {
          projectFolderId: ProjectLabelId.make("label:athens"),
          projectFolderSource: "explicit",
        },
      },
      unified,
    );
    expect(state.current?.label.name).toBe("Athens Racing");
    expect(state.options.map((entry) => [entry.label.name, entry.environmentId])).toEqual([
      ["Athens Racing", vps],
      ["Bartr", vps],
    ]);
  });
});

describe("possibleDuplicateProjects", () => {
  const older = label("label:a", "Duplicate Demo", [], {
    createdAt: "2026-10-01T00:00:00.000Z",
    possibleDuplicateIds: [ProjectLabelId.make("label:b")],
  });
  const newer = label("label:b", "Duplicate Demo", [], {
    createdAt: "2026-10-03T00:00:00.000Z",
    possibleDuplicateIds: [ProjectLabelId.make("label:a")],
  });

  it("offers one merge per pair, into the older project, from a machine that has both", () => {
    const unified = unifyProjectLabels([
      { environmentId: mac, labels: [newer, older] },
      { environmentId: vps, labels: [older, newer] },
    ]);
    const pairs = possibleDuplicateProjects(unified.labels);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.into.label.id).toBe("label:a");
    expect(pairs[0]?.from.label.id).toBe("label:b");
    expect(pairs[0]?.environmentId).toBe(mac);
  });

  it("cannot merge until one machine has both", () => {
    const unified = unifyProjectLabels([
      { environmentId: mac, labels: [older] },
      { environmentId: vps, labels: [newer] },
    ]);
    expect(possibleDuplicateProjects(unified.labels)[0]?.environmentId).toBeNull();
  });

  it("drops a pair whose other project is gone", () => {
    const unified = unifyProjectLabels([{ environmentId: mac, labels: [older] }]);
    expect(possibleDuplicateProjects(unified.labels)).toEqual([]);
  });
});

describe("projectMachinesLabel", () => {
  it("names the connected machines that have the project", () => {
    const names = new Map([
      [mac, "MacBook"],
      [vps, "Contabo VPS"],
    ]);
    expect(projectMachinesLabel([mac, vps], (id) => names.get(id) ?? null)).toBe(
      "MacBook · Contabo VPS",
    );
    expect(projectMachinesLabel(["gone" as EnvironmentId], () => null)).toBeNull();
  });
});

describe("projectMergeCandidates", () => {
  it("offers dismissed and differently named projects, preserving the older destination", () => {
    const unified = unifyProjectLabels([
      {
        environmentId: mac,
        labels: [
          label("label:new", "New name", [], { createdAt: "2026-10-03T00:00:00.000Z" }),
          label("label:old", "Old name"),
        ],
      },
    ]);
    const entry = unified.labels.find((each) => each.label.id === "label:new")!;
    expect(possibleDuplicateProjects(unified.labels)).toEqual([]);
    const candidates = projectMergeCandidates(entry, unified.labels);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      environmentId: mac,
      into: { label: { id: "label:old" } },
      from: { label: { id: "label:new" } },
    });
  });

  it("excludes itself and projects with no shared machine", () => {
    const unified = unifyProjectLabels([
      { environmentId: mac, labels: [label("label:local", "Local")] },
      { environmentId: vps, labels: [label("label:remote", "Remote")] },
    ]);
    expect(projectMergeCandidates(unified.labels[0]!, unified.labels)).toEqual([]);
  });

  it("uses a shared replica even when each project's preferred machine differs", () => {
    const a = label("label:a", "A");
    const b = label("label:b", "B");
    const unified = unifyProjectLabels([
      { environmentId: mac, labels: [a] },
      { environmentId: vps, labels: [a, b] },
    ]);
    const entry = unified.labels.find((each) => each.label.id === a.id)!;
    expect(projectMergeCandidates(entry, unified.labels)[0]?.environmentId).toBe(vps);
  });
});
