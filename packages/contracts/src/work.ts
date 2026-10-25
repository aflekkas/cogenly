import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const WorkTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const WorkScopeSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(16000));

/** A task card a chat agent proposed or started; stable across retries of the same request. */
export const WorkTaskId = TrimmedNonEmptyString.pipe(Schema.brand("WorkTaskId"));
export type WorkTaskId = typeof WorkTaskId.Type;
/** What the task agent is asked to do. Kept short: the card shows it and every shell carries it. */
export const WorkTaskBrief = TrimmedNonEmptyString.check(Schema.isMaxLength(4000));
export const WorkTaskWorkspace = Schema.Literals(["worktree", "local"]);
/** `propose` waits for the user's approval on the card; `start` launches at once. */
export const WorkTaskMode = Schema.Literals(["propose", "start"]);
export type WorkTaskMode = typeof WorkTaskMode.Type;
/**
 * The card's own lifecycle. Once started, whether the task is running, done or
 * failed is read live from its Work thread; `outcome` is what was reported back.
 */
export const WorkTaskStatus = Schema.Literals(["proposed", "dismissed", "started"]);
export type WorkTaskStatus = typeof WorkTaskStatus.Type;
export const WorkTaskOutcome = Schema.Struct({
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  /** A short excerpt of the task agent's final reply. */
  summary: Schema.String.check(Schema.isMaxLength(600)),
  /** The Work thread's run whose end was reported. */
  runId: RunId,
  reportedAt: IsoDateTime,
});
export type WorkTaskOutcome = typeof WorkTaskOutcome.Type;
/** A coding task a chat handed off, shown as a card in the chat that asked for it. */
export const WorkTask = Schema.Struct({
  machine: Schema.optional(EnvironmentId),
  id: WorkTaskId,
  status: WorkTaskStatus,
  requestedMode: WorkTaskMode,
  title: WorkTitle,
  brief: WorkTaskBrief,
  /** The project the task runs in; the scratch project means "No project" on this machine. */
  targetProjectId: ProjectId,
  workspace: Schema.optional(WorkTaskWorkspace),
  /** Absent: the chat's own model. */
  modelSelection: Schema.optional(ModelSelection),
  /** The chat run that created the card, so the card sits after that turn. */
  runId: Schema.optional(RunId),
  /** The Work thread, once started. */
  threadId: Schema.optional(ThreadId),
  outcome: Schema.optional(WorkTaskOutcome),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkTask = typeof WorkTask.Type;

export const WorkStartInput = Schema.Struct({
  machine: Schema.optional(EnvironmentId),
  /** Stable across retries: one handoff creates one Work thread. */
  commandId: CommandId,
  sourceThreadId: ThreadId,
  targetProjectId: ProjectId,
  /** Absent: the Work thread titles itself from its first message, like a new thread. */
  title: Schema.optional(WorkTitle),
  /** Absent: the handoff carries the chat's own recent words through the cut-off. */
  scopeSummary: Schema.optional(WorkScopeSummary),
  /** Absent: a new worktree when the repository is under git, else its checkout. */
  workspace: Schema.optional(Schema.Literals(["worktree", "local"])),
  modelSelection: Schema.optional(ModelSelection),
  /**
   * The last source message the Work carries over. Absent means the whole chat;
   * the Work thread is told to ignore anything after it in the source.
   */
  throughMessageId: Schema.optional(MessageId),
  /**
   * Approves this chat's proposed task card. The card's title, brief, project
   * and model apply unless the fields above override them as the user's edits.
   */
  taskId: Schema.optional(WorkTaskId),
});
export type WorkStartInput = typeof WorkStartInput.Type;
export const WorkStartResult = Schema.Struct({ threadId: ThreadId });
export type WorkStartResult = typeof WorkStartResult.Type;
/** What a chat agent's task handoff did: a card waiting on the user, or a started Work thread. */
export const WorkTaskHandoffResult = Schema.Struct({
  taskId: WorkTaskId,
  status: Schema.Literals(["proposed", "started"]),
  threadId: Schema.optional(ThreadId),
  /** What to tell the user next. */
  note: Schema.String,
});
export type WorkTaskHandoffResult = typeof WorkTaskHandoffResult.Type;
export const WorkHandoffDraft = Schema.Struct({
  title: WorkTitle,
  scopeSummary: WorkScopeSummary,
  suggestedProjectId: Schema.NullOr(ProjectId),
});
export type WorkHandoffDraft = typeof WorkHandoffDraft.Type;
export class WorkHandoffError extends Schema.TaggedError<WorkHandoffError>()("WorkHandoffError", {
  sourceThreadId: ThreadId,
  machineOffline: Schema.optional(Schema.Boolean),
  stage: Schema.Literals([
    "read-source",
    "resolve-project",
    "launch",
    "record-link",
    "task-unavailable",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Work handoff failed during ${this.stage}.`;
  }
}
