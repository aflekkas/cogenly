import type {
  EnvironmentId,
  MessageId,
  OrchestrationV2Notification,
  ProjectId,
  RunId,
  ThreadEnvMode,
  WorkHandoffError,
  WorkHandoffLink,
} from "@cogenly/contracts";
import type { ProjectSettingSource } from "@cogenly/shared/projectSettings";
import type { EnvironmentProject } from "@cogenly/client-runtime/state/models";
import { isPickableRepository } from "~/projectLabels/projectMeta.logic";
import type { WorkStatus } from "@cogenly/client-runtime/state/work-status";

/** The picker's "No repository" choice: Work runs in the environment's scratch project. */
export const NO_REPOSITORY = "no-repository";
export type WorkRepositoryChoice = ProjectId | typeof NO_REPOSITORY;
/** The picker's "Add repository" row: an action, not a place to start Work. */
export const ADD_REPOSITORY = "add-repository";

export interface WorkPickerChoice {
  readonly value: WorkRepositoryChoice | typeof ADD_REPOSITORY;
  readonly label: string;
  /** The repository a repository row starts Work in, for its icon. */
  readonly repository?: EnvironmentProject;
}

/**
 * The Start Work picker's rows: the chat's own repository first, so Enter
 * starts there, then the rest in the given order, "No repository" when the
 * machine offers it, and "Add repository".
 */
export function listWorkPickerChoices(input: {
  readonly repositories: ReadonlyArray<EnvironmentProject>;
  readonly sourceProjectId: ProjectId | null;
  readonly canRunWithoutRepository: boolean;
  /** What a repository row reads, as the repository pickers name it (`useRepositoryNames`). */
  readonly nameOf?: (repository: EnvironmentProject) => string;
}): WorkPickerChoice[] {
  const nameOf = input.nameOf ?? ((repository: EnvironmentProject) => repository.title);
  const own = input.repositories.filter((repository) => repository.id === input.sourceProjectId);
  const others = input.repositories.filter((repository) => repository.id !== input.sourceProjectId);
  return [
    ...[...own, ...others].map((repository) => ({
      value: repository.id,
      label: nameOf(repository),
      repository,
    })),
    ...(input.canRunWithoutRepository
      ? [{ value: NO_REPOSITORY, label: "No repository" } as const]
      : []),
    { value: ADD_REPOSITORY, label: "Add repository…" },
  ];
}

/** One project in the Start Work picker's first level: its repositories on this machine. */
export interface WorkProjectGroup<Project> {
  /** The project's key, or `null` for the repositories in no project. */
  readonly key: string | null;
  readonly project: Project | null;
  readonly choices: ReadonlyArray<WorkPickerChoice>;
}

/**
 * The repository rows of `choices` under their projects: the project holding
 * the chat's own repository first (so Enter lands there), then the rest in
 * the given project order, and repositories in no project last.
 */
export function groupWorkChoicesByProject<Project extends { readonly key: string }>(input: {
  readonly choices: ReadonlyArray<WorkPickerChoice>;
  readonly projects: ReadonlyArray<Project>;
  readonly projectOf: (repository: ProjectId) => Project | null;
  readonly sourceProjectId: ProjectId | null;
}): WorkProjectGroup<Project>[] {
  const byKey = new Map<string | null, WorkPickerChoice[]>();
  for (const choice of input.choices) {
    if (choice.value === NO_REPOSITORY || choice.value === ADD_REPOSITORY) continue;
    const key = input.projectOf(choice.value)?.key ?? null;
    byKey.set(key, [...(byKey.get(key) ?? []), choice]);
  }
  // Every project is listed, even one with nothing on this machine yet: its
  // GitHub repositories are a pick away.
  const groups: WorkProjectGroup<Project>[] = input.projects.map((project) => ({
    key: project.key,
    project,
    choices: byKey.get(project.key) ?? [],
  }));
  const unfiled = byKey.get(null);
  if (unfiled) groups.push({ key: null, project: null, choices: unfiled });
  const sourceIndex = groups.findIndex((group) =>
    group.choices.some((choice) => choice.value === input.sourceProjectId),
  );
  if (sourceIndex > 0) groups.unshift(...groups.splice(sourceIndex, 1));
  return groups;
}

/**
 * Repositories a chat can hand Work to: the source thread's environment runs
 * the session, so only its projects qualify, and only real repositories:
 * never the scratch ("No project") workspace, where chats live, or its folders.
 */
export function listWorkRepositories(
  projects: ReadonlyArray<EnvironmentProject>,
  environmentId: EnvironmentId,
  scratchWorkspaceRoot: string | null | undefined,
): EnvironmentProject[] {
  return projects
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        isPickableRepository(project, scratchWorkspaceRoot),
    )
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

/**
 * Work starts in its own worktree when nothing says otherwise. A project
 * override, a cogenly.json, or a machine-wide default still decides; only the
 * built-in "local" fallback gives way, and only for repositories (never the
 * scratch workspace).
 */
export function workPrefersNewWorktree(input: {
  readonly inWorkMode: boolean;
  readonly isScratch: boolean;
  readonly environmentDefault: ThreadEnvMode | null;
  readonly resolvedSource: ProjectSettingSource;
}): boolean {
  return (
    input.inWorkMode &&
    !input.isScratch &&
    input.environmentDefault === null &&
    input.resolvedSource === "environment"
  );
}

/**
 * Opens a Work thread the server just started. The thread route reads a thread
 * this client has not received yet as missing and sends the user home, where a
 * fresh draft opens in its place, so opening waits for the thread to arrive.
 * Resolves false, without opening anything, when it never does.
 */
export async function openWorkWhenArrived(input: {
  readonly waitForThread: () => Promise<boolean>;
  readonly open: () => unknown;
}): Promise<boolean> {
  if (!(await input.waitForThread())) return false;
  await input.open();
  return true;
}

/**
 * What a failed start tells the user, and whether retrying must reuse the
 * command id. A failure to record the chat's link means the session exists, so
 * the same id repairs the link instead of starting another session; the other
 * stages rejected the start, so the next attempt is a new command.
 */
export function describeWorkStartFailure(stage: WorkHandoffError["stage"] | null): {
  readonly message: string;
  readonly retryWithSameCommand: boolean;
} {
  switch (stage) {
    case "read-source":
      return {
        message: "This chat could not be read. Reload it and try again.",
        retryWithSameCommand: false,
      };
    case "resolve-project":
      return {
        message: "That repository is not available on this machine. Choose another.",
        retryWithSameCommand: false,
      };
    case "launch":
      return {
        message: "The session could not start in that repository.",
        retryWithSameCommand: false,
      };
    case "record-link":
      return {
        message: "Work started, but this chat's link to it was not saved. Try again to repair it.",
        retryWithSameCommand: true,
      };
    case "task-unavailable":
      return {
        message: "This task was dismissed or already started.",
        retryWithSameCommand: false,
      };
    case null:
      return { message: "Work could not start. Try again.", retryWithSameCommand: true };
  }
}

export type WorkStatusTone = "info" | "warning" | "success" | "error" | "secondary";

export interface WorkStatusPresentation {
  readonly label: string;
  readonly tone: WorkStatusTone;
}

const WORK_STATUS_PRESENTATION: Record<WorkStatus, WorkStatusPresentation | null> = {
  // No run, process, or review evidence yet: a label would only restate "new".
  draft: null,
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  awaiting_input: { label: "Needs input", tone: "warning" },
  review_ready: { label: "Ready for review", tone: "success" },
  completed: { label: "Completed", tone: "secondary" },
  failed: { label: "Failed", tone: "error" },
  canceled: { label: "Canceled", tone: "secondary" },
  paused: { label: "Paused", tone: "warning" },
};

/** The Work thread header's status pill; null when there is nothing to say. */
export function workStatusPresentation(status: WorkStatus): WorkStatusPresentation | null {
  return WORK_STATUS_PRESENTATION[status];
}

/**
 * The extra state a Work sidebar row can prove from its shell. Running, input,
 * approval, and failure already have the row's own status pill, and review
 * readiness needs checkpoint data that only the open thread loads, so this
 * covers how a run ended when nothing newer is happening: stopped by the user
 * (paused) or cancelled. Settled and archived work counts as done, as in
 * `deriveWorkStatus`.
 */
export function deriveWorkRowStatus(thread: {
  readonly latestRun: { readonly status: string } | null;
  readonly runtime: { readonly status: string } | null;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
}): Extract<WorkStatus, "paused" | "canceled"> | null {
  if (
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.settledAt !== null
  ) {
    return null;
  }
  const runtimeStatus = thread.runtime?.status;
  if (
    runtimeStatus === "preparing" ||
    runtimeStatus === "queued" ||
    runtimeStatus === "starting" ||
    runtimeStatus === "running" ||
    runtimeStatus === "waiting" ||
    runtimeStatus === "idle"
  ) {
    return null;
  }
  switch (thread.latestRun?.status) {
    case "interrupted":
      return "paused";
    case "cancelled":
    case "rolled_back":
      return "canceled";
    default:
      return null;
  }
}

export interface WorkHandoffAnchors {
  /** Links to show right after the given message, oldest first. */
  readonly byMessageId: ReadonlyMap<MessageId, ReadonlyArray<WorkHandoffLink>>;
  /** Links with no message to sit beside; shown after the last message. */
  readonly unanchored: ReadonlyArray<WorkHandoffLink>;
}

/**
 * Where each Work handoff marker sits in its chat: after the message it was
 * started from. A link without that message (the whole chat was handed over,
 * an older link, or the message is gone) sits after the turn that had ended
 * when the Work started, at that turn's last reply rather than mid-turn
 * commentary.
 */
export function anchorWorkHandoffs(
  links: ReadonlyArray<WorkHandoffLink>,
  messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: "user" | "assistant" | "system";
    readonly runId: RunId | null;
    readonly createdAt: string;
  }>,
): WorkHandoffAnchors {
  const byMessageId = new Map<MessageId, WorkHandoffLink[]>();
  const unanchored: WorkHandoffLink[] = [];
  const messageIds = new Set(messages.map((message) => message.id));
  const ordered = links.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const link of ordered) {
    const anchor =
      link.throughMessageId !== undefined && messageIds.has(link.throughMessageId)
        ? link.throughMessageId
        : anchorAtTurnEnd(link.createdAt, messages);
    if (anchor === null) {
      unanchored.push(link);
      continue;
    }
    byMessageId.set(anchor, [...(byMessageId.get(anchor) ?? []), link]);
  }
  return { byMessageId, unanchored };
}

/**
 * The message that ended the last turn before `createdAt`: that turn's last
 * reply, or the user message when no reply came. Null before any message.
 */
export function anchorAtTurnEnd(
  createdAt: string,
  messages: Parameters<typeof anchorWorkHandoffs>[1],
): MessageId | null {
  const before = messages.findLast(
    (message) => message.role !== "system" && message.createdAt <= createdAt,
  );
  if (before === undefined) return null;
  if (before.role !== "assistant" || before.runId === null) return before.id;
  return (
    messages.findLast((message) => message.role === "assistant" && message.runId === before.runId)
      ?.id ?? before.id
  );
}

export type WorkHandoffStatus = "running" | "waiting" | "done" | "failed" | "stopped";

/**
 * A Work session's state as its chat's handoff card shows it, from the
 * thread shell alone so a card never loads the Work thread's history.
 * `waiting` means it waits on the user (an approval or an answer). Null when
 * it has not started a run yet.
 */
export function deriveWorkHandoffStatus(thread: {
  readonly latestRun: { readonly status: string } | null;
  readonly runtime: { readonly status: string } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
}): WorkHandoffStatus | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  const runtimeStatus = thread.runtime?.status;
  if (
    runtimeStatus === "preparing" ||
    runtimeStatus === "queued" ||
    runtimeStatus === "starting" ||
    runtimeStatus === "running" ||
    runtimeStatus === "waiting"
  ) {
    return "running";
  }
  if (
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.settledAt !== null
  ) {
    return "done";
  }
  switch (thread.latestRun?.status) {
    case undefined:
      return null;
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "stopped";
    default:
      return "running";
  }
}

/**
 * The status a Work session reported back to its chat with, as that chat's
 * notification card shows it: the state then, not now. A delegated session
 * reports `updated` when it has a question for the user.
 */
export function workNotificationStatus(
  outcome: OrchestrationV2Notification["outcome"],
): WorkHandoffStatus {
  switch (outcome) {
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "updated":
      return "waiting";
    case "completed":
    case "unknown":
      return "done";
  }
}
