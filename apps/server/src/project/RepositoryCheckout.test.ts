// @effect-diagnostics nodeBuiltinImport:off - tests run real git against temp folders on disk.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  SourceControlProviderKind,
  isRemoteRepositoryPlaceholder,
  SourceControlRepositoryError,
} from "@cogenly/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { layerIdentity as layerSharedIdentity } from "../sync/testkit.ts";
import * as ProjectLabelFolders from "../projectLabels/ProjectLabelFolders.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryCheckout from "./RepositoryCheckout.ts";

const projectId = ProjectId.make("project:smile-express");

// No user or system git config: hooks, templates and signing stay out of the tests.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], { cwd, stdio: "pipe", env: gitEnv });

/** A local bare repository holding one committed file, used as the remote. */
function makeBareRemote(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "repository-checkout-"));
  const seed = NodePath.join(root, "seed");
  NodeFS.mkdirSync(seed);
  git(seed, ["init", "--initial-branch=main"]);
  NodeFS.writeFileSync(NodePath.join(seed, "README.md"), "hello\n");
  git(seed, ["add", "."]);
  git(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  // Named like the repository, so its derived folder is `smile-express`.
  const bare = NodePath.join(root, "smile-express.git");
  git(root, ["init", "--bare", "--initial-branch=main", bare]);
  git(seed, ["push", bare, "main"]);
  return bare;
}

/** The driver's `execute`, running real git with the test config. */
const gitDriver = Layer.mock(GitVcsDriver.GitVcsDriver)({
  execute: (input) =>
    Effect.sync(() => {
      const result = NodeChildProcess.spawnSync("git", [...input.args], {
        cwd: input.cwd,
        env: gitEnv,
        encoding: "utf8",
      });
      return {
        exitCode: (result.status ?? 1) as never,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }),
});
// Unused by these flows beyond the run guard; a broken database is a test bug.
const memoryDatabase = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer), Layer.orDie);

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

/** The tracker's source control, cloning with real git and counting clones in `box`. */
const gitRepositories = (box: Pick<Box, "cloneCalls" | "onPrepareClone" | "onClone">) =>
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
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
            { stdio: "pipe", env: gitEnv },
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

function harness(box: Box) {
  const clones = ProjectCloneTracker.layer.pipe(Layer.provide(gitRepositories(box)));
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
        Layer.mock(ProjectLabelFolders.ProjectLabelFolders)({}),
        gitDriver,
        memoryDatabase,
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
        Layer.mock(ProjectLabelFolders.ProjectLabelFolders)({}),
        gitDriver,
        memoryDatabase,
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

/**
 * checkoutRepository against the real label service over a memory database:
 * a project record lands in `projection_projects` like ProjectService does,
 * and the project folder is `<root>/<Project>`.
 */
function checkoutHarness(
  projectDir: string,
  box: Pick<Box, "cloneCalls">,
  options?: {
    /** Runs the relocation reactor too. */
    readonly beforeUpdate?: (
      input: ProjectService.ProjectUpdateInput,
    ) => Effect.Effect<void, ProjectService.ProjectServiceError>;
    readonly relocation?: boolean;
    readonly realFolders?: boolean;
    /** Told about every workspace-root update, like the record's event. */
    readonly onMoved?: (projectId: ProjectId, workspaceRoot: string) => Effect.Effect<void>;
  },
) {
  const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
  const persistence = Events.layer.pipe(Layer.provideMerge(database));
  const folders = options?.realFolders
    ? ProjectLabelFolders.layer.pipe(
        Layer.provide(database),
        Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "checkout-folders" })),
        Layer.provide(ServerSettings.layerTest({ projectsRoot: NodePath.dirname(projectDir) })),
        Layer.provide(NodeServices.layer),
      )
    : Layer.mock(ProjectLabelFolders.ProjectLabelFolders)({
        ensureForLabel: () =>
          Effect.sync(() => {
            NodeFS.mkdirSync(projectDir, { recursive: true });
            return { dir: projectDir, dirName: NodePath.basename(projectDir) };
          }),
        dirForLabel: () =>
          Effect.succeed({ dir: projectDir, dirName: NodePath.basename(projectDir) }),
        projectsRoot: Effect.succeed(NodePath.dirname(projectDir)),
      });
  const labels = ProjectLabelService.layer.pipe(
    Layer.provideMerge(options?.realFolders ? folders : Layer.empty),
    Layer.provide(layerSharedIdentity),
    Layer.provideMerge(persistence),
    Layer.provide(NodeServices.layer),
  );
  const projects = Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const getById = (id: ProjectId) =>
        sql<{ workspace_root: string; title: string }>`
          SELECT workspace_root, title FROM projection_projects WHERE project_id = ${id} AND deleted_at IS NULL
        `.pipe(
          Effect.map((rows) =>
            rows[0]
              ? Option.some({ id, title: rows[0].title, workspaceRoot: rows[0].workspace_root })
              : Option.none(),
          ),
          Effect.orDie,
        );
      return Layer.mock(ProjectService.ProjectService)({
        create: (input) =>
          Effect.gen(function* () {
            if (input.createWorkspaceRootIfMissing)
              NodeFS.mkdirSync(input.workspaceRoot, { recursive: true });
            yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${input.projectId}, ${input.title}, ${input.workspaceRoot}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`.pipe(
              Effect.orDie,
            );
            return {} as never;
          }),
        getById: (id) => getById(id) as never,
        getByWorkspaceRoot: (workspaceRoot) =>
          sql<{ project_id: ProjectId }>`
            SELECT project_id FROM projection_projects WHERE workspace_root = ${workspaceRoot} AND deleted_at IS NULL
          `.pipe(
            Effect.orDie,
            Effect.flatMap((rows) =>
              rows[0] ? getById(rows[0].project_id) : Effect.succeed(Option.none()),
            ),
          ) as never,
        update: (input) =>
          Effect.gen(function* () {
            if (options?.beforeUpdate) yield* options.beforeUpdate(input);
            if (input.workspaceRoot !== undefined) {
              yield* sql`UPDATE projection_projects SET workspace_root = ${input.workspaceRoot} WHERE project_id = ${input.projectId}`.pipe(
                Effect.orDie,
              );
              if (options?.onMoved) yield* options.onMoved(input.projectId, input.workspaceRoot);
            }
            return {} as never;
          }),
      });
    }),
  );
  const checkout = RepositoryCheckout.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        projects,
        Layer.mock(GitWorkflow.GitWorkflowService)({ isRepository }),
        gitDriver,
        folders,
      ),
    ),
    Layer.provideMerge(ProjectCloneTracker.layer.pipe(Layer.provide(gitRepositories(box)))),
    Layer.provideMerge(labels),
    Layer.provideMerge(folders),
    Layer.provideMerge(NodeServices.layer),
  );
  return options?.relocation
    ? RepositoryCheckout.layerRelocation.pipe(Layer.provideMerge(checkout))
    : checkout;
}

/** A project that links `remote` from another machine: only the placeholder exists here. */
const linkFromElsewhere = (remote: string, directoryName: string) =>
  Effect.gen(function* () {
    const labels = yield* ProjectLabelService.ProjectLabelService;
    const sql = yield* SqlClient.SqlClient;
    const { label } = yield* labels.create({ name: "Spawn" });
    const placeholder = `remote:${remote}`;
    yield* sql`INSERT INTO label_repositories(label_id, repository_id, remote, directory_name) VALUES (${label.id}, ${placeholder}, ${remote}, ${directoryName})`;
    yield* sql`INSERT INTO scheduled_tasks(task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, last_run_status, run_count) VALUES ('task:nightly', 'Nightly', 'Go', 1, '{}', ${placeholder}, '{"type":"root"}', '{}', 'full-access', 'default', 'user', 'web', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'never', 0)`;
    return label;
  });

const waitForCloneToSettle = (repositoryId: ProjectId) =>
  Effect.gen(function* () {
    const clones = yield* ProjectCloneTracker.ProjectCloneTracker;
    return yield* clones.stream.pipe(
      Stream.map((all) => all.find((clone) => clone.projectId === repositoryId)),
      Stream.filter((clone) => clone === undefined || clone.phase !== "running"),
      Stream.runHead,
    );
  });

describe("RepositoryCheckout.checkoutRepository", () => {
  it.effect("clones a repository linked from another machine into its project folder", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    const box = { cloneCalls: 0 };
    return Effect.gen(function* () {
      const label = yield* linkFromElsewhere(bare, "smile-express");
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const labels = yield* ProjectLabelService.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const { repositoryId } = yield* checkouts.checkoutRepository({
        labelId: label.id,
        remote: bare,
      });
      expect(isRemoteRepositoryPlaceholder(repositoryId)).toBe(false);
      // The placeholder is gone in the same step the record appears, and
      // the scheduled task bound to it follows.
      expect(
        yield* sql`SELECT repository_id, remote, directory_name FROM label_repositories`,
      ).toEqual([{ repository_id: repositoryId, remote: bare, directory_name: "smile-express" }]);
      expect(yield* sql`SELECT project_id FROM scheduled_tasks`).toEqual([
        { project_id: repositoryId },
      ]);
      yield* waitForCloneToSettle(repositoryId);
      const destination = NodePath.join(projectDir, "repos", "smile-express");
      expect(NodeFS.readFileSync(NodePath.join(destination, "README.md"), "utf8")).toBe("hello\n");
      expect((yield* labels.read(label.id)).label.repositories?.[0]?.checkout).toBe("ready");
      // Asking again is a no-op: same record, no second clone.
      expect(yield* checkouts.checkoutRepository({ labelId: label.id, remote: bare })).toEqual({
        repositoryId,
      });
      expect(box.cloneCalls).toBe(1);
    }).pipe(Effect.provide(checkoutHarness(projectDir, box)));
  });

  it.effect("a launch on the placeholder id clones first and waits for the checkout", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    const box = { cloneCalls: 0 };
    return Effect.gen(function* () {
      yield* linkFromElsewhere(bare, "smile-express");
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      yield* checkouts.ensureCheckout(ProjectId.make(`remote:${bare}`));
      expect(
        NodeFS.readFileSync(
          NodePath.join(projectDir, "repos", "smile-express", "README.md"),
          "utf8",
        ),
      ).toBe("hello\n");
      expect(box.cloneCalls).toBe(1);
    }).pipe(Effect.provide(checkoutHarness(projectDir, box)));
  });

  it.effect("adopts a checkout of the same repository already in the folder", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    NodeFS.mkdirSync(NodePath.join(projectDir, "repos"), { recursive: true });
    git(NodePath.join(projectDir, "repos"), ["clone", bare, "smile-express"]);
    const box = { cloneCalls: 0 };
    return Effect.gen(function* () {
      const label = yield* linkFromElsewhere(bare, "smile-express");
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const labels = yield* ProjectLabelService.ProjectLabelService;
      yield* checkouts.checkoutRepository({ labelId: label.id, remote: bare });
      expect(box.cloneCalls).toBe(0);
      expect((yield* labels.read(label.id)).label.repositories?.[0]?.checkout).toBe("ready");
    }).pipe(Effect.provide(checkoutHarness(projectDir, box)));
  });

  it.effect("refuses to clone over a folder that holds other files", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    NodeFS.mkdirSync(NodePath.join(projectDir, "repos", "smile-express"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(projectDir, "repos", "smile-express", "notes.txt"),
      "mine\n",
    );
    const box = { cloneCalls: 0 };
    return Effect.gen(function* () {
      const label = yield* linkFromElsewhere(bare, "smile-express");
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(
        checkouts.checkoutRepository({ labelId: label.id, remote: bare }),
      );
      expect(error.reason).toBe("destination_taken");
      expect(box.cloneCalls).toBe(0);
      expect(yield* sql`SELECT repository_id FROM label_repositories`).toEqual([
        { repository_id: `remote:${bare}` },
      ]);
      expect(
        NodeFS.readFileSync(
          NodePath.join(projectDir, "repos", "smile-express", "notes.txt"),
          "utf8",
        ),
      ).toBe("mine\n");
    }).pipe(Effect.provide(checkoutHarness(projectDir, box)));
  });

  /** The state a checkout leaves when binding its new record fails: the record, still the placeholder. */
  const recordLeftUnbound = (destination: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repositoryId = ProjectId.make("earlier-record");
      NodeFS.mkdirSync(destination, { recursive: true });
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${repositoryId}, 'smile-express', ${destination}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      return repositoryId;
    });

  it.effect("a retry after a failed bind binds the record the clone already made", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    NodeFS.mkdirSync(NodePath.join(projectDir, "repos"), { recursive: true });
    git(NodePath.join(projectDir, "repos"), ["clone", bare, "smile-express"]);
    const box = { cloneCalls: 0 };
    return Effect.gen(function* () {
      const label = yield* linkFromElsewhere(bare, "smile-express");
      const earlier = yield* recordLeftUnbound(NodePath.join(projectDir, "repos", "smile-express"));
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const sql = yield* SqlClient.SqlClient;
      expect(yield* checkouts.checkoutRepository({ labelId: label.id, remote: bare })).toEqual({
        repositoryId: earlier,
      });
      expect(yield* sql`SELECT project_id FROM projection_projects`).toEqual([
        { project_id: earlier },
      ]);
      expect(yield* sql`SELECT repository_id FROM label_repositories`).toEqual([
        { repository_id: earlier },
      ]);
      expect(box.cloneCalls).toBe(0);
    }).pipe(Effect.provide(checkoutHarness(projectDir, box)));
  });

  it.effect("a retry after a failed bind and a failed clone clones into that record", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    const box = { cloneCalls: 0 };
    return Effect.gen(function* () {
      const label = yield* linkFromElsewhere(bare, "smile-express");
      const destination = NodePath.join(projectDir, "repos", "smile-express");
      const earlier = yield* recordLeftUnbound(destination);
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const sql = yield* SqlClient.SqlClient;
      expect(yield* checkouts.checkoutRepository({ labelId: label.id, remote: bare })).toEqual({
        repositoryId: earlier,
      });
      yield* waitForCloneToSettle(earlier);
      expect(NodeFS.readFileSync(NodePath.join(destination, "README.md"), "utf8")).toBe("hello\n");
      expect(yield* sql`SELECT project_id FROM projection_projects`).toEqual([
        { project_id: earlier },
      ]);
      expect(box.cloneCalls).toBe(1);
    }).pipe(Effect.provide(checkoutHarness(projectDir, box)));
  });

  it.effect("refuses a remote the project does not link", () => {
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    return Effect.gen(function* () {
      const label = yield* linkFromElsewhere("github.com/org/repo", "repo");
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const error = yield* Effect.flip(
        checkouts.checkoutRepository({ labelId: label.id, remote: "github.com/org/other" }),
      );
      expect(error.reason).toBe("not_linked");
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });
});

describe("RepositoryCheckout.removeCheckout", () => {
  /** A project linking `bare`, cloned here into its project folder. */
  const clonedHere = (bare: string) =>
    Effect.gen(function* () {
      const label = yield* linkFromElsewhere(bare, "smile-express");
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const { repositoryId } = yield* checkouts.checkoutRepository({
        labelId: label.id,
        remote: bare,
      });
      yield* waitForCloneToSettle(repositoryId);
      return { label, repositoryId, checkouts };
    });

  it.effect("deletes the checkout and keeps the link, which clones back in place", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    const destination = NodePath.join(projectDir, "repos", "smile-express");
    const box = { cloneCalls: 0 };
    return Effect.gen(function* () {
      const { label, repositoryId, checkouts } = yield* clonedHere(bare);
      const labels = yield* ProjectLabelService.ProjectLabelService;
      expect(yield* checkouts.removeCheckout({ labelId: label.id, repositoryId })).toEqual({
        removed: true,
      });
      expect(NodeFS.existsSync(destination)).toBe(false);
      const link = (yield* labels.read(label.id)).label.repositories?.[0];
      expect(link).toMatchObject({ repositoryId, checkout: "missing" });
      // Removing again finds nothing to remove; cloning again lands in place.
      expect(yield* checkouts.removeCheckout({ labelId: label.id, repositoryId })).toEqual({
        removed: false,
      });
      expect(yield* checkouts.checkoutRepository({ labelId: label.id, remote: bare })).toEqual({
        repositoryId,
      });
      yield* waitForCloneToSettle(repositoryId);
      expect(NodeFS.readFileSync(NodePath.join(destination, "README.md"), "utf8")).toBe("hello\n");
      expect(box.cloneCalls).toBe(2);
    }).pipe(Effect.provide(checkoutHarness(projectDir, box)));
  });

  it.effect("refuses while the checkout holds work found nowhere else", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    const destination = NodePath.join(projectDir, "repos", "smile-express");
    return Effect.gen(function* () {
      const { label, repositoryId, checkouts } = yield* clonedHere(bare);
      const attempt = checkouts.removeCheckout({ labelId: label.id, repositoryId }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );

      NodeFS.writeFileSync(NodePath.join(destination, "draft.md"), "wip\n");
      expect(yield* attempt).toBe("uncommitted_changes");
      git(destination, ["stash", "push", "--include-untracked", "-m", "wip"]);
      expect(yield* attempt).toBe("uncommitted_changes");
      git(destination, ["stash", "drop"]);

      git(destination, [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "local",
      ]);
      expect(yield* attempt).toBe("unpushed_commits");
      git(destination, ["push", "origin", "HEAD"]);

      git(destination, ["worktree", "add", NodePath.join(tempRoot(), "wt"), "-b", "feature"]);
      expect(yield* attempt).toBe("has_worktrees");

      expect(NodeFS.existsSync(NodePath.join(destination, "README.md"))).toBe(true);
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });

  it.effect(
    "refuses work that git config, ignores, a detached HEAD or a submodule would hide",
    () => {
      const bare = makeBareRemote();
      const projectDir = NodePath.join(tempRoot(), "Spawn");
      const destination = NodePath.join(projectDir, "repos", "smile-express");
      const commit = (cwd: string, message: string) =>
        git(cwd, [
          "-c",
          "user.name=T",
          "-c",
          "user.email=t@example.com",
          "commit",
          "--allow-empty",
          "-m",
          message,
        ]);
      return Effect.gen(function* () {
        const { label, repositoryId, checkouts } = yield* clonedHere(bare);
        const attempt = checkouts.removeCheckout({ labelId: label.id, repositoryId }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );

        // A repository configured to hide untracked files still has them.
        git(destination, ["config", "status.showUntrackedFiles", "no"]);
        NodeFS.writeFileSync(NodePath.join(destination, "draft.md"), "wip\n");
        expect(yield* attempt).toBe("uncommitted_changes");
        NodeFS.rmSync(NodePath.join(destination, "draft.md"));

        // An ignored `.env` exists only here; ignored build output does not count.
        NodeFS.writeFileSync(
          NodePath.join(destination, ".git", "info", "exclude"),
          ".env\nnode_modules/\n",
        );
        NodeFS.mkdirSync(NodePath.join(destination, "node_modules", "left-pad"), {
          recursive: true,
        });
        NodeFS.writeFileSync(
          NodePath.join(destination, "node_modules", "left-pad", "index.js"),
          "",
        );
        NodeFS.writeFileSync(NodePath.join(destination, ".env"), "TOKEN=1\n");
        const ignored = yield* Effect.flip(
          checkouts.removeCheckout({ labelId: label.id, repositoryId }),
        );
        expect(ignored).toMatchObject({ reason: "uncommitted_changes" });
        expect(ignored.detail).toContain(".env");
        NodeFS.rmSync(NodePath.join(destination, ".env"));

        // A commit on a detached HEAD is on no branch and no remote.
        git(destination, ["checkout", "--detach"]);
        commit(destination, "detached");
        expect(yield* attempt).toBe("unpushed_commits");
        git(destination, ["checkout", "main"]);

        // A submodule's own commits count too.
        const library = makeBareRemote();
        git(destination, ["-c", "protocol.file.allow=always", "submodule", "add", library, "lib"]);
        commit(destination, "add lib");
        git(destination, ["push", "origin", "HEAD"]);
        commit(NodePath.join(destination, "lib"), "library work");
        git(destination, ["add", "lib"]);
        commit(destination, "bump lib");
        git(destination, ["push", "origin", "HEAD"]);
        expect(yield* attempt).toBe("unpushed_commits");
        git(NodePath.join(destination, "lib"), ["push", "origin", "HEAD:main"]);
        git(NodePath.join(destination, "lib"), ["fetch", "origin"]);

        expect(yield* checkouts.removeCheckout({ labelId: label.id, repositoryId })).toEqual({
          removed: true,
        });
      }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
    },
  );

  it.effect("never deletes a record that points at a folder holding other projects", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    return Effect.gen(function* () {
      const { label, repositoryId, checkouts } = yield* clonedHere(bare);
      const sql = yield* SqlClient.SqlClient;
      // The project folder itself, made a clean checkout so git alone would allow it.
      git(projectDir, ["init", "--initial-branch=main"]);
      yield* sql`UPDATE projection_projects SET workspace_root = ${projectDir} WHERE project_id = ${repositoryId}`;
      const error = yield* Effect.flip(
        checkouts.removeCheckout({ labelId: label.id, repositoryId }),
      );
      expect(error).toMatchObject({ reason: "protected_folder" });
      expect(NodeFS.existsSync(NodePath.join(projectDir, "repos", "smile-express"))).toBe(true);
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });

  it.effect("refuses while a turn runs in the repository", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    return Effect.gen(function* () {
      const { label, repositoryId, checkouts } = yield* clonedHere(bare);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('thread:busy', ${repositoryId}, 'Busy', 'codex', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('run:busy', 'thread:busy', 1, 'codex', 'running', '2026-01-01T00:00:00.000Z', '{}')`;
      const error = yield* Effect.flip(
        checkouts.removeCheckout({ labelId: label.id, repositoryId }),
      );
      expect(error).toMatchObject({ reason: "thread_active" });
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });
});

describe("RepositoryCheckout.adoptRepository", () => {
  /** A checkout of `bare` kept outside any project folder, linked into a project. */
  const linkedElsewhere = (bare: string, folder: string) =>
    Effect.gen(function* () {
      const labels = yield* ProjectLabelService.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const elsewhere = NodePath.join(tempRoot(), folder);
      git(NodePath.dirname(elsewhere), ["clone", bare, folder]);
      const repositoryId = ProjectId.make(`repo:${folder}`);
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${repositoryId}, ${folder}, ${elsewhere}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      const { label } = yield* labels.create({ name: "Spawn" });
      yield* sql`INSERT INTO label_repositories(label_id, repository_id, remote, directory_name) VALUES (${label.id}, ${repositoryId}, ${bare}, ${folder})`;
      return { label, repositoryId, elsewhere };
    });

  it.effect("renames a checkout kept elsewhere into repos/<repo>, worktrees and all", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    return Effect.gen(function* () {
      const { label, repositoryId, elsewhere } = yield* linkedElsewhere(bare, "spawn-smile");
      const worktree = NodePath.join(tempRoot(), "fix-login");
      git(elsewhere, ["worktree", "add", worktree, "-b", "fix-login"]);
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const labels = yield* ProjectLabelService.ProjectLabelService;
      const destination = NodePath.join(projectDir, "repos", "smile-express");
      // The folder follows the remote's name, not the old checkout's.
      expect((yield* labels.read(label.id)).label.repositories?.[0]?.directoryName).toBe(
        "smile-express",
      );
      expect(yield* checkouts.adoptRepository({ labelId: label.id, repositoryId })).toEqual({
        moved: true,
        workspaceRoot: destination,
      });
      expect(NodeFS.existsSync(elsewhere)).toBe(false);
      expect(NodeFS.readFileSync(NodePath.join(destination, "README.md"), "utf8")).toBe("hello\n");
      // The record follows, and the worktree still knows its repository.
      expect((yield* labels.read(label.id)).label.repositories?.[0]?.checkout).toBe("ready");
      expect(git(worktree, ["rev-parse", "--git-common-dir"]).toString().trim()).toBe(
        NodeFS.realpathSync(NodePath.join(destination, ".git")),
      );
      // Already in place: nothing to do.
      expect(yield* checkouts.adoptRepository({ labelId: label.id, repositoryId })).toEqual({
        moved: false,
        workspaceRoot: destination,
      });
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });

  it.effect("repoints an already moved checkout through its forwarding link", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    return Effect.gen(function* () {
      const { label, repositoryId, elsewhere } = yield* linkedElsewhere(bare, "forwarded");
      const destination = NodePath.join(projectDir, "repos", "smile-express");
      NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
      const worktree = NodePath.join(tempRoot(), "external");
      git(elsewhere, ["worktree", "add", worktree, "-b", "external"]);
      NodeFS.renameSync(elsewhere, destination);
      NodeFS.symlinkSync(destination, elsewhere);
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      expect(yield* checkouts.adoptRepository({ labelId: label.id, repositoryId })).toEqual({
        moved: true,
        workspaceRoot: destination,
      });
      expect(NodeFS.lstatSync(elsewhere).isSymbolicLink()).toBe(true);
      expect(NodeFS.lstatSync(destination).isDirectory()).toBe(true);
      expect(git(worktree, ["rev-parse", "--git-common-dir"]).toString().trim()).toBe(
        NodeFS.realpathSync(NodePath.join(destination, ".git")),
      );
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });

  it.effect("never tears a subfolder out of some other repository", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    return Effect.gen(function* () {
      const { label, repositoryId, elsewhere } = yield* linkedElsewhere(bare, "monorepo");
      const sql = yield* SqlClient.SqlClient;
      const subfolder = NodePath.join(elsewhere, "packages", "app");
      NodeFS.mkdirSync(subfolder, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(subfolder, "index.ts"), "");
      yield* sql`UPDATE projection_projects SET workspace_root = ${subfolder} WHERE project_id = ${repositoryId}`;
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const error = yield* Effect.flip(
        checkouts.adoptRepository({ labelId: label.id, repositoryId }),
      );
      expect(error).toMatchObject({ reason: "move_failed" });
      expect(NodeFS.existsSync(NodePath.join(subfolder, "index.ts"))).toBe(true);
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });

  it.effect("renames a checkout whose folder differs from its name only in case", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    return Effect.gen(function* () {
      const { label, repositoryId, elsewhere } = yield* linkedElsewhere(bare, "spawn-smile");
      const sql = yield* SqlClient.SqlClient;
      const upper = NodePath.join(projectDir, "repos", "Smile-Express");
      NodeFS.mkdirSync(NodePath.dirname(upper), { recursive: true });
      NodeFS.renameSync(elsewhere, upper);
      yield* sql`UPDATE projection_projects SET workspace_root = ${upper} WHERE project_id = ${repositoryId}`;
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const destination = NodePath.join(projectDir, "repos", "smile-express");
      expect(yield* checkouts.adoptRepository({ labelId: label.id, repositoryId })).toEqual({
        moved: true,
        workspaceRoot: destination,
      });
      expect(NodeFS.readdirSync(NodePath.join(projectDir, "repos"))).toEqual(["smile-express"]);
      expect(NodeFS.readFileSync(NodePath.join(destination, "README.md"), "utf8")).toBe("hello\n");
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });

  it.effect("refuses while a worktree lives inside the checkout or a turn runs in it", () => {
    const bare = makeBareRemote();
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    return Effect.gen(function* () {
      const { label, repositoryId, elsewhere } = yield* linkedElsewhere(bare, "spawn-smile");
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      const sql = yield* SqlClient.SqlClient;
      const attempt = checkouts.adoptRepository({ labelId: label.id, repositoryId }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
      git(elsewhere, ["worktree", "add", NodePath.join(elsewhere, ".inner"), "-b", "inner"]);
      expect(yield* attempt).toBe("worktrees_inside");
      git(elsewhere, ["worktree", "remove", NodePath.join(elsewhere, ".inner")]);
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('thread:busy', ${repositoryId}, 'Busy', 'codex', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('run:busy', 'thread:busy', 1, 'codex', 'running', '2026-01-01T00:00:00.000Z', '{}')`;
      expect(yield* attempt).toBe("thread_active");
      expect(NodeFS.existsSync(NodePath.join(elsewhere, "README.md"))).toBe(true);
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });
});

describe("RepositoryCheckout.relocateProjectRepositories", () => {
  /**
   * A project owned by Spawn-Partners with its `platform` already in
   * `repos/platform`; its remote is a GitHub one so the owner decides the
   * folder (nothing here talks to GitHub).
   */
  const ownedProject = (projectDir: string) =>
    Effect.gen(function* () {
      const labels = yield* ProjectLabelService.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const checkout = NodePath.join(projectDir, "repos", "platform");
      NodeFS.mkdirSync(checkout, { recursive: true });
      git(checkout, ["init", "--initial-branch=main"]);
      git(checkout, ["remote", "add", "origin", "https://github.com/spawn-partners/platform.git"]);
      const repositoryId = ProjectId.make("repo:platform");
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${repositoryId}, 'platform', ${checkout}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      const { label } = yield* labels.create({ name: "Spawn" });
      const owner = (name: string) => ({
        id: label.id,
        link: { kind: "github-owner" as const, owner: name },
      });
      yield* labels.linkSource(owner("Spawn-Partners"));
      yield* sql`INSERT INTO label_repositories(label_id, repository_id, remote, directory_name) VALUES (${label.id}, ${repositoryId}, 'github.com/spawn-partners/platform', 'platform')`;
      return { label, repositoryId, owner };
    });

  it.effect("moves in-folder checkouts to the folders a new owner derives", () => {
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    return Effect.gen(function* () {
      const { label, repositoryId, owner } = yield* ownedProject(projectDir);
      const labels = yield* ProjectLabelService.ProjectLabelService;
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      expect(yield* checkouts.relocateProjectRepositories(label.id)).toEqual({ moved: [] });
      yield* labels.unlinkSource(owner("Spawn-Partners"));
      yield* labels.linkSource(owner("bartr-app"));
      expect(yield* checkouts.relocateProjectRepositories(label.id)).toEqual({
        moved: [repositoryId],
      });
      const moved = NodePath.join(projectDir, "repos", "spawn-partners", "platform");
      expect(NodeFS.existsSync(NodePath.join(moved, ".git"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(projectDir, "repos", "platform"))).toBe(false);
      expect((yield* labels.read(label.id)).label.repositories?.[0]).toMatchObject({
        directoryName: "spawn-partners/platform",
        checkout: "ready",
      });
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });

  it.effect(
    "follows merged checkouts to their real suffixed path and through a later project rename",
    () => {
      const parent = tempRoot();
      const projectDir = NodePath.join(parent, "Target");
      return Effect.gen(function* () {
        const labels = yield* ProjectLabelService.ProjectLabelService;
        const folders = yield* ProjectLabelFolders.ProjectLabelFolders;
        const sql = yield* SqlClient.SqlClient;
        const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
        const source = (yield* labels.create({ name: "Source" })).label;
        const target = (yield* labels.create({ name: "Target" })).label;
        const sourceRoot = NodePath.join(
          (yield* folders.dirForLabel(source)).dir,
          "repos",
          "platform",
        );
        const targetRoot = NodePath.join(projectDir, "repos", "platform");
        for (const root of [sourceRoot, targetRoot]) {
          NodeFS.mkdirSync(root, { recursive: true });
          git(root, ["init", "--initial-branch=main"]);
          git(root, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "init",
          ]);
        }
        const worktree = NodePath.join(parent, "external");
        git(sourceRoot, ["worktree", "add", worktree, "-b", "external"]);
        const repositoryId = ProjectId.make("repo:merged");
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${repositoryId},'platform',${sourceRoot},'[]','2026-01-01','2026-01-01')`;
        yield* sql`INSERT INTO label_repositories(label_id,repository_id,directory_name) VALUES (${source.id},${repositoryId},'platform')`;
        yield* labels.merge({ sourceId: source.id, targetId: target.id });
        yield* folders.reconcileMerges;
        yield* checkouts.relocateProjectRepositories(target.id);
        const moved = NodePath.join(projectDir, "repos", "platform (2)");
        expect(yield* sql`SELECT workspace_root FROM projection_projects`).toEqual([
          { workspace_root: moved },
        ]);
        expect(git(worktree, ["rev-parse", "--git-common-dir"]).toString().trim()).toBe(
          NodeFS.realpathSync(NodePath.join(moved, ".git")),
        );
        expect(NodeFS.lstatSync(sourceRoot).isSymbolicLink()).toBe(true);
        yield* labels.update({ id: target.id, name: "Renamed" });
        yield* checkouts.relocateProjectRepositories(target.id);
        const renamed = NodePath.join(parent, "Renamed", "repos", "platform (2)");
        expect(yield* sql`SELECT workspace_root FROM projection_projects`).toEqual([
          { workspace_root: renamed },
        ]);
        expect(git(worktree, ["rev-parse", "--git-common-dir"]).toString().trim()).toBe(
          NodeFS.realpathSync(NodePath.join(renamed, ".git")),
        );
      }).pipe(
        Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 }, { realFolders: true })),
      );
    },
  );

  it.effect("relocates by itself when the project's owner changes", () => {
    const projectDir = NodePath.join(tempRoot(), "Spawn");
    const moved = Deferred.makeUnsafe<string>();
    return Effect.gen(function* () {
      const { owner } = yield* ownedProject(projectDir);
      const labels = yield* ProjectLabelService.ProjectLabelService;
      yield* labels.unlinkSource(owner("Spawn-Partners"));
      expect(yield* Deferred.await(moved)).toBe(
        NodePath.join(projectDir, "repos", "spawn-partners", "platform"),
      );
    }).pipe(
      Effect.provide(
        checkoutHarness(
          projectDir,
          { cloneCalls: 0 },
          {
            relocation: true,
            onMoved: (_, workspaceRoot) =>
              Deferred.succeed(moved, workspaceRoot).pipe(Effect.asVoid),
          },
        ),
      ),
    );
  });
});

describe("RepositoryCheckout relocation after a project folder rename", () => {
  it.effect("rolls the checkout and its external worktrees back when repointing fails", () => {
    const parent = tempRoot();
    const projectDir = NodePath.join(parent, "Renamed");
    const before = NodePath.join(parent, "Source", "repos", "platform");
    const after = NodePath.join(projectDir, "repos", "platform");
    const worktree = NodePath.join(parent, "external");
    NodeFS.mkdirSync(before, { recursive: true });
    git(before, ["init", "--initial-branch=main"]);
    git(before, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ]);
    git(before, ["worktree", "add", worktree, "-b", "external"]);
    NodeFS.renameSync(NodePath.join(parent, "Source"), projectDir);
    return Effect.gen(function* () {
      const labels = yield* ProjectLabelService.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const repositoryId = ProjectId.make("repo:rollback");
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${repositoryId},'platform',${before},'[]','2026-01-01','2026-01-01')`;
      const { label } = yield* labels.create({ name: "Renamed" });
      yield* sql`INSERT INTO label_repositories(label_id,repository_id,directory_name) VALUES (${label.id},${repositoryId},'platform')`;
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      expect(yield* checkouts.relocateProjectRepositories(label.id)).toEqual({ moved: [] });
      expect(yield* sql`SELECT workspace_root FROM projection_projects`).toEqual([
        { workspace_root: before },
      ]);
      expect(NodeFS.existsSync(after)).toBe(false);
      expect(git(worktree, ["rev-parse", "--git-common-dir"]).toString().trim()).toBe(
        NodeFS.realpathSync(NodePath.join(before, ".git")),
      );
    }).pipe(
      Effect.provide(
        checkoutHarness(
          projectDir,
          { cloneCalls: 0 },
          {
            beforeUpdate: () =>
              Effect.fail(
                new ProjectService.ProjectOperationError({
                  operation: "dispatch-project-command",
                  cause: "injected failure",
                }),
              ),
          },
        ),
      ),
    );
  });

  it.effect("points the record at the checkout's place in the renamed folder", () => {
    const parent = tempRoot();
    const projectDir = NodePath.join(parent, "Spawned");
    return Effect.gen(function* () {
      const labels = yield* ProjectLabelService.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const checkouts = yield* RepositoryCheckout.RepositoryCheckout;
      // Before the rename the project folder was `Spawn`, now it is `Spawned`.
      const before = NodePath.join(parent, "Spawn", "repos", "platform");
      const after = NodePath.join(projectDir, "repos", "platform");
      NodeFS.mkdirSync(before, { recursive: true });
      git(before, ["init", "--initial-branch=main"]);
      git(before, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ]);
      const worktree = NodePath.join(parent, "external-worktree");
      git(before, ["worktree", "add", worktree, "-b", "external"]);
      NodeFS.renameSync(NodePath.join(parent, "Spawn"), projectDir);
      const repositoryId = ProjectId.make("repo:platform");
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${repositoryId}, 'platform', ${before}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      const { label } = yield* labels.create({ name: "Spawned" });
      yield* sql`INSERT INTO label_repositories(label_id, repository_id, remote, directory_name) VALUES (${label.id}, ${repositoryId}, NULL, 'platform')`;
      expect(yield* checkouts.relocateProjectRepositories(label.id)).toEqual({
        moved: [repositoryId],
      });
      expect(yield* sql`SELECT workspace_root FROM projection_projects`).toEqual([
        { workspace_root: after },
      ]);
      expect(git(worktree, ["rev-parse", "--git-common-dir"]).toString().trim()).toBe(
        NodeFS.realpathSync(NodePath.join(after, ".git")),
      );
      expect(git(after, ["worktree", "list", "--porcelain"]).toString()).toContain(
        NodeFS.realpathSync(worktree),
      );
    }).pipe(Effect.provide(checkoutHarness(projectDir, { cloneCalls: 0 })));
  });
});
