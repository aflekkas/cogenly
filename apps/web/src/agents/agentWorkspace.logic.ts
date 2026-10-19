/**
 * Pure helpers for an agent's Open items, Activity and Responsibilities. Status
 * and policy text mirror what the server enforces (`AgentWorkspaceService`,
 * `AgentMcpPolicy`); nothing here grants or infers access.
 */
import type {
  Agent,
  AgentApproval,
  AgentEventContext,
  AgentEventFilter,
  AgentEventKind,
  AgentPermissions,
  Commitment,
  CommitmentHistory,
  CommitmentRef,
  ProjectId,
  ProjectLabelId,
  ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";

type Autonomy = Agent["autonomy"];
type Scope = Agent["scope"];
type CommitmentStatus = Commitment["status"];

// Open items -----------------------------------------------------------------

export const COMMITMENT_STATUS_LABEL: Record<CommitmentStatus, string> = {
  proposed: "Proposed",
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  dismissed: "Dismissed",
};

export type CommitmentGroupKey = "proposed" | "open" | "in_progress" | "waiting" | "closed";
export const COMMITMENT_GROUP_LABEL: Record<CommitmentGroupKey, string> = {
  proposed: "Proposed · confirm or dismiss",
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting",
  closed: "Done & dismissed",
};

const byDueThenRecent = (a: Commitment, b: Commitment) =>
  (a.dueAt ?? "￿").localeCompare(b.dueAt ?? "￿") ||
  b.updatedAt.localeCompare(a.updatedAt) ||
  a.id.localeCompare(b.id);
const byRecent = (a: Commitment, b: Commitment) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

/**
 * Proposed items first (they need a decision), then open, in progress and waiting,
 * each soonest-due first with undated items after; done and dismissed close the list,
 * most recent first. Empty groups are omitted.
 */
export function groupCommitments(items: ReadonlyArray<Commitment>) {
  const groups: Record<CommitmentGroupKey, Commitment[]> = {
    proposed: [],
    open: [],
    in_progress: [],
    waiting: [],
    closed: [],
  };
  for (const item of items) {
    groups[item.status === "done" || item.status === "dismissed" ? "closed" : item.status].push(
      item,
    );
  }
  groups.proposed.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
  groups.open.sort(byDueThenRecent);
  groups.in_progress.sort(byDueThenRecent);
  groups.waiting.sort(byDueThenRecent);
  groups.closed.sort(byRecent);
  return (Object.keys(groups) as CommitmentGroupKey[])
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, label: COMMITMENT_GROUP_LABEL[key], items: groups[key] }));
}

/** Items that still want something from someone: everything but done and dismissed. */
export function countOpenCommitments(items: ReadonlyArray<Commitment>) {
  return items.filter((item) => item.status !== "done" && item.status !== "dismissed").length;
}

export function commitmentOwnerLabel(
  owner: Commitment["owner"],
  agentName: (agentId: string) => string | undefined,
) {
  if (owner.kind === "user") return "You";
  if (owner.kind === "person") return owner.name;
  return agentName(owner.agentId) ?? "An agent";
}

/**
 * One line of an open item's history. The server records the actor as "user" or
 * "agent:<id>"; anything else is shown as recorded.
 */
export function describeCommitmentHistory(
  entry: Pick<CommitmentHistory, "who" | "fromStatus" | "toStatus">,
  agentName: (agentId: string) => string | undefined,
) {
  const agentId = entry.who.startsWith("agent:") ? entry.who.slice("agent:".length) : null;
  const who =
    entry.who === "user"
      ? "You"
      : agentId !== null
        ? (agentName(agentId) ?? "An agent")
        : entry.who;
  const to = COMMITMENT_STATUS_LABEL[entry.toStatus];
  const change =
    entry.fromStatus === null
      ? `Added as ${to}`
      : entry.fromStatus === entry.toStatus
        ? to
        : `${COMMITMENT_STATUS_LABEL[entry.fromStatus]} → ${to}`;
  return { who, change };
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "Overdue · Oct 3", "Due today", "Due tomorrow" or "Due Oct 21"; null without a date. */
export function commitmentDueLabel(
  dueAt: string | null,
  now = new Date(),
  locale?: string,
): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000);
  const date = due.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(due.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  if (days < 0) return { text: `Overdue · ${date}`, overdue: true };
  if (days === 0) return { text: "Due today", overdue: false };
  if (days === 1) return { text: "Due tomorrow", overdue: false };
  return { text: `Due ${date}`, overdue: false };
}

export type ResolvedCommitmentRef =
  | { kind: "chat"; label: string; messageId?: string }
  | { kind: "thread"; label: string; threadId: string }
  | { kind: "external"; label: string; href: string }
  | { kind: "text"; label: string };

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** "PR #12" linking out when the id is an http(s) URL; plain text otherwise. */
function prRef(
  id: string,
): { kind: "external"; label: string; href: string } | { kind: "text"; label: string } {
  const url = safeUrl(id);
  const number = url?.pathname.match(/\/pull\/(\d+)/)?.[1] ?? id.match(/#(\d+)$/)?.[1];
  const label = number ? `PR #${number}` : "Pull request";
  return url ? { kind: "external", label, href: url.href } : { kind: "text", label };
}

/**
 * Where a source or evidence reference leads. Threads and runs open in the app,
 * messages in this agent's conversation open the chat, and PRs and URLs open
 * externally only when they are http(s) links. Anything unresolved stays plain text.
 */
export function resolveCommitmentRef(
  ref: CommitmentRef,
  context: {
    conversationThreadId: string;
    messageIds: ReadonlySet<string>;
    runs: ReadonlyArray<{ id: string; threadId: string }>;
  },
): ResolvedCommitmentRef {
  const toThread = (threadId: string, label: string): ResolvedCommitmentRef =>
    threadId === context.conversationThreadId
      ? { kind: "chat", label }
      : { kind: "thread", label, threadId };
  switch (ref.kind) {
    case "thread":
      return toThread(ref.id, "Thread");
    case "message":
      return context.messageIds.has(ref.id)
        ? { kind: "chat", label: "Message", messageId: ref.id }
        : { kind: "text", label: "Message" };
    case "run": {
      const run = context.runs.find((candidate) => candidate.id === ref.id);
      return run ? toThread(run.threadId, "Run") : { kind: "text", label: "Run" };
    }
    case "pr":
      return prRef(ref.id);
    case "url": {
      const url = safeUrl(ref.id);
      return url
        ? { kind: "external", label: url.hostname.replace(/^www\./, ""), href: url.href }
        : { kind: "text", label: "Link" };
    }
  }
}

// Approvals ------------------------------------------------------------------

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Resolves the projects and repositories an event filter names. */
export interface FilterNames {
  labelName: (labelId: ProjectLabelId) => string | undefined;
  repositoryName: (projectId: ProjectId) => string | undefined;
}

/**
 * "Weekdays at 09:00", "Every hour", or for an event trigger "When PR checks fail",
 * followed by its filter when `names` can resolve it.
 */
export function describeSchedule(
  schedule:
    | ScheduledTaskUpsertSchedule
    | { type: "interval"; everyMs: number }
    | { type: "fixed_time"; timeOfDay: string; weekdays?: ReadonlyArray<number> | undefined }
    | { type: "webhook" }
    | { type: "event"; event: AgentEventKind; filter?: EventFilter | undefined },
  names?: FilterNames,
) {
  if (schedule.type === "webhook") return "On webhook request";
  if (schedule.type === "event") {
    const filter = names ? describeEventFilter(schedule.filter, names) : null;
    return filter
      ? `${EVENT_TRIGGER_LABEL[schedule.event]} ${filter}`
      : EVENT_TRIGGER_LABEL[schedule.event];
  }
  if (schedule.type === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % 1440 === 0)
      return minutes === 1440 ? "Every day" : `Every ${minutes / 1440} days`;
    if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  const days = [...new Set(schedule.weekdays ?? [])].toSorted((a, b) => a - b);
  const when =
    days.length === 0 || days.length === 7
      ? "Every day"
      : days.join() === "1,2,3,4,5"
        ? "Weekdays"
        : days.join() === "0,6"
          ? "Weekends"
          : days.map((day) => WEEKDAY_NAMES[day] ?? "?").join(", ");
  return `${when} at ${schedule.timeOfDay}`;
}

export interface ApprovalDescription {
  /** One line naming the action and its target. */
  title: string;
  /** Supporting lines: the prompt, or each permission and scope change. */
  details: ReadonlyArray<string>;
}

const excerpt = (text: string, max = 240) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** Plain language for what approving would do, so a decision never needs the raw payload. */
export function describeApproval(
  approval: Pick<AgentApproval, "action">,
  context: {
    agent: Pick<Agent, "name" | "permissions" | "scope" | "autonomy">;
    repositoryName: (projectId: ProjectId) => string | undefined;
    labelName: (labelId: ProjectLabelId) => string | undefined;
  },
): ApprovalDescription {
  const action = approval.action;
  switch (action.actionKind) {
    case "start_work": {
      const repository = context.repositoryName(action.payload.projectId) ?? "a repository";
      return {
        title: `Start Work in ${repository}: ${action.payload.title}`,
        details: [excerpt(action.payload.prompt)],
      };
    }
    case "schedule_trigger":
      return action.payload.schedule.type === "event"
        ? {
            title: `${describeSchedule(action.payload.schedule, context)} → wake ${context.agent.name}`,
            details: [`“${action.payload.title}” · ${excerpt(action.payload.prompt)}`],
          }
        : {
            title: `Schedule “${action.payload.title}” · ${describeSchedule(action.payload.schedule)}`,
            details: [excerpt(action.payload.prompt)],
          };
    case "change_permissions":
      return {
        title: "Change its permissions",
        details: policyDiff(context.agent, action.payload, context.labelName),
      };
  }
}

/** Each change as "+ Grant", "− Grant", "Autonomy: A → B", "+ Project X", "− Project Y". */
export function policyDiff(
  current: Pick<Agent, "permissions" | "scope" | "autonomy">,
  next: {
    permissions: AgentPermissions;
    scope?: Scope | undefined;
    autonomy?: Autonomy | undefined;
  },
  labelName: (labelId: ProjectLabelId) => string | undefined,
) {
  const lines: string[] = [];
  if (next.autonomy && next.autonomy !== current.autonomy)
    lines.push(`Autonomy: ${AUTONOMY_LABEL[current.autonomy]} → ${AUTONOMY_LABEL[next.autonomy]}`);
  for (const option of PERMISSION_OPTIONS) {
    const before = current.permissions[option.key];
    const after = next.permissions[option.key];
    if (before !== after) lines.push(`${after ? "+" : "−"} ${option.label}`);
  }
  if (next.scope) {
    const name = (id: ProjectLabelId) => labelName(id) ?? "a deleted project";
    const was = new Map(current.scope.map((entry) => [entry.labelId, entry]));
    const now = new Map(next.scope.map((entry) => [entry.labelId, entry]));
    for (const [id, entry] of now) {
      const previous = was.get(id);
      if (!previous)
        lines.push(`+ Project ${name(id)} (${SCOPE_ACCESS_LABEL[scopeAccess(entry.permissions)]})`);
      else if (scopeAccess(previous.permissions) !== scopeAccess(entry.permissions))
        lines.push(
          `Project ${name(id)}: ${SCOPE_ACCESS_LABEL[scopeAccess(previous.permissions)]} → ${SCOPE_ACCESS_LABEL[scopeAccess(entry.permissions)]}`,
        );
    }
    for (const id of was.keys()) if (!now.has(id)) lines.push(`− Project ${name(id)}`);
  }
  return lines.length > 0 ? lines : ["No effective change"];
}

// Event triggers ---------------------------------------------------------------

type EventFilter = typeof AgentEventFilter.Type;
type EventOrigin = NonNullable<EventFilter["origin"]>;

export const EVENT_TRIGGER_LABEL: Record<AgentEventKind, string> = {
  "work.completed": "When Work finishes",
  "work.failed": "When Work fails",
  "work.review_ready": "When Work is ready for review",
  "pr.updated": "When a PR is updated",
  "pr.checks_failed": "When PR checks fail",
  "pr.merged": "When a PR merges",
  "commitment.due": "When an open item is due",
};

/** The event picker, most useful first. */
export const EVENT_TRIGGER_OPTIONS: ReadonlyArray<{ value: AgentEventKind; label: string }> = [
  { value: "pr.checks_failed", label: "PR checks fail" },
  { value: "pr.updated", label: "A PR is updated" },
  { value: "pr.merged", label: "A PR merges" },
  { value: "work.review_ready", label: "Work is ready for review" },
  { value: "work.completed", label: "Work finishes" },
  { value: "work.failed", label: "Work fails" },
  { value: "commitment.due", label: "An open item is due" },
];

export const EVENT_ORIGIN_LABEL: Record<EventOrigin, string> = {
  direct: "Work you started",
  chat: "Work started from a chat",
  agent: "Work an agent started",
};

/** Open items carry projects but no repository or Work origin, so only projects filter them. */
export function eventFiltersWork(event: AgentEventKind) {
  return event !== "commitment.due";
}

/**
 * The filter as saved: duplicates and empty lists dropped, repository and origin
 * dropped for events they cannot match, and nothing at all when nothing narrows it.
 */
export function normalizeEventFilter(
  event: AgentEventKind,
  filter: EventFilter | undefined,
): EventFilter | undefined {
  const labelIds = [...new Set(filter?.labelIds ?? [])];
  const projectIds = eventFiltersWork(event) ? [...new Set(filter?.projectIds ?? [])] : [];
  const origin = eventFiltersWork(event) ? filter?.origin : undefined;
  const next = {
    ...(labelIds.length > 0 ? { labelIds } : {}),
    ...(projectIds.length > 0 ? { projectIds } : {}),
    ...(origin ? { origin } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * What an agent's event filter may name: the projects and repositories it can read,
 * which the server also enforces (`event_filter_out_of_scope`).
 */
export function eventFilterChoices<L extends ScopeLabel>(
  agent: Pick<Agent, "scope" | "projectId" | "permissions" | "autonomy">,
  labels: ReadonlyArray<L>,
  repositories: ReadonlyArray<{ id: ProjectId; title: string }>,
) {
  return {
    labels: agentReadableLabels(agent, labels),
    repositories: agentRepositoryAccess(agent, labels, repositories)
      .filter((repository) => repository.readable)
      .map(({ id, title }) => ({ id, title })),
  };
}

/** The ids a saved filter names that are no longer among the choices. */
export function eventFilterOutOfScope(
  filter: EventFilter | undefined,
  choices: {
    labels: ReadonlyArray<{ id: ProjectLabelId }>;
    repositories: ReadonlyArray<{ id: ProjectId }>;
  },
) {
  const labels = new Set(choices.labels.map((label) => label.id));
  const repositories = new Set(choices.repositories.map((repository) => repository.id));
  return {
    labelIds: (filter?.labelIds ?? []).filter((id) => !labels.has(id)),
    projectIds: (filter?.projectIds ?? []).filter((id) => !repositories.has(id)),
  };
}

export const EVENT_FILTER_OUT_OF_SCOPE_MESSAGE =
  "This trigger is limited to a project or repository the agent can't read. Remove it from the filter, or grant the project Read in the agent's Responsibilities.";
export const EVENT_RUN_NOW_UNSUPPORTED_MESSAGE =
  "Event triggers run only when the event happens, so there is no Run now.";

/** The `ScheduledTaskError.code` the server attached to a failure, if any. */
export function scheduledTaskErrorCode(cause: unknown) {
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : null;
}

/** A failed trigger save or run in words: the known scope codes plainly, else the server's message. */
export function triggerErrorMessage(cause: unknown, fallback: string) {
  const code = scheduledTaskErrorCode(cause);
  if (code === "event_filter_out_of_scope") return EVENT_FILTER_OUT_OF_SCOPE_MESSAGE;
  if (code === "event_run_now_unsupported") return EVENT_RUN_NOW_UNSUPPORTED_MESSAGE;
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * "in Bartr, cogenly · only Work an agent started": projects then repositories, then
 * origin; null when the trigger reacts to every event of its kind it can read.
 */
export function describeEventFilter(filter: EventFilter | undefined, names: FilterNames) {
  const places = [
    ...new Set([
      ...(filter?.labelIds ?? []).map((id) => names.labelName(id) ?? "a deleted project"),
      ...(filter?.projectIds ?? []).map((id) => names.repositoryName(id) ?? "a removed repository"),
    ]),
  ];
  const parts = [
    places.length > 0 ? `in ${places.join(", ")}` : null,
    filter?.origin ? `only ${EVENT_ORIGIN_LABEL[filter.origin]}` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Responsibilities -----------------------------------------------------------

export const AUTONOMY_LABEL: Record<Autonomy, string> = {
  observe: "Observe",
  propose: "Propose",
  execute_bounded: "Execute bounded work",
  autonomous_within_policy: "Autonomous within policy",
};

export const AUTONOMY_OPTIONS: ReadonlyArray<{
  value: Autonomy;
  label: string;
  description: string;
}> = [
  {
    value: "observe",
    label: AUTONOMY_LABEL.observe,
    description: "Reads and summarizes. Never changes anything.",
  },
  {
    value: "propose",
    label: AUTONOMY_LABEL.propose,
    description: "Drafts plans and open items. Asks you before starting Work or acting.",
  },
  {
    value: "execute_bounded",
    label: AUTONOMY_LABEL.execute_bounded,
    description:
      "Starts Work in its home repository and projects granted Read & execute. Asks for anything else.",
  },
  {
    value: "autonomous_within_policy",
    label: AUTONOMY_LABEL.autonomous_within_policy,
    description: "Acts on its own within the grants below. New triggers and grants still need you.",
  },
];

type PermissionKey = keyof AgentPermissions;
export const PERMISSION_OPTIONS: ReadonlyArray<{
  key: PermissionKey;
  label: string;
  description: string;
  highImpact: boolean;
}> = [
  {
    key: "read",
    label: "Read",
    description: "Read context and its open items.",
    highImpact: false,
  },
  {
    key: "draft",
    label: "Draft",
    description: "Propose open items, notes and plans for you to confirm.",
    highImpact: false,
  },
  {
    key: "execute",
    label: "Start Work",
    description:
      "Start coding sessions and run tools, in its home repository and projects granted Read & execute.",
    highImpact: false,
  },
  {
    key: "send",
    label: "Send",
    description: "Send messages, comments or reviews outside Cogenly.",
    highImpact: true,
  },
  { key: "create_pr", label: "Create PRs", description: "Open pull requests.", highImpact: true },
  { key: "merge", label: "Merge", description: "Merge pull requests.", highImpact: true },
  { key: "deploy", label: "Deploy", description: "Run deployments.", highImpact: true },
  { key: "delete", label: "Delete", description: "Delete or remove data.", highImpact: true },
];

const EXECUTING_AUTONOMY: ReadonlySet<Autonomy> = new Set([
  "execute_bounded",
  "autonomous_within_policy",
]);

/** Whether the agent's own settings let it execute anywhere: Read, Start Work and an executing autonomy. */
export function agentCanExecute(agent: Pick<Agent, "autonomy" | "permissions">) {
  return (
    agent.permissions.read && agent.permissions.execute && EXECUTING_AUTONOMY.has(agent.autonomy)
  );
}

/**
 * What happens when the agent tries to start Work, mirroring the server's gate:
 * observe agents are refused; paused, propose, or no Read or Start Work grant asks the
 * owner; otherwise it may start Work in its home repository and in repositories linked
 * to projects granted Read & execute, and asks for any other one.
 */
export function agentWorkStartPolicy(agent: Pick<Agent, "autonomy" | "enabled" | "permissions">): {
  outcome: "refused" | "asks" | "scoped";
  text: string;
} {
  if (agent.autonomy === "observe")
    return { outcome: "refused", text: "Can't start Work at this autonomy level." };
  if (!agent.enabled || !agentCanExecute(agent))
    return {
      outcome: "asks",
      text: !agent.enabled
        ? "Paused: asks you before starting Work."
        : !agent.permissions.execute
          ? "Asks you before starting Work (no Start Work permission)."
          : !agent.permissions.read
            ? "Asks you before starting Work (no Read permission)."
            : "Asks you before starting Work.",
    };
  return {
    outcome: "scoped",
    text: "Starts Work on its own in its home repository and in projects granted Read & execute; asks you for any other repository.",
  };
}

export type ScopeAccess = "read" | "draft" | "execute" | "custom";
export const SCOPE_ACCESS_LABEL: Record<ScopeAccess, string> = {
  read: "Read",
  draft: "Read & draft",
  execute: "Read & execute",
  custom: "Custom",
};
/** The per-project choices, each a step up from the last. */
export const SCOPE_ACCESS_OPTIONS: ReadonlyArray<{
  value: Exclude<ScopeAccess, "custom">;
  label: string;
  description: string;
}> = [
  {
    value: "read",
    label: SCOPE_ACCESS_LABEL.read,
    description: "Reads its repositories, facts and open items.",
  },
  {
    value: "draft",
    label: SCOPE_ACCESS_LABEL.draft,
    description: "Also proposes open items for you to confirm. Never starts Work here.",
  },
  {
    value: "execute",
    label: SCOPE_ACCESS_LABEL.execute,
    description: "Also starts Work in its repositories without asking, within its autonomy.",
  },
];
const NO_PERMISSIONS: AgentPermissions = {
  read: false,
  draft: false,
  execute: false,
  send: false,
  create_pr: false,
  merge: false,
  deploy: false,
  delete: false,
};

/** Scope grants are read, draft and execute per project; any other mix is kept as "Custom". */
export function scopeAccess(permissions: AgentPermissions): ScopeAccess {
  const { read, draft, execute, ...rest } = permissions;
  if (Object.values(rest).some(Boolean) || !read) return "custom";
  if (execute) return draft ? "execute" : "custom";
  return draft ? "draft" : "read";
}

export function scopePermissions(access: Exclude<ScopeAccess, "custom">): AgentPermissions {
  return {
    ...NO_PERMISSIONS,
    read: true,
    draft: access !== "read",
    execute: access === "execute",
  };
}

/**
 * Why a project's grant does less than its label says, given the agent-level settings
 * the server also requires; null when the grant takes full effect.
 */
export function scopeAccessLimit(
  agent: Pick<Agent, "autonomy" | "permissions">,
  access: ScopeAccess,
): string | null {
  if (!agent.permissions.read) return "Has no effect while the Read permission is off.";
  if (access === "execute" && !agentCanExecute(agent)) {
    const needs = [
      EXECUTING_AUTONOMY.has(agent.autonomy) ? null : "autonomy Execute bounded work or higher",
      agent.permissions.execute ? null : "the Start Work permission",
    ].filter((need) => need !== null);
    return `Executing here also needs ${needs.join(" and ")}. Until then it asks you first.`;
  }
  if ((access === "draft" || access === "execute") && !agent.permissions.draft)
    return "Can't propose open items while the Draft permission is off.";
  if ((access === "draft" || access === "execute") && agent.autonomy === "observe")
    return "Can't propose open items at Observe autonomy.";
  return null;
}

/** Add a project with read & draft access, or remove it. Other grants are untouched. */
export function toggleScope(scope: Scope, labelId: ProjectLabelId, selected: boolean): Scope {
  const without = scope.filter((entry) => entry.labelId !== labelId);
  return selected ? [...without, { labelId, permissions: scopePermissions("draft") }] : without;
}

type ScopeLabel = {
  id: ProjectLabelId;
  name: string;
  repositoryIds: ReadonlyArray<ProjectId>;
};

/** Projects the agent may read, and so name in event trigger filters. */
export function agentReadableLabels<L extends { id: ProjectLabelId }>(
  agent: Pick<Agent, "scope" | "permissions">,
  labels: ReadonlyArray<L>,
): L[] {
  if (!agent.permissions.read) return [];
  const readable = new Set(
    agent.scope.filter((entry) => entry.permissions.read).map((entry) => entry.labelId),
  );
  return labels.filter((label) => readable.has(label.id));
}

/**
 * The agent's repositories, mirroring the server's `AgentAccessScope`: its home
 * repository first, then those linked to projects it is granted Read on, each once with
 * the projects that link it. `readable` repositories can be read and named in event
 * filters; `executable` ones it may start Work in without asking, which takes Read and
 * execute on the same project grant (the home repository needs neither) plus the
 * agent's own Read, Start Work and an executing autonomy. Tags are never grants.
 */
export function agentRepositoryAccess(
  agent: Pick<Agent, "scope" | "projectId" | "permissions" | "autonomy">,
  labels: ReadonlyArray<ScopeLabel>,
  repositories: ReadonlyArray<{ id: ProjectId; title: string }>,
) {
  const grants = new Map(
    agent.scope.filter((entry) => entry.permissions.read).map((entry) => [entry.labelId, entry]),
  );
  const canExecute = agentCanExecute(agent);
  const byId = new Map(repositories.map((repository) => [repository.id, repository]));
  const result = new Map<
    ProjectId,
    {
      id: ProjectId;
      title: string;
      projects: string[];
      home: boolean;
      readable: boolean;
      executable: boolean;
    }
  >();
  const home = agent.projectId === null ? undefined : byId.get(agent.projectId);
  if (home)
    result.set(home.id, {
      ...home,
      projects: [],
      home: true,
      readable: agent.permissions.read,
      executable: canExecute,
    });
  for (const label of labels) {
    const grant = grants.get(label.id);
    if (!grant) continue;
    for (const repositoryId of label.repositoryIds) {
      const repository = byId.get(repositoryId);
      if (!repository) continue;
      const entry = result.get(repositoryId) ?? {
        ...repository,
        projects: [],
        home: false,
        readable: agent.permissions.read,
        executable: false,
      };
      entry.projects.push(label.name);
      entry.executable ||= canExecute && grant.permissions.execute;
      result.set(repositoryId, entry);
    }
  }
  return [...result.values()].toSorted(
    (a, b) =>
      Number(b.home) - Number(a.home) ||
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );
}

// Sidebar --------------------------------------------------------------------

/**
 * Pending decisions only: approvals plus questions or approvals inside its runs.
 * Before its requests load, a run known to be waiting counts once. Never messages.
 */
export function agentAttentionCount(agent: {
  approvals: ReadonlyArray<unknown>;
  requests: ReadonlyArray<unknown>;
  waitingInRun?: boolean | undefined;
}) {
  return agent.approvals.length + (agent.requests.length || (agent.waitingInRun ? 1 : 0));
}

/** The Agents badge: every decision waiting for you, across all agents. */
export function decisionsWaitingCount(
  agents: ReadonlyArray<Parameters<typeof agentAttentionCount>[0]>,
) {
  return agents.reduce((total, agent) => total + agentAttentionCount(agent), 0);
}

export const decisionsWaitingLabel = (count: number) =>
  `${count} ${count === 1 ? "decision" : "decisions"} waiting for you`;

export interface AgentScopeHeading {
  key: string;
  name: string;
  color: string | undefined;
}

/**
 * Agents under each project in their explicit scope (an agent in two projects
 * appears under both), alphabetical, then unscoped agents. With no scoped agent at
 * all the result is one section without a heading.
 */
export function groupAgentsByScope<T>(
  agents: ReadonlyArray<T>,
  projectsOf: (agent: T) => ReadonlyArray<AgentScopeHeading>,
): Array<{ project: AgentScopeHeading | null; agents: T[] }> {
  const sections = new Map<string, { project: AgentScopeHeading; agents: T[] }>();
  const other: T[] = [];
  for (const agent of agents) {
    const projects = projectsOf(agent);
    if (projects.length === 0) other.push(agent);
    for (const project of projects) {
      const section = sections.get(project.key);
      if (section) {
        if (!section.agents.includes(agent)) section.agents.push(agent);
      } else sections.set(project.key, { project, agents: [agent] });
    }
  }
  const result: Array<{ project: AgentScopeHeading | null; agents: T[] }> = [
    ...sections.values(),
  ].toSorted((a, b) =>
    a.project.name.localeCompare(b.project.name, undefined, { sensitivity: "base" }),
  );
  if (other.length > 0 || result.length === 0) result.push({ project: null, agents: other });
  return result;
}

// Activity ---------------------------------------------------------------------

export const RUN_TRIGGER_LABEL: Record<
  "owner_message" | "trigger" | "approval" | "work" | "event",
  string
> = {
  owner_message: "Your message",
  trigger: "Trigger",
  approval: "Approved action",
  work: "Work session",
  event: "Event",
};

/** Activity's heading for a run: what happened for event runs, otherwise how it was woken. */
export function runTriggerLabel(run: {
  triggerKind: keyof typeof RUN_TRIGGER_LABEL;
  triggerContext?: Pick<AgentEventContext, "kind"> | undefined;
}) {
  return run.triggerKind === "event" && run.triggerContext
    ? EVENT_OCCURRED_LABEL[run.triggerContext.kind]
    : RUN_TRIGGER_LABEL[run.triggerKind];
}

const EVENT_OCCURRED_LABEL: Record<AgentEventKind, string> = {
  "work.completed": "Work finished",
  "work.failed": "Work failed",
  "work.review_ready": "Work ready for review",
  "pr.updated": "PR updated",
  "pr.checks_failed": "PR checks failed",
  "pr.merged": "PR merged",
  "commitment.due": "Open item due",
};

export type ResolvedEventRef =
  | { kind: "thread"; label: string; threadId: string }
  | { kind: "external"; label: string; href: string }
  | { kind: "item"; label: string; commitmentId: string }
  | { kind: "text"; label: string };

/** What an event run was about: its Work thread, pull request and open item, in that order. */
export function eventRunRefs(
  refs: AgentEventContext["refs"],
  commitmentTitle: (id: string) => string | undefined,
): ResolvedEventRef[] {
  const result: ResolvedEventRef[] = [];
  if (refs.threadId) result.push({ kind: "thread", label: "Work", threadId: refs.threadId });
  if (refs.prUrl) result.push(prRef(refs.prUrl));
  if (refs.commitmentId) {
    const title = commitmentTitle(refs.commitmentId);
    result.push(
      title
        ? { kind: "item", label: title, commitmentId: refs.commitmentId }
        : { kind: "text", label: "A removed open item" },
    );
  }
  return result;
}

/** Run status as recorded by the provider run, not as the model described it. */
export function runStatusLabel(status: string) {
  const text = status.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One audited action in plain words, with the Work thread it opened when there is one. */
export function describeRunAction(
  action: { kind: string; targetId: string | null },
  commitmentTitle: (id: string) => string | undefined,
): { text: string; threadId?: string } {
  const item = (verb: string) => {
    const title = action.targetId ? commitmentTitle(action.targetId) : undefined;
    return title ? `${verb} “${title}”` : `${verb} an open item`;
  };
  switch (action.kind) {
    case "commitment_proposed":
      return { text: item("Proposed") };
    case "commitment_status_changed":
      return { text: item("Updated") };
    case "approval_requested":
      return { text: "Asked for your approval" };
    case "work_started":
      return action.targetId
        ? { text: "Started Work", threadId: action.targetId }
        : { text: "Started Work" };
    case "schedule_trigger":
      return { text: "Added a trigger you approved" };
    case "change_permissions":
      return { text: "Changed permissions you approved" };
    default:
      return { text: runStatusLabel(action.kind) };
  }
}
