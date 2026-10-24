/**
 * ProjectMove: moving a whole project to another paired machine. The target
 * first gets a checkout of every repository the project links, cloned from
 * its remote with the target's own credentials, then every thread filed in
 * the project moves (ThreadTransfer), agents with their conversations.
 * Clone, not copy: a clone is portable and never carries the old machine's
 * paths or half-finished worktrees; unpushed work is reported per thread.
 */
import {
  type EnvironmentId,
  type ProjectLabelId,
  type ProjectMoveInput,
  ProjectMovePrepare,
  type ProjectMoveRepository,
  type ProjectMoveResult,
  THREAD_MOVE_MAX_THREADS,
  type ThreadId,
  type ThreadMoveResult,
  ThreadRemoteError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { cloneRepositoryIntoLabel } from "../projectLabels/ProjectLabelCloneRepository.ts";
import * as ProjectLabelFolders from "../projectLabels/ProjectLabelFolders.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadRouting from "./ThreadRouting.ts";
import * as ThreadTransfer from "./ThreadTransfer.ts";

export class ProjectMove extends Context.Service<
  ProjectMove,
  {
    readonly move: (input: ProjectMoveInput) => Effect.Effect<ProjectMoveResult, ThreadRemoteError>;
  }
>()("cogenly-server/threadSync/ProjectMove") {}

const make = Effect.gen(function* () {
  const replication = yield* ThreadReplication.ThreadReplication;
  const transfer = yield* ThreadTransfer.ThreadTransfer;
  const routing = yield* ThreadRouting.ThreadRouting;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const labels = yield* ProjectLabelService.ProjectLabelService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  // Only the full server clones; a layer without it reports the repository as failed.
  const cloneDeps = yield* Effect.all({
    clones: Effect.serviceOption(ProjectCloneTracker.ProjectCloneTracker),
    projects: Effect.serviceOption(ProjectService.ProjectService),
    identities: Effect.serviceOption(RepositoryIdentityResolver.RepositoryIdentityResolver),
    settings: Effect.serviceOption(ServerSettings.ServerSettingsService),
    folders: Effect.serviceOption(ProjectLabelFolders.ProjectLabelFolders),
    broadcaster: Effect.serviceOption(VcsStatusBroadcaster.VcsStatusBroadcaster),
    checkout: Effect.serviceOption(RepositoryCheckout.RepositoryCheckout),
  });
  const crypto = yield* Crypto.Crypto;
  const home = yield* HostProcess.HomeDirectory;
  const self = replication.environmentId;

  /** A repository record whose checkout is on disk with files in it. */
  const checkedOut = (workspaceRoot: string) =>
    fileSystem.readDirectory(workspaceRoot).pipe(
      Effect.map((entries) => entries.length > 0),
      Effect.orElseSucceed(() => false),
    );

  const clone = Effect.fn("ProjectMove.clone")(function* (id: ProjectLabelId, remote: string) {
    const { clones, projects, identities, settings } = cloneDeps;
    if (
      Option.isNone(clones) ||
      Option.isNone(projects) ||
      Option.isNone(identities) ||
      Option.isNone(settings)
    )
      return yield* Effect.fail("This machine cannot clone repositories.");
    yield* cloneRepositoryIntoLabel(
      { id, ...RepositoryCheckout.cloneInputForRemote(remote) },
      {
        labels,
        clones: clones.value,
        projects: projects.value,
        identities: identities.value,
        settings: settings.value,
        crypto,
        path,
        home,
        cogenlyHome: config.baseDir,
        ...(Option.isSome(cloneDeps.folders) ? { folders: cloneDeps.folders.value } : {}),
        refreshGitStatus: (cwd) =>
          Option.isNone(cloneDeps.broadcaster)
            ? Effect.void
            : cloneDeps.broadcaster.value
                .refreshStatus(cwd)
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid),
      },
    ).pipe(Effect.mapError((error) => error.message));
  });

  /**
   * On the target: a checkout of each linked repository. A missing checkout
   * of a known record clones in place; a repository known here only by its
   * remote is cloned into the project folder. Clones run on after this answers.
   */
  const prepareHere = Effect.fn("ProjectMove.prepareHere")(function* (id: ProjectLabelId) {
    const { label } = yield* labels.readActive(id).pipe(
      Effect.mapError(
        (error) =>
          new ThreadRemoteError({
            reason: "rejected",
            detail:
              error.reason === "not_found"
                ? "This machine does not have that project yet. Try again once it has synced."
                : error.message,
          }),
      ),
    );
    const results: Array<ProjectMoveRepository> = [];
    for (const link of label.repositories ?? []) {
      if (link.remote === null) {
        const record = yield* projectStore.get(link.repositoryId).pipe(Effect.orDie);
        if (Option.isNone(record) || !(yield* checkedOut(record.value.workspaceRoot)))
          results.push({
            remote: link.repositoryId,
            status: "failed",
            detail: "This repository has no remote to clone from.",
          });
        continue;
      }
      const record = yield* projectStore.get(link.repositoryId).pipe(Effect.orDie);
      if (Option.isSome(record) && (yield* checkedOut(record.value.workspaceRoot))) {
        results.push({ remote: link.remote, status: "present" });
        continue;
      }
      const started =
        Option.isSome(record) && Option.isSome(cloneDeps.checkout)
          ? yield* Effect.result(
              cloneDeps.checkout.value.ensureCheckout(link.repositoryId).pipe(
                Effect.mapError((error) => error.message),
                Effect.forkDetach,
              ),
            )
          : yield* Effect.result(clone(id, link.remote));
      results.push(
        started._tag === "Success"
          ? { remote: link.remote, status: "cloning" }
          : { remote: link.remote, status: "failed", detail: started.failure },
      );
    }
    return results;
  });

  yield* channels.register(ProjectMovePrepare, ({ id, target }, caller) =>
    Effect.gen(function* () {
      if (target === self) return yield* prepareHere(id);
      const view = yield* machines.list.pipe(
        Effect.mapError(() => new ThreadRemoteError({ reason: "offline" })),
      );
      if (view.link._tag !== "hub" || target === caller.environmentId)
        return yield* new ThreadRemoteError({ reason: "not-owner" });
      return yield* routing.callMachine(target, ProjectMovePrepare, { id, target }, "30 minutes");
    }),
  );

  /** Every live thread filed in the project, its own chat included. */
  const projectThreads = (id: ProjectLabelId) =>
    sql<{ readonly thread_id: string }>`
      SELECT f.thread_id FROM effective_thread_project_folders f
      JOIN orchestration_v2_projection_threads t ON t.thread_id = f.thread_id
      WHERE f.folder_id = ${id} AND t.deleted_at IS NULL
      UNION
      SELECT l.project_chat_thread_id FROM project_labels l
      JOIN orchestration_v2_projection_threads t ON t.thread_id = l.project_chat_thread_id
      WHERE l.label_id = ${id} AND t.deleted_at IS NULL`.pipe(
      Effect.map((rows) => rows.map((row) => row.thread_id as ThreadId)),
      Effect.orDie,
    );

  const move: ProjectMove["Service"]["move"] = Effect.fn("ProjectMove.move")(function* (input) {
    const repositories =
      input.target === self
        ? yield* prepareHere(input.id)
        : yield* routing.callMachine(
            input.target,
            ProjectMovePrepare,
            { id: input.id, target: input.target as EnvironmentId },
            "30 minutes",
          );
    const threadIds = yield* projectThreads(input.id);
    const threads: { moved: Array<ThreadId>; skipped: Array<ThreadMoveResult["skipped"][number]> } =
      { moved: [], skipped: [] };
    for (let at = 0; at < threadIds.length; at += THREAD_MOVE_MAX_THREADS) {
      const result = yield* transfer.move({
        threadIds: threadIds.slice(at, at + THREAD_MOVE_MAX_THREADS),
        target: input.target,
        ...(input.leaveLocalChanges === undefined
          ? {}
          : { leaveLocalChanges: input.leaveLocalChanges }),
      });
      threads.moved.push(...result.moved);
      threads.skipped.push(...result.skipped);
    }
    return { repositories, threads } satisfies ProjectMoveResult;
  });

  return ProjectMove.of({ move });
});

export const layer = Layer.effect(ProjectMove, make);
