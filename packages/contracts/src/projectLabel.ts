import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Project folders provide context only and never grant access. Legacy names/IDs are stable. */
export const ProjectLabelId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectLabelId"));
export type ProjectLabelId = typeof ProjectLabelId.Type;
const color = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const description = Schema.String.check(Schema.isMaxLength(4000));
const fields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  color: Schema.optional(color),
  description: Schema.optional(description),
};
export const ProjectLabel = Schema.Struct({
  id: ProjectLabelId,
  ...fields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectLabel = typeof ProjectLabel.Type;
export const ProjectLabelWithRepositories = Schema.Struct({
  ...ProjectLabel.fields,
  repositoryIds: Schema.Array(ProjectId),
  /** Visible chats and Work: excludes archives, delegated children and agent conversations. */
  threadCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type ProjectLabelWithRepositories = typeof ProjectLabelWithRepositories.Type;
export const ProjectLabelRepository = Schema.Struct({
  labelId: ProjectLabelId,
  repositoryId: ProjectId,
});
export type ProjectLabelRepository = typeof ProjectLabelRepository.Type;
/**
 * Legacy membership envelope. Arrays contain at most one effective folder per
 * thread; confidence/source/confirmation fields are fixed compatibility values.
 * New clients use projectFolderId on shell entries or ThreadProjectFolderResult.
 */
export const ThreadProjectLabel = Schema.Struct({
  threadId: ThreadId,
  labelId: ProjectLabelId,
  confidence: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  confirmedByUser: Schema.Boolean,
  source: Schema.Literals(["user", "suggested"]),
});
export type ThreadProjectLabel = typeof ThreadProjectLabel.Type;
export const ProjectLabelCreateInput = Schema.Struct(fields);
export type ProjectLabelCreateInput = typeof ProjectLabelCreateInput.Type;
/** Omitted fields are preserved; null clears color or description. */
export const ProjectLabelUpdateInput = Schema.Struct({
  id: ProjectLabelId,
  name: Schema.optional(fields.name),
  color: Schema.optional(Schema.NullOr(color)),
  description: Schema.optional(Schema.NullOr(description)),
});
export type ProjectLabelUpdateInput = typeof ProjectLabelUpdateInput.Type;
export const ProjectLabelKey = Schema.Struct({ id: ProjectLabelId });
export const ProjectLabelListResult = Schema.Struct({
  labels: Schema.Array(ProjectLabelWithRepositories),
});
export const ProjectLabelMutationResult = Schema.Struct({ label: ProjectLabelWithRepositories });
export const ProjectLabelDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export const ThreadProjectLabelsInput = Schema.Struct({ threadId: ThreadId });
export const SetThreadProjectLabelsInput = Schema.Struct({
  threadId: ThreadId,
  labelIds: Schema.Array(ProjectLabelId).check(Schema.isMaxLength(1)),
});
export type SetThreadProjectLabelsInput = typeof SetThreadProjectLabelsInput.Type;
/** Null removes explicit filing and restores the repository default for work. */
export const MoveThreadProjectFolderInput = Schema.Struct({
  threadId: ThreadId,
  folderId: Schema.NullOr(ProjectLabelId),
});
export type MoveThreadProjectFolderInput = typeof MoveThreadProjectFolderInput.Type;
/** How the effective folder was selected; does not grant access. */
export const ProjectFolderSource = Schema.NullOr(Schema.Literals(["explicit", "repository"]));
export const ThreadProjectFolderResult = Schema.Struct({
  threadId: ThreadId,
  projectFolderId: Schema.NullOr(ProjectLabelId),
});
export type ThreadProjectFolderResult = typeof ThreadProjectFolderResult.Type;
export const ThreadProjectLabelsResult = Schema.Struct({
  labels: Schema.Array(ThreadProjectLabel),
});
export class ProjectLabelError extends Schema.TaggedError<ProjectLabelError>()(
  "ProjectLabelError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["storage", "not_found", "invalid_membership"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return "The folder, repository, or thread was not found.";
      case "invalid_membership":
        return "A thread can belong to at most one project folder.";
      case "storage":
        return "Could not access project folders.";
    }
  }
}
