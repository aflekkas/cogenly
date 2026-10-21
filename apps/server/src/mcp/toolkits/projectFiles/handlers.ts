import { OrchestratorMcpFailure, type ProjectLabelError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProjectFilesToolkit } from "./tools.ts";

const resourceFailure = (error: ProjectLabelError): OrchestratorMcpFailure =>
  error.reason === "storage"
    ? new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "The project folder could not be read.",
      })
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const noProjectFailure = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "The calling thread is not filed in a Cogenly project folder.",
  });

const callerThreadId = (operation: string) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
    return thread.threadId;
  });

const handlers = {
  // Project files are read-only thread context, so chat-surface callers may
  // use these alongside every other caller.
  project_files_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("project_files_list");
      const files = yield* ProjectFiles.ProjectFiles;
      const folder = yield* files.folderForThread(threadId).pipe(Effect.mapError(resourceFailure));
      if (folder === null) return yield* noProjectFailure();
      const listed = yield* files
        .listResources(folder.labelId)
        .pipe(Effect.mapError(resourceFailure));
      const prefix = input.prefix;
      if (prefix === undefined) return listed;
      return {
        ...listed,
        resources: listed.resources.filter((resource) => resource.relativePath.startsWith(prefix)),
      };
    }),
  ),
  project_file_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("project_file_read");
      const files = yield* ProjectFiles.ProjectFiles;
      const folder = yield* files.folderForThread(threadId).pipe(Effect.mapError(resourceFailure));
      if (folder === null) return yield* noProjectFailure();
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
      const threadId = yield* callerThreadId("project_recall");
      const files = yield* ProjectFiles.ProjectFiles;
      const folder = yield* files.folderForThread(threadId).pipe(Effect.mapError(resourceFailure));
      if (folder === null) return yield* noProjectFailure();
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
