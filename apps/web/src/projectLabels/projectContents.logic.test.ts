import { describe, expect, it } from "vite-plus/test";

import { indexProjectContents, projectContentsCount } from "./projectContents.logic";

describe("indexProjectContents", () => {
  const threads = [
    { id: "fix-ui", mode: "tasks" as const, work: ["env:spawn"], tags: ["env:spawn"] },
    { id: "audit", mode: "tasks" as const, work: ["env:spawn", "env:bartr"], tags: [] },
    { id: "brainstorm", mode: "chats" as const, work: ["env:bartr"], tags: ["env:spawn"] },
    { id: "agent-chat", mode: "agents" as const, work: [], tags: ["env:spawn"] },
  ];
  const index = indexProjectContents({
    threads,
    modeOf: (thread) => thread.mode,
    workProjectKeys: (thread) => thread.work as Array<`${string}:${string}`>,
    chatProjectKeys: (thread) => thread.tags as Array<`${string}:${string}`>,
    agents: [{ name: "Scout", scope: ["env:spawn", "env:spawn"] }],
    agentProjectKeys: (agent) => agent.scope as Array<`${string}:${string}`>,
  });

  it("files Work by its projects, chats by their tags, and agents by scope, each once", () => {
    const spawn = index.get("env:spawn")!;
    expect(spawn.work.map((thread) => thread.id)).toEqual(["fix-ui", "audit"]);
    expect(spawn.chats.map((thread) => thread.id)).toEqual(["brainstorm"]);
    expect(spawn.agents.map((agent) => agent.name)).toEqual(["Scout"]);
    expect(projectContentsCount(spawn)).toBe(4);
  });

  it("leaves agent conversations to their agent and empty projects out", () => {
    expect(index.get("env:bartr")!.chats).toEqual([]);
    expect(index.has("env:empty")).toBe(false);
    expect(projectContentsCount(index.get("env:empty"))).toBe(0);
  });
});
