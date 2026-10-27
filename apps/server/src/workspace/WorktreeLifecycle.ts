import type { ProjectId, ThreadId } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { withWorkspaceLease } from "./workspaceLease.ts";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";

export class WorktreePrepareError extends Schema.TaggedError<WorktreePrepareError>()(
  "WorktreePrepareError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not prepare the worktree at ${this.path}.`;
  }
}

class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message() {
    return "The project has no current branch from which to recreate the worktree.";
  }
}

const isWorktreePrepareError = Schema.is(WorktreePrepareError);

export class WorktreeLifecycle extends Context.Service<
  WorktreeLifecycle,
  {
    /** Recreate under the workspace lease; release it before opening setup terminals. */
    readonly prepare: (input: {
      threadId: ThreadId;
      projectId: ProjectId;
      worktreePath: string;
      branch: string;
    }) => Effect.Effect<void, WorktreePrepareError>;
  }
>()("cogenly-server/workspace/WorktreeLifecycle") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitWorkflow.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const setupScripts = yield* Setup.ProjectSetupScriptRunner;
  const scope = yield* Scope.Scope;
  const prepare: WorktreeLifecycle["Service"]["prepare"] = Effect.fn("WorktreeLifecycle.prepare")(
    function* (input) {
      const marker = yield* withWorkspaceLease(
        path.resolve(input.worktreePath),
        Effect.gen(function* () {
          let needsSetup = false;
          if (!(yield* fs.exists(input.worktreePath))) {
            const project = yield* projects.getById(input.projectId);
            if (Option.isNone(project))
              return yield* new WorktreePrepareError({
                path: input.worktreePath,
                cause: "Project unavailable",
              });
            const cwd = project.value.workspaceRoot;
            yield* git.pruneWorktrees({ cwd });
            const branches = yield* git.listLocalBranchNames(cwd);
            if (branches.includes(input.branch)) {
              yield* git.createWorktree({ cwd, refName: input.branch, path: input.worktreePath });
            } else {
              // The workspace can have changed outside Cogenly since its last status read.
              yield* git.invalidateLocalStatus(cwd);
              const { refName } = yield* git.localStatus({ cwd });
              if (refName === null)
                return yield* new WorktreeRecreateNoBaseError({
                  worktreePath: input.worktreePath,
                  branch: input.branch,
                });
              const baseRef = "refs/heads/" + refName;
              yield* git.createWorktree({
                cwd,
                refName: baseRef,
                baseRefName: baseRef,
                newRefName: input.branch,
                path: input.worktreePath,
              });
            }
            needsSetup = true;
          }
          const gitFile = yield* fs.readFileString(path.join(input.worktreePath, ".git"));
          if (!gitFile.startsWith("gitdir: "))
            return yield* new WorktreePrepareError({
              path: input.worktreePath,
              cause: "Expected linked worktree",
            });
          const marker = path.join(
            path.resolve(input.worktreePath, gitFile.slice("gitdir: ".length).trim()),
            "cogenly-dependencies-pruned",
          );
          needsSetup ||= yield* fs.exists(marker);
          if (!needsSetup) return null;
          // Keep the marker on a failed setup so the next attempt retries it.
          yield* fs.writeFileString(marker, "Setup required before next turn.\n");
          return marker;
        }),
      );
      if (marker === null) return;
      const setup = yield* setupScripts.runForThread({
        threadId: input.threadId,
        projectId: input.projectId,
        worktreePath: input.worktreePath,
        observeCompletion: {},
      });
      const complete = Effect.gen(function* () {
        if (setup.status === "started") {
          const completed = setup.completion === undefined ? null : yield* setup.completion;
          if (completed?.exitCode !== 0)
            return yield* new WorktreePrepareError({
              path: input.worktreePath,
              cause: "Setup did not complete successfully",
            });
        }
        yield* fs.remove(marker).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.void,
          ),
        );
      });
      if (setup.status === "started" && setup.async) {
        yield* complete.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Recreated worktree setup failed", {
              path: input.worktreePath,
              error,
            }),
          ),
          Effect.forkIn(scope),
        );
      } else yield* complete;
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isWorktreePrepareError(cause)
            ? cause
            : new WorktreePrepareError({ path: input.worktreePath, cause }),
        ),
      ),
  );
  return WorktreeLifecycle.of({ prepare });
});

export const layer = Layer.effect(WorktreeLifecycle, make);
