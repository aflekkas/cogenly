import { describe, expect, it } from "vite-plus/test";

import { indexProjectContents, projectContentsCount } from "./projectContents.logic";

describe("indexProjectContents", () => {
  const threads = [
    { id: "fix-ui", mode: "tasks" as const, folder: "env:spawn" as const },
    { id: "brainstorm", mode: "chats" as const, folder: "env:spawn" as const },
    { id: "audit", mode: "tasks" as const, folder: "env:bartr" as const },
    { id: "loose", mode: "chats" as const, folder: null },
    { id: "agent-chat", mode: "agents" as const, folder: "env:spawn" as const },
  ];
  const index = indexProjectContents({
    threads,
    modeOf: (thread) => thread.mode,
    folderKeyOf: (thread) => thread.folder,
  });

  it("files each thread once, under its one folder, split into chats and Work", () => {
    const spawn = index.get("env:spawn")!;
    expect(spawn.work.map((thread) => thread.id)).toEqual(["fix-ui"]);
    expect(spawn.chats.map((thread) => thread.id)).toEqual(["brainstorm"]);
    expect(projectContentsCount(spawn)).toBe(2);
    expect(index.get("env:bartr")!.work.map((thread) => thread.id)).toEqual(["audit"]);
  });

  it("leaves unfiled threads, agent conversations and empty folders out", () => {
    const all = [...index.values()].flatMap((entry) => [...entry.chats, ...entry.work]);
    expect(all.map((thread) => thread.id)).not.toContain("loose");
    expect(all.map((thread) => thread.id)).not.toContain("agent-chat");
    expect(projectContentsCount(index.get("env:empty"))).toBe(0);
  });
});
