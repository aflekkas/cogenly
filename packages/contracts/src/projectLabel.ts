import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Context/relevance only. A label or repository link never grants access. */
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
});
export type ProjectLabelWithRepositories = typeof ProjectLabelWithRepositories.Type;
export const ProjectLabelRepository = Schema.Struct({
  labelId: ProjectLabelId,
  repositoryId: ProjectId,
});
export type ProjectLabelRepository = typeof ProjectLabelRepository.Type;
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
  labelIds: Schema.Array(ProjectLabelId).check(Schema.isMaxLength(100)),
});
export type SetThreadProjectLabelsInput = typeof SetThreadProjectLabelsInput.Type;
export const ReviewThreadProjectLabelInput = Schema.Struct({
  threadId: ThreadId,
  labelId: ProjectLabelId,
  accept: Schema.Boolean,
});
export type ReviewThreadProjectLabelInput = typeof ReviewThreadProjectLabelInput.Type;
export const ThreadProjectLabelsResult = Schema.Struct({
  labels: Schema.Array(ThreadProjectLabel),
});
export class ProjectLabelError extends Schema.TaggedError<ProjectLabelError>()(
  "ProjectLabelError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["storage", "not_found", "not_suggested"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return "The label, repository, or thread was not found.";
      case "not_suggested":
        return "The thread tag is not a pending suggestion.";
      case "storage":
        return "Could not access project labels.";
    }
  }
}
