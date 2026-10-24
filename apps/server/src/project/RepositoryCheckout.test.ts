// @effect-diagnostics nodeBuiltinImport:off - tests run real git against temp folders on disk.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  SourceControlProviderKind,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryCheckout from "./RepositoryCheckout.ts";

const projectId = ProjectId.make("project:smile-express");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, stdio: "pipe" });

/** A local bare repository holding one committed file, used as the remote. */
function makeBareRemote(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "repository-checkout-"));
  const seed = NodePath.join(root, "seed");
  NodeFS.mkdirSync(seed);
  git(seed, ["init", "--initial-branch=main"]);
  NodeFS.writeFileSync(NodePath.join(seed, "README.md"), "hello\n");
  git(seed, ["add", "."]);
  git(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  const bare = NodePath.join(root, "remote.git");
  git(root, ["init", "--bare", "--initial-branch=main", bare]);
  git(seed, ["push", bare, "main"]);
  return bare;
}

const tempRoot = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "repository-checkout-"));

const isRepository = (cwd: string) =>
  Effect.sync(() => {
    try {
      git(cwd, ["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  });

interface Box {
  workspaceRoot: string;
  remote: string | null;
  cloneCalls: number;
  onPrepareClone?: () => Effect.Effect<void>;
  onListLabels?: () => Effect.Effect<void>;
  onClone?: () => void;
}

function harness(box: Box) {
  const repositories = Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
    prepareClone: (input) =>
      (box.onPrepareClone ? box.onPrepareClone() : Effect.void).pipe(
        Effect.as({
          destinationPath: input.destinationPath ?? "",
          remoteUrl: input.remoteUrl ?? "",
          cloneUrl: input.remoteUrl ?? "",
          repository: null,
        }),
      ),
    cloneRepository: (input) =>
      Effect.try({
        try: () => {
          box.cloneCalls += 1;
          NodeChildProcess.execFileSync(
            "git",
            ["clone", "--progress", "--", input.remoteUrl ?? "", input.destinationPath ?? ""],
            { stdio: "pipe" },
          );
          box.onClone?.();
          return {
            cwd: input.destinationPath ?? "",
            remoteUrl: input.remoteUrl ?? "",
            repository: null,
          };
        },
        catch: (cause) =>
          new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: SourceControlProviderKind.make("unknown"),
            detail: cause instanceof Error ? cause.message : "clone failed",
            cause,
          }),
      }),
    discardClone: () => Effect.void,
  });
  const clones = ProjectCloneTracker.layer.pipe(Layer.provide(repositories));
  return RepositoryCheckout.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "smile-express",
              workspaceRoot: box.workspaceRoot,
            } as never),
          update: () => Effect.succeed({} as never),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({ isRepository }),
        clones,
        Layer.mock(ProjectLabelService.ProjectLabelService)({
          list: () =>
            (box.onListLabels ? box.onListLabels() : Effect.void).pipe(
              Effect.andThen(
                Effect.succeed({
                  labels: [
                    {
                      repositories: [
                        {
                          repositoryId: projectId,
                          remote: box.remote,
                          directoryName: "smile-express",
                        },
                      ],
                    },
                  ],
                } as never),
              ),
            ),
        }),
        NodeServices.layer,
      ),
    ),
  );
}

const run = (box: Box) =>
  Effect.gen(function* () {
    const checkout = yield* RepositoryCheckout.RepositoryCheckout;
    return yield* checkout.ensureCheckout(projectId);
  }).pipe(Effect.provide(harness(box)), Effect.scoped);

/**
 * A launch that arrives while this repository's clone is still running:
 * git has already created `.git`, but no files are checked out yet. The
 * tracker is mocked so the clone stays running until the test releases it.
 */
const runDuringClone = Effect.gen(function* () {
  const workspaceRoot = NodePath.join(tempRoot(), "smile-express");
  NodeFS.mkdirSync(workspaceRoot);
  // Mid-clone state: `.git` exists, the working tree is still empty.
  git(workspaceRoot, ["init", "--initial-branch=main"]);
  const waitStarted = yield* Deferred.make<void>();
  const releaseClone = yield* Deferred.make<void>();
  const returned = yield* Deferred.make<void>();
  const snapshot = (phase: "running" | "done") =>
    ({
      projectId,
      remoteUrl: "https://example.invalid/repo.git",
      destinationPath: workspaceRoot,
      repository: null,
      phase,
      stage: "receiving",
      percent: 10,
      detail: null,
      error: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      sequence: 1,
    }) as never;
  const clones = Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
    get: () => Effect.succeed(snapshot("running")),
    stream: Stream.callback<ReadonlyArray<never>>((mailbox) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(waitStarted, undefined);
        yield* Deferred.await(releaseClone);
        NodeFS.writeFileSync(NodePath.join(workspaceRoot, "README.md"), "hello\n");
        yield* Effect.sync(() => Queue.offerUnsafe(mailbox, [snapshot("done")]));
      }),
    ),
  });
  const layer = RepositoryCheckout.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "smile-express",
              workspaceRoot,
            } as never),
          update: () => Effect.succeed({} as never),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({ isRepository }),
        clones,
        Layer.mock(ProjectLabelService.ProjectLabelService)({
          list: () =>
            Effect.succeed({
              labels: [
                {
                  repositories: [
                    { repositoryId: projectId, remote: null, directoryName: "smile-express" },
                  ],
                },
              ],
            } as never),
        }),
        NodeServices.layer,
      ),
    ),
  );
  const ensure = Effect.gen(function* () {
    const checkout = yield* RepositoryCheckout.RepositoryCheckout;
    return yield* checkout.ensureCheckout(projectId);
  }).pipe(
    Effect.ensuring(Deferred.succeed(returned, undefined).pipe(Effect.asVoid)),
    Effect.provide(layer),
    Effect.scoped,
  );
  const fiber = yield* Effect.forkScoped(ensure);
  // Whichever happens first decides: the ensure subscribing to wait for
  // the clone (fixed) or the ensure returning against the half-clone.
  const first = yield* Effect.raceFirst(
    Deferred.await(waitStarted).pipe(Effect.as("waiting" as const)),
    Deferred.await(returned).pipe(Effect.as("returned" as const)),
  );
  const outcome = { first, poll: fiber.pollUnsafe(), workspaceRoot };
  yield* Deferred.succeed(releaseClone, undefined);
  yield* Fiber.join(fiber);
  return outcome;
});

describe("RepositoryCheckout.ensureCheckout", () => {
  it.effect("succeeds without cloning when the checkout already exists", () => {
    const bare = makeBareRemote();
    const root = tempRoot();
    const workspaceRoot = NodePath.join(root, "smile-express");
    git(root, ["clone", bare, workspaceRoot]);
    const box: Box = { workspaceRoot, remote: bare, cloneCalls: 0 };
    return Effect.gen(function* () {
      yield* run(box);
      expect(box.cloneCalls).toBe(0);
      expect(NodeFS.readFileSync(NodePath.join(workspaceRoot, "README.md"), "utf8")).toBe(
        "hello\n",
      );
    });
  });

  it.effect("clones an empty folder in place from its known remote", () => {
    const bare = makeBareRemote();
    const workspaceRoot = NodePath.join(tempRoot(), "smile-express");
    NodeFS.mkdirSync(workspaceRoot);
    const box: Box = { workspaceRoot, remote: bare, cloneCalls: 0 };
    return Effect.gen(function* () {
      yield* run(box);
      expect(box.cloneCalls).toBe(1);
      expect(NodeFS.existsSync(NodePath.join(workspaceRoot, ".git"))).toBe(true);
      expect(NodeFS.readFileSync(NodePath.join(workspaceRoot, "README.md"), "utf8")).toBe(
        "hello\n",
      );
    });
  });

  it.effect("clones an empty folder that sits inside some other repository", () => {
    const bare = makeBareRemote();
    const projectsRoot = tempRoot();
    git(projectsRoot, ["init", "--initial-branch=main"]);
    const workspaceRoot = NodePath.join(projectsRoot, "smile-express");
    NodeFS.mkdirSync(workspaceRoot);
    const box: Box = { workspaceRoot, remote: bare, cloneCalls: 0 };
    return Effect.gen(function* () {
      yield* run(box);
      expect(box.cloneCalls).toBe(1);
      expect(NodeFS.readFileSync(NodePath.join(workspaceRoot, "README.md"), "utf8")).toBe(
        "hello\n",
      );
    });
  });

  it.effect("clones when the folder is missing entirely", () => {
    const bare = makeBareRemote();
    const workspaceRoot = NodePath.join(tempRoot(), "smile-express");
    const box: Box = { workspaceRoot, remote: bare, cloneCalls: 0 };
    return Effect.gen(function* () {
      yield* run(box);
      expect(NodeFS.readFileSync(NodePath.join(workspaceRoot, "README.md"), "utf8")).toBe(
        "hello\n",
      );
    });
  });

  it.effect("two concurrent ensures into one empty repo clone once and both succeed", () => {
    const bare = makeBareRemote();
    const workspaceRoot = NodePath.join(tempRoot(), "smile-express");
    NodeFS.mkdirSync(workspaceRoot);
    const box: Box = { workspaceRoot, remote: bare, cloneCalls: 0 };
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let listCalls = 0;
      box.onListLabels = () =>
        Effect.suspend(() => {
          listCalls += 1;
          // Hold the first ensure after its checkout check but before it can
          // start a clone, so the second ensure claims the clone first: the
          // check-then-start race, deterministically.
          return listCalls === 1
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void;
        });
      // Both ensures share one clone tracker, like two launches in one
      // server: the harness layer is provided once around the whole test,
      // since providing it per ensure would rebuild the tracker each time.
      const ensure = Effect.gen(function* () {
        const checkout = yield* RepositoryCheckout.RepositoryCheckout;
        return yield* checkout.ensureCheckout(projectId);
      }).pipe(Effect.scoped);
      const first = yield* Effect.forkScoped(ensure);
      yield* Deferred.await(entered);
      const second = yield* Effect.forkScoped(ensure);
      // The second ensure claimed the clone and finished; only now release
      // the first ensure so its start meets the already-claimed clone.
      yield* Fiber.join(second);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(box.cloneCalls).toBe(1);
      expect(NodeFS.readFileSync(NodePath.join(workspaceRoot, "README.md"), "utf8")).toBe(
        "hello\n",
      );
    }).pipe(Effect.provide(harness(box)));
  });

  it.effect("waits for this repository's running clone instead of launching into it", () =>
    Effect.gen(function* () {
      const outcome = yield* runDuringClone;
      expect(outcome.first).toBe("waiting");
      expect(outcome.poll).toBeUndefined();
      expect(NodeFS.readFileSync(NodePath.join(outcome.workspaceRoot, "README.md"), "utf8")).toBe(
        "hello\n",
      );
    }),
  );

  it.effect("fails with what to do when there is no checkout and no remote", () => {
    const workspaceRoot = NodePath.join(tempRoot(), "smile-express");
    NodeFS.mkdirSync(workspaceRoot);
    const box: Box = { workspaceRoot, remote: null, cloneCalls: 0 };
    return Effect.gen(function* () {
      const error = yield* Effect.flip(run(box));
      expect(error._tag).toBe("RepositoryCheckoutError");
      expect(error.reason).toBe("no_remote");
      expect(error.message).toBe(
        "smile-express has no checkout and no known remote; clone it with project_label_clone_repository or link an existing checkout.",
      );
      expect(box.cloneCalls).toBe(0);
    });
  });

  it.effect("leaves a folder that already has files to launch as before, untouched", () => {
    const bare = makeBareRemote();
    const workspaceRoot = NodePath.join(tempRoot(), "smile-express");
    NodeFS.mkdirSync(workspaceRoot);
    NodeFS.writeFileSync(NodePath.join(workspaceRoot, "keep.txt"), "mine\n");
    const box: Box = { workspaceRoot, remote: bare, cloneCalls: 0 };
    return Effect.gen(function* () {
      yield* run(box);
      expect(NodeFS.readFileSync(NodePath.join(workspaceRoot, "keep.txt"), "utf8")).toBe("mine\n");
      expect(NodeFS.existsSync(NodePath.join(workspaceRoot, ".git"))).toBe(false);
      expect(box.cloneCalls).toBe(0);
    });
  });
});
