import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { ProjectLabelId } from "./projectLabel.ts";

export class ProjectRepositoryMismatchError extends Schema.TaggedError<ProjectRepositoryMismatchError>()(
  "ProjectRepositoryMismatchError",
  {
    projectId: ProjectId,
    projectFolderId: ProjectLabelId,
    repositoryName: Schema.String,
    projectName: Schema.String,
  },
) {
  override get message(): string {
    return `${this.repositoryName} is not in the ${this.projectName} project. Add it to the project first, or start without a project.`;
  }
}
