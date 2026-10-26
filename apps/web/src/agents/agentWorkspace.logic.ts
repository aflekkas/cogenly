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
  VaultField,
} from "@cogenly/contracts";

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
  /** Supporting lines: the prompt, or each permission change. */
  details: ReadonlyArray<string>;
}

const excerpt = (text: string, max = 240) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** The exact executable and credential mappings the owner is authorizing. */
function describeIntegrationApproval(
  action: Extract<
    AgentApproval["action"],
    { actionKind: "integration_add" | "integration_update" }
  >,
): ApprovalDescription {
  const input = action.payload;
  if ("preset" in input)
    return {
      title: `Connect Google · ${input.accountLabel}`,
      details: [
        "Gmail, Calendar, Drive, Docs and Sheets, run by Cogenly",
        ...(input.callbackOrigin === undefined
          ? []
          : [`Sign-in returns to ${input.callbackOrigin}`]),
      ],
    };
  return {
    title:
      "id" in input
        ? `Change integration ${input.id}`
        : `Connect ${input.displayName} (${input.name})`,
    details: [
      input.url,
      `${input.transport} · Headers: ${Object.keys(input.headers).join(", ") || "none"}`,
      ...Object.values(input.headers).flatMap((value) =>
        [...value.matchAll(/\{\{credential:([^}]*)\}\}/g)].map((match) => `Vault: ${match[1]}`),
      ),
      ...(input.command
        ? [
            `Command: ${[input.command.command, ...input.command.args].map((part) => JSON.stringify(part)).join(" ")}`,
            `Environment: ${JSON.stringify(input.command.env)}`,
            "Approving allows this command to run on this machine.",
          ]
        : []),
    ],
  };
}

/** Plain language for what approving would do, so a decision never needs the raw payload. */
export function describeApproval(
  approval: Pick<AgentApproval, "action">,
  context: {
    agent: Pick<Agent, "name" | "permissions">;
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
        details: policyDiff(context.agent, action.payload),
      };
    case "vault_use":
      return {
        title: `Use “${action.payload.vaultItemName}” (${action.payload.field})`,
        details: [
          action.payload.domain === null
            ? "Approving lets this agent use the item from now on."
            : `On ${action.payload.domain}. Approving lets this agent use the item from now on.`,
        ],
      };
    case "integration_add":
    case "integration_update":
      return describeIntegrationApproval(action);
  }
}

const VAULT_FIELD_LABEL: Record<VaultField, string> = {
  username: "username",
  password: "password",
  totp: "one-time code",
  value: "secret",
  cardNumber: "card number",
  cardExpiry: "card expiry",
  cardCvc: "card security code",
  cardholderName: "cardholder name",
};

/**
 * The question an ordinary thread's approval card asks. Allowing one grants
 * that thread alone (`AgentWorkspaceService.approve`), so the copy says so.
 * Null for kinds a thread cannot raise.
 */
export function describeThreadApproval(
  approval: Pick<AgentApproval, "action">,
): ApprovalDescription | null {
  const action = approval.action;
  if (action.actionKind === "integration_add" || action.actionKind === "integration_update")
    return describeIntegrationApproval(action);
  if (action.actionKind !== "vault_use") return null;
  const { vaultItemName, field, domain, processExposure } = action.payload;
  if (processExposure !== undefined) {
    // Accounts write the exposure warning into the item name too; show it once.
    const name = vaultItemName.replace(processExposure.message, "").trim().replace(/\.$/, "");
    return {
      title: `Let this thread use “${name}”?`,
      details: [processExposure.message],
    };
  }
  const what = `your ${VAULT_FIELD_LABEL[field]}`;
  return {
    title:
      domain === null
        ? `Use ${what} from “${vaultItemName}”?`
        : `Fill ${what} for ${domain} from “${vaultItemName}”?`,
    details: ["Allowing lets this thread use the item from now on."],
  };
}

/** Each change as "+ Grant" or "− Grant". */
export function policyDiff(
  current: Pick<Agent, "permissions">,
  next: { permissions: AgentPermissions },
) {
  const lines: string[] = [];
  for (const option of PERMISSION_OPTIONS) {
    const before = current.permissions[option.key];
    const after = next.permissions[option.key];
    if (before !== after) lines.push(`${after ? "+" : "−"} ${option.label}`);
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
 * What an agent's event filter may name: every project and repository, as long as
 * it may read at all, which the server also enforces (`event_filter_out_of_scope`).
 */
export function eventFilterChoices<L extends { id: ProjectLabelId }>(
  agent: Pick<Agent, "permissions">,
  labels: ReadonlyArray<L>,
  repositories: ReadonlyArray<{ id: ProjectId; title: string }>,
) {
  return agent.permissions.read
    ? { labels: [...labels], repositories: repositories.map(({ id, title }) => ({ id, title })) }
    : { labels: [], repositories: [] };
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
  "This trigger is limited to a project or repository that no longer exists, or the agent's Read permission is off. Remove it from the filter, or turn Read back on.";
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
    description: "Start coding sessions and run tools in any repository.",
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

/** Whether the agent may start Work on its own: it needs both Read and Start Work. */
export function agentCanExecute(agent: Pick<Agent, "permissions">) {
  return agent.permissions.read && agent.permissions.execute;
}

/** What happens when the agent tries to start Work, mirroring the server's gate. */
export function agentWorkStartPolicy(agent: Pick<Agent, "permissions">): {
  outcome: "asks" | "starts";
  text: string;
} {
  if (!agentCanExecute(agent))
    return {
      outcome: "asks",
      text: !agent.permissions.execute
        ? "Asks you before starting Work (no Start Work permission)."
        : "Asks you before starting Work (no Read permission).",
    };
  return { outcome: "starts", text: "Starts Work on its own in any repository." };
}

/**
 * Where Work can start, home repository first: every repository, each marked with
 * whether the agent may start Work there on its own or would ask you first.
 */
export function agentRepositoryAccess(
  agent: Pick<Agent, "projectId" | "permissions">,
  repositories: ReadonlyArray<{ id: ProjectId; title: string }>,
) {
  const executable = agentCanExecute(agent);
  return repositories
    .map((repository) => ({ ...repository, home: repository.id === agent.projectId, executable }))
    .toSorted(
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
    case "mcp:memory_remember":
      return { text: "Remembered a note" };
    case "mcp:memory_forget":
      return { text: "Forgot a note" };
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
