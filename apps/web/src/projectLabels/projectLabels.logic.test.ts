import {
  type EnvironmentId,
  ProjectId,
  ProjectLabelId,
  ThreadId,
  type ProjectLabelWithRepositories,
  type ThreadProjectLabel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextThreadLabelIds,
  resolveThreadTags,
  splitTagChips,
  workRowProjectTags,
  type ProjectLabelKey,
} from "./projectLabels.logic";

describe("workRowProjectTags", () => {
  const entry = (key: ProjectLabelKey, name: string) => ({
    key,
    environmentId: "env" as EnvironmentId,
    label: { name, color: "green" } as ProjectLabelWithRepositories,
  });
  const spawn = entry("env:spawn", "Spawn Partners");
  const bartr = entry("env:bartr", "Bartr");
  const directory = {
    byKey: new Map([
      [spawn.key, spawn],
      [bartr.key, bartr],
    ]),
    projectsByRepository: new Map([
      ["env:server", [spawn]],
      ["other:server", [bartr, spawn]],
    ]),
  };

  it("merges confirmed tags with every checkout's linked projects, once each, alphabetically", () => {
    expect(
      workRowProjectTags(["env:spawn"], ["env:server", "other:server"], directory).map(
        (tag) => tag.name,
      ),
    ).toEqual(["Bartr", "Spawn Partners"]);
  });

  it("drops tags whose project no longer exists and shows nothing for untagged scratch work", () => {
    expect(workRowProjectTags(["env:gone"], [], directory)).toEqual([]);
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
    threadCount: 0,
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
