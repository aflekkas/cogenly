import {
  OrchestratorMcpFailure,
  type OrchestrationDispatchCommandError,
  type ProjectLabelError,
  type SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Labels from "../../../projectLabels/ProjectLabelService.ts";
import * as Clone from "../../../projectLabels/ProjectLabelCloneRepository.ts";
import * as Clones from "../../../project/ProjectCloneTracker.ts";
import * as Projects from "../../../project/ProjectService.ts";
import * as Identities from "../../../project/RepositoryIdentityResolver.ts";
import * as Settings from "../../../serverSettings.ts";
import * as ServerConfig from "../../../config.ts";
import * as Broadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProjectLabelsToolkit } from "./tools.ts";
const failure = (error: { reason: string; message: string }) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "not_found" || error.reason === "archived"
        ? "invalid_request"
        : "orchestration_error",
    message: error.message,
  });
// moveThread re-homes the same thread, but never while a turn is in flight.
const moveFailure = (error: ProjectLabelError) =>
  error.reason === "thread_active"
    ? new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "A turn is running in this thread, so it cannot be moved yet. Wait for the turn to finish, then move it; the chat keeps its history and its next turn runs in the new project folder.",
      })
    : failure(error);
const cloneFailure = (
  error: ProjectLabelError | SourceControlRepositoryError | OrchestrationDispatchCommandError,
) =>
  error._tag === "ProjectLabelError"
    ? failure(error)
    : new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: error._tag === "SourceControlRepositoryError" ? error.detail : error.message,
      });
export const layer = McpToolAccess.toLayer(ProjectLabelsToolkit, {
  t3_project_label_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.list().pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.read(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_file_thread: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const labels = yield* Labels.ProjectLabelService;
        // Re-home: the same thread is re-filed, whatever its history. Its
        // next turn runs in the project folder with a fresh provider session
        // seeded from that history.
        const moved = yield* labels
          .moveThread({ threadId: input.threadId, folderId: input.labelId })
          .pipe(Effect.mapError(moveFailure));
        return {
          threadId: input.threadId,
          sourceThreadId: input.threadId,
          projectFolderId: moved.projectFolderId ?? input.labelId,
          forked: false,
          message:
            "Filed the thread into the project. The chat keeps its history; its next turn runs in the project folder.",
        };
      }),
  ),
  t3_thread_move_project_folder: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const labels = yield* Labels.ProjectLabelService;
        return yield* labels.moveThread(input).pipe(Effect.mapError(moveFailure));
      }),
  ),
  t3_thread_set_project_labels: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const labels = yield* Labels.ProjectLabelService;
        return yield* labels.setThreadLabels(input, false).pipe(Effect.mapError(moveFailure));
      }),
  ),
  t3_project_label_create: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.create(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_update: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.update(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_delete: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.delete(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_archive: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.archive(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_unarchive: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.unarchive(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_link_source: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.linkSource(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_unlink_source: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.unlinkSource(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_link_repository: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.linkRepository(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_unlink_repository: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.unlinkRepository(input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_project_label_clone_repository: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const broadcaster = yield* Broadcaster.VcsStatusBroadcaster;
      return yield* Clone.cloneRepositoryIntoLabel(input, {
        labels: yield* Labels.ProjectLabelService,
        clones: yield* Clones.ProjectCloneTracker,
        projects: yield* Projects.ProjectService,
        identities: yield* Identities.RepositoryIdentityResolver,
        settings: yield* Settings.ServerSettingsService,
        crypto: yield* Crypto.Crypto,
        path: yield* Path.Path,
        home: yield* HostProcess.HomeDirectory,
        cogenlyHome: (yield* ServerConfig.ServerConfig).baseDir,
        refreshGitStatus: (cwd) =>
          broadcaster
            .refreshStatus(cwd)
            .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid),
      }).pipe(Effect.mapError(cloneFailure));
    }),
  ),
});
