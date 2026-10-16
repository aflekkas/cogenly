import { describe, expect, it } from "vite-plus/test";

import {
  chatDateGroup,
  classifySidebarThreadMode,
  createChatDateGrouper,
  filterThreadsForSidebarMode,
  isSidebarMode,
  sidebarModeForThread,
  sortChatsByActivity,
  type SidebarModeThreadClassifier,
} from "./sidebarModes.logic";

const classifier: SidebarModeThreadClassifier = {
  agentThreadKeys: new Set(["env-a:agent-thread", "env-b:scratch-agent"]),
  scratchProjectKeys: new Set(["env-a:scratch", "env-b:scratch"]),
};

const thread = (environmentId: string, id: string, projectId: string) => ({
  environmentId,
  id,
  projectId,
});

describe("classifySidebarThreadMode", () => {
  it("puts scratch threads in chats and project threads in tasks", () => {
    expect(classifySidebarThreadMode({ isAgent: false, isScratch: true })).toBe("chats");
    expect(classifySidebarThreadMode({ isAgent: false, isScratch: false })).toBe("tasks");
  });

  it("lets a scheduled task binding win over the project", () => {
    expect(classifySidebarThreadMode({ isAgent: true, isScratch: true })).toBe("agents");
    expect(classifySidebarThreadMode({ isAgent: true, isScratch: false })).toBe("agents");
  });
});

describe("sidebarModeForThread", () => {
  it("classifies by environment, not by bare ids", () => {
    // Same thread id and project id on another machine is a different thread.
    expect(sidebarModeForThread(thread("env-a", "agent-thread", "app"), classifier)).toBe("agents");
    expect(sidebarModeForThread(thread("env-b", "agent-thread", "app"), classifier)).toBe("tasks");
    expect(sidebarModeForThread(thread("env-a", "t1", "scratch"), classifier)).toBe("chats");
    expect(sidebarModeForThread(thread("env-c", "t1", "scratch"), classifier)).toBe("tasks");
  });

  it("keeps scratch-bound agents out of chats", () => {
    expect(sidebarModeForThread(thread("env-b", "scratch-agent", "scratch"), classifier)).toBe(
      "agents",
    );
  });
});

describe("filterThreadsForSidebarMode", () => {
  const threads = [
    thread("env-a", "chat", "scratch"),
    thread("env-a", "task", "app"),
    thread("env-a", "agent-thread", "app"),
    thread("env-b", "remote-chat", "scratch"),
    thread("env-b", "scratch-agent", "scratch"),
  ];

  it("partitions every thread into exactly one mode", () => {
    const chats = filterThreadsForSidebarMode(threads, "chats", classifier);
    const tasks = filterThreadsForSidebarMode(threads, "tasks", classifier);
    const agents = filterThreadsForSidebarMode(threads, "agents", classifier);
    expect(chats.map((entry) => entry.id)).toEqual(["chat", "remote-chat"]);
    expect(tasks.map((entry) => entry.id)).toEqual(["task"]);
    expect(agents.map((entry) => entry.id)).toEqual(["agent-thread", "scratch-agent"]);
    expect(chats.length + tasks.length + agents.length).toBe(threads.length);
  });
});

describe("isSidebarMode", () => {
  it("accepts only known modes", () => {
    expect(isSidebarMode("chats")).toBe(true);
    expect(isSidebarMode("agents")).toBe(true);
    expect(isSidebarMode("inbox")).toBe(false);
    expect(isSidebarMode(null)).toBe(false);
  });
});

describe("chatDateGroup", () => {
  // Local time: groups follow the user's calendar day, not UTC.
  const now = new Date(2026, 9, 15, 14, 30);
  const at = (...args: [number, number, number, number?, number?]) =>
    new Date(args[0], args[1], args[2], args[3] ?? 0, args[4] ?? 0).toISOString();

  it("buckets by local calendar day", () => {
    expect(chatDateGroup(at(2026, 9, 15, 0, 1), now)).toBe("today");
    expect(chatDateGroup(at(2026, 9, 14, 23, 59), now)).toBe("yesterday");
    expect(chatDateGroup(at(2026, 9, 14, 0, 0), now)).toBe("yesterday");
    expect(chatDateGroup(at(2026, 9, 13, 23, 0), now)).toBe("previous7Days");
    expect(chatDateGroup(at(2026, 9, 8, 0, 0), now)).toBe("previous7Days");
    expect(chatDateGroup(at(2026, 9, 7, 23, 0), now)).toBe("older");
  });

  it("treats future and unparseable timestamps sensibly", () => {
    expect(chatDateGroup(at(2026, 9, 16), now)).toBe("today");
    expect(chatDateGroup("not a date", now)).toBe("older");
  });
});

describe("sortChatsByActivity and createChatDateGrouper", () => {
  const now = new Date(2026, 9, 15, 14, 30);
  const chat = (id: string, latestUserMessageAt: string | null, updatedAt: string) => ({
    id,
    latestUserMessageAt,
    updatedAt,
  });
  const chats = [
    chat("old", null, new Date(2026, 8, 1).toISOString()),
    chat(
      "today-early",
      new Date(2026, 9, 15, 9).toISOString(),
      new Date(2026, 9, 15, 13).toISOString(),
    ),
    chat(
      "yesterday",
      new Date(2026, 9, 14, 18).toISOString(),
      new Date(2026, 9, 15, 13).toISOString(),
    ),
    chat("today-late", null, new Date(2026, 9, 15, 12).toISOString()),
  ];

  it("sorts newest first by the last user message, falling back to the update time", () => {
    expect(sortChatsByActivity(chats).map((entry) => entry.id)).toEqual([
      "today-late",
      "today-early",
      "yesterday",
      "old",
    ]);
  });

  it("labels only the first row of each date group", () => {
    const groupOf = createChatDateGrouper(now);
    expect(sortChatsByActivity(chats).map(groupOf)).toEqual(["today", null, "yesterday", "older"]);
  });
});
