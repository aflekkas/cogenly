import * as Schema from "effect/Schema";
import { CommandId, MessageId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const WorkStartInput = Schema.Struct({
  /** Stable across retries: one handoff creates one Work thread. */
  commandId: CommandId,
  sourceThreadId: ThreadId,
  targetProjectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  scopeSummary: TrimmedNonEmptyString.check(Schema.isMaxLength(16000)),
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
export const WorkProposeHandoffInput = Schema.Struct({
  sourceThreadId: ThreadId,
  /** Drafts from the chat up to and including this message. Absent means the latest messages. */
  throughMessageId: Schema.optional(MessageId),
});
export type WorkProposeHandoffInput = typeof WorkProposeHandoffInput.Type;
export const WorkHandoffDraft = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  scopeSummary: TrimmedNonEmptyString.check(Schema.isMaxLength(16000)),
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
