import {
  AgentId,
  conservativeAgentPermissions,
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
  agentWorkStartPolicy,
  commitmentDueLabel,
  describeApproval,
  describeEventFilter,
  describeRunAction,
  describeSchedule,
  eventRunRefs,
  normalizeEventFilter,
  groupAgentsByScope,
  groupCommitments,
  resolveCommitmentRef,
  scopeAccess,
  scopePermissions,
  startWorkRepositories,
  toggleScope,
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
  const spawn = ProjectLabelId.make("spawn");
  const bartr = ProjectLabelId.make("bartr");
  const agent = {
    name: "Bartr Engineering",
    autonomy: "propose" as const,
    permissions: conservativeAgentPermissions,
    scope: [{ labelId: spawn, permissions: scopePermissions("read") }],
  };
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
            runtimeMode: "approval-required",
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

  it("lists every grant, autonomy and scope change", () => {
    const description = describeApproval(
      approval({
        actionKind: "change_permissions",
        payload: {
          permissions: { ...conservativeAgentPermissions, draft: false, send: true },
          autonomy: "execute_bounded",
          scope: [
            { labelId: spawn, permissions: scopePermissions("draft") },
            { labelId: bartr, permissions: scopePermissions("read") },
          ],
        },
      }),
      context,
    );
    expect(description.details).toEqual([
      "Autonomy: Propose → Execute bounded work",
      "− Draft",
      "+ Send",
      "Project Spawn: Read → Read & draft",
      "+ Project Bartr (Read)",
    ]);
  });
});

describe("scope access", () => {
  it("maps read and draft presets and keeps other mixes custom", () => {
    expect(scopeAccess(scopePermissions("read"))).toBe("read");
    expect(scopeAccess(scopePermissions("draft"))).toBe("draft");
    expect(scopeAccess({ ...scopePermissions("read"), merge: true })).toBe("custom");
    expect(scopeAccess({ ...scopePermissions("draft"), read: false })).toBe("custom");
  });
  it("adds a project with read and draft and removes it again", () => {
    const id = ProjectLabelId.make("spawn");
    const added = toggleScope([], id, true);
    expect(added).toEqual([{ labelId: id, permissions: scopePermissions("draft") }]);
    expect(toggleScope(added, id, false)).toEqual([]);
  });
});

describe("agentWorkStartPolicy", () => {
  const base = { enabled: true, permissions: { ...conservativeAgentPermissions, execute: true } };
  it("mirrors the server gate", () => {
    expect(agentWorkStartPolicy({ ...base, autonomy: "observe" }).outcome).toBe("refused");
    expect(agentWorkStartPolicy({ ...base, autonomy: "propose" }).outcome).toBe("asks");
    expect(
      agentWorkStartPolicy({ ...base, autonomy: "execute_bounded", enabled: false }).outcome,
    ).toBe("asks");
    expect(
      agentWorkStartPolicy({
        ...base,
        autonomy: "autonomous_within_policy",
        permissions: conservativeAgentPermissions,
      }).outcome,
    ).toBe("asks");
    expect(agentWorkStartPolicy({ ...base, autonomy: "execute_bounded" }).outcome).toBe(
      "home_only",
    );
  });
});

describe("startWorkRepositories", () => {
  const spawn = ProjectLabelId.make("spawn");
  const bartr = ProjectLabelId.make("bartr");
  const audit = ProjectId.make("audit");
  const site = ProjectId.make("site");
  const app = ProjectId.make("app");
  const labels = [
    { id: spawn, name: "Spawn", repositoryIds: [audit, site, ProjectId.make("gone")] },
    { id: ProjectLabelId.make("ops"), name: "Ops", repositoryIds: [site] },
    { id: bartr, name: "Bartr", repositoryIds: [app, site] },
  ];
  const repositories = [
    { id: audit, title: "booking-audit" },
    { id: site, title: "Website" },
    { id: app, title: "app" },
  ];
  it("offers only repositories linked to scoped projects, once each", () => {
    const scope = [{ labelId: spawn, permissions: scopePermissions("read") }];
    expect(startWorkRepositories(scope, labels, repositories)).toEqual([
      { id: audit, title: "booking-audit", projects: ["Spawn"] },
      { id: site, title: "Website", projects: ["Spawn"] },
    ]);
    const both = [...scope, { labelId: bartr, permissions: scopePermissions("read") }];
    expect(
      startWorkRepositories(both, labels, repositories).find((repo) => repo.id === site)?.projects,
    ).toEqual(["Spawn", "Bartr"]);
  });
  it("offers nothing without scope", () => {
    expect(startWorkRepositories([], labels, repositories)).toEqual([]);
  });
});

describe("agentAttentionCount", () => {
  it("counts pending approvals and requests, never messages", () => {
    expect(agentAttentionCount({ approvals: [1, 2], requests: [], state: "idle" })).toBe(2);
    expect(agentAttentionCount({ approvals: [], requests: [], state: "blocked" })).toBe(1);
    expect(agentAttentionCount({ approvals: [1], requests: [1, 2], state: "blocked" })).toBe(3);
    expect(agentAttentionCount({ approvals: [], requests: [], state: "thinking" })).toBe(0);
  });
});

describe("groupAgentsByScope", () => {
  const spawn = { key: "spawn", name: "Spawn", color: undefined };
  const bartr = { key: "bartr", name: "Bartr", color: undefined };
  it("lists an agent under each scoped project and unscoped agents last", () => {
    const scopes: Record<string, (typeof spawn)[]> = {
      ops: [spawn],
      eng: [spawn, bartr],
      solo: [],
    };
    const sections = groupAgentsByScope(["ops", "eng", "solo"], (agent) => scopes[agent]!);
    expect(sections.map((section) => [section.project?.name ?? null, section.agents])).toEqual([
      ["Bartr", ["eng"]],
      ["Spawn", ["ops", "eng"]],
      [null, ["solo"]],
    ]);
  });
  it("returns one unlabeled section when no agent has scope", () => {
    expect(groupAgentsByScope(["a", "b"], () => [])).toEqual([
      { project: null, agents: ["a", "b"] },
    ]);
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
