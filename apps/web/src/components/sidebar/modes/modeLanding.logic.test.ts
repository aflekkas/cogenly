import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  modeSwitchReplacesMainPanel,
  resolveModeLanding,
  type MainPanelContent,
} from "./modeLanding.logic";
import { SIDEBAR_MODES, type SidebarMode } from "./sidebarModes.logic";

const env = EnvironmentId.make("env-a");
const chat = scopeThreadRef(env, ThreadId.make("chat-1"));
const agentThread = scopeThreadRef(env, ThreadId.make("agent-1"));
const repository = scopeProjectRef(env, ProjectId.make("booking-audit"));

const everything = {
  bootstrapped: true,
  recentChat: chat,
  chatEnvironmentId: env,
  recentRepository: repository,
  recentAgentConversation: agentThread,
  agentsLoaded: true,
};

describe("resolveModeLanding", () => {
  it("never opens a repository draft in Chats, whatever repositories exist", () => {
    const cases = [
      everything,
      { ...everything, recentChat: null },
      { ...everything, recentChat: null, chatEnvironmentId: null },
      { ...everything, bootstrapped: false },
    ];
    for (const input of cases) {
      expect(resolveModeLanding({ mode: "chats", ...input }).kind).not.toBe("repository-draft");
    }
  });

  it("opens the most recent chat, else a new plain chat, else says chats are unavailable", () => {
    expect(resolveModeLanding({ mode: "chats", ...everything })).toEqual({
      kind: "open-thread",
      threadRef: chat,
    });
    expect(resolveModeLanding({ mode: "chats", ...everything, recentChat: null })).toEqual({
      kind: "new-chat",
      environmentId: env,
    });
    expect(
      resolveModeLanding({
        mode: "chats",
        ...everything,
        recentChat: null,
        chatEnvironmentId: null,
      }),
    ).toEqual({ kind: "chats-unavailable" });
  });

  it("keeps Work landing on a draft in the most recent repository", () => {
    expect(resolveModeLanding({ mode: "tasks", ...everything })).toEqual({
      kind: "repository-draft",
      projectRef: repository,
    });
    expect(resolveModeLanding({ mode: "tasks", ...everything, recentRepository: null })).toEqual({
      kind: "no-repositories",
    });
  });

  it("opens the most recent agent, or the agents empty state once agents have loaded", () => {
    expect(resolveModeLanding({ mode: "agents", ...everything })).toEqual({
      kind: "open-thread",
      threadRef: agentThread,
    });
    const none = { ...everything, recentAgentConversation: null };
    expect(resolveModeLanding({ mode: "agents", ...none }).kind).toBe("agents-empty");
    expect(resolveModeLanding({ mode: "agents", ...none, agentsLoaded: false }).kind).toBe("wait");
  });

  it("opens the projects overview in Projects", () => {
    expect(resolveModeLanding({ mode: "projects", ...everything }).kind).toBe("projects-overview");
  });

  it("waits for threads before choosing a chat or repository", () => {
    expect(resolveModeLanding({ mode: "chats", ...everything, bootstrapped: false }).kind).toBe(
      "wait",
    );
    expect(resolveModeLanding({ mode: "tasks", ...everything, bootstrapped: false }).kind).toBe(
      "wait",
    );
  });
});

describe("modeSwitchReplacesMainPanel", () => {
  const thread = (mode: Exclude<SidebarMode, "projects">): MainPanelContent => ({
    kind: "thread",
    mode,
  });

  it("replaces a thread another mode lists, and keeps one this mode lists", () => {
    expect(modeSwitchReplacesMainPanel("chats", thread("tasks"))).toBe(true);
    expect(modeSwitchReplacesMainPanel("chats", thread("agents"))).toBe(true);
    expect(modeSwitchReplacesMainPanel("tasks", thread("chats"))).toBe(true);
    expect(modeSwitchReplacesMainPanel("projects", thread("chats"))).toBe(true);
    expect(modeSwitchReplacesMainPanel("chats", thread("chats"))).toBe(false);
    expect(modeSwitchReplacesMainPanel("tasks", thread("tasks"))).toBe(false);
    expect(modeSwitchReplacesMainPanel("agents", thread("agents"))).toBe(false);
  });

  it("replaces a project view outside Projects", () => {
    for (const mode of SIDEBAR_MODES) {
      expect(modeSwitchReplacesMainPanel(mode, { kind: "project-view" })).toBe(mode !== "projects");
    }
  });

  it("leaves the index and other pages to land or go back on their own", () => {
    for (const mode of SIDEBAR_MODES) {
      expect(modeSwitchReplacesMainPanel(mode, { kind: "index" })).toBe(false);
      expect(modeSwitchReplacesMainPanel(mode, { kind: "other" })).toBe(false);
    }
  });
});
