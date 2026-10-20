import { describe, expect, it } from "vite-plus/test";

import {
  classifyThreadKind,
  threadCapabilities,
  threadKindForSidebarMode,
} from "./threadCapabilities";

describe("threadCapabilities", () => {
  it("gives a chat conversation controls and no repository controls", () => {
    expect(threadCapabilities("chat")).toEqual({
      startWork: true,
      rename: true,
      regenerateTitle: true,
      markUnread: true,
      projectFolder: true,
      settle: false,
      snooze: false,
      autoSettle: false,
      archive: false,
      delete: "always-confirm",
      copyLink: true,
      copyWorkspace: false,
      repositorySettings: false,
      git: false,
      diff: false,
      terminal: false,
      files: false,
      threadDetails: true,
      agentSettings: false,
    });
  });

  it("gives Work its whole lifecycle and repository, but not Start Work", () => {
    expect(threadCapabilities("work")).toEqual({
      startWork: false,
      rename: true,
      regenerateTitle: true,
      markUnread: true,
      projectFolder: true,
      settle: true,
      snooze: true,
      autoSettle: true,
      archive: true,
      delete: "setting",
      copyLink: true,
      copyWorkspace: true,
      repositorySettings: true,
      git: true,
      diff: true,
      terminal: true,
      files: true,
      threadDetails: true,
      agentSettings: false,
    });
  });

  it("leaves an agent conversation's name and lifetime to the agent", () => {
    expect(threadCapabilities("agentConversation")).toEqual({
      startWork: false,
      rename: false,
      regenerateTitle: false,
      markUnread: true,
      projectFolder: false,
      settle: false,
      snooze: false,
      autoSettle: false,
      archive: false,
      delete: false,
      copyLink: true,
      copyWorkspace: false,
      repositorySettings: false,
      git: false,
      diff: false,
      terminal: false,
      files: false,
      threadDetails: false,
      agentSettings: true,
    });
  });
});

describe("classifyThreadKind", () => {
  it("files agent-started Work as Work, even in a scratch folder", () => {
    expect(classifyThreadKind({ agentRole: "work", isScratch: true })).toBe("work");
  });

  it("files an agent's conversation as its own kind", () => {
    expect(classifyThreadKind({ agentRole: "conversation", isScratch: false })).toBe(
      "agentConversation",
    );
    expect(
      classifyThreadKind({ agentRole: null, isAgentConversation: true, isScratch: true }),
    ).toBe("agentConversation");
  });

  it("splits plain threads into chats and Work by their folder", () => {
    expect(classifyThreadKind({ agentRole: null, isScratch: true })).toBe("chat");
    expect(classifyThreadKind({ agentRole: null, isScratch: false })).toBe("work");
  });

  it("trusts the recorded surface over the folder", () => {
    expect(classifyThreadKind({ agentRole: null, isScratch: true, surface: "work" })).toBe("work");
    expect(classifyThreadKind({ agentRole: null, isScratch: false, surface: "chat" })).toBe("chat");
  });

  it("matches the sidebar mode that lists the thread", () => {
    expect(threadKindForSidebarMode("chats")).toBe("chat");
    expect(threadKindForSidebarMode("tasks")).toBe("work");
    expect(threadKindForSidebarMode("agents")).toBe("agentConversation");
  });
});
