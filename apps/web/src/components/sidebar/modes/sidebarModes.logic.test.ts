import { describe, expect, it } from "vite-plus/test";

import {
  chatDateGroup,
  classifySidebarThreadMode,
  countChatListGroups,
  createChatDateGrouper,
  orderChatsWithPins,
  applyPinnedDragOrder,
  pinnedDragOrder,
  filterThreadsForSidebarMode,
  isSidebarMode,
  newThreadShortcutTarget,
  sidebarModeForThread,
  sortChatsByActivity,
  windowChatList,
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

  it("lets an agent conversation win over the project", () => {
    expect(classifySidebarThreadMode({ isAgent: true, isScratch: true })).toBe("agents");
    expect(classifySidebarThreadMode({ isAgent: true, isScratch: false })).toBe("agents");
  });

  it("puts agent work in tasks wherever it runs", () => {
    expect(classifySidebarThreadMode({ isAgent: true, isScratch: true, isAgentWork: true })).toBe(
      "tasks",
    );
    expect(classifySidebarThreadMode({ isAgent: true, isScratch: false, isAgentWork: true })).toBe(
      "tasks",
    );
  });
});

describe("surface classification", () => {
  it("lists Work started without a repository under Work, and a chat in a repository under Chats", () => {
    expect(classifySidebarThreadMode({ isAgent: false, isScratch: true, surface: "work" })).toBe(
      "tasks",
    );
    expect(classifySidebarThreadMode({ isAgent: false, isScratch: false, surface: "chat" })).toBe(
      "chats",
    );
  });

  it("lets agents win over the surface", () => {
    expect(classifySidebarThreadMode({ isAgent: true, isScratch: true, surface: "chat" })).toBe(
      "agents",
    );
    expect(
      classifySidebarThreadMode({
        isAgent: true,
        isScratch: true,
        isAgentWork: true,
        surface: "chat",
      }),
    ).toBe("tasks");
  });

  it("filters threads by surface, not project", () => {
    const thread = (id: string, surface?: "chat" | "work") => ({
      environmentId: "env-a",
      id,
      projectId: "scratch",
      source: { surface },
    });
    const threads = [thread("work-no-repo", "work"), thread("chat", "chat"), thread("legacy")];
    expect(filterThreadsForSidebarMode(threads, "tasks", classifier).map((t) => t.id)).toEqual([
      "work-no-repo",
    ]);
    expect(filterThreadsForSidebarMode(threads, "chats", classifier).map((t) => t.id)).toEqual([
      "chat",
      "legacy",
    ]);
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

  it("lists agent work beside user work and keeps conversations in agents", () => {
    const owned = [
      {
        ...thread("env-a", "scratch-work", "scratch"),
        source: { agent: { role: "work" as const } },
      },
      { ...thread("env-a", "project-work", "app"), source: { agent: { role: "work" as const } } },
      {
        ...thread("env-a", "conversation", "app"),
        source: { agent: { role: "conversation" as const } },
      },
    ];
    expect(filterThreadsForSidebarMode(owned, "chats", classifier)).toEqual([]);
    expect(filterThreadsForSidebarMode(owned, "tasks", classifier).map((t) => t.id)).toEqual([
      "scratch-work",
      "project-work",
    ]);
    expect(filterThreadsForSidebarMode(owned, "agents", classifier).map((t) => t.id)).toEqual([
      "conversation",
    ]);
  });

  it("partitions every thread into exactly one mode", () => {
    const chats = filterThreadsForSidebarMode(threads, "chats", classifier);
    const tasks = filterThreadsForSidebarMode(threads, "tasks", classifier);
    const agents = filterThreadsForSidebarMode(threads, "agents", classifier);
    expect(chats.map((entry) => entry.id)).toEqual(["chat", "remote-chat"]);
    expect(tasks.map((entry) => entry.id)).toEqual(["task"]);
    expect(agents.map((entry) => entry.id)).toEqual(["agent-thread", "scratch-agent"]);
    expect(chats.length + tasks.length + agents.length).toBe(threads.length);
  });

  it("lists builder threads nowhere", () => {
    const builder = {
      ...thread("env-a", "builder", "scratch"),
      source: { surface: "builder" as const },
    };
    expect(sidebarModeForThread(builder, classifier)).toBeNull();
    expect(filterThreadsForSidebarMode([builder], "chats", classifier)).toEqual([]);
    expect(filterThreadsForSidebarMode([builder], "tasks", classifier)).toEqual([]);
    expect(filterThreadsForSidebarMode([builder], "agents", classifier)).toEqual([]);
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

  it("counts every chat under its heading, pinned ones under Pinned", () => {
    const pinned = {
      ...chat("pinned", null, new Date(2026, 9, 15, 10).toISOString()),
      pinnedAt: "x",
    };
    expect(Object.fromEntries(countChatListGroups([...chats, pinned], now))).toEqual({
      older: 1,
      today: 2,
      yesterday: 1,
      pinned: 1,
    });
  });
});

describe("orderChatsWithPins", () => {
  const now = new Date(2026, 9, 15, 14, 30);
  const chat = (
    id: string,
    updatedAt: Date,
    pin: { at: string; key: string | null } | null = null,
  ) => ({
    id,
    createdAt: updatedAt.toISOString(),
    latestUserMessageAt: null,
    updatedAt: updatedAt.toISOString(),
    pinnedAt: pin?.at ?? null,
    pinOrderKey: pin?.key ?? null,
  });
  const pinnedAt = new Date(2026, 9, 15, 10).toISOString();
  const chats = [
    chat("today", new Date(2026, 9, 15, 12)),
    chat("pinned-second", new Date(2026, 9, 15, 13), { at: pinnedAt, key: "t" }),
    chat("old", new Date(2026, 8, 1)),
    chat("pinned-first", new Date(2026, 8, 2), { at: pinnedAt, key: "f" }),
    chat("pinned-keyless", new Date(2026, 9, 14, 9), { at: pinnedAt, key: null }),
  ];

  it("leads with pinned chats by order key, keyless pins after, then the rest newest first", () => {
    expect(orderChatsWithPins(chats).map((entry) => entry.id)).toEqual([
      "pinned-first",
      "pinned-second",
      "pinned-keyless",
      "today",
      "old",
    ]);
  });

  it("groups pinned chats under Pinned only, whatever their date", () => {
    const groupOf = createChatDateGrouper(now);
    expect(orderChatsWithPins(chats).map(groupOf)).toEqual([
      "pinned",
      null,
      null,
      "today",
      "older",
    ]);
  });

  it("shows no Pinned group when nothing is pinned", () => {
    const groupOf = createChatDateGrouper(now);
    const unpinned = chats.map((entry) => ({ ...entry, pinnedAt: null, pinOrderKey: null }));
    expect(orderChatsWithPins(unpinned).map(groupOf)).not.toContain("pinned");
  });
});

describe("dragging a pinned chat", () => {
  it("moves the pin to the slot whose midpoint the pointer passed", () => {
    // Other rows' midpoints, top to bottom: b at 50, c at 90.
    expect(pinnedDragOrder(["a", "b", "c"], "a", [50, 90], 10)).toEqual(["a", "b", "c"]);
    expect(pinnedDragOrder(["a", "b", "c"], "a", [50, 90], 60)).toEqual(["b", "a", "c"]);
    expect(pinnedDragOrder(["a", "b", "c"], "a", [50, 90], 120)).toEqual(["b", "c", "a"]);
    expect(pinnedDragOrder(["a", "b", "c"], "c", [10, 50], 30)).toEqual(["a", "c", "b"]);
  });

  it("leaves the order alone for a key that is not pinned", () => {
    expect(pinnedDragOrder(["a", "b"], "z", [10], 100)).toEqual(["a", "b"]);
  });

  it("previews the drag order on the pins only, keeping unknown pins after", () => {
    const chat = (id: string, pinned: boolean) => ({ id, pinnedAt: pinned ? "t" : null });
    const chats = [chat("a", true), chat("b", true), chat("new", true), chat("x", false)];
    expect(
      applyPinnedDragOrder(chats, ["b", "a"], (entry) => entry.id).map((entry) => entry.id),
    ).toEqual(["b", "a", "new", "x"]);
  });
});

describe("windowChatList", () => {
  const chats = Array.from({ length: 7 }, (_, index) => `chat-${index}`);
  const isOpen = (key: string | null) => (chat: string) => chat === key;

  it("renders everything when the list fits the window", () => {
    expect(windowChatList(chats, 10, isOpen(null))).toEqual({ visible: chats, hiddenCount: 0 });
  });

  it("renders the newest page and counts the rest", () => {
    expect(windowChatList(chats, 3, isOpen(null))).toEqual({
      visible: ["chat-0", "chat-1", "chat-2"],
      hiddenCount: 4,
    });
  });

  it("keeps an open chat from beyond the window, after the page", () => {
    expect(windowChatList(chats, 3, isOpen("chat-5"))).toEqual({
      visible: ["chat-0", "chat-1", "chat-2", "chat-5"],
      hiddenCount: 3,
    });
    expect(windowChatList(chats, 3, isOpen("chat-1")).visible).toHaveLength(3);
  });
});

describe("newThreadShortcutTarget", () => {
  it("starts a plain chat in Chats mode, whatever the repositories", () => {
    expect(
      newThreadShortcutTarget({ mode: "chats", legacySidebar: false, repositoryCount: 4 }),
    ).toBe("chat");
    expect(
      newThreadShortcutTarget({ mode: "chats", legacySidebar: false, repositoryCount: 1 }),
    ).toBe("chat");
  });

  it("keeps the repository flow in Work and Agents", () => {
    expect(
      newThreadShortcutTarget({ mode: "tasks", legacySidebar: false, repositoryCount: 3 }),
    ).toBe("repository-picker");
    expect(
      newThreadShortcutTarget({ mode: "tasks", legacySidebar: false, repositoryCount: 1 }),
    ).toBe("current-repository");
    expect(
      newThreadShortcutTarget({ mode: "agents", legacySidebar: false, repositoryCount: 3 }),
    ).toBe("repository-picker");
  });

  it("leaves the legacy sidebar on its contextual create", () => {
    expect(
      newThreadShortcutTarget({ mode: "chats", legacySidebar: true, repositoryCount: 3 }),
    ).toBe("current-repository");
  });
});
