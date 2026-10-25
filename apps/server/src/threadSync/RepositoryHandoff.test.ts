import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProjectLabelId,
  ThreadHandoffCommit,
  EventId,
  type ThreadMoveResult,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Config from "../config.ts";
import { pair } from "../machines/testkit.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as RepositoryHandoff from "./RepositoryHandoff.ts";
import { exportBundle } from "./repositoryBundle.ts";
import { startThreadMachine, threadCreated, threadId } from "./testkit.ts";

const layer = RepositoryHandoff.layer.pipe(
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(Config.layerTest("/tmp", { prefix: "handoff-git" })),
  Layer.provideMerge(NodeServices.layer),
);
const branch = "feature/pit-stops";
const projectId = ProjectId.make("project:mcp-test");

const fixture = Effect.fnUntraced(function* (state: "stale" | "diverged" | "missing") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* Git.GitVcsDriver;
  // Cover every Git operation, including those in the services under test.
  const git = {
    ...driver,
    execute: (input: Git.ExecuteGitInput) =>
      driver.execute({ ...input, env: { ...input.env, GIT_CONFIG_GLOBAL: "/dev/null" } }),
  };
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ cwd, args, operation: "handoff-test" });
  const temp = yield* fs.makeTempDirectoryScoped();
  const source = path.join(temp, "source");
  const target = path.join(temp, "target");
  const remote = path.join(temp, "remote.git");
  yield* fs.makeDirectory(source);
  yield* run(temp, ["init", "--bare", "--initial-branch=main", remote]);
  yield* run(source, ["init", "--initial-branch=main"]);
  const commit = (cwd: string, message: string) =>
    run(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-am",
      message,
    ]);
  yield* fs.writeFileString(path.join(source, "code.txt"), "base\n");
  yield* run(source, ["add", "."]);
  yield* commit(source, "base");
  const base = (yield* run(source, ["rev-parse", "HEAD"])).stdout.trim();
  yield* run(source, ["remote", "add", "origin", remote]);
  yield* run(source, ["push", "-u", "origin", "main"]);
  yield* run(temp, ["clone", remote, target]);
  if (state !== "missing") yield* run(target, ["branch", branch, base]);
  if (state === "diverged") {
    yield* run(target, ["checkout", branch]);
    yield* fs.writeFileString(path.join(target, "code.txt"), "destination work\n");
    yield* commit(target, "destination only");
    yield* run(target, ["checkout", "main"]);
  }
  const previous =
    state === "missing" ? undefined : (yield* run(target, ["rev-parse", branch])).stdout.trim();
  yield* run(source, ["checkout", "-b", branch]);
  yield* fs.writeFileString(path.join(source, "code.txt"), "source pushed\n");
  yield* commit(source, "source latest");
  yield* run(source, ["push", "-u", "origin", branch]);
  const revision = (yield* run(source, ["rev-parse", "HEAD"])).stdout.trim();
  const repository = { branch, revision, remoteRef: `refs/heads/${branch}` };
  return { fs, path, git, temp, source, target, run, commit, base, previous, revision, repository };
});

it.live.each(["stale", "diverged", "missing"] as const)(
  "moves the exact pushed revision with a %s destination branch",
  (state) =>
    Effect.gen(function* () {
      const f = yield* fixture(state);
      if (state === "stale") {
        yield* f.fs.writeFileString(f.path.join(f.source, "code.txt"), "source unpushed\n");
        yield* f.commit(f.source, "unpushed stays on source");
      }
      const hub = yield* startThreadMachine(
        `revision-${state}-hub`,
        "cloud-server",
        undefined,
        undefined,
        true,
        undefined,
        false,
        { git: f.git },
      );
      const laptop = yield* startThreadMachine(
        `revision-${state}-laptop`,
        "computer",
        undefined,
        undefined,
        true,
        undefined,
        false,
        { git: f.git },
      );
      yield* pair(hub, laptop);
      for (const [machine, root] of [
        [hub, f.target],
        [laptop, f.source],
      ] as const)
        yield* machine.sql`INSERT INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
          VALUES (${projectId}, 'Racing', ${root}, 0, '[]', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
      const event = threadCreated("event:revision", yield* DateTime.now);
      if (event.type !== "thread.created") throw new Error("Expected thread.created");
      yield* laptop.sink.write({
        events: [{ ...event, payload: { ...event.payload, branch, worktreePath: f.source } }],
      });
      yield* Option.getOrThrow(laptop.worker).drain();
      yield* laptop.sync.sync(hub.environmentId);
      const preview = yield* laptop.transfer.move({
        threadIds: [threadId],
        target: hub.environmentId,
        leaveLocalChanges: state === "stale",
        dryRun: true,
      });
      expect(preview.planned?.[0]?.branch).toMatchObject({
        branch,
        revision: f.revision,
        action: state === "missing" ? "create" : "verify",
      });
      expect(yield* hub.replication.owner(threadId)).toMatchObject({ local: false });
      // A dry run must neither fetch nor change a branch.
      expect((yield* Effect.result(f.run(f.target, ["cat-file", "-e", f.revision])))._tag).toBe(
        "Failure",
      );
      const moved = yield* laptop.transfer.move({
        threadIds: [threadId],
        target: hub.environmentId,
        leaveLocalChanges: state === "stale",
      });
      expect(moved.moved).toEqual([threadId]);
      expect(moved.skipped).toEqual([]);
      expect((yield* f.run(f.target, ["rev-parse", branch])).stdout.trim()).toBe(f.revision);
      const thread = (yield* hub.projections.getThreadProjection(threadId)).thread;
      expect(thread.worktreePath).not.toBeNull();
      expect((yield* f.run(thread.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
        f.revision,
      );
      expect(yield* f.fs.readFileString(f.path.join(thread.worktreePath!, "code.txt"))).toBe(
        "source pushed\n",
      );
      expect(moved.branches?.[0]?.action).toBe(
        state === "stale" ? "fast-forward" : state === "diverged" ? "preserve" : "create",
      );
      const retry = yield* laptop.machines.call(hub.environmentId, ThreadHandoffCommit, {
        threadId,
        from: laptop.environmentId,
        to: hub.environmentId,
        epoch: 1,
        repository: f.repository,
        attachmentIds: [],
        lastEventId: EventId.make("event:revision"),
        eventCount: 1,
      });
      expect(retry.branch).toEqual(
        moved.branches?.[0] === undefined
          ? undefined
          : {
              branch,
              revision: moved.branches[0].revision,
              action: moved.branches[0].action,
              ...(moved.branches[0].preservedBranch === undefined
                ? {}
                : { preservedBranch: moved.branches[0].preservedBranch }),
            },
      );
      expect((yield* f.run(f.target, ["rev-parse", `${branch}@{upstream}`])).stdout.trim()).toBe(
        f.revision,
      );
      const marker = (yield* f.run(thread.worktreePath!, [
        "rev-parse",
        "--git-path",
        "cogenly-dependencies-pruned",
      ])).stdout.trim();
      expect(yield* f.fs.exists(f.path.resolve(thread.worktreePath!, marker))).toBe(true);
      const preserved = moved.branches?.[0]?.preservedBranch;
      if (state === "diverged") {
        expect(preserved).toMatch(/^preserved\/feature\/pit-stops-\d+$/);
        expect((yield* f.run(f.target, ["rev-parse", preserved!])).stdout.trim()).toBe(f.previous);
      } else expect(preserved).toBeUndefined();
      yield* Option.getOrThrow(hub.worker).drain();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  30000,
);

describe("repository preparation", () => {
  it.effect(
    "pins a transferred bundle and preserves diverged work, including dirty checked-out files",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("diverged");
        yield* f.run(f.target, ["checkout", branch]);
        yield* f.fs.writeFileString(
          f.path.join(f.target, "code.txt"),
          "uncommitted destination edits\n",
        );
        const bundle = yield* exportBundle(f.source, f.revision).pipe(
          Effect.provideService(Git.GitVcsDriver, f.git),
        );
        const handoff = yield* RepositoryHandoff.RepositoryHandoff.pipe(
          Effect.provide(
            RepositoryHandoff.layer.pipe(Layer.provide(Layer.succeed(Git.GitVcsDriver, f.git))),
          ),
        );
        const prepared = yield* handoff.prepare({
          cwd: f.target,
          worktreePath: f.target,
          repository: { ...f.repository, bundle },
        });
        expect(prepared.branch?.action).toBe("preserve");
        expect((yield* f.run(f.target, ["branch", "--show-current"])).stdout.trim()).toBe(
          prepared.branch?.preservedBranch,
        );
        expect(yield* f.fs.readFileString(f.path.join(f.target, "code.txt"))).toBe(
          "uncommitted destination edits\n",
        );
        expect((yield* f.run(prepared.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
          f.revision,
        );
        expect(
          (yield* f.run(f.target, ["rev-parse", prepared.branch!.preservedBranch!])).stdout.trim(),
        ).toBe(f.previous);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps the handed-off commit when the pushed branch advances before acceptance", () =>
    Effect.gen(function* () {
      const f = yield* fixture("stale");
      yield* f.fs.writeFileString(f.path.join(f.source, "code.txt"), "later push\n");
      yield* f.commit(f.source, "later push");
      yield* f.run(f.source, ["push"]);
      const handoff = yield* RepositoryHandoff.RepositoryHandoff;
      const prepared = yield* handoff.prepare({
        cwd: f.target,
        worktreePath: f.path.join(f.temp, "worktree"),
        repository: f.repository,
      });
      expect((yield* f.run(prepared.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
        f.revision,
      );
      expect(yield* f.fs.readFileString(f.path.join(prepared.worktreePath!, "code.txt"))).toBe(
        "source pushed\n",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live(
    "project moves carry branch preservation reports through a spoke-to-spoke handoff",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("diverged");
        const hub = yield* startThreadMachine("project-revision-hub", "cloud-server");
        const laptop = yield* startThreadMachine(
          "project-revision-source",
          "computer",
          undefined,
          undefined,
          true,
          undefined,
          false,
          { git: f.git },
        );
        const target = yield* startThreadMachine(
          "project-revision-target",
          "computer",
          undefined,
          undefined,
          true,
          undefined,
          false,
          { git: f.git },
        );
        yield* pair(hub, laptop);
        yield* pair(hub, target);
        for (const [machine, root] of [
          [laptop, f.source],
          [target, f.target],
        ] as const) {
          yield* machine.sql`INSERT INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
          VALUES (${projectId}, 'Racing', ${root}, 0, '[]', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
          yield* machine.sql`INSERT INTO project_labels(label_id, name, created_at, updated_at) VALUES ('label:racing', 'Racing', '2026-10-24T00:00:00.000Z', '2026-10-24T00:00:00.000Z')`;
          yield* machine.sql`INSERT INTO label_repositories(label_id, repository_id, remote) VALUES ('label:racing', ${projectId}, 'github.com/test/racing')`;
        }
        const event = threadCreated("event:project-revision", yield* DateTime.now);
        if (event.type !== "thread.created") throw new Error("Expected thread.created");
        yield* laptop.sink.write({
          events: [{ ...event, payload: { ...event.payload, branch, worktreePath: f.source } }],
        });
        yield* laptop.sql`INSERT INTO thread_project_labels(thread_id, label_id) VALUES (${threadId}, 'label:racing')`;
        yield* Option.getOrThrow(laptop.worker).drain();
        const result = yield* laptop.projectMove.move({
          id: ProjectLabelId.make("label:racing"),
          target: target.environmentId,
        });
        const moved: ThreadMoveResult = result.threads;
        expect(moved.moved).toEqual([threadId]);
        expect(moved.skipped).toEqual([]);
        expect(moved.branches?.[0]).toMatchObject({
          threadId,
          branch,
          revision: f.revision,
          action: "preserve",
        });
        const worktree = (yield* target.projections.getThreadProjection(threadId)).thread
          .worktreePath!;
        expect((yield* f.run(worktree, ["rev-parse", "HEAD"])).stdout.trim()).toBe(f.revision);
        expect(
          (yield* f.run(f.target, [
            "rev-parse",
            moved.branches![0]!.preservedBranch!,
          ])).stdout.trim(),
        ).toBe(f.previous);
        yield* Option.getOrThrow(target.worker).drain();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    30000,
  );
});
