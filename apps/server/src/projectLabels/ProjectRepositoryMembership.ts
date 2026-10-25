import { ProjectId, ProjectLabelId, ProjectRepositoryMismatchError } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectLabelFolders from "./ProjectLabelFolders.ts";

export class ProjectRepositoryMembershipError extends Schema.TaggedError<ProjectRepositoryMembershipError>()(
  "ProjectRepositoryMembershipError",
  { projectId: ProjectId, projectFolderId: ProjectLabelId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not check the repository's project membership.";
  }
}

/** New starts and saved launch configurations share this rule; replay never calls it. */
export class ProjectRepositoryMembership extends Context.Service<
  ProjectRepositoryMembership,
  {
    readonly validate: (input: {
      readonly projectId: ProjectId;
      readonly projectFolderId?: ProjectLabelId | null | undefined;
      /** Portable launches check the target's shared remote before resolving a checkout. */
      readonly repositoryRemote?: string | undefined;
    }) => Effect.Effect<void, ProjectRepositoryMismatchError | ProjectRepositoryMembershipError>;
  }
>()("cogenly-server/projectLabels/ProjectRepositoryMembership") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const folders = yield* Effect.serviceOption(ProjectLabelFolders.ProjectLabelFolders);

  return ProjectRepositoryMembership.of({
    validate: Effect.fn("ProjectRepositoryMembership.validate")(function* (input) {
      const folderId = input.projectFolderId;
      if (folderId == null) return;
      yield* Effect.gen(function* () {
        const labels = yield* sql<{ readonly name: string }>`
          SELECT name FROM project_labels WHERE label_id = ${folderId}`;
        const label = labels[0] ?? { name: folderId };
        const projects = yield* sql<{ readonly title: string; readonly workspace_root: string }>`
          SELECT title, workspace_root FROM projection_projects WHERE project_id = ${input.projectId}`;
        const project = projects[0];
        const remote =
          input.repositoryRemote ??
          (input.projectId.startsWith("remote:")
            ? input.projectId.slice("remote:".length)
            : undefined);
        const links =
          remote === undefined
            ? yield* sql`SELECT 1 FROM label_repositories
              WHERE label_id = ${folderId} AND repository_id = ${input.projectId} LIMIT 1`
            : yield* sql`SELECT 1 FROM label_repositories
              WHERE label_id = ${folderId} AND remote = ${remote} LIMIT 1`;
        if (links.length > 0) return;
        if (input.repositoryRemote === undefined && project !== undefined) {
          const root = path.resolve(project.workspace_root);
          if (Option.isSome(config) && root === path.resolve(config.value.baseDir, "scratch"))
            return;
          if (Option.isSome(folders)) {
            const ownFolder = yield* folders.value.dirForLabel({ id: folderId, name: label.name });
            if (root === path.resolve(ownFolder.dir)) return;
          }
        }
        return yield* new ProjectRepositoryMismatchError({
          projectId: input.projectId,
          projectFolderId: folderId,
          repositoryName: project?.title ?? input.repositoryRemote ?? input.projectId,
          projectName: label.name,
        });
      }).pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProjectRepositoryMismatchError"
            ? cause
            : new ProjectRepositoryMembershipError({
                projectId: input.projectId,
                projectFolderId: folderId,
                cause,
              }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(ProjectRepositoryMembership, make);
