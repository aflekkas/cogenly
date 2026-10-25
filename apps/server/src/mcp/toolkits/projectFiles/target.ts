import {
  OrchestratorMcpFailure,
  type ProjectLabelError,
  type ProjectLabelId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";

import * as ProjectFiles from "../../../projectLabels/ProjectFiles.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const resourceFailure = (error: ProjectLabelError): OrchestratorMcpFailure =>
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

const missingFolderFailure = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "That Cogenly project folder no longer exists.",
  });

/** The folder a call reads: the named one from an `@` mention, else the caller's own. */
export const targetFolder = (operation: string, projectFolderId: ProjectLabelId | undefined) =>
  Effect.gen(function* () {
    const files = yield* ProjectFiles.ProjectFiles;
    if (projectFolderId !== undefined) {
      const folder = yield* files
        .folderById(projectFolderId)
        .pipe(Effect.mapError(resourceFailure));
      return folder ?? (yield* missingFolderFailure());
    }
    const threadId = yield* callerThreadId(operation);
    const folder = yield* files.folderForThread(threadId).pipe(Effect.mapError(resourceFailure));
    return folder ?? (yield* noProjectFailure());
  });

const callerThreadId = (operation: string) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
    return thread.threadId;
  });
