import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@cogenly/shared/orchestrationV2ThreadError";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  type ModelSelection,
  type OrchestrationV2NotificationSource,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProviderGoal,
  type ServerProviderModel,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ThreadProjection,
  orchestrationV2RunWorkStartedAt,
  type ThreadId,
} from "@cogenly/contracts";
import {
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
} from "@cogenly/shared/orchestrationV2PendingBackgroundWork";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@cogenly/shared/model";
import { formatDuration } from "@cogenly/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

import {
  threadRuntimeIsActive,
  type ThreadRunSummary,
  type ThreadRuntimeSummary,
} from "./models.ts";
import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";

const ACTIVITY_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const INTERRUPTIBLE_RUN_STATUSES = new Set(["preparing", "starting", "running"]);

function latestMatchingRun(
  projection: OrchestrationV2ThreadProjection,
  predicate: (run: OrchestrationV2ThreadProjection["runs"][number]) => boolean,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, candidate) =>
      predicate(candidate) && (latest === null || candidate.ordinal > latest.ordinal)
        ? candidate
        : latest,
    null,
  );
}

function summarizeThreadRun(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2ThreadProjection["runs"][number],
): ThreadRunSummary {
  return {
    runId: run.id,
    status: run.status,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    assistantMessageId:
      projection.messages.findLast(
        (message) => message.runId === run.id && message.role === "assistant",
      )?.id ?? null,
    ...(run.sourcePlanRef === undefined ? {} : { sourcePlanRef: run.sourcePlanRef }),
  };
}

function presentedUsageLimitRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  return usageLimitRunPresentedAsLatest(
    projection.runs,
    projection.turnItems,
    providerSession?.lastError ?? null,
  );
}

/** The run that stands for the thread's outcome when no run is executing. */
function presentedLatestRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["runs"][number] | null {
  return presentedUsageLimitRun(projection) ?? latestUnheldRun(projection.runs);
}

export function deriveLatestThreadRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run = presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * Returns the run that owns live provider work, falling back to the newest run
 * once the thread is idle. A newer queued run must not make an older executing
 * run look settled in clients that render per-run activity.
 */
export function deriveThreadActivityRun(
  projection: OrchestrationV2ThreadProjection,
): ThreadRunSummary | null {
  const run =
    latestMatchingRun(projection, (candidate) => ACTIVITY_RUN_STATUSES.has(candidate.status)) ??
    presentedLatestRun(projection);
  return run === null ? null : summarizeThreadRun(projection, run);
}

/**
 * The work a provider runs on a native subagent's thread is a runless root turn
 * whose status follows the subagent; only messages sent to the child give it runs. Returns
 * when that work started while it is still active, so clients can show the
 * same working state (and timer) as a run. Stop, queue, and steer stay run-only.
 */
export function deriveRunlessWorkStartedAt(
  projection: OrchestrationV2ThreadProjection,
): string | null {
  const status = nativeSubagentRootStatus(projection);
  return status !== null && isOrchestrationV2WorkActive(status.status) ? status.startedAt : null;
}

export interface ProviderSubagentStatus {
  readonly status: OrchestrationV2ExecutionNode["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

function nativeSubagentRootStatus(
  projection: OrchestrationV2ThreadProjection,
): ProviderSubagentStatus | null {
  if (!isProviderNativeSubagentThread(projection.thread)) return null;
  const node = projection.nodes.findLast(
    (candidate) => candidate.kind === "root_turn" && candidate.runId === null,
  );
  if (node === undefined) return null;
  return {
    status: node.status,
    startedAt: node.startedAt === null ? null : DateTime.formatIso(node.startedAt),
    completedAt: node.completedAt === null ? null : DateTime.formatIso(node.completedAt),
  };
}

const RUN_SUBAGENT_STATUS: Record<
  OrchestrationV2ThreadProjection["runs"][number]["status"],
  OrchestrationV2ExecutionNode["status"]
> = {
  preparing: "pending",
  queued: "pending",
  starting: "pending",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  interrupted: "interrupted",
  failed: "failed",
  cancelled: "cancelled",
  rolled_back: "cancelled",
};

/**
 * Status of a provider-native subagent thread (see
 * isProviderNativeSubagentThread): its runless root turn, until a message
 * sent to the child gives it runs of its own, then its latest run. A message
 * still queued behind the native work leaves the native status in place, and
 * native work the parent starts again shows while it runs or once it is the
 * latest work. Null until that root turn arrives, and for every other thread.
 */
export function deriveProviderSubagentStatus(
  projection: OrchestrationV2ThreadProjection,
): ProviderSubagentStatus | null {
  const native = nativeSubagentRootStatus(projection);
  if (native === null) return null;
  const run = presentedLatestRun(projection);
  if (run === null || run.startedAt === null) return native;
  const own: ProviderSubagentStatus = {
    status: RUN_SUBAGENT_STATUS[run.status],
    startedAt: DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
  };
  if (isOrchestrationV2WorkActive(own.status)) return own;
  if (isOrchestrationV2WorkActive(native.status)) return native;
  return native.startedAt !== null &&
    Date.parse(native.startedAt) > DateTime.toEpochMillis(run.startedAt)
    ? native
    : own;
}

/** The observed selection belongs to the active provider thread, never a previous handoff. */
export function deriveReportedModelSelection(
  projection: OrchestrationV2ThreadProjection,
): ModelSelection | null {
  const providerThread = projection.providerThreads.find(
    (candidate) =>
      candidate.id === projection.thread.activeProviderThreadId &&
      candidate.providerInstanceId === projection.thread.modelSelection.instanceId,
  );
  return providerThread?.nativeMetadata?.modelSelection ?? null;
}

// Option ids providers use for reasoning effort (Codex, Claude, Grok/ACP, OpenCode).
const REASONING_EFFORT_OPTION_IDS = ["reasoningEffort", "effort", "reasoning", "variant"] as const;

/**
 * The reasoning effort a thread's model runs at, resolved and named the way
 * the composer's effort picker does: the stored choice when valid, else the
 * descriptor's current value, else the model's default. Null when the
 * provider catalog has no effort option for this model (a subagent on a
 * model the catalog does not describe), rather than guessing.
 */
export function formatModelSelectionEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> = [],
  reportedSelection?: ModelSelection | null,
): string | null {
  const caps = models.find((model) => model.slug === selection.model)?.capabilities;
  if (!caps) return null;
  const descriptors = getProviderOptionDescriptors({ caps, selections: selection.options });
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const descriptor = descriptors.find((candidate) => candidate.id === id);
    if (descriptor?.type !== "select") continue;
    const label = getProviderOptionCurrentLabel(descriptor, selection, reportedSelection);
    if (label) return label;
  }
  return null;
}

const SUBAGENT_STATUS_LABELS: Record<OrchestrationV2ExecutionNode["status"], string> = {
  idle: "Idle",
  pending: "Working",
  running: "Working",
  waiting: "Waiting",
  completed: "Completed",
  interrupted: "Interrupted",
  failed: "Failed",
  cancelled: "Cancelled",
  rolled_back: "Cancelled",
};

/**
 * One line for the subagent banner: "Working 12s", "Completed in 34s",
 * or just the status when no duration is known.
 */
export function formatProviderSubagentStatus(
  status: ProviderSubagentStatus | null,
  nowMs: number,
): string {
  if (status === null) return "Starting";
  const label = SUBAGENT_STATUS_LABELS[status.status];
  const live = isOrchestrationV2WorkActive(status.status);
  if (!live && status.status !== "completed") return label;
  const start = status.startedAt === null ? Number.NaN : Date.parse(status.startedAt);
  const end = live
    ? nowMs
    : status.completedAt === null
      ? Number.NaN
      : Date.parse(status.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return label;
  // Whole seconds: a ticking label must not flicker through tenths.
  const elapsed = formatDuration(Math.max(1_000, Math.floor((end - start) / 1_000) * 1_000));
  return live ? `${label} ${elapsed}` : `${label} in ${elapsed}`;
}

export function deriveThreadRuntime(
  projection: OrchestrationV2ThreadProjection,
): ThreadRuntimeSummary | null {
  const latestRun = deriveLatestThreadRun(projection);
  const providerSession = projection.providerSessions.findLast(
    (session) => session.providerInstanceId === projection.thread.providerInstanceId,
  );
  const usageLimitedRun = presentedUsageLimitRun(projection);
  const latestRunProjection = presentedLatestRun(projection);
  const activityRun = deriveThreadActivityRun(projection);
  const liveActivityRun = latestMatchingRun(projection, (run) =>
    ACTIVITY_RUN_STATUSES.has(run.status),
  );
  // Same rule as the shell runtime: only background work that holds the
  // completion parks the thread at idle; a dev server left running does not.
  const backgroundWorkHoldsRun = backgroundWorkHoldsCompletion(
    derivePendingBackgroundWork({
      latestRun: latestRunProjection,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
      runs: projection.runs,
      pullRequests: projection.thread.pullRequests,
    }),
  );
  // A pull request watch can hold a thread that never ran.
  if (
    latestRun === null &&
    projection.thread.activeProviderThreadId === null &&
    !backgroundWorkHoldsRun
  ) {
    return null;
  }
  const activeRunId =
    latestMatchingRun(projection, (run) => INTERRUPTIBLE_RUN_STATUSES.has(run.status))?.id ?? null;
  return {
    status: usageLimitedRun
      ? "failed"
      : backgroundWorkHoldsRun && latestRunProjection?.status !== "failed"
        ? "idle"
        : (activityRun?.status ?? "idle"),
    activeRunId,
    activityStartedAt:
      liveActivityRun === null
        ? null
        : DateTime.formatIso(orchestrationV2RunWorkStartedAt(liveActivityRun)),
    providerInstanceId: projection.thread.providerInstanceId,
    providerName: providerSession?.driver ?? null,
    ...threadErrorSummary(
      latestRootProviderFailure(latestRunProjection, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    updatedAt: DateTime.formatIso(projection.updatedAt),
  };
}

/** When a provider names no wait, the backoff window assumed for display. */
export const PROVIDER_BACKOFF_FALLBACK_MS = 60_000;

export interface ProviderBackoff {
  /** "OpenAI" for Codex, "Anthropic" for Claude, else the driver name. */
  readonly serviceLabel: string;
  /** When the provider is expected to try again, epoch milliseconds. */
  readonly retryAtMs: number;
  readonly attempt: number;
  readonly maxAttempts: number | null;
}

const BACKOFF_SERVICE_LABELS: Record<string, string> = {
  codex: "OpenAI",
  claude: "Anthropic",
};

/**
 * The rate-limit backoff the thread's active run is in, from the running
 * retry item the adapters record while the provider waits out a 429. Null
 * once the retry time has passed: the provider is trying again.
 */
export function deriveProviderBackoff(
  projection: OrchestrationV2ThreadProjection,
  nowMs: number,
): ProviderBackoff | null {
  const run = latestMatchingRun(projection, (candidate) =>
    ACTIVITY_RUN_STATUSES.has(candidate.status),
  );
  if (run === null) return null;
  const item = projection.turnItems.findLast(
    (candidate) =>
      candidate.runId === run.id &&
      candidate.type === "error" &&
      candidate.status === "running" &&
      candidate.retry !== undefined &&
      candidate.failure.class === "usage_limit" &&
      (candidate.failure.limitKind === "rate_limit" ||
        candidate.failure.code === "rateLimitExceeded"),
  );
  if (item === undefined || item.type !== "error" || item.retry === undefined) return null;
  const startedMs = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
  const resetMs =
    item.failure.resetAt === null || item.failure.resetAt === undefined
      ? Number.NaN
      : Date.parse(item.failure.resetAt);
  const retryAtMs =
    item.retry.retryDelayMs !== null && item.retry.retryDelayMs > 0
      ? startedMs + item.retry.retryDelayMs
      : Number.isFinite(resetMs)
        ? resetMs
        : startedMs + PROVIDER_BACKOFF_FALLBACK_MS;
  if (nowMs >= retryAtMs) return null;
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  const session =
    providerThread?.providerSessionId === null || providerThread?.providerSessionId === undefined
      ? undefined
      : projection.providerSessions.find(
          (candidate) => candidate.id === providerThread.providerSessionId,
        );
  const driver = session?.driver ?? run.providerInstanceId;
  return {
    serviceLabel: BACKOFF_SERVICE_LABELS[driver] ?? driver,
    retryAtMs,
    attempt: item.retry.attempt,
    maxAttempts: item.retry.maxAttempts,
  };
}

/** "Rate-limited by OpenAI · retrying at 13:41:33" for the shared status line. */
export function formatProviderBackoff(backoff: ProviderBackoff, nowMs: number): string {
  const at = DateTime.toDate(DateTime.makeUnsafe(backoff.retryAtMs)).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const remaining = formatDuration(Math.max(1_000, backoff.retryAtMs - nowMs));
  return `Rate-limited by ${backoff.serviceLabel} · retrying at ${at} (in ${remaining})`;
}

export function threadRuntimeHasInterruptibleRun(
  runtime: ThreadRuntimeSummary | null | undefined,
): boolean {
  return (
    threadRuntimeIsActive(runtime) &&
    runtime?.activeRunId !== null &&
    runtime?.activeRunId !== undefined
  );
}

type BackgroundWorkKind = OrchestrationV2PendingBackgroundTask["kind"];

// `order` groups work the way a reader thinks about it: agents first, loose tasks last.
const BACKGROUND_WORK_KINDS: Record<
  BackgroundWorkKind,
  { readonly order: number; readonly singular: string; readonly plural: string }
> = {
  subagent: { order: 0, singular: "subagent", plural: "subagents" },
  command: { order: 1, singular: "command", plural: "commands" },
  monitor: { order: 2, singular: "monitor", plural: "monitors" },
  background_task: { order: 3, singular: "background task", plural: "background tasks" },
};

export interface PendingBackgroundWorkItem {
  readonly taskId: string;
  readonly kind: BackgroundWorkKind;
  /** The work's name, or its noun when the provider gave none. */
  readonly label: string;
  /** A subagent's own thread, when it has one. */
  readonly childThreadId: ThreadId | undefined;
}

export interface PendingBackgroundWorkPresentation {
  /**
   * "Waiting on subagent Review src/math.ts", "Waiting on 2 subagents and 1 command",
   * or "Running: Start the dev server" when only commands remain.
   */
  readonly title: string;
  readonly items: ReadonlyArray<PendingBackgroundWorkItem>;
  /**
   * True when the work will wake the agent (subagents, monitors). False when
   * only commands remain, such as a dev server: the agent is done.
   */
  readonly waiting: boolean;
}

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Names what a settled thread still runs, grouped by kind, for the composer strip. */
export function presentPendingBackgroundWork(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): PendingBackgroundWorkPresentation | null {
  if (tasks.length === 0) return null;
  const waiting = backgroundWorkHoldsCompletion(tasks);
  const items = tasks
    .map((task): PendingBackgroundWorkItem => {
      const description = task.description?.trim();
      const label =
        task.kind === "subagent" && description !== undefined
          ? formatSubagentDisplayTitle(description).trim()
          : description;
      return {
        taskId: task.taskId,
        kind: task.kind,
        label:
          label === undefined || label.length === 0
            ? BACKGROUND_WORK_KINDS[task.kind].singular
            : label,
        childThreadId: task.kind === "subagent" ? task.childThreadId : undefined,
      };
    })
    // `map` returned a new array; Hermes has no `toSorted`.
    .sort(
      (left, right) =>
        BACKGROUND_WORK_KINDS[left.kind].order - BACKGROUND_WORK_KINDS[right.kind].order,
    );
  const [only] = items;
  if (items.length === 1 && only !== undefined) {
    const noun = BACKGROUND_WORK_KINDS[only.kind].singular;
    const named = only.label !== noun;
    const title = waiting
      ? named
        ? `${only.kind === "monitor" ? "" : `Waiting on ${noun} `}${only.label}`
        : `Waiting on a ${noun}`
      : named
        ? `Running: ${only.label}`
        : `Running a ${noun}`;
    return { title, items, waiting };
  }
  const counts = new Map<BackgroundWorkKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const groups = Array.from(counts, ([kind, count]) => {
    const { singular, plural } = BACKGROUND_WORK_KINDS[kind];
    return `${count} ${count === 1 ? singular : plural}`;
  });
  return { title: `${waiting ? "Waiting on" : "Running"} ${joinWithAnd(groups)}`, items, waiting };
}

export interface ProviderGoalPresentation {
  /** "Pursuing goal", "Goal paused", "Goal complete"... */
  readonly title: string;
  readonly objective: string;
  /** "12k / 50k tokens · 4m" for Codex, "2 checks" for Claude; null when nothing is reported. */
  readonly usage: string | null;
  /** Only Codex stops a goal short of done, and only a stopped goal can resume. */
  readonly canResume: boolean;
}

const PROVIDER_GOAL_TITLES: Record<OrchestrationV2ProviderGoal["status"], string> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usage_limited: "Goal hit a usage limit",
  budget_limited: "Goal reached its token budget",
  complete: "Goal complete",
};

function formatGoalTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/**
 * Status line for a native `/goal`, shared by the web composer row and mobile.
 * An active goal on an idle thread (Claude after Stop) is set, not pursued.
 */
export function presentProviderGoal(
  goal: OrchestrationV2ProviderGoal,
  working: boolean,
): ProviderGoalPresentation {
  const usage: Array<string> = [];
  if (goal.tokensUsed !== undefined && goal.tokensUsed > 0) {
    usage.push(
      goal.tokenBudget == null
        ? `${formatGoalTokens(goal.tokensUsed)} tokens`
        : `${formatGoalTokens(goal.tokensUsed)} / ${formatGoalTokens(goal.tokenBudget)} tokens`,
    );
  }
  if (goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds >= 60) {
    usage.push(formatDuration(goal.timeUsedSeconds * 1_000));
  }
  if (goal.checks !== undefined && goal.checks > 0) {
    usage.push(`${goal.checks} ${goal.checks === 1 ? "check" : "checks"}`);
  }
  return {
    title: goal.status === "active" && !working ? "Goal set" : PROVIDER_GOAL_TITLES[goal.status],
    objective: goal.objective,
    usage: usage.length === 0 ? null : usage.join(" · "),
    canResume: goal.status !== "active" && goal.status !== "complete",
  };
}

/** The thread a notification row opens: that of the one subagent, delegated task or Work task it reports. */
export function notificationChildThreadId(
  source: OrchestrationV2NotificationSource,
): ThreadId | undefined {
  switch (source.kind) {
    case "subagent":
    case "delegated_task":
    case "work_task":
      return source.childThreadId;
    case "command":
    case "monitor":
    case "background_task":
    case "system":
      return undefined;
    default:
      source satisfies never;
      return undefined;
  }
}
