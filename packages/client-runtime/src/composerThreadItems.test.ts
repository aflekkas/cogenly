import type {
  EnvironmentId,
  IntegrationSource,
  ProjectLabelId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  integrationSourceChipLabel,
  integrationSourceNotice,
  integrationSourcesForProject,
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

function source(
  overrides: Omit<Partial<IntegrationSource>, "id"> & { id: string },
): IntegrationSource {
  return {
    name: overrides.id,
    displayName: overrides.serviceName ?? "Gmail",
    icon: null,
    serviceName: "Gmail",
    accountLabel: null,
    status: "connected",
    scope: { type: "all" },
    ...overrides,
    id: overrides.id as IntegrationSource["id"],
  };
}

describe("integrationSourcesForProject", () => {
  const project = "label-1" as ProjectLabelId;
  const sources = [
    source({ id: "everywhere" }),
    source({ id: "here", scope: { type: "projects", labelIds: [project] } }),
    source({
      id: "elsewhere",
      scope: { type: "projects", labelIds: ["label-2" as ProjectLabelId] },
    }),
  ];

  it("keeps all-project sources and those scoped to the thread's project", () => {
    expect(integrationSourcesForProject(sources, project).map((entry) => entry.id)).toEqual([
      "everywhere",
      "here",
    ]);
  });

  it("gives a thread in no project only the all-project sources", () => {
    expect(integrationSourcesForProject(sources, null).map((entry) => entry.id)).toEqual([
      "everywhere",
    ]);
  });
});

describe("integrationSourceChipLabel", () => {
  it("names the service and the account", () => {
    expect(
      integrationSourceChipLabel({
        serviceName: "Gmail",
        displayName: "Gmail",
        accountLabel: "work",
      }),
    ).toBe("Gmail · work");
  });

  it("falls back to the integration's own name, then the service alone", () => {
    expect(
      integrationSourceChipLabel({
        serviceName: "Linear",
        displayName: "Linear (Acme)",
        accountLabel: null,
      }),
    ).toBe("Linear · Linear (Acme)");
    expect(
      integrationSourceChipLabel({
        serviceName: "Linear",
        displayName: "Linear",
        accountLabel: " ",
      }),
    ).toBe("Linear");
  });
});

describe("integrationSourceNotice", () => {
  it("says nothing for a connected source", () => {
    expect(integrationSourceNotice({ status: "connected" })).toBeNull();
  });

  it("asks for sign-in, on this machine when the account was synced from another", () => {
    expect(integrationSourceNotice({ status: "needs_sign_in" })).toMatchObject({
      badge: "Needs sign-in",
      tone: "warning",
    });
    expect(
      integrationSourceNotice({
        status: "needs_sign_in",
        syncedFrom: { machineLabel: "Mac mini" },
      }),
    ).toMatchObject({
      badge: "Sign in on this machine",
      tone: "warning",
      detail: expect.stringContaining("Mac mini"),
    });
  });

  it("reports an error with the server's reason", () => {
    expect(integrationSourceNotice({ status: "error", message: "Token revoked" })).toEqual({
      badge: "Error",
      tone: "error",
      detail: "Token revoked",
    });
  });
});

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

  it("matches sources by service, account or integration name", () => {
    const sources = [
      source({ id: "gmail-work", serviceName: "Gmail", accountLabel: "work" }),
      source({ id: "gmail-home", serviceName: "Gmail", accountLabel: "home" }),
      source({ id: "linear", name: "linear-acme", serviceName: "Linear", accountLabel: null }),
    ];
    const byQuery = (query: string) =>
      matchComposerMentionItems({ ...base, sources, query }).map((item) => [
        item.group,
        item.label,
        item.description,
      ]);
    expect(byQuery("work")).toEqual([["sources", "Gmail", "work"]]);
    expect(byQuery("gmail")).toEqual([
      ["sources", "Gmail", "work"],
      ["sources", "Gmail", "home"],
    ]);
    expect(byQuery("acme")).toEqual([["sources", "Linear", ""]]);
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
