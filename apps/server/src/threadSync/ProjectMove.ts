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
  ProjectMovePreview,
  type ProjectMoveRepository,
  type ProjectMoveResult,
  THREAD_MOVE_MAX_THREADS,
  type ThreadId,
  type ThreadMoveResult,
  ThreadRemoteError,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectLabelFolders from "../projectLabels/ProjectLabelFolders.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as ThreadReplication from "./ThreadReplication.ts";
import * as ThreadRouting from "./ThreadRouting.ts";
import { adoptLocalCheckout, findLocalCheckout, previewClonePath } from "./localCheckout.ts";
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
  const checkout = yield* RepositoryCheckout.RepositoryCheckout;
  const context = yield* Effect.context<
    | SqlClient.SqlClient
    | FileSystem.FileSystem
    | RepositoryIdentityResolver.RepositoryIdentityResolver
    | ProjectLabelService.ProjectLabelService
    | ProjectLabelFolders.ProjectLabelFolders
    | Path.Path
  >();
  const self = replication.environmentId;

  /** A repository record whose checkout is on disk with files in it. */
  const checkedOut = (workspaceRoot: string) =>
    fileSystem.readDirectory(workspaceRoot).pipe(
      Effect.map((entries) => entries.length > 0),
      Effect.orElseSucceed(() => false),
    );

  /**
   * On the target: a checkout of each linked repository. A checkout of the
   * remote already here joins the project where it is; otherwise
   * checkoutRepository clones it into the project folder, and the clone runs
   * on after this answers.
   */
  const prepareHere = Effect.fn("ProjectMove.prepareHere")(function* (
    id: ProjectLabelId,
    dryRun = false,
  ) {
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
      const record = yield* projectStore.get(link.repositoryId).pipe(Effect.orDie);
      const present = Option.isSome(record) && (yield* checkedOut(record.value.workspaceRoot));
      if (link.remote === null) {
        if (!present)
          results.push({
            remote: link.repositoryId,
            status: "failed",
            detail: "This repository has no remote to clone from.",
          });
        continue;
      }
      if (present) {
        results.push({ remote: link.remote, status: "present" });
        continue;
      }
      // A checkout of it here, outside any other project, joins this one in place.
      const adopted = yield* (dryRun ? findLocalCheckout : adoptLocalCheckout)(
        id,
        link.remote,
      ).pipe(Effect.provideContext(context));
      if (Option.isSome(adopted)) {
        results.push({
          remote: link.remote,
          status: "present",
          detail: `${dryRun ? "Would file" : "Filed"} the checkout at ${adopted.value.workspaceRoot} into the project.`,
        });
        continue;
      }
      if (dryRun) {
        const destination = yield* previewClonePath(id, link.remote).pipe(
          Effect.provideContext(context),
          Effect.orDie,
        );
        results.push({ remote: link.remote, status: "will-clone", detail: destination });
        continue;
      }
      const started = yield* Effect.result(
        checkout
          .checkoutRepository({ labelId: id, remote: link.remote })
          .pipe(Effect.mapError((error) => error.message)),
      );
      results.push(
        started._tag === "Success"
          ? { remote: link.remote, status: "cloning" }
          : { remote: link.remote, status: "failed", detail: started.failure },
      );
    }
    return results;
  });

  // A dry run has its own channel, so an older target refuses it instead of cloning.
  for (const [channel, dryRun] of [
    [ProjectMovePrepare, false],
    [ProjectMovePreview, true],
  ] as const)
    yield* channels.register(channel, ({ id, target }, caller) =>
      Effect.gen(function* () {
        if (target === self) return yield* prepareHere(id, dryRun);
        const view = yield* machines.list.pipe(
          Effect.mapError(() => new ThreadRemoteError({ reason: "offline" })),
        );
        if (view.link._tag !== "hub" || target === caller.environmentId)
          return yield* new ThreadRemoteError({ reason: "not-owner" });
        return yield* routing.callMachine(target, channel, { id, target }, "30 minutes");
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
    const dryRun = input.dryRun === true;
    const repositories =
      input.target === self
        ? yield* prepareHere(input.id, dryRun)
        : yield* routing.callMachine(
            input.target,
            dryRun ? ProjectMovePreview : ProjectMovePrepare,
            { id: input.id, target: input.target as EnvironmentId },
            "30 minutes",
          );
    const threadIds = yield* projectThreads(input.id);
    const threads: {
      moved: Array<ThreadId>;
      skipped: Array<ThreadMoveResult["skipped"][number]>;
      planned: Array<NonNullable<ThreadMoveResult["planned"]>[number]>;
    } = { moved: [], skipped: [], planned: [] };
    for (let at = 0; at < threadIds.length; at += THREAD_MOVE_MAX_THREADS) {
      const result = yield* transfer.move({
        threadIds: threadIds.slice(at, at + THREAD_MOVE_MAX_THREADS),
        target: input.target,
        ...(input.leaveLocalChanges === undefined
          ? {}
          : { leaveLocalChanges: input.leaveLocalChanges }),
        ...(dryRun ? { dryRun } : {}),
      });
      threads.moved.push(...result.moved);
      threads.skipped.push(...result.skipped);
      threads.planned.push(...(result.planned ?? []));
    }
    const { planned: _planned, ...moved } = threads;
    return {
      repositories,
      threads: dryRun ? threads : moved,
    } satisfies ProjectMoveResult;
  });

  return ProjectMove.of({ move });
});

export const layer = Layer.effect(ProjectMove, make);
