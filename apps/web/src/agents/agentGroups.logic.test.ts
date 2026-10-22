import { type EnvironmentId, ProjectLabelId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectLabelKey,
  type EnvironmentProjectLabel,
} from "../projectLabels/projectLabels.logic";
import { groupAgentsByProject, NO_PROJECT_GROUP_KEY } from "./agentGroups.logic";

const env = "env" as EnvironmentId;
const other = "other" as EnvironmentId;

function folder(environmentId: EnvironmentId, id: string, name: string): EnvironmentProjectLabel {
  return {
    key: projectLabelKey(environmentId, id),
    environmentId,
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

function agent(name: string, projectFolderId: string | null, environmentId = env) {
  return {
    name,
    environmentId,
    projectFolderId: projectFolderId === null ? null : ProjectLabelId.make(projectFolderId),
    attention: false,
  };
}

const folders = [folder(env, "web", "Website"), folder(env, "ops", "Ops")];
const names = (result: ReturnType<typeof groupAgentsByProject<ReturnType<typeof agent>>>) =>
  result.groups.map((group) => [group.key, group.agents.map((entry) => entry.name)]);

describe("groupAgentsByProject", () => {
  it("groups agents by folder in name order, keeping their order inside a group", () => {
    const result = groupAgentsByProject({
      agents: [agent("a", "web"), agent("b", "ops"), agent("c", "web")],
      folders,
    });
    expect(result.grouped).toBe(true);
    expect(names(result)).toEqual([
      ["env:ops", ["b"]],
      ["env:web", ["a", "c"]],
    ]);
    expect(result.groups[0]?.folder?.label.name).toBe("Ops");
  });

  it("puts unfiled agents and unknown folders in No project, last", () => {
    const result = groupAgentsByProject({
      agents: [agent("a", null), agent("b", "gone"), agent("c", "web"), agent("d", "web", other)],
      folders,
    });
    expect(names(result)).toEqual([
      ["env:web", ["c"]],
      [NO_PROJECT_GROUP_KEY, ["a", "b", "d"]],
    ]);
    expect(result.groups.at(-1)?.folder).toBeNull();
  });

  it("stays flat when nobody is in a known project", () => {
    const result = groupAgentsByProject({
      agents: [agent("a", null), agent("b", "gone")],
      folders,
    });
    expect(result.grouped).toBe(false);
    expect(names(result)).toEqual([[NO_PROJECT_GROUP_KEY, ["a", "b"]]]);
  });

  it("applies the filter before grouping and drops groups it empties", () => {
    const needsYou = { ...agent("b", null), attention: true };
    const result = groupAgentsByProject({
      agents: [agent("a", "web"), needsYou, { ...agent("c", "ops"), attention: true }],
      folders,
      include: (entry) => entry.attention,
    });
    expect(names(result)).toEqual([
      ["env:ops", ["c"]],
      [NO_PROJECT_GROUP_KEY, ["b"]],
    ]);
    const unfiledOnly = groupAgentsByProject({
      agents: [agent("a", "web"), needsYou],
      folders,
      include: (entry) => entry.attention,
    });
    // The filter left nobody in a project, so the headers go too.
    expect(unfiledOnly.grouped).toBe(false);
  });

  it("returns no groups for no agents", () => {
    expect(groupAgentsByProject({ agents: [], folders }).groups).toEqual([]);
  });
});
