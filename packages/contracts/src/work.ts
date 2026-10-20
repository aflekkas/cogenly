import * as Schema from "effect/Schema";
import { CommandId, MessageId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const WorkTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const WorkScopeSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(16000));

export const WorkStartInput = Schema.Struct({
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
});
export type WorkStartInput = typeof WorkStartInput.Type;
export const WorkStartResult = Schema.Struct({ threadId: ThreadId });
export type WorkStartResult = typeof WorkStartResult.Type;
export const WorkHandoffDraft = Schema.Struct({
  title: WorkTitle,
  scopeSummary: WorkScopeSummary,
  suggestedProjectId: Schema.NullOr(ProjectId),
});
export type WorkHandoffDraft = typeof WorkHandoffDraft.Type;
export class WorkHandoffError extends Schema.TaggedError<WorkHandoffError>()("WorkHandoffError", {
  sourceThreadId: ThreadId,
  stage: Schema.Literals(["read-source", "resolve-project", "launch", "record-link"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Work handoff failed during ${this.stage}.`;
  }
}
