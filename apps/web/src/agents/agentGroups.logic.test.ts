import { planPinnedReorder } from "@cogenly/client-runtime/state/thread-sort";
import { type EnvironmentId, ProjectLabelId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectLabelKey,
  type EnvironmentProjectLabel,
} from "../projectLabels/projectLabels.logic";
import {
  groupAgentsByProject,
  NO_PROJECT_GROUP_KEY,
  onePerAgent,
  orderAgentsForList,
} from "./agentGroups.logic";

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

  it("files an agent listed from another machine into the project's one group", () => {
    const shared = {
      ...folder(env, "web", "Website"),
      copies: [
        { environmentId: env, label: folder(env, "web", "Website").label },
        { environmentId: other, label: folder(other, "web", "Website").label },
      ],
    };
    const result = groupAgentsByProject({
      agents: [agent("a", "web"), agent("b", "web", other)],
      folders: [shared],
    });
    expect(names(result)).toEqual([["env:web", ["a", "b"]]]);
  });
});

describe("onePerAgent", () => {
  it("keeps one contact per agent id, the owner machine's copy, in the first copy's place", () => {
    const kept = onePerAgent([
      { id: "scout", environmentId: env, ownerMachine: other, name: "replica" },
      { id: "solo", environmentId: env, name: "solo" },
      { id: "scout", environmentId: other, ownerMachine: other, name: "owner" },
    ]);
    expect(kept.map((entry) => [entry.id, entry.name])).toEqual([
      ["scout", "owner"],
      ["solo", "solo"],
    ]);
  });
});

describe("orderAgentsForList", () => {
  const ordered = (agents: ReadonlyArray<{ id: string; orderKey: string | null }>) =>
    orderAgentsForList(agents).map((entry) => entry.id);

  it("leads with unarranged agents in their given order, then arranged ones by key", () => {
    expect(
      ordered([
        { id: "arranged-late", orderKey: "t" },
        { id: "new", orderKey: null },
        { id: "arranged-early", orderKey: "f" },
        { id: "newer", orderKey: null },
      ]),
    ).toEqual(["new", "newer", "arranged-early", "arranged-late"]);
  });

  it("draws a planned move where it was dropped, keying a keyless group once", () => {
    const agents = [
      { id: "a", orderKey: null as string | null },
      { id: "b", orderKey: null as string | null },
      { id: "c", orderKey: null as string | null },
    ];
    const keysById = () => new Map(agents.map((entry) => [entry.id, entry.orderKey]));
    const apply = (writes: ReadonlyArray<{ id: string; orderKey: string }>) => {
      for (const write of writes)
        agents.find((entry) => entry.id === write.id)!.orderKey = write.orderKey;
    };
    // c dragged to the top: the keyless group is keyed in full.
    const first = planPinnedReorder({
      orderedIds: ["c", "a", "b"],
      keysById: keysById(),
      movedId: "c",
    });
    apply(first);
    expect(ordered(agents)).toEqual(["c", "a", "b"]);
    // Then a moved below b: one write between keyed neighbours.
    const second = planPinnedReorder({
      orderedIds: ["c", "b", "a"],
      keysById: keysById(),
      movedId: "a",
    });
    expect(second).toHaveLength(1);
    apply(second);
    expect(ordered(agents)).toEqual(["c", "b", "a"]);
  });
});
