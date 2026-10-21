import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchComposerMentionItems,
  mentionMatchScore,
  type ComposerThreadCandidate,
} from "./composerThreadItems.ts";

const env = "env-1" as EnvironmentId;
const other = "env-2" as EnvironmentId;
const thread = (
  id: string,
  title: string,
  kind: ComposerThreadCandidate["kind"],
  updatedAt: string,
): ComposerThreadCandidate => ({
  environmentId: env,
  id: id as ThreadId,
  title,
  kind,
  updatedAt,
  archivedAt: null,
});

const base = {
  environmentId: env,
  excludeThreadId: "current" as ThreadId,
  threads: [
    thread("t-old", "Fix login redirect", "work", "2026-10-01T00:00:00.000Z"),
    thread("t-new", "Login page polish", "work", "2026-10-20T00:00:00.000Z"),
    thread("c-1", "Chat about logins", "chat", "2026-10-19T00:00:00.000Z"),
    thread("current", "Login current", "work", "2026-10-21T00:00:00.000Z"),
    thread("conv", "Scout conversation", "agentConversation", "2026-10-21T00:00:00.000Z"),
    {
      ...thread("t-other", "Login elsewhere", "work", "2026-10-21T00:00:00.000Z"),
      environmentId: other,
    },
  ],
  agents: [
    {
      environmentId: env,
      id: "scout",
      name: "Scout",
      conversationThreadId: "conv" as ThreadId,
      activeAt: "2026-10-18T00:00:00.000Z",
    },
  ],
  projectFolders: [
    { environmentId: env, id: "p-1", name: "Login revamp", updatedAt: "2026-10-02T00:00:00.000Z" },
  ],
};

describe("mentionMatchScore", () => {
  it("ranks exact, prefix, word prefix, then substring", () => {
    expect(mentionMatchScore("Login", "login")).toBe(0);
    expect(mentionMatchScore("Login page", "login")).toBe(1);
    expect(mentionMatchScore("Fix login", "login")).toBe(2);
    expect(mentionMatchScore("Relogin", "login")).toBe(3);
    expect(mentionMatchScore("Logout", "login")).toBeNull();
  });
});

describe("matchComposerMentionItems", () => {
  it("groups tasks, chats, agents and projects, closest first then most recent", () => {
    const items = matchComposerMentionItems({ ...base, query: "login" });
    expect(items.map((item) => [item.group, item.label])).toEqual([
      ["tasks", "Login page polish"],
      ["tasks", "Fix login redirect"],
      ["projects", "Login revamp"],
      ["chats", "Chat about logins"],
    ]);
  });

  it("leads with the section holding the closest match", () => {
    const items = matchComposerMentionItems({ ...base, query: "scout" });
    expect(items.map((item) => [item.group, item.label])).toEqual([["agents", "Scout"]]);
  });

  it("offers recent entries in every section for a bare @", () => {
    const items = matchComposerMentionItems({ ...base, query: "" });
    expect(new Set(items.map((item) => item.group))).toEqual(
      new Set(["tasks", "chats", "agents", "projects"]),
    );
    expect(items.filter((item) => item.group === "tasks").map((item) => item.label)).toEqual([
      "Login page polish",
      "Fix login redirect",
    ]);
  });
});
