// @effect-diagnostics nodeBuiltinImport:off - tests run real git against temp folders on disk.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  SourceControlProviderKind,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
}

function harness(box: Box) {
  const repositories = Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
    prepareClone: (input) =>
      Effect.succeed({
        destinationPath: input.destinationPath ?? "",
        remoteUrl: input.remoteUrl ?? "",
        cloneUrl: input.remoteUrl ?? "",
        repository: null,
      }),
    cloneRepository: (input) =>
      Effect.try({
        try: () => {
          box.cloneCalls += 1;
          NodeChildProcess.execFileSync(
            "git",
            ["clone", "--progress", "--", input.remoteUrl ?? "", input.destinationPath ?? ""],
            { stdio: "pipe" },
          );
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
            Effect.succeed({
              labels: [
                {
                  repositories: [
                    { repositoryId: projectId, remote: box.remote, directoryName: "smile-express" },
                  ],
                },
              ],
            } as never),
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
