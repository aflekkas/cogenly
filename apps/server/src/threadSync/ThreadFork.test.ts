import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import { forkCheckout, forkSource } from "../git/forkRepository.ts";
import { pair } from "../machines/testkit.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { startThreadMachine } from "./testkit.ts";

const sourceId = ThreadId.make("thread:source");
const sourceProject = ProjectId.make("repo:source");
const targetProject = ProjectId.make("repo:target");
const remote = "github.com/test/machine-fork";
const url = `https://${remote}.git`;
const at = "2026-10-24T00:00:00.000Z";
const providers = [
  Schema.decodeUnknownSync(ServerProvider)({
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: at,
    models: [
      { slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null, isDefault: true },
    ],
  }),
];
const layer = Git.layer.pipe(
  Layer.provideMerge(Config.layerTest("/tmp", { prefix: "machine-fork" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Real repositories behind a portable remote; URL rewriting keeps every fetch local. */
const setup = Effect.fn("test.machineFork")(function* (name: string, cloned = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* Git.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped();
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  const bare = path.join(root, "remote.git");
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    driver.execute({ cwd, args, operation: "fork-test" });
  yield* git(root, ["init", "--bare", "--initial-branch=main", bare]);
  const clone = (cwd: string) =>
    Effect.gen(function* () {
      yield* git(root, ["-c", `url.${bare}.insteadOf=${url}`, "clone", url, cwd]);
      yield* git(cwd, ["config", `url.${bare}.insteadOf`, url]);
      return cwd;
    }).pipe(Effect.orDie);
  yield* clone(sourceRoot);
  yield* fs.writeFileString(path.join(sourceRoot, "code.txt"), "pushed code");
  yield* git(sourceRoot, ["add", "."]);
  const commit = (cwd: string, message: string) =>
    git(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ]);
  yield* commit(sourceRoot, "initial");
  yield* git(sourceRoot, ["push", "-u", "origin", "main"]);
  yield* git(sourceRoot, ["checkout", "-b", "feature/fork"]);
  yield* commit(sourceRoot, "feature");
  yield* git(sourceRoot, ["push", "-u", "origin", "feature/fork"]);
  const pushed = (yield* git(sourceRoot, ["rev-parse", "HEAD"])).stdout.trim();
  if (cloned) yield* clone(targetRoot);
  const options = {
    git: {
      forkSource: (input: Parameters<typeof forkSource>[0]) =>
        forkSource(input).pipe(Effect.provideService(Git.GitVcsDriver, driver)),
      forkCheckout: (input: Parameters<typeof forkCheckout>[0]) =>
        forkCheckout(input).pipe(Effect.provideService(Git.GitVcsDriver, driver)),
    },
    providers,
    clone: () => clone(targetRoot),
  };
  const source = yield* startThreadMachine(
    `${name}-source`,
    "cloud-server",
    undefined,
    undefined,
    true,
    options,
  );
  const target = yield* startThreadMachine(
    `${name}-target`,
    "computer",
    undefined,
    undefined,
    true,
    options,
  );
  yield* pair(source, target);
  for (const [machine, projectId, cwd] of [
    [source, sourceProject, sourceRoot],
    [target, targetProject, targetRoot],
  ] as const) {
    yield* machine.sql`INSERT INTO project_labels(label_id, name, created_at, updated_at) VALUES ('label:project', 'Project', ${at}, ${at})`;
    if (machine === source || cloned)
      yield* machine.sql`INSERT INTO projection_projects(project_id, title, workspace_root, auto_pull, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Repository', ${cwd}, 0, '[]', ${at}, ${at})`;
    yield* machine.sql`INSERT INTO label_repositories(label_id, repository_id, remote)
      VALUES ('label:project', ${machine === source || cloned ? projectId : `remote:${remote}`}, ${remote})`;
  }
  const engine = Option.getOrThrow(source.engine);
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("source:create"),
    threadId: sourceId,
    projectId: sourceProject,
    title: "Source conversation",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/fork",
    worktreePath: sourceRoot,
    createdBy: "user",
    creationSource: "web",
  });
  yield* source.sql`INSERT INTO thread_project_labels(thread_id, label_id) VALUES (${sourceId}, 'label:project')`;
  yield* engine.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("source:message"),
    threadId: sourceId,
    messageId: MessageId.make("source:message"),
    text: "Keep this conversation context",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const projection = yield* source.projections.getThreadProjection(sourceId);
  const now = yield* DateTime.now;
  yield* source.sink.write({
    events: [
      {
        id: EventId.make("source:native"),
        type: "provider-thread.updated",
        threadId: sourceId,
        occurredAt: now,
        payload: {
          ...projection.providerThreads[0]!,
          nativeThreadRef: {
            driver: providers[0]!.driver,
            nativeId: "source-native-session",
            strength: "strong",
          },
        },
      },
      {
        id: EventId.make("source:finished"),
        type: "run.updated",
        threadId: sourceId,
        occurredAt: now,
        payload: { ...projection.runs[0]!, status: "completed", completedAt: now },
      },
    ],
  });
  const input = {
    commandId: CommandId.make("fork:request"),
    sourceThreadId: sourceId,
    targetThreadId: ThreadId.make("thread:fork"),
    machine: target.environmentId,
  };
  return { source, target, sourceRoot, targetRoot, input, pushed, fs, path, git, commit, options };
});

describe("forking a conversation to another machine", () => {
  it.live.each([
    { cloned: false, name: "clones the same repository on the target" },
    { cloned: true, name: "resolves the same remote to the target's checkout" },
  ])(
    "$name",
    ({ cloned }) =>
      Effect.gen(function* () {
        const { source, target, sourceRoot, input, pushed, git } = yield* setup(
          `fork-${cloned}`,
          cloned,
        );
        const before = yield* source.projections.getThreadProjection(sourceId);
        const eventsBefore =
          yield* source.sql`SELECT event_id FROM orchestration_events WHERE stream_id = ${sourceId}`;
        const result = yield* source.forks!.fork(input);
        expect(result).toMatchObject({
          targetThreadId: input.targetThreadId,
          branch: "feature/fork",
          commit: pushed,
          usedLastPushed: false,
        });
        yield* target.preparationFinished;
        const fork = yield* target.projections.getThreadProjection(input.targetThreadId);
        expect(fork.thread.projectId).toBe(cloned ? targetProject : `project:clone:${remote}`);
        expect(fork.thread.lineage).toMatchObject({
          parentThreadId: sourceId,
          relationshipToParent: "fork",
        });
        expect(fork.thread.branch).toBe("feature/fork");
        expect(fork.thread.worktreePath).not.toBe(sourceRoot);
        expect((yield* git(fork.thread.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
          pushed,
        );
        expect(target.checkouts).toEqual(cloned ? [] : [{ labelId: "label:project", remote }]);
        expect(yield* source.replication.owner(input.targetThreadId)).toMatchObject({
          local: false,
          owner: target.environmentId,
        });
        expect(yield* source.replication.owner(sourceId)).toBeUndefined();
        const after = yield* source.projections.getThreadProjection(sourceId);
        // Outgoing context transfers are also listed on the source; its own state and history stay intact.
        expect({ ...after, contextTransfers: [] }).toEqual(before);
        expect(
          yield* source.sql`SELECT event_id FROM orchestration_events WHERE stream_id = ${sourceId}`,
        ).toEqual(eventsBefore);
        // The replica can route retries to the source owner; all requests identify the same fork.
        const retried = yield* target.forks!.fork(input);
        expect(retried).toMatchObject({ ...result, sequence: expect.any(Number) });
        expect(
          (yield* target.sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${input.targetThreadId}`)
            .length,
        ).toBe(1);
        expect(fork.contextTransfers).toHaveLength(1);
        expect(
          (yield* target.sql`SELECT event_id FROM orchestration_events WHERE stream_id = ${input.targetThreadId} AND event_type = 'thread.created'`)
            .length,
        ).toBe(1);
        expect(fork.thread.activeProviderThreadId).toBeNull();
        // The first turn consumes portable context, never a source provider session.
        yield* Option.getOrThrow(target.engine).dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("fork:continue"),
          threadId: input.targetThreadId,
          messageId: MessageId.make("fork:continue"),
          text: "Continue",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const continued = yield* target.projections.getThreadProjection(input.targetThreadId);
        expect(
          continued.contextHandoffs.some((handoff) =>
            handoff.summaryText.includes("Keep this conversation context"),
          ),
        ).toBe(true);
        expect(continued.contextTransfers[0]?.resolution?.strategy).toBe("portable_context");
        yield* Option.getOrThrow(target.worker).drain();
        expect(target.provider.turns).toHaveLength(1);
        expect(target.provider.turns[0]?.providerThread.nativeThreadRef?.nativeId).not.toBe(
          "source-native-session",
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
    30000,
  );

  it.live.each(["commits", "files", "both"])(
    "requires an explicit choice for local %s, preserving work on the source",
    (changes) =>
      Effect.gen(function* () {
        const { source, target, sourceRoot, input, pushed, fs, path, git, commit } = yield* setup(
          `fork-local-${changes}`,
        );
        if (changes !== "files") yield* commit(sourceRoot, "unpushed");
        const localHead = (yield* git(sourceRoot, ["rev-parse", "HEAD"])).stdout;
        if (changes !== "commits")
          yield* fs.writeFileString(path.join(sourceRoot, "code.txt"), "uncommitted work");
        const before = yield* source.projections.getThreadProjection(sourceId);
        const refused = yield* Effect.flip(source.forks!.fork(input));
        expect(refused.reason).toBe("local-changes");
        if (changes !== "commits") expect(refused.message).toContain("uncommitted changes");
        if (changes !== "files") expect(refused.message).toContain("unpushed commits");
        expect(target.checkouts).toEqual([]);
        expect(
          Option.isNone(
            yield* Effect.option(target.projections.getThreadProjection(input.targetThreadId)),
          ),
        ).toBe(true);
        const accepted = yield* source.forks!.fork({ ...input, allowLastPushed: true });
        expect(accepted).toMatchObject({ commit: pushed, usedLastPushed: true });
        expect(yield* source.forks!.fork(input)).toMatchObject({
          ...accepted,
          sequence: expect.any(Number),
        });
        expect((yield* git(sourceRoot, ["rev-parse", "HEAD"])).stdout).toBe(localHead);
        expect(yield* fs.readFileString(path.join(sourceRoot, "code.txt"))).toBe(
          changes === "commits" ? "pushed code" : "uncommitted work",
        );
        yield* target.preparationFinished;
        const fork = yield* target.projections.getThreadProjection(input.targetThreadId);
        expect((yield* git(fork.thread.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
          pushed,
        );
        expect(yield* fs.readFileString(path.join(fork.thread.worktreePath!, "code.txt"))).toBe(
          "pushed code",
        );
        const after = yield* source.projections.getThreadProjection(sourceId);
        // Outgoing context transfers are also listed on the source; its own state and history stay intact.
        expect({ ...after, contextTransfers: [] }).toEqual(before);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    30000,
  );

  it.live(
    "matches remote identity across remote names and reuses an exact clean checkout",
    () =>
      Effect.gen(function* () {
        const { source, target, sourceRoot, targetRoot, input, pushed, git, fs } = yield* setup(
          "fork-remotes",
          true,
        );
        yield* git(sourceRoot, ["remote", "rename", "origin", "upstream"]);
        yield* git(sourceRoot, ["branch", "--unset-upstream"]);
        yield* git(targetRoot, ["remote", "rename", "origin", "central"]);
        yield* git(targetRoot, ["checkout", "feature/fork"]);
        const result = yield* source.forks!.fork(input);
        expect(result).toMatchObject({ commit: pushed, usedLastPushed: false });
        yield* target.preparationFinished;
        const fork = yield* target.projections.getThreadProjection(input.targetThreadId);
        expect(fork.thread.worktreePath).toBe(yield* fs.realPath(targetRoot));
        expect((yield* git(targetRoot, ["symbolic-ref", "--short", "HEAD"])).stdout.trim()).toBe(
          "feature/fork",
        );
      }).pipe(Effect.scoped, Effect.provide(layer)),
    30000,
  );

  it.live.each([
    { dirty: false, name: "refuses a conflicting target branch without resetting commits" },
    { dirty: true, name: "refuses uncommitted target edits without replacing files" },
  ])(
    "$name",
    ({ dirty }) =>
      Effect.gen(function* () {
        const { source, target, targetRoot, input, fs, path, git, commit } = yield* setup(
          `fork-conflict-${dirty}`,
          true,
        );
        yield* git(targetRoot, ["checkout", "feature/fork"]);
        if (dirty) yield* fs.writeFileString(path.join(targetRoot, "code.txt"), "target edits");
        else yield* commit(targetRoot, "target commit");
        const head = (yield* git(targetRoot, ["rev-parse", "HEAD"])).stdout;
        const status = (yield* git(targetRoot, ["status", "--porcelain"])).stdout;
        const error = yield* Effect.flip(source.forks!.fork(input));
        expect(error.message).toContain("no target files were replaced");
        expect((yield* git(targetRoot, ["rev-parse", "HEAD"])).stdout).toBe(head);
        expect((yield* git(targetRoot, ["status", "--porcelain"])).stdout).toBe(status);
        expect(
          Option.isNone(
            yield* Effect.option(target.projections.getThreadProjection(input.targetThreadId)),
          ),
        ).toBe(true);
        expect(yield* source.replication.owner(sourceId)).toBeUndefined();
      }).pipe(Effect.scoped, Effect.provide(layer)),
    30000,
  );
});
