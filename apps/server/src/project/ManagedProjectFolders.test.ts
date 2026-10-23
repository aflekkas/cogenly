import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Project,
  ProjectLabelError,
  ProjectLabelId,
  ProjectId,
  ProjectLabelWithRepositories,
  ThreadId,
  type ProjectLabelRepository,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

const labelId = ProjectLabelId.make("label:spawn-partners");
const testLabel = ProjectLabelWithRepositories.make({
  id: labelId,
  name: "Spawn Partners",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  repositoryIds: [],
  sourceLinks: [],
  threadCount: 0,
  instructions: "",
  projectChatThreadId: null,
});

/** Every filing the service attempted, in order. Tests key off their own project id. */
const linked: Array<ProjectLabelRepository> = [];

const gitSuccess = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

// The single-param Layer constructors leave their requirements as unknown,
// which does not satisfy the precise consumers below; narrowing here is sound
// because these layers build with no requirements at runtime.
const nodeFileSystem: Layer.Layer<FileSystem.FileSystem, never, never> = NodeFileSystem.layer;
const nodePath: Layer.Layer<Path.Path, never, never> = NodePath.layer;
const nodeCrypto: Layer.Layer<Crypto.Crypto, never, never> = NodeCrypto.layer;

const scratchProjectId = ProjectId.make("project:scratch");
const repositoryProjectId = ProjectId.make("project:acme");
/** Set by `useProjectsRoot` from the test config's base dir. */
let scratchWorkspaceRoot: string | null = null;

const layerTest = ManagedProjectFolders.layer.pipe(
  Layer.provideMerge(
    Layer.mock(ProjectService.ProjectService)({
      create: (input) =>
        Effect.succeed(
          Project.make({
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
      getByWorkspaceRoot: () => Effect.succeed(Option.none()),
      // The Scratch project ("No project") lives at `<baseDir>/scratch`.
      getById: (projectId) =>
        Effect.succeed(
          projectId === scratchProjectId && scratchWorkspaceRoot !== null
            ? Option.some(
                Project.make({
                  id: scratchProjectId,
                  title: "No project",
                  workspaceRoot: scratchWorkspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  deletedAt: null,
                }),
              )
            : Option.none(),
        ),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectLabelService.ProjectLabelService)({
      read: (id) =>
        id === labelId
          ? Effect.succeed({ label: testLabel })
          : Effect.fail(new ProjectLabelError({ operation: "read", reason: "not_found" })),
      readActive: (id) =>
        id === labelId
          ? Effect.succeed({ label: testLabel })
          : Effect.fail(new ProjectLabelError({ operation: "read", reason: "not_found" })),
      linkRepository: (input) => {
        linked.push(input);
        return Effect.succeed({ label: testLabel });
      },
    }),
  ),
  Layer.provideMerge(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      readConfigValue: () => Effect.succeed(null),
      execute: () => Effect.succeed(gitSuccess),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest({})),
  Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "cogenly-create-new-" })),
  Layer.provideMerge(nodeFileSystem),
  Layer.provideMerge(nodePath),
  Layer.provideMerge(nodeCrypto),
);

/** A fresh projects root per test, so creates never see each other's folders. */
const useProjectsRoot = Effect.fn("useProjectsRoot")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const home = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "cogenly-create-new-" }),
  );
  const projectsRoot = path.join(home, "Cogenly");
  yield* settings.updateSettings({ projectsRoot });
  scratchWorkspaceRoot = path.resolve((yield* ServerConfig.ServerConfig).baseDir, "scratch");
  return projectsRoot;
});

it.layer(layerTest)("ManagedProjectFolders", (it) => {
  describe("createNamedProject", () => {
    it.effect("creates an unfiled repository under Repositories", () =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectsRoot = yield* useProjectsRoot();

        const created = yield* folders.createNamedProject({ name: "Acme Web" });

        expect(created.workspaceRoot).toBe(path.join(projectsRoot, "Repositories", "acme-web"));
        expect(created.commitError).toBeUndefined();
        expect(
          yield* fileSystem.readFileString(path.join(created.workspaceRoot, "README.md")),
        ).toContain("# Acme Web");
        expect(
          yield* fileSystem.exists(path.join(created.workspaceRoot, "assets", "icon.svg")),
        ).toBe(true);
        expect(linked.filter((entry) => entry.repositoryId === created.projectId)).toEqual([]);
      }),
    );

    it.effect("creates a project repository under the project's folder and files it", () =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const path = yield* Path.Path;
        const projectsRoot = yield* useProjectsRoot();

        const created = yield* folders.createNamedProject({ name: "Acme", labelId });

        expect(created.workspaceRoot).toBe(path.join(projectsRoot, "Spawn Partners", "acme"));
        expect(linked).toContainEqual({ labelId, repositoryId: created.projectId });
      }),
    );

    it.effect("claims -2 names under the project folder when taken", () =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const path = yield* Path.Path;
        const projectsRoot = yield* useProjectsRoot();

        const first = yield* folders.createNamedProject({ name: "Acme", labelId });
        const second = yield* folders.createNamedProject({ name: "Acme", labelId });

        expect(first.workspaceRoot).toBe(path.join(projectsRoot, "Spawn Partners", "acme"));
        expect(second.workspaceRoot).toBe(path.join(projectsRoot, "Spawn Partners", "acme-2"));
      }),
    );

    it.effect("fails an unknown label without creating a folder", () =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectsRoot = yield* useProjectsRoot();

        const failure = yield* folders
          .createNamedProject({ name: "Acme", labelId: ProjectLabelId.make("label:missing") })
          .pipe(Effect.flip);

        expect(failure._tag).toBe("ProjectLabelError");
        expect(failure).toMatchObject({ reason: "not_found" });
        expect(yield* fileSystem.exists(path.join(projectsRoot, "Repositories", "acme"))).toBe(
          false,
        );
        expect(yield* fileSystem.exists(path.join(projectsRoot, "Spawn Partners", "acme"))).toBe(
          false,
        );
      }),
    );
  });

  describe("folderForThread", () => {
    const threadId = ThreadId.make("thread:0123456789abcdef");

    it.effect("claims a dated folder of its own for unfiled Scratch threads", () =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        yield* useProjectsRoot();

        const folder = yield* folders.folderForThread({
          projectId: scratchProjectId,
          threadId,
          text: "Convert these PNGs",
        });

        const claimed = Option.getOrThrow(folder);
        expect(path.dirname(claimed)).toBe(path.resolve(config.baseDir, "scratch"));
        expect(path.basename(claimed)).toMatch(/^\d{4}-\d{2}-\d{2}-convert-these-pngs-/);
      }),
    );

    it.effect(
      "runs Scratch threads filed in a project in the project's folder, made if missing",
      () =>
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const projectsRoot = yield* useProjectsRoot();
          const projectDir = path.join(projectsRoot, "Spawn Partners");
          expect(yield* fileSystem.exists(projectDir)).toBe(false);

          const folder = yield* folders.folderForThread({
            projectId: scratchProjectId,
            threadId,
            text: "Draft the brief",
            labelId,
          });

          expect(folder).toEqual(Option.some(projectDir));
          expect(yield* fileSystem.exists(projectDir)).toBe(true);
        }),
    );

    it.effect("leaves repositories alone, filed or not", () =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        yield* useProjectsRoot();

        const folder = yield* folders.folderForThread({
          projectId: repositoryProjectId,
          threadId,
          text: "Fix the build",
          labelId,
        });

        expect(Option.isNone(folder)).toBe(true);
      }),
    );
  });
});
