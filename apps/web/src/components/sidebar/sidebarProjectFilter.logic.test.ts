import { type EnvironmentId, ProjectLabelId, ThreadId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectLabelKey,
  type EnvironmentProjectLabel,
  type ProjectLabelKey,
} from "../../projectLabels/projectLabels.logic";
import { searchSidebarThreads } from "../Sidebar.logic";
import { readSidebarProjectFilter, setSidebarProjectFilter } from "./sidebarProjectFilter";
import {
  filterBySidebarProject,
  resolveSidebarProjectFilter,
  SIDEBAR_NO_PROJECT,
  sidebarProjectFilterName,
  sidebarProjectFilterOptions,
} from "./sidebarProjectFilter.logic";

const mac = "mac" as EnvironmentId;
const vps = "vps" as EnvironmentId;

function project(id: string, name: string): EnvironmentProjectLabel {
  return {
    key: projectLabelKey(mac, id),
    environmentId: mac,
    label: {
      id: ProjectLabelId.make(id),
      name,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      repositoryIds: [],
      sourceLinks: [],
      threadCount: 0,
      instructions: "",
      projectChatThreadId: null,
    },
  };
}

const greek = project("greek", "GreekUGC");
const cogenly = project("cogenly", "Cogenly");
// The directory maps every machine's key for a project to its one entry: the
// VPS's copy of GreekUGC has its own id there.
const byKey = new Map<ProjectLabelKey, EnvironmentProjectLabel>([
  [greek.key, greek],
  [projectLabelKey(vps, "greek-on-vps"), greek],
  [cogenly.key, cogenly],
]);

function thread(id: string, title: string, environmentId: EnvironmentId, folderId: string | null) {
  return { environmentId, id: ThreadId.make(id), title, folderId };
}
const projectOf = (item: { environmentId: EnvironmentId; folderId: string | null }) =>
  item.folderId === null
    ? null
    : (byKey.get(projectLabelKey(item.environmentId, item.folderId)) ?? null);

const threads = [
  thread("1", "Launch plan", mac, "greek"),
  thread("2", "Fix login", mac, "cogenly"),
  thread("3", "Launch recap", vps, "greek-on-vps"),
  thread("4", "Launch party", mac, null),
  thread("5", "Groceries", mac, null),
];

describe("filterBySidebarProject", () => {
  it("keeps every item, as the same list, when no filter applies", () => {
    expect(filterBySidebarProject(threads, null, projectOf)).toBe(threads);
  });

  it("keeps one project's items from every machine, in order", () => {
    expect(filterBySidebarProject(threads, greek.key, projectOf).map((item) => item.id)).toEqual([
      "1",
      "3",
    ]);
  });

  it("keeps the items in no project", () => {
    expect(
      filterBySidebarProject(threads, SIDEBAR_NO_PROJECT, projectOf).map((item) => item.id),
    ).toEqual(["4", "5"]);
  });

  it("composes with the text search, which then searches only the project", () => {
    const narrowed = filterBySidebarProject(threads, greek.key, projectOf);
    expect(searchSidebarThreads(narrowed, "launch").map((item) => item.id)).toEqual(["1", "3"]);
    const unfiled = filterBySidebarProject(threads, SIDEBAR_NO_PROJECT, projectOf);
    expect(searchSidebarThreads(unfiled, "launch").map((item) => item.id)).toEqual(["4"]);
  });
});

describe("resolveSidebarProjectFilter", () => {
  it("resolves a key from either machine to the one project", () => {
    expect(resolveSidebarProjectFilter(projectLabelKey(vps, "greek-on-vps"), byKey)).toBe(
      greek.key,
    );
  });

  it("falls back to all when the project is gone", () => {
    expect(resolveSidebarProjectFilter(projectLabelKey(mac, "deleted"), byKey)).toBeNull();
  });

  it("keeps No project and all as they are", () => {
    expect(resolveSidebarProjectFilter(SIDEBAR_NO_PROJECT, byKey)).toBe(SIDEBAR_NO_PROJECT);
    expect(resolveSidebarProjectFilter(null, byKey)).toBeNull();
  });
});

describe("sidebarProjectFilterOptions", () => {
  it("lists the list's projects by name with counts, then No project", () => {
    expect(
      sidebarProjectFilterOptions(threads, projectOf, null, byKey).map((option) => [
        option.value,
        option.count,
      ]),
    ).toEqual([
      [cogenly.key, 1],
      [greek.key, 2],
      [SIDEBAR_NO_PROJECT, 2],
    ]);
  });

  it("leaves out projects and No project with nothing in the list", () => {
    const filed = threads.filter((item) => item.folderId === "cogenly");
    expect(
      sidebarProjectFilterOptions(filed, projectOf, null, byKey).map((option) => option.value),
    ).toEqual([cogenly.key]);
  });

  it("keeps the chosen filter listed after its last item leaves", () => {
    const filed = threads.filter((item) => item.folderId === "cogenly");
    expect(
      sidebarProjectFilterOptions(filed, projectOf, greek.key, byKey).map((option) => [
        option.value,
        option.count,
      ]),
    ).toEqual([
      [cogenly.key, 1],
      [greek.key, 0],
    ]);
  });
});

describe("sidebarProjectFilterName", () => {
  it("names the project, No project, or nothing for all", () => {
    expect(sidebarProjectFilterName(greek.key, byKey)).toBe("GreekUGC");
    expect(sidebarProjectFilterName(SIDEBAR_NO_PROJECT, byKey)).toBe("No project");
    expect(sidebarProjectFilterName(null, byKey)).toBeNull();
  });
});

describe("sidebar project filter store", () => {
  it("remembers each mode's filter on its own, and clears back to all", () => {
    setSidebarProjectFilter("chats", greek.key);
    setSidebarProjectFilter("agents", SIDEBAR_NO_PROJECT);
    expect(readSidebarProjectFilter("chats")).toBe(greek.key);
    expect(readSidebarProjectFilter("tasks")).toBeNull();
    expect(readSidebarProjectFilter("agents")).toBe(SIDEBAR_NO_PROJECT);
    setSidebarProjectFilter("chats", null);
    setSidebarProjectFilter("agents", null);
    expect(readSidebarProjectFilter("chats")).toBeNull();
    expect(readSidebarProjectFilter("agents")).toBeNull();
  });
});
