import {
  OrchestratorMcpFailure,
  type OrchestrationDispatchCommandError,
  type ProjectLabelError,
  type RepositoryCheckoutError,
  type SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Labels from "../../../projectLabels/ProjectLabelService.ts";
import * as Clone from "../../../projectLabels/ProjectLabelCloneRepository.ts";
import * as Clones from "../../../project/ProjectCloneTracker.ts";
import * as Checkout from "../../../project/RepositoryCheckout.ts";
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
const checkoutFailure = (error: RepositoryCheckoutError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "not_found" || error.reason === "not_linked"
        ? "invalid_request"
        : "orchestration_error",
    message: error.message,
  });
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
  project_folders_reconcile: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      const name = input.dirName;
      if (input.action !== "list" && name === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Pass dirName to ${input.action} an orphan folder; list them with action 'list'.`,
        });
      const adopted =
        input.action === "adopt" && name !== undefined
          ? (yield* labels.adoptOrphanFolder({ dirName: name }).pipe(Effect.mapError(failure)))
              .label
          : undefined;
      const removed =
        input.action === "remove" && name !== undefined
          ? (yield* labels.removeOrphanFolder({ dirName: name }).pipe(Effect.mapError(failure)))
              .removed
          : undefined;
      const { folders } = yield* labels.listOrphanFolders().pipe(Effect.mapError(failure));
      return {
        folders,
        ...(adopted === undefined ? {} : { adopted }),
        ...(removed === undefined ? {} : { removed }),
      };
    }),
  ),
  project_label_move_repository: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const checkouts = yield* Checkout.RepositoryCheckout;
      return yield* checkouts.adoptRepository(input).pipe(Effect.mapError(checkoutFailure));
    }),
  ),
  project_label_remove_checkout: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const checkouts = yield* Checkout.RepositoryCheckout;
      return yield* checkouts.removeCheckout(input).pipe(Effect.mapError(checkoutFailure));
    }),
  ),
  project_label_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.list().pipe(Effect.mapError(failure));
    }),
  ),
  project_label_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.read(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_file_thread: McpToolAccess.writesThreads(
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
  thread_move_project_folder: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const labels = yield* Labels.ProjectLabelService;
        return yield* labels.moveThread(input).pipe(Effect.mapError(moveFailure));
      }),
  ),
  thread_set_project_labels: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const labels = yield* Labels.ProjectLabelService;
        return yield* labels.setThreadLabels(input, false).pipe(Effect.mapError(moveFailure));
      }),
  ),
  project_label_create: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.create(input).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_update: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.update(input).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_delete: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.delete(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_archive: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.archive(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_unarchive: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.unarchive(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_link_source: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.linkSource(input).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_unlink_source: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.unlinkSource(input).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_link_repository: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.linkRepository(input).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_unlink_repository: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const labels = yield* Labels.ProjectLabelService;
      return yield* labels.unlinkRepository(input).pipe(Effect.mapError(failure));
    }),
  ),
  project_label_clone_repository: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const broadcaster = yield* Broadcaster.VcsStatusBroadcaster;
      const labels = yield* Labels.ProjectLabelService;
      const projects = yield* Projects.ProjectService;
      // A remote the project already links (say, from another machine) gets
      // its checkout here, under its synced directory name, instead of a
      // second link.
      const remote = Clone.cloneInputRemote(input);
      const { label } = yield* labels.read(input.id).pipe(Effect.mapError(failure));
      const linked =
        remote === null ? undefined : label.repositories?.find((link) => link.remote === remote);
      if (linked?.remote) {
        const checkouts = yield* Checkout.RepositoryCheckout;
        const { repositoryId } = yield* checkouts
          .checkoutRepository({ labelId: label.id, remote: linked.remote })
          .pipe(Effect.mapError(checkoutFailure));
        const project = yield* projects.getById(repositoryId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
        if (project === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `The checkout of ${linked.remote} has no repository record.`,
          });
        return {
          projectId: repositoryId,
          cwd: project.workspaceRoot,
          remoteUrl: linked.remote,
          repository: null,
        };
      }
      return yield* Clone.cloneRepositoryIntoLabel(
        input,
        {
          labels,
          clones: yield* Clones.ProjectCloneTracker,
          projects,
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
        },
        { caller: "agent" },
      ).pipe(Effect.mapError(cloneFailure));
    }),
  ),
});
