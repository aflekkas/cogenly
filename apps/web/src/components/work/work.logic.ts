import type { EnvironmentId, ProjectId, ThreadEnvMode, WorkHandoffError } from "@t3tools/contracts";
import type { ProjectSettingSource } from "@t3tools/shared/projectSettings";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { WorkStatus } from "@t3tools/client-runtime/state/work-status";

/** The picker's "No repository" choice: Work runs in the environment's scratch project. */
export const NO_REPOSITORY = "no-repository";
export type WorkRepositoryChoice = ProjectId | typeof NO_REPOSITORY;
/** The picker's "Add repository" row: an action, not a place to start Work. */
export const ADD_REPOSITORY = "add-repository";

export interface WorkPickerChoice {
  readonly value: WorkRepositoryChoice | typeof ADD_REPOSITORY;
  readonly label: string;
}

/**
 * The Start Work picker's rows: the chat's own repository first, so Enter
 * starts there, then the rest in the given order, "No repository" when the
 * machine offers it, and "Add repository".
 */
export function listWorkPickerChoices(input: {
  readonly repositories: ReadonlyArray<Pick<EnvironmentProject, "id" | "title">>;
  readonly sourceProjectId: ProjectId | null;
  readonly canRunWithoutRepository: boolean;
}): WorkPickerChoice[] {
  const own = input.repositories.filter((repository) => repository.id === input.sourceProjectId);
  const others = input.repositories.filter((repository) => repository.id !== input.sourceProjectId);
  return [
    ...[...own, ...others].map((repository) => ({ value: repository.id, label: repository.title })),
    ...(input.canRunWithoutRepository
      ? [{ value: NO_REPOSITORY, label: "No repository" } as const]
      : []),
    { value: ADD_REPOSITORY, label: "Add repository…" },
  ];
}

/**
 * Repositories a chat can hand Work to: the source thread's environment runs
 * the session, so only its projects qualify, and never the scratch ("No
 * project") workspace, which is where chats live.
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
        project.isScratch !== true &&
        !isScratchProject(project, scratchWorkspaceRoot),
    )
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

/**
 * Work starts in its own worktree when nothing says otherwise. A project
 * override, a t3.json, or a machine-wide default still decides; only the
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
