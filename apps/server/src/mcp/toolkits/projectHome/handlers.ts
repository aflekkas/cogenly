import {
  OrchestratorMcpFailure,
  type ProjectLabelError,
  type ProjectLabelId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";

import * as ProjectHome from "../../../projectLabels/ProjectHome.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { targetFolder } from "../projectFiles/target.ts";
import { ProjectHomeToolkit } from "./tools.ts";

const failure = (error: ProjectLabelError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

/** The target project's id: the named one, else the calling thread's. */
const projectOf = (operation: string, projectFolderId: ProjectLabelId | undefined) =>
  targetFolder(operation, projectFolderId).pipe(Effect.map((folder) => folder.labelId));

// Reads need a thread caller (an omitted project means the caller's own);
// changes need a live caller, like the other project-label tools. Chat-surface
// callers may use all of them: configuring a project is conversation work.
const handlers = {
  project_overview: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const id = yield* projectOf("project_overview", input.projectFolderId);
      const home = yield* ProjectHome.ProjectHome;
      return yield* home.overview(id).pipe(Effect.mapError(failure));
    }),
  ),
  project_instructions_get: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const id = yield* projectOf("project_instructions_get", input.projectFolderId);
      const home = yield* ProjectHome.ProjectHome;
      return yield* home.instructions(id).pipe(Effect.mapError(failure));
    }),
  ),
  project_instructions_set: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const id = yield* projectOf("project_instructions_set", input.projectFolderId);
      const home = yield* ProjectHome.ProjectHome;
      return yield* home
        .setInstructions({ id, instructions: input.instructions })
        .pipe(Effect.mapError(failure));
    }),
  ),
  project_repository_add: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const id = yield* projectOf("project_repository_add", input.projectFolderId);
      const home = yield* ProjectHome.ProjectHome;
      return yield* home
        .addRepository({ id, repositoryId: input.repositoryId })
        .pipe(Effect.mapError(failure));
    }),
  ),
  project_repository_remove: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const id = yield* projectOf("project_repository_remove", input.projectFolderId);
      const home = yield* ProjectHome.ProjectHome;
      return yield* home
        .removeRepository({ id, repositoryId: input.repositoryId })
        .pipe(Effect.mapError(failure));
    }),
  ),
  project_source_link: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const id = yield* projectOf("project_source_link", input.projectFolderId);
      const home = yield* ProjectHome.ProjectHome;
      return yield* home.linkSource({ id, link: input.link }).pipe(Effect.mapError(failure));
    }),
  ),
  project_source_unlink: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const id = yield* projectOf("project_source_unlink", input.projectFolderId);
      const home = yield* ProjectHome.ProjectHome;
      return yield* home.unlinkSource({ id, link: input.link }).pipe(Effect.mapError(failure));
    }),
  ),
  project_file_write: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const id = yield* projectOf("project_file_write", input.projectFolderId);
      const home = yield* ProjectHome.ProjectHome;
      return yield* home
        .writeFile({ id, title: input.title, text: input.text })
        .pipe(Effect.mapError(failure));
    }),
  ),
  project_file_remove: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const id = yield* projectOf("project_file_remove", input.projectFolderId);
      const home = yield* ProjectHome.ProjectHome;
      return yield* home.removeFile({ id, path: input.path }).pipe(Effect.mapError(failure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ProjectHomeToolkit.tools>;

export const layer = McpToolAccess.toLayer(ProjectHomeToolkit, handlers);
