import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ThreadEnvMode,
  WorkHandoffDraft,
  WorkHandoffError,
} from "@t3tools/contracts";
import type { ProjectSettingSource } from "@t3tools/shared/projectSettings";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { WorkStatus } from "@t3tools/client-runtime/state/work-status";

// Mirrors the limits in packages/contracts/src/work.ts, so the dialog explains
// a rejection before the server makes one.
export const WORK_TITLE_MAX_LENGTH = 200;
export const WORK_SCOPE_MAX_LENGTH = 16000;

export type WorkWorkspace = "worktree" | "local";

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

/** Fields the user changed in the dialog; absent means "still the suggestion". */
export interface StartWorkEdits {
  readonly title?: string;
  readonly scopeSummary?: string;
  readonly projectId?: ProjectId;
}

export interface StartWorkFields {
  readonly title: string;
  readonly scopeSummary: string;
  readonly projectId: ProjectId | null;
}

/**
 * What the dialog shows. The proposal arrives after the dialog opens, so it
 * fills only the fields the user has not touched yet. The repository falls
 * back from the user's pick to the suggestion, the chat's own repository, and
 * finally the only repository there is; anything outside the list is ignored.
 */
export function resolveStartWorkFields(input: {
  readonly edits: StartWorkEdits;
  readonly proposal: WorkHandoffDraft | null;
  readonly repositories: ReadonlyArray<Pick<EnvironmentProject, "id">>;
  readonly sourceThread: { readonly title: string; readonly projectId: ProjectId } | null;
}): StartWorkFields {
  const { edits, proposal, repositories, sourceThread } = input;
  const listed = (id: ProjectId | null | undefined): id is ProjectId =>
    id != null && repositories.some((repository) => repository.id === id);
  const projectId = [edits.projectId, proposal?.suggestedProjectId, sourceThread?.projectId].find(
    listed,
  );
  return {
    title: edits.title ?? proposal?.title ?? sourceThread?.title ?? "",
    scopeSummary: edits.scopeSummary ?? proposal?.scopeSummary ?? "",
    projectId: projectId ?? (repositories.length === 1 ? repositories[0]!.id : null),
  };
}

export type StartWorkSubmission =
  | {
      readonly ok: true;
      readonly input: {
        readonly targetProjectId: ProjectId;
        readonly title: string;
        readonly scopeSummary: string;
        readonly workspace: WorkWorkspace;
        readonly modelSelection?: ModelSelection;
      };
    }
  | { readonly ok: false; readonly reason: string };

/** Validates the dialog against the wire limits. A null model keeps the chat's. */
export function resolveStartWorkSubmission(input: {
  readonly fields: StartWorkFields;
  readonly workspace: WorkWorkspace;
  readonly modelSelection: ModelSelection | null;
}): StartWorkSubmission {
  const title = input.fields.title.trim();
  const scopeSummary = input.fields.scopeSummary.trim();
  if (input.fields.projectId === null) return { ok: false, reason: "Choose a repository." };
  if (title.length === 0) return { ok: false, reason: "Add a title." };
  if (title.length > WORK_TITLE_MAX_LENGTH) {
    return { ok: false, reason: `Keep the title under ${WORK_TITLE_MAX_LENGTH} characters.` };
  }
  if (scopeSummary.length === 0) return { ok: false, reason: "Describe the scope." };
  if (scopeSummary.length > WORK_SCOPE_MAX_LENGTH) {
    return { ok: false, reason: "The scope is too long. Trim it and reference the chat instead." };
  }
  return {
    ok: true,
    input: {
      targetProjectId: input.fields.projectId,
      title,
      scopeSummary,
      workspace: input.workspace,
      ...(input.modelSelection === null ? {} : { modelSelection: input.modelSelection }),
    },
  };
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
