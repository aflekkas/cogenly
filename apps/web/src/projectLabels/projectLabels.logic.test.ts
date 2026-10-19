import {
  ProjectId,
  ProjectLabelId,
  ThreadId,
  type ProjectLabelWithRepositories,
  type ThreadProjectLabel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupWorkByProject,
  nextThreadLabelIds,
  resolveThreadTags,
  splitTagChips,
  workSectionThreadOrder,
  type WorkProjectHeading,
} from "./projectLabels.logic";

const spawn: WorkProjectHeading = { key: "env:spawn", name: "Spawn Partners", color: "green" };
const bartr: WorkProjectHeading = { key: "env:bartr", name: "Bartr", color: "blue" };

describe("groupWorkByProject", () => {
  // Busiest-first, as groupTasksByProject delivers them.
  const repos = [
    { projectKey: "outreach", threads: ["fix outreach UI"] },
    { projectKey: "scratchpad", threads: ["try a thing"] },
    { projectKey: "shared-tools", threads: ["bump deps"] },
    { projectKey: "booking-audit", threads: ["improve scanner", "refactor reports"] },
    { projectKey: "bartr-app", threads: ["checkout flow"] },
  ];
  const links: Record<string, WorkProjectHeading[]> = {
    outreach: [spawn],
    "shared-tools": [bartr, spawn],
    "booking-audit": [spawn],
    "bartr-app": [bartr],
  };
  const sections = groupWorkByProject(repos, (key) => links[key] ?? []);

  it("puts each project's linked repos beneath it, busiest project first", () => {
    expect(sections.map((section) => section.project?.name ?? null)).toEqual([
      "Spawn Partners",
      "Bartr",
      null,
    ]);
    expect(sections[0]!.repos.map((repo) => repo.projectKey)).toEqual([
      "outreach",
      "shared-tools",
      "booking-audit",
    ]);
  });

  it("lists a repo linked to several projects under each of them", () => {
    expect(sections[1]!.repos.map((repo) => repo.projectKey)).toEqual([
      "shared-tools",
      "bartr-app",
    ]);
  });

  it("collects unlinked repos in a trailing section without a project", () => {
    expect(sections.at(-1)).toEqual({
      project: null,
      repos: [{ projectKey: "scratchpad", threads: ["try a thing"] }],
    });
  });

  it("reads like the plain repo list when no project links anything", () => {
    expect(groupWorkByProject(repos, () => [])).toEqual([{ project: null, repos }]);
  });

  it("orders each session once, at its first appearance", () => {
    expect(workSectionThreadOrder(sections)).toEqual([
      "fix outreach UI",
      "bump deps",
      "improve scanner",
      "refactor reports",
      "checkout flow",
      "try a thing",
    ]);
  });
});

describe("thread tags", () => {
  const threadId = ThreadId.make("chat");
  const label = (id: string, name: string): ProjectLabelWithRepositories => ({
    id: ProjectLabelId.make(id),
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    repositoryIds: [ProjectId.make("repo")],
  });
  const tag = (
    labelId: string,
    confirmedByUser: boolean,
    confidence: number | null = null,
  ): ThreadProjectLabel => ({
    threadId,
    labelId: ProjectLabelId.make(labelId),
    confidence,
    confirmedByUser,
    source: confirmedByUser ? "user" : "suggested",
  });
  const labelsById = new Map(
    [label("a", "Spawn"), label("b", "bartr"), label("c", "School"), label("d", "Investing")].map(
      (entry) => [entry.id, entry] as const,
    ),
  );

  it("puts confirmed tags before suggestions and drops tags for deleted projects", () => {
    const resolved = resolveThreadTags(
      [
        tag("c", false, 0.2),
        tag("a", true),
        tag("gone", true),
        tag("d", false, 0.9),
        tag("b", true),
      ],
      labelsById,
    );
    expect(resolved.map((entry) => [entry.label.name, entry.suggested])).toEqual([
      ["bartr", false],
      ["Spawn", false],
      ["Investing", true],
      ["School", true],
    ]);
  });

  it("shows two chips and counts the rest", () => {
    expect(splitTagChips(["a", "b"])).toEqual({ visible: ["a", "b"], overflow: [] });
    expect(splitTagChips(["a", "b", "c", "d"])).toEqual({
      visible: ["a", "b"],
      overflow: ["c", "d"],
    });
    expect(splitTagChips([])).toEqual({ visible: [], overflow: [] });
  });

  it("never sends a pending suggestion when toggling, so an edit cannot confirm it", () => {
    const tags = [tag("a", true), tag("c", false, 0.7)];
    expect(nextThreadLabelIds(tags, ProjectLabelId.make("b"), true)).toEqual(["a", "b"]);
    expect(nextThreadLabelIds(tags, ProjectLabelId.make("a"), false)).toEqual([]);
    expect(nextThreadLabelIds(tags, ProjectLabelId.make("a"), true)).toEqual(["a"]);
  });
});
