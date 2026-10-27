// @effect-diagnostics nodeBuiltinImport:off - real Git and disk fixtures, never the owner's state.
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  NodeId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@cogenly/contracts";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import * as HostProcess from "@cogenly/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Config from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Inspection from "./housekeeping/StorageInspection.ts";
import * as ServerBackup from "./housekeeping/ServerBackup.ts";
import { liveThreadShell } from "./mcp/McpToolAccess.testkit.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as Projects from "./orchestration-v2/ProjectStore.ts";
import * as Projections from "./orchestration-v2/ProjectionStore.ts";
import * as Sessions from "./orchestration-v2/ProviderSessionManager.ts";
import * as Settings from "./serverSettings.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as Storage from "./storageCleanup.ts";
import * as Terminals from "./terminal/Manager.ts";
import * as Git from "./vcs/GitVcsDriver.ts";
import * as WorktreeLifecycle from "./workspace/WorktreeLifecycle.ts";
import * as GitWorkflow from "./git/GitWorkflowService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as Setup from "./project/ProjectSetupScriptRunner.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as CheckpointDiff from "./checkpointing/CheckpointDiffQuery.ts";
import * as VcsRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import { checkpointRefForScopeOrdinal } from "./orchestration-v2/CheckpointService.ts";

const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
const fixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cogenly-storage-"));
  roots.push(root);
  const repo = NodePath.join(root, "repo");
  const worktree = NodePath.join(root, "worktrees", "child");
  NodeFS.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  NodeFS.writeFileSync(
    NodePath.join(repo, ".gitignore"),
    "node_modules/\n.turbo/\ndist/\n.cogenly/\n.env\n",
  );
  NodeFS.writeFileSync(NodePath.join(repo, "file.txt"), "initial\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["worktree", "add", "-b", "child", worktree]);
  NodeFS.writeFileSync(NodePath.join(worktree, "file.txt"), "child commit\n");
  git(worktree, ["commit", "-am", "only on local child branch"]);
  return { root, repo, worktree };
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const infrastructure = (box: ReturnType<typeof fixture>) => {
  const config = Config.layerTest(box.repo, NodePath.join(box.root, "home")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const driver = Git.layer.pipe(Layer.provide(config), Layer.provide(NodeServices.layer));
  // Run the actual driver with a deterministic Git environment too.
  const isolatedDriver = Layer.unwrap(
    Effect.gen(function* () {
      const driverService = yield* Git.GitVcsDriver;
      return Layer.succeed(Git.GitVcsDriver, {
        ...driverService,
        execute: (input) => driverService.execute({ ...input, env: { ...gitEnv, ...input.env } }),
      });
    }),
  ).pipe(Layer.provide(driver));
  return Layer.mergeAll(config, isolatedDriver, NodeServices.layer);
};

describe("storage safety inspection", () => {
  it.effect.each(["tracked", "untracked", "stash", "ignored", "unpreserved-head"] as const)(
    "blocks %s changes",
    (kind) => {
      const box = fixture();
      if (kind === "tracked" || kind === "stash")
        NodeFS.writeFileSync(NodePath.join(box.worktree, "file.txt"), "unsaved\n");
      if (kind === "untracked")
        NodeFS.writeFileSync(NodePath.join(box.worktree, "new.txt"), "unsaved\n");
      if (kind === "stash") git(box.worktree, ["stash", "push"]);
      if (kind === "ignored")
        NodeFS.writeFileSync(NodePath.join(box.worktree, ".env"), "private\n");
      if (kind === "unpreserved-head") {
        git(box.worktree, ["checkout", "--detach"]);
        NodeFS.writeFileSync(NodePath.join(box.worktree, "file.txt"), "new commit\n");
        git(box.worktree, ["commit", "-am", "detached"]);
      }
      return Effect.gen(function* () {
        const inspect = yield* Inspection.StorageInspection;
        expect(yield* inspect.gitBlocker(box.worktree, "child")).not.toBeNull();
      }).pipe(Effect.provide(Inspection.layer.pipe(Layer.provide(infrastructure(box)))));
    },
  );

  it.effect(
    "accepts local-only commits on the retained branch and rebuildable ignored files",
    () => {
      const box = fixture();
      NodeFS.writeFileSync(NodePath.join(box.worktree, "file.txt"), "local commit\n");
      git(box.worktree, ["commit", "-am", "local only"]);
      NodeFS.mkdirSync(NodePath.join(box.worktree, ".cogenly"));
      NodeFS.writeFileSync(NodePath.join(box.worktree, ".cogenly", "state.sqlite"), "dev copy");
      return Effect.gen(function* () {
        const inspect = yield* Inspection.StorageInspection;
        expect(yield* inspect.gitBlocker(box.worktree, "child")).toBeNull();
        expect(yield* inspect.gitBlocker(box.worktree, "child", true)).not.toBeNull();
      }).pipe(Effect.provide(Inspection.layer.pipe(Layer.provide(infrastructure(box)))));
    },
  );

  it.effect(
    "blocks a real process in a nested cwd and permits removal after that process exits",
    () => {
      const box = fixture();
      const nested = NodePath.join(box.worktree, "dist");
      NodeFS.mkdirSync(nested);
      const processIds: string[] = [];
      // Linux runners cannot inspect unrelated system processes. This fixture
      // inventories only its own child, whose real cwd and exit are still checked.
      const processInventory = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          readDirectory: (directory) =>
            directory === "/proc" ? Effect.succeed(processIds) : fs.readDirectory(directory),
        })),
      );
      return Effect.gen(function* () {
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeChildProcess.spawn(
              process.execPath,
              ["-e", "process.stdout.write('ready');process.stdin.resume()"],
              { cwd: nested, stdio: "pipe" },
            ),
          ),
          (child) =>
            Effect.sync(() => {
              child.kill();
            }),
        );
        yield* Effect.callback<void>((resume) => {
          child.stdout!.once("data", () => resume(Effect.void));
        });
        processIds.push(String(child.pid));
        const inspect = yield* Inspection.StorageInspection;
        expect(yield* inspect.processBlocker(box.worktree)).toContain("cwd");
        yield* Effect.callback<void>((resume) => {
          child.once("exit", () => resume(Effect.void));
          child.stdin!.end();
        });
        expect(yield* inspect.processBlocker(box.worktree)).toBeNull();
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Inspection.layer.pipe(
            Layer.provide(processInventory),
            Layer.provide(infrastructure(box)),
          ),
        ),
      );
    },
  );

  it.effect("keeps worktrees when a Linux process cwd cannot be inspected", () => {
    const box = fixture();
    const processInventory = Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (fs) => ({
        ...fs,
        readDirectory: (directory) =>
          directory === "/proc" ? Effect.succeed(["123"]) : fs.readDirectory(directory),
        readLink: (path) =>
          path === "/proc/123/cwd"
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readLink",
                  pathOrDescriptor: path,
                }),
              )
            : fs.readLink(path),
      })),
    );
    return Effect.gen(function* () {
      const inspect = yield* Inspection.StorageInspection;
      expect(yield* inspect.processBlocker(box.worktree)).toBe(
        "process inventory could not be verified",
      );
    }).pipe(
      Effect.provide(
        Inspection.layer.pipe(Layer.provide(processInventory), Layer.provide(infrastructure(box))),
      ),
      Effect.provideService(HostProcess.Platform, "linux"),
    );
  });

  it.effect(
    "counts allocated hardlinks once, excludes external links from reclaimable bytes and skips symlinks",
    () => {
      const box = fixture();
      const directory = NodePath.join(box.root, "usage");
      NodeFS.mkdirSync(directory);
      NodeFS.writeFileSync(NodePath.join(directory, "one"), Buffer.alloc(8192, 1));
      NodeFS.linkSync(NodePath.join(directory, "one"), NodePath.join(directory, "two"));
      NodeFS.linkSync(NodePath.join(directory, "one"), NodePath.join(box.root, "external"));
      NodeFS.symlinkSync(box.repo, NodePath.join(directory, "link"));
      return Effect.gen(function* () {
        const inspect = yield* Inspection.StorageInspection;
        const [usage] = yield* inspect.measure([{ path: directory, category: "test" }]);
        expect(usage!.apparentBytes).toBe(8192);
        expect(usage!.bytes - usage!.exclusiveBytes).toBe(
          NodeFS.statSync(NodePath.join(directory, "one")).blocks * 512,
        );
      }).pipe(Effect.provide(Inspection.layer.pipe(Layer.provide(infrastructure(box)))));
    },
  );
});

const makeStorage = (box: ReturnType<typeof fixture>) =>
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("CREATE TABLE projection_projects(project_id TEXT, workspace_root TEXT)");
    yield* sql.unsafe(
      "CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, project_id TEXT, deleted_at TEXT, payload_json TEXT)",
    );
    yield* sql.unsafe(
      "CREATE TABLE orchestration_v2_projection_subagents(child_thread_id TEXT, origin TEXT, status TEXT)",
    );
    yield* sql.unsafe(
      "CREATE TABLE orchestration_v2_projection_provider_sessions(status TEXT, payload_json TEXT)",
    );
    yield* sql.unsafe("CREATE TABLE orchestration_v2_effect_outbox(thread_id TEXT, status TEXT)");
    const base = liveThreadShell(ThreadId.make("child"), { activeRunId: null });
    const parent = { ...liveThreadShell(ThreadId.make("parent")), worktreePath: null };
    const state = {
      thread: {
        ...base,
        worktreePath: box.worktree,
        branch: "child",
        status: "completed",
        createdBy: "agent",
        lineage: {
          rootThreadId: parent.id,
          parentThreadId: parent.id,
          relationshipToParent: "subagent",
        },
      } as OrchestrationV2ThreadShell,
      process: null as string | null,
      sessionLive: false,
      historyUnavailable: false,
    };
    const save = () =>
      sql`DELETE FROM orchestration_v2_projection_threads`.pipe(
        Effect.andThen(
          sql`INSERT INTO orchestration_v2_projection_threads VALUES (${state.thread.id}, ${state.thread.projectId}, NULL, ${JSON.stringify({ worktreePath: state.thread.worktreePath, createdBy: state.thread.createdBy, lineage: state.thread.lineage })})`,
        ),
      );
    yield* save();
    yield* sql`INSERT INTO projection_projects VALUES (${state.thread.projectId}, ${box.repo})`;
    yield* sql`INSERT INTO orchestration_v2_projection_subagents VALUES (${state.thread.id}, 'app_owned', 'completed')`;
    const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    const removed = yield* Deferred.make<void>();
    const project = {
      id: state.thread.projectId,
      title: "Storage",
      workspaceRoot: box.repo,
      repositoryIdentity: null,
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      faviconPath: null,
      projectIcon: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const inspection = yield* Inspection.StorageInspection;
    const settingsLayer = Settings.layerTest({
      storageCleanup: { worktreeSettledAfterDays: 7 },
      worktreesDirectory: NodePath.dirname(box.worktree),
      automaticBackups: { enabled: false, retentionCount: 2 },
    });
    const dependencies = Layer.mergeAll(
      settingsLayer,
      ServerBackup.layer.pipe(Layer.provide(settingsLayer)),
      Layer.succeed(Inspection.StorageInspection, {
        ...inspection,
        processBlocker: () => Effect.succeed(state.process),
      }),

      Layer.mock(Projects.ProjectStoreV2)({
        listShells: () => Effect.succeed([project]),
        list: () => Effect.succeed([{ ...project, projectId: project.id, deletedAt: null }]),
      }),
      Layer.mock(Projections.ProjectionStoreV2)({
        // A cleanup inventory must use bounded per-owner reads, including archived owners.
        getThreadShell: (id) => {
          if (state.historyUnavailable) return Effect.die("history unavailable");
          return Effect.succeed(id === state.thread.id ? state.thread : parent);
        },
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromPubSub(events) }),
      Layer.mock(Sessions.ProviderSessionManagerV2)({
        isLive: () => Effect.succeed(state.sessionLive),
      }),
      Layer.mock(GitManager.GitManager)({
        invalidateStatus: () => Deferred.succeed(removed, undefined).pipe(Effect.asVoid),
      }),
      Layer.mock(Terminals.TerminalManager)({
        subscribeMetadata: () => Effect.succeed(() => undefined),
      }),
    );
    return {
      box,
      state,
      save,
      sql,
      events,
      removed,
      config,
      layer: Storage.layer.pipe(Layer.provideMerge(dependencies)),
    };
  });
const runStorageTest = <A, E>(
  body: (
    fixture: Effect.Success<ReturnType<typeof makeStorage>>,
  ) => Effect.Effect<A, E, Storage.StorageCleanup | Settings.ServerSettingsService | Scope.Scope>,
) => {
  const box = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(1_800_000_000_000);
    const test = yield* makeStorage(box);
    return yield* body(test).pipe(Effect.provide(test.layer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Inspection.layer.pipe(Layer.provideMerge(infrastructure(box))),
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
    Effect.scoped,
  );
};

describe("storage cleanup lifecycle", () => {
  it.effect(
    "previews terminal-task removal without changing the worktree or publishing a cleanup report",
    () =>
      runStorageTest((test) =>
        Effect.gen(function* () {
          const storage = yield* Storage.StorageCleanup;
          const preview = yield* storage.preview;
          expect(preview.dryRun).toBe(true);
          expect(
            preview.entries.find((entry) => entry.threadId === test.state.thread.id)?.outcome,
          ).toBe("removed");
          expect(NodeFS.existsSync(test.state.thread.worktreePath!)).toBe(true);
          expect(yield* storage.latestReport).toBeNull();
        }),
      ).pipe(Effect.provideService(ServerActivation, Effect.never)),
  );

  it.effect(
    "automatically removes terminal child worktrees and keeps local commits on their branch",
    () =>
      runStorageTest((test) =>
        Effect.gen(function* () {
          const storage = yield* Storage.StorageCleanup;
          yield* Deferred.await(test.removed);
          yield* storage.drain;
          expect(NodeFS.existsSync(test.state.thread.worktreePath!)).toBe(false);
          expect(git(test.config.cwd, ["show-ref", "refs/heads/child"])).toContain(
            "refs/heads/child",
          );
          expect(git(test.config.cwd, ["show", "child:file.txt"])).toBe("child commit");
        }),
      ),
  );

  it.effect("a terminal delegated-task event triggers automatic cleanup", () =>
    runStorageTest((test) =>
      Effect.gen(function* () {
        const storage = yield* Storage.StorageCleanup;
        // The startup pass has already completed; recreate an idle checkout and
        // deliver the terminal event, without relying on the hourly timer.
        yield* Deferred.await(test.removed);
        yield* storage.drain;
        git(test.box.repo, ["worktree", "add", test.box.worktree, "child"]);
        const completed = yield* Deferred.make<void>();
        const subscribed = yield* Deferred.make<void>();
        yield* storage.reports.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.filter(
            (report) =>
              report !== null && report.entries.some((entry) => entry.outcome === "removed"),
          ),
          Stream.drop(1),
          Stream.take(1),
          Stream.runForEach(() => Deferred.succeed(completed, undefined)),
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        const at = yield* DateTime.now;
        yield* PubSub.publish(test.events, {
          id: EventId.make("task-done"),
          type: "subagent.updated",
          threadId: ThreadId.make("parent"),
          occurredAt: at,
          payload: {
            id: NodeId.make("task"),
            threadId: ThreadId.make("parent"),
            runId: null,
            parentNodeId: NodeId.make("root"),
            origin: "app_owned",
            createdBy: "agent",
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: test.state.thread.providerInstanceId!,
            providerThreadId: null,
            childThreadId: test.state.thread.id,
            nativeTaskRef: null,
            prompt: "task",
            title: null,
            model: null,
            status: "completed",
            result: "done",
            startedAt: at,
            completedAt: at,
            updatedAt: at,
          },
        });
        yield* Deferred.await(completed);
        yield* storage.drain;
        expect(NodeFS.existsSync(test.box.worktree)).toBe(false);
      }),
    ),
  );

  it.effect.each([
    "process",
    "live-session",
    "live-thread",
    "shared-thread",
    "pending-effect",
  ] as const)("keeps a checkout blocked by %s", (blocker) =>
    runStorageTest((test) =>
      Effect.gen(function* () {
        if (blocker === "process") test.state.process = "process has its cwd inside the worktree";
        if (blocker === "live-thread")
          test.state.thread = {
            ...test.state.thread,
            activeRunId: liveThreadShell(ThreadId.make("other")).activeRunId,
            status: "running",
          };
        if (blocker === "shared-thread")
          yield* test.sql`INSERT INTO orchestration_v2_projection_threads VALUES ('other', ${test.state.thread.projectId}, NULL, ${JSON.stringify({ worktreePath: test.state.thread.worktreePath })})`;
        if (blocker === "pending-effect")
          yield* test.sql`INSERT INTO orchestration_v2_effect_outbox VALUES (${test.state.thread.id}, 'pending')`;
        if (blocker === "live-session") {
          test.state.sessionLive = true;
          yield* test.sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('ready', ${JSON.stringify({ id: "session:storage", cwd: test.box.worktree })})`;
        }
        const storage = yield* Storage.StorageCleanup;
        const report = yield* storage.runNow;
        expect(
          report.entries.find((entry) => entry.threadId === test.state.thread.id)?.outcome,
        ).toBe("kept");
        expect(NodeFS.existsSync(test.state.thread.worktreePath!)).toBe(true);
      }),
    ).pipe(Effect.provideService(ServerActivation, Effect.never)),
  );

  it.effect("storage classification works without hydrating unrelated chat history", () =>
    runStorageTest((test) =>
      Effect.gen(function* () {
        test.state.historyUnavailable = true;
        const storage = yield* Storage.StorageCleanup;
        const archived = { ...test.state.thread, archivedAt: "2026-01-01T00:00:00.000Z" };
        yield* test.sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${JSON.stringify(archived)}`;
        const report = yield* storage.status;
        expect(report.complete).toBe(true);
        expect(
          report.categories.find((entry) => entry.category === "agent-worktrees")?.files,
        ).toBeGreaterThan(0);
        yield* test.sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-01-02T00:00:00.000Z'`;
        const deleted = yield* storage.status;
        expect(
          deleted.categories.find((entry) => entry.category === "agent-worktrees")?.files ?? 0,
        ).toBe(0);
      }),
    ).pipe(Effect.provideService(ServerActivation, Effect.never)),
  );

  it.effect(
    "reports unsaved agent worktrees and measures dependencies and dev data separately",
    () =>
      runStorageTest((test) =>
        Effect.gen(function* () {
          NodeFS.writeFileSync(NodePath.join(test.box.worktree, "file.txt"), "unsaved\n");
          for (const name of ["node_modules", ".cogenly"]) {
            NodeFS.mkdirSync(NodePath.join(test.box.worktree, name));
            NodeFS.writeFileSync(
              NodePath.join(test.box.worktree, name, "data"),
              Buffer.alloc(8192, 1),
            );
          }
          const storage = yield* Storage.StorageCleanup;
          const report = yield* storage.runNow;
          expect(report.unsavedAgentWorktrees).toBe(1);
          const status = yield* storage.status;
          expect(status.complete).toBe(true);
          expect(status.volumes.length).toBeGreaterThan(0);
          expect(status.volumes[0]!.availableBytes).toBeGreaterThan(0);
          if (status.volumes.some((volume) => volume.sharedBlocksMayExist)) {
            expect(status.categories.every((category) => category.bytes === null)).toBe(true);
            expect(report.spaceMeasurement).toBe("volume-change");
            expect(report.entries.every((entry) => entry.bytes === null)).toBe(true);
          }
          expect(
            status.categories.find((entry) => entry.category === "agent-worktrees")?.files,
          ).toBeGreaterThan(0);
          expect(
            status.categories.find((entry) => entry.category === "dependencies")?.files,
          ).toBeGreaterThan(0);
          expect(
            status.categories.find((entry) => entry.category === "dev-data")?.files,
          ).toBeGreaterThan(0);
        }),
      ).pipe(Effect.provideService(ServerActivation, Effect.never)),
  );

  it.effect.each(["settled", "archived", "active"] as const)(
    "applies retention to %s Work threads",
    (location) =>
      runStorageTest((test) =>
        Effect.gen(function* () {
          test.state.thread = {
            ...test.state.thread,
            lineage: {
              rootThreadId: test.state.thread.id,
              parentThreadId: null,
              relationshipToParent: null,
            },
            settledAt: location === "settled" ? DateTime.makeUnsafe("2025-01-01") : null,
            archivedAt: location === "archived" ? DateTime.makeUnsafe("2025-01-01") : null,
          };
          const storage = yield* Storage.StorageCleanup;
          const report = yield* storage.runNow;
          expect(
            report.entries.find((entry) => entry.threadId === test.state.thread.id)?.outcome,
          ).toBe(location === "active" ? "kept" : "removed");
        }),
      ).pipe(Effect.provideService(ServerActivation, Effect.never)),
  );

  it.effect("previews file retention and keeps current logs and recent captures", () =>
    runStorageTest((test) =>
      Effect.gen(function* () {
        const old = 1_577_836_800;
        const capture = NodePath.join(test.config.browserArtifactsDir, "old.png");
        const log = NodePath.join(test.config.logsDir, "server.log.1");
        const current = NodePath.join(test.config.logsDir, "server.log");
        const recent = NodePath.join(test.config.browserArtifactsDir, "recent.png");
        NodeFS.mkdirSync(test.config.browserArtifactsDir, { recursive: true });
        NodeFS.mkdirSync(test.config.logsDir, { recursive: true });
        for (const target of [capture, log, current, recent]) NodeFS.writeFileSync(target, "data");
        for (const target of [capture, log, current]) NodeFS.utimesSync(target, old, old);
        NodeFS.utimesSync(recent, 1_800_000_000, 1_800_000_000);
        const storage = yield* Storage.StorageCleanup;
        yield* storage.preview;
        expect(NodeFS.existsSync(capture)).toBe(true);
        yield* storage.runNow;
        expect(NodeFS.existsSync(capture)).toBe(false);
        expect(NodeFS.existsSync(log)).toBe(false);
        expect(NodeFS.existsSync(current)).toBe(true);
        expect(NodeFS.existsSync(recent)).toBe(true);
      }),
    ).pipe(Effect.provideService(ServerActivation, Effect.never)),
  );

  it.effect(
    "dependency pruning is opt-in, previews without deleting, and marks the next turn for setup",
    () =>
      runStorageTest((test) =>
        Effect.gen(function* () {
          test.state.thread = {
            ...test.state.thread,
            lineage: {
              rootThreadId: test.state.thread.id,
              parentThreadId: null,
              relationshipToParent: null,
            },
          };
          for (const name of ["node_modules", ".turbo", "dist"]) {
            NodeFS.mkdirSync(NodePath.join(test.box.worktree, name));
            NodeFS.writeFileSync(NodePath.join(test.box.worktree, name, "rebuildable"), "data");
          }
          const storage = yield* Storage.StorageCleanup;
          yield* storage.runNow;
          expect(NodeFS.existsSync(NodePath.join(test.box.worktree, "node_modules"))).toBe(true);
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.updateSettings({ storageCleanup: { dependenciesAfterDays: 1 } });
          const preview = yield* storage.preview;
          expect(
            preview.entries.filter(
              (entry) => entry.kind === "dependencies" && entry.outcome === "removed",
            ),
          ).toHaveLength(3);
          expect(NodeFS.existsSync(NodePath.join(test.box.worktree, "node_modules"))).toBe(true);
          yield* storage.runNow;
          expect(NodeFS.existsSync(test.box.worktree)).toBe(true);
          expect(NodeFS.existsSync(NodePath.join(test.box.worktree, "node_modules"))).toBe(false);
          const marker = NodePath.resolve(
            test.box.worktree,
            git(test.box.worktree, ["rev-parse", "--git-path", "cogenly-dependencies-pruned"]),
          );
          expect(NodeFS.existsSync(marker)).toBe(true);
        }),
      ).pipe(Effect.provideService(ServerActivation, Effect.never)),
  );
  it.effect("backup cleanup previews safely and keeps the newest two complete snapshots", () =>
    runStorageTest((test) =>
      Effect.gen(function* () {
        const root = NodePath.join(test.config.baseDir, "backups");
        const names = [
          "2024-01-01T00-00-00.000Z",
          "2024-01-02T00-00-00.000Z",
          "2024-01-03T00-00-00.000Z",
        ];
        for (const name of names) {
          NodeFS.mkdirSync(NodePath.join(root, name), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(root, name, "statev2.sqlite"), "snapshot");
        }
        const outside = NodePath.join(test.box.root, "protected");
        NodeFS.mkdirSync(outside);
        NodeFS.writeFileSync(NodePath.join(outside, "statev2.sqlite"), "keep");
        NodeFS.symlinkSync(outside, NodePath.join(root, "2023-01-01T00-00-00.000Z"));
        const storage = yield* Storage.StorageCleanup;
        const preview = yield* storage.preview;
        expect(
          preview.entries.filter(
            (entry) => entry.kind === "backups" && entry.outcome === "removed",
          ),
        ).toHaveLength(1);
        expect(NodeFS.existsSync(NodePath.join(root, names[0]!))).toBe(true);
        const report = yield* storage.runNow;
        expect(report.spaceMeasurement).toBe("volume-change");
        expect(NodeFS.existsSync(NodePath.join(root, names[0]!))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(root, names[1]!))).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(root, names[2]!))).toBe(true);
        expect(NodeFS.existsSync(NodePath.join(outside, "statev2.sqlite"))).toBe(true);
      }),
    ).pipe(Effect.provideService(ServerActivation, Effect.never)),
  );
});

describe("worktree reuse and checkpoints", () => {
  it.effect("recreates a removed child's branch and reruns setup after dependency pruning", () => {
    const box = fixture();
    const commit = git(box.worktree, ["rev-parse", "HEAD"]);
    git(box.repo, ["worktree", "remove", box.worktree]);
    let setups = 0;
    return Effect.gen(function* () {
      const driver = yield* Git.GitVcsDriver;
      const lifecycle = WorktreeLifecycle.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(GitWorkflow.GitWorkflowService)({
              createWorktree: (input) => driver.createWorktree(input),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () => Effect.succeed(Option.some({ workspaceRoot: box.repo } as never)),
            }),
            Layer.mock(Setup.ProjectSetupScriptRunner)({
              runForThread: () =>
                withWorkspaceLease(
                  NodePath.resolve(box.worktree),
                  Effect.sync(() => {
                    setups++;
                    return { status: "no-script" as const };
                  }),
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const worktrees = yield* WorktreeLifecycle.WorktreeLifecycle;
        const input = {
          threadId: ThreadId.make("child"),
          projectId: liveThreadShell(ThreadId.make("child")).projectId,
          worktreePath: box.worktree,
          branch: "child",
        };
        yield* worktrees.prepare(input);
        expect(git(box.worktree, ["rev-parse", "HEAD"])).toBe(commit);
        expect(NodeFS.readFileSync(NodePath.join(box.worktree, "file.txt"), "utf8")).toBe(
          "child commit\n",
        );
        expect(setups).toBe(1);
        const marker = NodePath.resolve(
          box.worktree,
          git(box.worktree, ["rev-parse", "--git-path", "cogenly-dependencies-pruned"]),
        );
        NodeFS.writeFileSync(marker, "pruned");
        yield* worktrees.prepare(input);
        expect(setups).toBe(2);
        expect(NodeFS.existsSync(marker)).toBe(false);
      }).pipe(Effect.provide(lifecycle));
    }).pipe(Effect.provide(infrastructure(box)));
  });

  it.effect("checkpoint diffs survive worktree removal and the retained ref restores files", () => {
    const box = fixture();
    const scopeId = CheckpointScopeId.make("scope:storage");
    const threadId = ThreadId.make("child");
    const runId = RunId.make("run:storage");
    const storeLayer = CheckpointStore.layer.pipe(
      Layer.provide(VcsRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
    );
    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointStore.CheckpointStore;
      const baseline = yield* checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 0 });
      const final = CheckpointRef.make("refs/t3/checkpoints/storage-final");
      yield* checkpoints.captureCheckpoint({ cwd: box.worktree, checkpointRef: baseline });
      NodeFS.writeFileSync(NodePath.join(box.worktree, "file.txt"), "checkpoint contents\n");
      yield* checkpoints.captureCheckpoint({ cwd: box.worktree, checkpointRef: final });
      git(box.worktree, ["checkout", "--", "file.txt"]);
      git(box.repo, ["worktree", "remove", box.worktree]);
      const diffLayer = CheckpointDiff.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCheckpointContext: () =>
              Effect.succeed({
                repositoryCwd: box.repo,
                runs: [{ id: runId, ordinal: 1, status: "completed" }],
                checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd: box.worktree }],
                checkpoints: [{ scopeId, runId, appRunOrdinal: 1, status: "ready", ref: final }],
              }),
          }),
        ),
      );
      const diff = yield* CheckpointDiff.CheckpointDiffQuery.pipe(
        Effect.flatMap((query) =>
          query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 }),
        ),
        Effect.provide(diffLayer),
      );
      expect(diff.diff).toContain("+checkpoint contents");
      git(box.repo, ["worktree", "add", box.worktree, "child"]);
      yield* checkpoints.restoreCheckpoint({ cwd: box.worktree, checkpointRef: final });
      expect(NodeFS.readFileSync(NodePath.join(box.worktree, "file.txt"), "utf8")).toBe(
        "checkpoint contents\n",
      );
    }).pipe(Effect.provide(storeLayer.pipe(Layer.provideMerge(infrastructure(box)))));
  });
});
