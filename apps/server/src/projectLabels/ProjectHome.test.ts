import { layerIdentity as layerSharedIdentity } from "../sync/testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProjectLabelError,
  ProviderInstanceId,
  ThreadId,
  type ProjectLabelId,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Config from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectFiles from "./ProjectFiles.ts";
import * as ProjectHome from "./ProjectHome.ts";
import * as Labels from "./ProjectLabelService.ts";

const at = "2026-01-01T00:00:00.000Z";
const scratch = ProjectId.make("scratch");
const testHome = "/tmp/cogenly-project-home-test";
const repo = ProjectId.make("repo-web");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

/** Launches the test saw, so lazy creation can be counted. */
const launches = Ref.makeUnsafe<ReadonlyArray<ThreadId>>([]);
/** The project each launch ran in. */
const launchedProjects = Ref.makeUnsafe<ReadonlyArray<ProjectId>>([]);
const removedPaths = Ref.makeUnsafe<ReadonlyArray<string>>([]);

const insertThread = (threadId: ThreadId, projectId = scratch) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, ${projectId}, 'Project chat', 'codex', 'full-access', 'default', ${at}, ${at}, '{"surface":"chat"}')`;
  });

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const persistence = Events.layer.pipe(Layer.provideMerge(database));
const labels = Labels.layer
  .pipe(Layer.provide(layerSharedIdentity))
  .pipe(Layer.provideMerge(persistence), Layer.provide(Config.layerTest(process.cwd(), testHome)));

// The launch stub writes the thread row and files it, as the real launch does.
const launch = Layer.effect(
  ThreadLaunchService.ThreadLaunchService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* Labels.ProjectLabelService;
    return ThreadLaunchService.ThreadLaunchService.of({
      launch: (input: ThreadLaunchService.ThreadLaunchInput) =>
        Effect.gen(function* () {
          const threadId = input.threadId!;
          yield* Ref.update(launches, (all) => [...all, threadId]);
          yield* Ref.update(launchedProjects, (all) => [...all, input.projectId]);
          yield* insertThread(threadId, input.projectId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          if (input.projectFolderId !== undefined)
            yield* service.moveThread({ threadId, folderId: input.projectFolderId });
          return { threadId, projection: null as never, resumed: false };
        }).pipe(Effect.orDie),
      checkWorktreeBase: () => Effect.void,
      retryPreparation: () => Effect.die("unused"),
    } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]);
  }),
);

const threads = Layer.effect(
  ThreadManagementService.ThreadManagementService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      getThreadShell: (threadId: ThreadId) =>
        sql<{
          deleted_at: string | null;
        }>`SELECT deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`.pipe(
          Effect.map((rows) =>
            rows[0] === undefined
              ? null
              : { ...liveThreadShell(threadId), deletedAt: rows[0].deleted_at },
          ),
          Effect.orDie,
        ),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];
  }),
);

const files = Layer.mock(ProjectFiles.ProjectFiles)({
  createResource: (input) =>
    Effect.succeed({
      resource: {
        relativePath: `Resources/${input.resource.kind === "note" ? input.resource.title : "x"}.md`,
        kind: "file" as const,
        mimeType: "text/markdown",
        sizeBytes: 1,
        modifiedAt: at,
      },
    }),
  removeResource: (input) =>
    Ref.modify(removedPaths, (all): [{ removed: boolean }, ReadonlyArray<string>] =>
      all.includes(input.relativePath)
        ? [{ removed: false }, all]
        : [{ removed: true }, [...all, input.relativePath]],
    ),
});

const folders = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
  ensureScratchProject: Effect.succeed({ projectId: scratch }),
});

// An environment without Scratch (its data dir inside a checkout).
const noScratch = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
  ensureScratchProject: Effect.fail(new ManagedProjectFolders.ScratchUnavailableError()),
});

const layerWith = (managedFolders: typeof folders) =>
  ProjectHome.layer.pipe(
    Layer.provide(Layer.mergeAll(launch, threads, files, managedFolders, ProjectStore.layer)),
    Layer.provideMerge(labels),
    Layer.provide(NodeServices.layer),
  );
const layer = layerWith(folders);

const seed = Effect.gen(function* () {
  yield* Ref.set(launches, []);
  yield* Ref.set(launchedProjects, []);
  yield* Ref.set(removedPaths, []);
  const sql = yield* SqlClient.SqlClient;
  // Scratch is the managed No project workspace, not an unlinked repository.
  // Membership recognizes its configured root, never the arbitrary project id.
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${scratch}, 'No project', ${`${testHome}/scratch`}, '[]', ${at}, ${at})`;
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${repo}, 'web', '/repos/web', '[]', ${at}, ${at})`;
  const service = yield* Labels.ProjectLabelService;
  return (yield* service.create({ name: "Spawn" })).label.id;
});

const labelOf = (id: ProjectLabelId) =>
  Labels.ProjectLabelService.pipe(
    Effect.flatMap((service) => service.read(id)),
    Effect.map(({ label }) => label),
  );

describe("ProjectHome project chat", () => {
  it.effect("creates the chat on first call and returns the same thread afterwards", () =>
    Effect.gen(function* () {
      const id = yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      const first = yield* home.ensureChat({ id, modelSelection });
      expect(first).toEqual({ threadId: ProjectHome.projectChatThreadIdFor(id), created: true });
      const again = yield* Effect.all(
        [home.ensureChat({ id, modelSelection }), home.ensureChat({ id, modelSelection })],
        { concurrency: "unbounded" },
      );
      expect(again).toEqual([
        { threadId: first.threadId, created: false },
        { threadId: first.threadId, created: false },
      ]);
      expect(yield* Ref.get(launches)).toEqual([first.threadId]);
      expect(yield* Ref.get(launchedProjects)).toEqual([scratch]);
      const label = yield* labelOf(id);
      expect(label.projectChatThreadId).toBe(first.threadId);
      // The project chat is filed in the project but not counted as one of its chats.
      expect(label.threadCount).toBe(0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the project chat in its project", () =>
    Effect.gen(function* () {
      const id = yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      const service = yield* Labels.ProjectLabelService;
      const other = (yield* service.create({ name: "Elsewhere" })).label.id;
      const chat = yield* home.ensureChat({ id, modelSelection });
      for (const folderId of [other, null]) {
        const refused = yield* service
          .moveThread({ threadId: chat.threadId, folderId })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({ reason: "project_chat", projectName: "Spawn" });
      }
      // Re-filing it in its own project stays allowed.
      expect(yield* service.moveThread({ threadId: chat.threadId, folderId: id })).toEqual({
        threadId: chat.threadId,
        projectFolderId: id,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates concurrent first visits once", () =>
    Effect.gen(function* () {
      const id = yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      const results = yield* Effect.all(
        Array.from({ length: 4 }, () => home.ensureChat({ id, modelSelection })),
        { concurrency: "unbounded" },
      );
      expect(new Set(results.map((result) => result.threadId)).size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(yield* Ref.get(launches)).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("replaces a deleted project chat with a new thread", () =>
    Effect.gen(function* () {
      const id = yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* home.ensureChat({ id, modelSelection });
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${at} WHERE thread_id = ${first.threadId}`;
      const replaced = yield* home.ensureChat({ id, modelSelection });
      expect(replaced.created).toBe(true);
      expect(replaced.threadId).not.toBe(first.threadId);
      expect((yield* labelOf(id)).projectChatThreadId).toBe(replaced.threadId);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adopts a launched chat whose recording was lost", () =>
    Effect.gen(function* () {
      const id = yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      yield* insertThread(ProjectHome.projectChatThreadIdFor(id));
      const result = yield* home.ensureChat({ id, modelSelection });
      expect(result).toEqual({ threadId: ProjectHome.projectChatThreadIdFor(id), created: false });
      expect(yield* Ref.get(launches)).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs the chat in a linked repository where Scratch is unavailable", () =>
    Effect.gen(function* () {
      const id = yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      const error = yield* home.ensureChat({ id, modelSelection }).pipe(Effect.flip);
      expect(error.message).toBe("Add a repository to Spawn to talk to it on this environment.");
      expect(yield* Ref.get(launches)).toEqual([]);
      yield* home.addRepository({ id, repositoryId: repo });
      const created = yield* home.ensureChat({ id, modelSelection });
      expect(created.created).toBe(true);
      expect(yield* Ref.get(launchedProjects)).toEqual([repo]);
      expect((yield* labelOf(id)).projectChatThreadId).toBe(created.threadId);
    }).pipe(Effect.provide(layerWith(noScratch))),
  );

  it.effect("fails for a project that does not exist", () =>
    Effect.gen(function* () {
      yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      const error = yield* home
        .ensureChat({ id: "label:missing" as ProjectLabelId, modelSelection })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProjectLabelError);
    }).pipe(Effect.provide(layer)),
  );
});

describe("Project archiving", () => {
  it.effect("archives and unarchives a project, keeping its chat and threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = yield* seed;
        const home = yield* ProjectHome.ProjectHome;
        const service = yield* Labels.ProjectLabelService;
        const chat = yield* home.ensureChat({ id, modelSelection });
        const filed = ThreadId.make("thread:filed");
        yield* insertThread(filed);
        yield* service.moveThread({ threadId: filed, folderId: id });
        const live = yield* service.subscribe().pipe(Stream.toQueue({ capacity: 16 }));
        expect((yield* Queue.take(live)).labels[0]?.archivedAt).toBeUndefined();

        const archived = (yield* service.archive(id)).label;
        expect(archived.archivedAt).toEqual(expect.any(String));
        expect((yield* Queue.take(live)).labels[0]?.archivedAt).toBe(archived.archivedAt);
        // Nothing filed in it moves: the chat, the thread and its count stay.
        expect(archived.projectChatThreadId).toBe(chat.threadId);
        expect(archived.threadCount).toBe(1);
        expect((yield* service.getThreadLabels(filed)).labels.map((tag) => tag.labelId)).toEqual([
          id,
        ]);
        // Archiving again keeps the original date.
        expect((yield* service.archive(id)).label.archivedAt).toBe(archived.archivedAt);

        const restored = (yield* service.unarchive(id)).label;
        expect(restored.archivedAt).toBeUndefined();
        expect(restored.projectChatThreadId).toBe(chat.threadId);
        expect((yield* service.unarchive(id)).label.archivedAt).toBeUndefined();
        expect((yield* labelOf(id)).archivedAt).toBeUndefined();
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("refuses filing into an archived project until it is unarchived", () =>
    Effect.gen(function* () {
      const id = yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      const service = yield* Labels.ProjectLabelService;
      const other = (yield* service.create({ name: "Other" })).label.id;
      const chat = yield* home.ensureChat({ id, modelSelection });
      const filed = ThreadId.make("thread:filed");
      const loose = ThreadId.make("thread:loose");
      yield* insertThread(filed);
      yield* insertThread(loose);
      yield* service.moveThread({ threadId: filed, folderId: id });
      yield* service.archive(id);

      const refused = yield* service
        .moveThread({ threadId: loose, folderId: id })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("archived");
      expect(refused.message).toBe("Spawn is archived. Unarchive it to add to it.");
      expect(
        (yield* service.setThreadLabels({ threadId: loose, labelIds: [id] }).pipe(Effect.flip))
          .reason,
      ).toBe("archived");
      expect((yield* home.addRepository({ id, repositoryId: repo }).pipe(Effect.flip)).reason).toBe(
        "archived",
      );
      expect((yield* service.getThreadLabels(loose)).labels).toEqual([]);
      expect((yield* labelOf(id)).repositoryIds).toEqual([]);

      // What is already filed keeps working: re-filing in place and reopening
      // the project chat succeed without launching anything.
      expect(yield* service.moveThread({ threadId: filed, folderId: id })).toEqual({
        threadId: filed,
        projectFolderId: id,
      });
      expect(yield* home.ensureChat({ id, modelSelection })).toEqual({
        threadId: chat.threadId,
        created: false,
      });
      expect(yield* Ref.get(launches)).toEqual([chat.threadId]);

      // Moving out is allowed; moving back in is not.
      expect(
        (yield* service.moveThread({ threadId: filed, folderId: other })).projectFolderId,
      ).toBe(other);
      expect(
        (yield* service.moveThread({ threadId: filed, folderId: id }).pipe(Effect.flip)).reason,
      ).toBe("archived");
      expect((yield* service.moveThread({ threadId: filed, folderId: null })).projectFolderId).toBe(
        null,
      );

      yield* service.unarchive(id);
      expect((yield* service.moveThread({ threadId: loose, folderId: id })).projectFolderId).toBe(
        id,
      );
      expect((yield* home.addRepository({ id, repositoryId: repo })).action).toBe("added");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails to archive a project that does not exist", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Labels.ProjectLabelService;
      const error = yield* service.archive("label:missing" as ProjectLabelId).pipe(Effect.flip);
      expect(error.reason).toBe("not_found");
    }).pipe(Effect.provide(layer)),
  );
});

describe("ProjectHome configuration changes", () => {
  it.effect("adds and removes a repository, publishing each change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = yield* seed;
        const home = yield* ProjectHome.ProjectHome;
        const service = yield* Labels.ProjectLabelService;
        const live = yield* service.subscribe().pipe(Stream.toQueue({ capacity: 16 }));
        expect((yield* Queue.take(live)).labels[0]?.repositoryIds).toEqual([]);
        expect(yield* home.addRepository({ id, repositoryId: repo })).toEqual({
          projectFolderId: id,
          kind: "repository",
          label: "web",
          action: "added",
        });
        expect((yield* Queue.take(live)).labels[0]?.repositoryIds).toEqual([repo]);
        expect((yield* home.addRepository({ id, repositoryId: repo })).action).toBe("unchanged");
        expect((yield* home.removeRepository({ id, repositoryId: repo })).action).toBe("removed");
        expect((yield* Queue.take(live)).labels[0]?.repositoryIds).toEqual([]);
        expect((yield* home.removeRepository({ id, repositoryId: repo })).action).toBe("unchanged");
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("links and unlinks GitHub sources", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = yield* seed;
        const home = yield* ProjectHome.ProjectHome;
        const service = yield* Labels.ProjectLabelService;
        const live = yield* service.subscribe().pipe(Stream.toQueue({ capacity: 16 }));
        yield* Queue.take(live);
        const link = { kind: "github-repo" as const, owner: "aflekkas", repo: "cogenly" };
        expect(yield* home.linkSource({ id, link })).toEqual({
          projectFolderId: id,
          kind: "source",
          label: "aflekkas/cogenly",
          action: "added",
        });
        expect((yield* Queue.take(live)).labels[0]?.sourceLinks).toEqual([link]);
        expect((yield* home.linkSource({ id, link })).action).toBe("unchanged");
        const owner = { kind: "github-owner" as const, owner: "aflekkas" };
        expect((yield* home.unlinkSource({ id, link: owner })).action).toBe("unchanged");
        expect((yield* home.unlinkSource({ id, link })).action).toBe("removed");
        expect((yield* Queue.take(live)).labels[0]?.sourceLinks).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("sets, updates and clears instructions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = yield* seed;
        const home = yield* ProjectHome.ProjectHome;
        const service = yield* Labels.ProjectLabelService;
        expect(yield* home.instructions(id)).toEqual({ projectFolderId: id, instructions: "" });
        const live = yield* service.subscribe().pipe(Stream.toQueue({ capacity: 16 }));
        yield* Queue.take(live);
        expect((yield* home.setInstructions({ id, instructions: "Use pnpm." })).action).toBe(
          "added",
        );
        expect((yield* Queue.take(live)).labels[0]?.instructions).toBe("Use pnpm.");
        expect((yield* home.setInstructions({ id, instructions: "Use pnpm." })).action).toBe(
          "unchanged",
        );
        expect((yield* home.setInstructions({ id, instructions: "Use bun." })).action).toBe(
          "updated",
        );
        expect((yield* home.setInstructions({ id, instructions: "" })).action).toBe("removed");
        expect((yield* home.overview(id)).instructions).toBe("");
        // A description edit keeps the instructions.
        yield* home.setInstructions({ id, instructions: "Keep me." });
        yield* service.update({ id, description: "Short subtitle" });
        expect((yield* labelOf(id)).instructions).toBe("Keep me.");
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("writes and removes project files with receipts", () =>
    Effect.gen(function* () {
      const id = yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      expect(yield* home.writeFile({ id, title: "brief", text: "hello" })).toEqual({
        projectFolderId: id,
        kind: "file",
        label: "Resources/brief.md",
        action: "added",
      });
      expect((yield* home.removeFile({ id, path: "Resources/brief.md" })).action).toBe("removed");
      expect((yield* home.removeFile({ id, path: "Resources/brief.md" })).action).toBe("unchanged");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists repositories by title in the overview", () =>
    Effect.gen(function* () {
      const id = yield* seed;
      const home = yield* ProjectHome.ProjectHome;
      yield* home.addRepository({ id, repositoryId: repo });
      expect(yield* home.overview(id)).toMatchObject({
        projectFolderId: id,
        name: "Spawn",
        repositories: [{ id: repo, title: "web" }],
        projectChatThreadId: null,
      });
    }).pipe(Effect.provide(layer)),
  );
});
