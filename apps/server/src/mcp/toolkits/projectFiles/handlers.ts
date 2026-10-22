import * as Effect from "effect/Effect";

import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { resourceFailure, targetFolder } from "./target.ts";
import { ProjectFilesToolkit } from "./tools.ts";

const handlers = {
  // Project files are read-only thread context, so chat-surface callers may
  // use these alongside every other caller.
  project_files_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const folder = yield* targetFolder("project_files_list", input.projectFolderId);
      const files = yield* ProjectFiles.ProjectFiles;
      const listed = yield* files
        .listResources(folder.labelId)
        .pipe(Effect.mapError(resourceFailure));
      const prefix = input.prefix;
      return {
        projectFolderId: folder.labelId,
        name: folder.name,
        directory: folder.dir,
        truncated: listed.truncated,
        resources:
          prefix === undefined
            ? listed.resources
            : listed.resources.filter((resource) => resource.relativePath.startsWith(prefix)),
      };
    }),
  ),
  project_file_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const folder = yield* targetFolder("project_file_read", input.projectFolderId);
      const files = yield* ProjectFiles.ProjectFiles;
      return yield* files
        .readResource({
          id: folder.labelId,
          relativePath: input.path,
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        .pipe(Effect.mapError(resourceFailure));
    }),
  ),
  project_recall: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const folder = yield* targetFolder("project_recall", input.projectFolderId);
      const files = yield* ProjectFiles.ProjectFiles;
      return yield* files
        .searchResources({
          labelId: folder.labelId,
          query: input.query,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        .pipe(Effect.mapError(resourceFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ProjectFilesToolkit.tools>;

export const layer = McpToolAccess.toLayer(ProjectFilesToolkit, handlers);
