import {
  AgentId,
  defaultAgentPermissions,
  ProjectId,
  ProjectLabelId,
  ProviderInstanceId,
  ThreadId,
  type AgentApproval,
  type Commitment,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  agentAttentionCount,
  agentRepositoryAccess,
  agentWorkStartPolicy,
  commitmentDueLabel,
  decisionsWaitingCount,
  decisionsWaitingLabel,
  describeApproval,
  describeThreadApproval,
  describeCommitmentHistory,
  describeEventFilter,
  describeRunAction,
  describeSchedule,
  EVENT_FILTER_OUT_OF_SCOPE_MESSAGE,
  eventFilterChoices,
  eventFilterOutOfScope,
  eventRunRefs,
  normalizeEventFilter,
  groupCommitments,
  resolveCommitmentRef,
  triggerErrorMessage,
} from "./agentWorkspace.logic";

const commitment = (
  id: string,
  status: Commitment["status"],
  fields: Partial<Commitment> = {},
): Commitment => ({
  id,
  title: id,
  description: "",
  owner: { kind: "user" },
  dueAt: null,
  reminderAt: null,
  waitingOn: null,
  labelIds: [],
  agentId: null,
  sourceRefs: [],
  evidenceRefs: [],
  status,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...fields,
});

describe("groupCommitments", () => {
  it("puts proposals first and closes with done and dismissed", () => {
    const groups = groupCommitments([
      commitment("done", "done"),
      commitment("waiting", "waiting"),
      commitment("open", "open"),
      commitment("dismissed", "dismissed"),
      commitment("proposed", "proposed"),
      commitment("progress", "in_progress"),
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      "proposed",
      "open",
      "in_progress",
      "waiting",
      "closed",
    ]);
    expect(
      groups
        .at(-1)!
        .items.map((item) => item.id)
        .toSorted(),
    ).toEqual(["dismissed", "done"]);
  });

  it("orders active items soonest due first, undated after, then most recently updated", () => {
    const [open] = groupCommitments([
      commitment("undated-old", "open", { updatedAt: "2026-10-02T00:00:00.000Z" }),
      commitment("later", "open", { dueAt: "2026-10-20T00:00:00.000Z" }),
      commitment("undated-new", "open", { updatedAt: "2026-10-05T00:00:00.000Z" }),
      commitment("sooner", "open", { dueAt: "2026-10-10T00:00:00.000Z" }),
    ]);
    expect(open!.items.map((item) => item.id)).toEqual([
      "sooner",
      "later",
      "undated-new",
      "undated-old",
    ]);
  });

  it("omits empty groups", () => {
    expect(groupCommitments([commitment("a", "open")]).map((group) => group.key)).toEqual(["open"]);
  });
});

describe("commitmentDueLabel", () => {
  const now = new Date(2026, 9, 19, 15);
  it("flags overdue, today and tomorrow relative to local days", () => {
    expect(commitmentDueLabel(new Date(2026, 9, 18, 23).toISOString(), now)?.overdue).toBe(true);
    expect(commitmentDueLabel(new Date(2026, 9, 19, 8).toISOString(), now)?.text).toBe("Due today");
    expect(commitmentDueLabel(new Date(2026, 9, 20, 23).toISOString(), now)?.text).toBe(
      "Due tomorrow",
    );
    expect(commitmentDueLabel(null, now)).toBeNull();
  });
});

describe("resolveCommitmentRef", () => {
  const context = {
    conversationThreadId: "conversation",
    messageIds: new Set(["m1"]),
    runs: [
      { id: "run-chat", threadId: "conversation" },
      { id: "run-work", threadId: "work-1" },
    ],
  };
  it("opens threads and runs in the app and the agent's own conversation as chat", () => {
    expect(resolveCommitmentRef({ kind: "thread", id: "work-2" }, context)).toEqual({
      kind: "thread",
      label: "Thread",
      threadId: "work-2",
    });
    expect(resolveCommitmentRef({ kind: "run", id: "run-work" }, context)).toMatchObject({
      kind: "thread",
      threadId: "work-1",
    });
    expect(resolveCommitmentRef({ kind: "run", id: "run-chat" }, context).kind).toBe("chat");
    expect(resolveCommitmentRef({ kind: "message", id: "m1" }, context)).toEqual({
      kind: "chat",
      label: "Message",
      messageId: "m1",
    });
  });
  it("keeps unknown and non-http references as text", () => {
    expect(resolveCommitmentRef({ kind: "message", id: "elsewhere" }, context).kind).toBe("text");
    expect(resolveCommitmentRef({ kind: "run", id: "missing" }, context).kind).toBe("text");
    expect(resolveCommitmentRef({ kind: "url", id: "javascript:alert(1)" }, context).kind).toBe(
      "text",
    );
    expect(resolveCommitmentRef({ kind: "pr", id: "acme/web#12" }, context)).toEqual({
      kind: "text",
      label: "PR #12",
    });
  });
  it("opens pull requests and links externally", () => {
    expect(
      resolveCommitmentRef({ kind: "pr", id: "https://github.com/acme/web/pull/42" }, context),
    ).toEqual({ kind: "external", label: "PR #42", href: "https://github.com/acme/web/pull/42" });
    expect(
      resolveCommitmentRef({ kind: "url", id: "https://www.example.com/a" }, context),
    ).toMatchObject({ kind: "external", label: "example.com" });
  });
});

describe("describeSchedule", () => {
  it("names intervals and days plainly", () => {
    expect(describeSchedule({ type: "interval", everyMs: 3_600_000 })).toBe("Every hour");
    expect(describeSchedule({ type: "interval", everyMs: 15 * 60_000 })).toBe("Every 15 minutes");
    expect(describeSchedule({ type: "interval", everyMs: 86_400_000 })).toBe("Every day");
    expect(
      describeSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1, 2, 3, 4] }),
    ).toBe("Weekdays at 09:00");
    expect(describeSchedule({ type: "fixed_time", timeOfDay: "07:30" })).toBe("Every day at 07:30");
    expect(describeSchedule({ type: "fixed_time", timeOfDay: "07:30", weekdays: [3, 1] })).toBe(
      "Mon, Wed at 07:30",
    );
  });
});

const LABEL_NAMES = { spawn: "Spawn", bartr: "Bartr" };
describe("event trigger filters", () => {
  const names = {
    labelName: (id: string) => (LABEL_NAMES as Record<string, string>)[id],
    repositoryName: (id: string) => (id === "repo-1" ? "booking-audit" : undefined),
  };
  const bartr = ProjectLabelId.make("bartr");
  const repo = ProjectId.make("repo-1");

  it("summarizes projects, repositories and origin, naming what was removed", () => {
    expect(describeEventFilter(undefined, names)).toBeNull();
    expect(describeEventFilter({ labelIds: [], projectIds: [] }, names)).toBeNull();
    expect(
      describeEventFilter(
        { labelIds: [bartr, ProjectLabelId.make("gone")], projectIds: [repo], origin: "agent" },
        names,
      ),
    ).toBe("in Bartr, a deleted project, booking-audit · only Work an agent started");
    expect(describeEventFilter({ origin: "direct" }, names)).toBe("only Work you started");
  });

  it("appends the summary to the event only when names are known", () => {
    const schedule = {
      type: "event" as const,
      event: "pr.merged" as const,
      filter: { labelIds: [bartr] },
    };
    expect(describeSchedule(schedule, names)).toBe("When a PR merges in Bartr");
    expect(describeSchedule(schedule)).toBe("When a PR merges");
  });

  it("saves only filters that narrow, and drops ones the event cannot match", () => {
    expect(normalizeEventFilter("pr.updated", { labelIds: [], projectIds: [] })).toBeUndefined();
    expect(
      normalizeEventFilter("pr.updated", { labelIds: [bartr, bartr], projectIds: [repo] }),
    ).toEqual({ labelIds: [bartr], projectIds: [repo] });
    // Open items have no repository or Work origin.
    expect(
      normalizeEventFilter("commitment.due", {
        labelIds: [bartr],
        projectIds: [repo],
        origin: "chat",
      }),
    ).toEqual({ labelIds: [bartr] });
    expect(normalizeEventFilter("commitment.due", { origin: "chat" })).toBeUndefined();
  });
});

describe("event filter scope", () => {
  const spawn = ProjectLabelId.make("spawn");
  const bartr = ProjectLabelId.make("bartr");
  const home = ProjectId.make("home");
  const site = ProjectId.make("site");
  const other = ProjectId.make("other");
  const labels = [
    { id: spawn, name: "Spawn", repositoryIds: [site] },
    { id: bartr, name: "Bartr", repositoryIds: [other] },
  ];
  const repositories = [
    { id: home, title: "home" },
    { id: site, title: "site" },
    { id: other, title: "other" },
  ];
  const agent = { permissions: defaultAgentPermissions };

  it("offers every project and repository, and none without Read", () => {
    expect(eventFilterChoices(agent, labels, repositories)).toEqual({ labels, repositories });
    expect(
      eventFilterChoices(
        { permissions: { ...defaultAgentPermissions, read: false } },
        labels,
        repositories,
      ),
    ).toEqual({ labels: [], repositories: [] });
  });
  it("finds saved filter entries that no longer exist", () => {
    const choices = eventFilterChoices(agent, [labels[0]!], repositories.slice(0, 2));
    expect(
      eventFilterOutOfScope({ labelIds: [spawn, bartr], projectIds: [site, other] }, choices),
    ).toEqual({ labelIds: [bartr], projectIds: [other] });
    expect(eventFilterOutOfScope(undefined, choices)).toEqual({ labelIds: [], projectIds: [] });
  });
  it("words the server's scope codes and passes other messages through", () => {
    const rejected = Object.assign(new Error("raw"), { code: "event_filter_out_of_scope" });
    expect(triggerErrorMessage(rejected, "fallback")).toBe(EVENT_FILTER_OUT_OF_SCOPE_MESSAGE);
    expect(triggerErrorMessage(new Error("Server said no"), "fallback")).toBe("Server said no");
    expect(triggerErrorMessage("nope", "fallback")).toBe("fallback");
  });
});

describe("eventRunRefs", () => {
  it("links the Work thread, the pull request and the open item", () => {
    const titles = (id: string) => (id === "c1" ? "Ship the fix" : undefined);
    expect(
      eventRunRefs(
        {
          threadId: ThreadId.make("work-1"),
          prUrl: "https://github.com/acme/bartr/pull/42",
          commitmentId: "c1",
        },
        titles,
      ),
    ).toEqual([
      { kind: "thread", label: "Work", threadId: "work-1" },
      { kind: "external", label: "PR #42", href: "https://github.com/acme/bartr/pull/42" },
      { kind: "item", label: "Ship the fix", commitmentId: "c1" },
    ]);
    expect(eventRunRefs({ prUrl: "javascript:alert(1)", commitmentId: "gone" }, titles)).toEqual([
      { kind: "text", label: "Pull request" },
      { kind: "text", label: "A removed open item" },
    ]);
  });
});

describe("describeApproval", () => {
  const bartr = ProjectLabelId.make("bartr");
  const agent = { name: "Bartr Engineering", permissions: defaultAgentPermissions };
  const context = {
    agent,
    repositoryName: (id: string) => (id === "repo-1" ? "booking-audit" : undefined),
    labelName: (id: string) => (LABEL_NAMES as Record<string, string>)[id],
  };
  const approval = (action: AgentApproval["action"]) => ({ action });

  it("names the repository and title for Work", () => {
    const description = describeApproval(
      approval({
        actionKind: "start_work",
        payload: {
          agentId: AgentId.make("a"),
          projectId: ProjectId.make("repo-1"),
          title: "Fix booking checks",
          prompt: "Repair the broken path checks.",
        },
      }),
      context,
    );
    expect(description.title).toBe("Start Work in booking-audit: Fix booking checks");
    expect(description.details).toEqual(["Repair the broken path checks."]);
  });

  it("names the event, where it applies and who wakes for an event trigger", () => {
    const trigger = (schedule: ScheduledTaskUpsertSchedule) =>
      describeApproval(
        approval({
          actionKind: "schedule_trigger",
          payload: {
            title: "Failing checks",
            prompt: "Find what broke.",
            enabled: true,
            schedule,
            projectId: ProjectId.make("repo-1"),
            threadId: null,
            modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          },
        }),
        context,
      );
    const scoped = trigger({
      type: "event",
      event: "pr.checks_failed",
      filter: { labelIds: [bartr], projectIds: [ProjectId.make("repo-1")] },
    });
    expect(scoped.title).toBe(
      "When PR checks fail in Bartr, booking-audit → wake Bartr Engineering",
    );
    expect(scoped.details).toEqual(["“Failing checks” · Find what broke."]);
    expect(trigger({ type: "event", event: "work.review_ready" }).title).toBe(
      "When Work is ready for review → wake Bartr Engineering",
    );
    // Timed triggers keep naming the trigger and its schedule.
    expect(
      trigger({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }).title,
    ).toBe("Schedule “Failing checks” · Weekdays at 09:00");
  });

  it("lists every grant change", () => {
    const description = describeApproval(
      approval({
        actionKind: "change_permissions",
        payload: { permissions: { ...defaultAgentPermissions, draft: false, send: true } },
      }),
      context,
    );
    expect(description.details).toEqual(["− Draft", "+ Send"]);
  });
});

describe("describeThreadApproval", () => {
  const threadId = ThreadId.make("thread-1");
  const vault = (
    payload: Partial<Extract<AgentApproval["action"], { actionKind: "vault_use" }>["payload"]>,
  ) => ({
    action: {
      actionKind: "vault_use" as const,
      payload: {
        vaultItemId: "vault:1",
        vaultItemName: "GitHub",
        field: "password" as const,
        domain: "github.com",
        threadId,
        ...payload,
      },
    },
  });

  it("asks to fill a field on the page's host, granting only this thread", () => {
    expect(describeThreadApproval(vault({}))).toEqual({
      title: "Fill your password for github.com from “GitHub”?",
      details: ["Allowing lets this thread use the item from now on."],
    });
    expect(describeThreadApproval(vault({ field: "totp", domain: null }))?.title).toBe(
      "Use your one-time code from “GitHub”?",
    );
  });

  it("names a CLI token once and keeps its exposure warning", () => {
    const message = "The agent and the commands it runs can read this token." as const;
    const description = describeThreadApproval(
      vault({
        vaultItemName: `CLI token · Work GitHub. ${message}`,
        field: "value",
        domain: null,
        processExposure: {
          accountId: "account:1",
          credentialId: "credential:1",
          credentialRevision: 1,
          threadId,
          projectKey: "repository:repo-1",
          message,
        },
      }),
    );
    expect(description).toEqual({
      title: "Let this thread use “CLI token · Work GitHub”?",
      details: [message],
    });
  });
});

describe("agentWorkStartPolicy", () => {
  it("mirrors the server gate", () => {
    expect(agentWorkStartPolicy({ permissions: defaultAgentPermissions }).outcome).toBe("starts");
    expect(
      agentWorkStartPolicy({ permissions: { ...defaultAgentPermissions, execute: false } }).outcome,
    ).toBe("asks");
    expect(
      agentWorkStartPolicy({ permissions: { ...defaultAgentPermissions, read: false } }).outcome,
    ).toBe("asks");
  });
});

describe("agentRepositoryAccess", () => {
  const audit = ProjectId.make("audit");
  const site = ProjectId.make("site");
  const app = ProjectId.make("app");
  const repositories = [
    { id: site, title: "Website" },
    { id: audit, title: "booking-audit" },
    { id: app, title: "app" },
  ];
  const summary = (entries: ReturnType<typeof agentRepositoryAccess>) =>
    entries.map((entry) => [entry.title, entry.home, entry.executable]);

  it("offers every repository, home first", () => {
    expect(
      summary(
        agentRepositoryAccess(
          { projectId: site, permissions: defaultAgentPermissions },
          repositories,
        ),
      ),
    ).toEqual([
      ["Website", true, true],
      ["app", false, true],
      ["booking-audit", false, true],
    ]);
  });
  it("marks every repository as asking first without Start Work", () => {
    expect(
      agentRepositoryAccess(
        { projectId: null, permissions: { ...defaultAgentPermissions, execute: false } },
        repositories,
      ).some((entry) => entry.executable),
    ).toBe(false);
  });
});

describe("agentAttentionCount", () => {
  it("counts pending approvals and requests, never messages", () => {
    expect(agentAttentionCount({ approvals: [1, 2], requests: [] })).toBe(2);
    expect(agentAttentionCount({ approvals: [], requests: [], waitingInRun: true })).toBe(1);
    expect(agentAttentionCount({ approvals: [1], requests: [1, 2], waitingInRun: true })).toBe(3);
    expect(agentAttentionCount({ approvals: [], requests: [] })).toBe(0);
  });
  it("does not count an approval twice while the run waits on nothing else", () => {
    expect(agentAttentionCount({ approvals: [1], requests: [], waitingInRun: false })).toBe(1);
  });
  it("sums decisions across agents for the Agents badge", () => {
    expect(
      decisionsWaitingCount([
        { approvals: [1], requests: [] },
        { approvals: [], requests: [], waitingInRun: true },
        { approvals: [], requests: [] },
      ]),
    ).toBe(2);
    expect(decisionsWaitingLabel(1)).toBe("1 decision waiting for you");
    expect(decisionsWaitingLabel(3)).toBe("3 decisions waiting for you");
  });
});

describe("describeCommitmentHistory", () => {
  const names = (id: string) => (id === "juniper" ? "Juniper" : undefined);
  it("names who changed it and the status change", () => {
    expect(
      describeCommitmentHistory({ who: "user", fromStatus: "open", toStatus: "done" }, names),
    ).toEqual({ who: "You", change: "Open → Done" });
    expect(
      describeCommitmentHistory(
        { who: "agent:juniper", fromStatus: null, toStatus: "proposed" },
        names,
      ),
    ).toEqual({ who: "Juniper", change: "Added as Proposed" });
  });
  it("falls back for removed agents and unchanged status", () => {
    expect(
      describeCommitmentHistory({ who: "agent:gone", fromStatus: "open", toStatus: "open" }, names),
    ).toEqual({ who: "An agent", change: "Open" });
  });
});

describe("describeRunAction", () => {
  const titles = (id: string) => (id === "c1" ? "Email Dana" : undefined);
  it("names touched items and links started Work", () => {
    expect(describeRunAction({ kind: "commitment_proposed", targetId: "c1" }, titles).text).toBe(
      "Proposed “Email Dana”",
    );
    expect(
      describeRunAction({ kind: "commitment_status_changed", targetId: "gone" }, titles).text,
    ).toBe("Updated an open item");
    expect(describeRunAction({ kind: "work_started", targetId: "t1" }, titles)).toEqual({
      text: "Started Work",
      threadId: "t1",
    });
    expect(describeRunAction({ kind: "something_new", targetId: null }, titles).text).toBe(
      "Something new",
    );
  });
});
