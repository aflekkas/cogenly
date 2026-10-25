// @effect-diagnostics nodeBuiltinImport:off - the checkout-state test reads real folders on disk.
import { layerIdentity as layerSharedIdentity } from "../sync/testkit.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Facts from "../context/FactService.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProjectId,
  ProjectLabelId,
  ThreadId,
  type ProjectCloneSnapshot,
  type ProjectLabelWithRepositories,
} from "@cogenly/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as GitHubRest from "@cogenly/source-control-github/server/GitHubRest";
import * as Labels from "./ProjectLabelService.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectConfigFileLoader from "../project/ProjectConfigFileLoader.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const persistence = Events.layer.pipe(Layer.provideMerge(database));
const layer = Labels.layer
  .pipe(Layer.provide(layerSharedIdentity))
  .pipe(Layer.provideMerge(persistence), Layer.provide(NodeServices.layer));
const threadId = ThreadId.make("chat");
const repoA = ProjectId.make("repo-a"),
  repoB = ProjectId.make("repo-b");
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const repo of [repoA, repoB])
    yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${repo}, ${repo}, ${`/repos/${repo}`}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${threadId}, ${repoA}, 'Chat', 'codex', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}')`;
});
describe("project labels", () => {
  it.effect(
    "counts only visible chats and Work, preserving independent forks and excluding archives and child threads",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const folders = yield* Labels.ProjectLabelService;
        const folder = (yield* folders.create({ name: "Folder" })).label.id;
        yield* folders.linkRepository({ labelId: folder, repositoryId: repoA });
        const at = "2026-01-01T00:00:00.000Z";
        for (const [id, payload, archived, deleted] of [
          ["root-chat", { surface: "chat" }, false, false],
          [
            "fork",
            {
              surface: "work",
              lineage: { parentThreadId: threadId, relationshipToParent: "fork" },
            },
            false,
            false,
          ],
          ["agent-work", { agent: { id: "agent:owner", role: "work" } }, false, false],
          [
            "subagent",
            { lineage: { parentThreadId: threadId, relationshipToParent: "subagent" } },
            false,
            false,
          ],
          ["archived", { surface: "work" }, true, false],
          ["deleted", { surface: "work" }, false, true],
          ["conversation", { agent: { id: "agent:owner", role: "conversation" } }, false, false],
          ["registered-conversation", {}, false, false],
        ] as const) {
          yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,archived_at,deleted_at) VALUES (${id},${repoA},${id},'codex','full-access','default',${at},${at},${JSON.stringify(payload)},${archived ? at : null},${deleted ? at : null})`;
        }
        yield* sql`INSERT INTO agents(agent_id,conversation_thread_id,payload_json,enabled) VALUES ('agent:owner','registered-conversation','{}',1)`;
        yield* folders.moveThread({ threadId: ThreadId.make("root-chat"), folderId: folder });
        expect((yield* folders.read(folder)).label.threadCount).toBe(4);
        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at=${at} WHERE thread_id=${threadId}`;
        expect((yield* folders.list()).labels[0]?.threadCount).toBe(3);
        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at=NULL WHERE thread_id=${threadId}`;
        expect((yield* folders.list()).labels[0]?.threadCount).toBe(4);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("creates, updates, clears fields and links multiple repositories independently", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Labels.ProjectLabelService;
      const { label } = yield* service.create({
        name: "Spawn",
        color: "green",
        description: "Operations",
      });
      yield* service.linkRepository({ labelId: label.id, repositoryId: repoA });
      yield* service.linkRepository({ labelId: label.id, repositoryId: repoB });
      yield* service.linkRepository({ labelId: label.id, repositoryId: repoB });
      expect((yield* service.list()).labels[0]?.repositoryIds).toEqual([repoA, repoB]);
      const edited = yield* service.update({ id: label.id, name: "Spawn Partners", color: null });
      expect(edited.label).toMatchObject({
        name: "Spawn Partners",
        description: "Operations",
        createdAt: label.createdAt,
      });
      expect(edited.label.color).toBeUndefined();
      yield* service.unlinkRepository({ labelId: label.id, repositoryId: repoA });
      expect((yield* service.list()).labels[0]?.repositoryIds).toEqual([repoB]);
      expect(yield* service.delete(label.id)).toEqual({ deleted: true });
      expect(yield* service.delete(label.id)).toEqual({ deleted: false });
      expect((yield* service.list()).labels).toEqual([]);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM label_repositories`).toEqual([]);
      expect((yield* sql`SELECT * FROM project_label_audit`).length).toBeGreaterThan(5);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stores the directory name on link and marks a repo with no remote local-only", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Labels.ProjectLabelService;
      const { label } = yield* service.create({ name: "Spawn" });
      yield* service.linkRepository({ labelId: label.id, repositoryId: repoA });
      // No identity resolver in this layer: the directory name still lands,
      // and the remote stays null (local-only) instead of guessing.
      expect((yield* service.read(label.id)).label.repositories).toEqual([
        { repositoryId: repoA, remote: null, directoryName: "repo-a", checkout: "missing" },
      ]);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT remote, directory_name FROM label_repositories`).toEqual([
        { remote: null, directory_name: "repo-a" },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stores the normalized remote on link and backfills links that predate it", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Labels.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const { label } = yield* service.create({ name: "Spawn" });
      yield* service.linkRepository({ labelId: label.id, repositoryId: repoB });
      expect((yield* service.read(label.id)).label.repositories).toEqual([
        {
          repositoryId: repoB,
          remote: "github.com/spawn/repo-b",
          // No home owner linked: another owner's repository is `<owner>/<repo>`.
          directoryName: "spawn/repo-b",
          checkout: "missing",
        },
      ]);
      // A link written before portable identity backfills from the remote
      // on read, and the backfill is stored.
      yield* sql`UPDATE label_repositories SET remote = NULL, directory_name = NULL WHERE repository_id = ${repoB}`;
      expect((yield* service.read(label.id)).label.repositories).toEqual([
        {
          repositoryId: repoB,
          remote: "github.com/spawn/repo-b",
          // No home owner linked: another owner's repository is `<owner>/<repo>`.
          directoryName: "spawn/repo-b",
          checkout: "missing",
        },
      ]);
      expect(yield* sql`SELECT remote, directory_name FROM label_repositories`).toEqual([
        { remote: "github.com/spawn/repo-b", directory_name: "spawn/repo-b" },
      ]);
      // A repository whose checkout has no remote stays local-only.
      yield* service.linkRepository({ labelId: label.id, repositoryId: repoA });
      expect(
        (yield* service.read(label.id)).label.repositories?.find(
          (link) => link.repositoryId === repoA,
        ),
      ).toEqual({
        repositoryId: repoA,
        remote: null,
        directoryName: "repo-a",
        checkout: "missing",
      });
    }).pipe(
      Effect.provide(
        Labels.layer.pipe(Layer.provide(layerSharedIdentity)).pipe(
          Layer.provideMerge(
            Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
              resolve: (cwd) =>
                Effect.succeed(
                  cwd.endsWith("repo-b")
                    ? {
                        canonicalKey: "github.com/spawn/repo-b",
                        locator: {
                          source: "git-remote" as const,
                          remoteName: "origin",
                          remoteUrl: "git@github.com:Spawn/Repo-B.git",
                        },
                        rootPath: cwd,
                      }
                    : null,
                ),
            }),
          ),
          Layer.provideMerge(persistence),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("enforces one folder and derives work membership while explicit filing wins", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Labels.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const a = (yield* service.create({ name: "A" })).label.id;
      const b = (yield* service.create({ name: "B" })).label.id;
      yield* service.linkRepository({ labelId: a, repositoryId: repoA });
      expect((yield* service.getThreadLabels(threadId)).labels.map((t) => t.labelId)).toEqual([a]);
      expect((yield* service.list()).labels.find((l) => l.id === a)?.threadCount).toBe(1);
      expect(yield* service.moveThread({ threadId, folderId: b })).toEqual({
        threadId,
        projectFolderId: b,
      });
      expect((yield* service.list()).labels.find((l) => l.id === a)?.threadCount).toBe(0);
      expect((yield* service.list()).labels.find((l) => l.id === b)?.threadCount).toBe(1);
      // Repository moves affect only threads without explicit filing.
      yield* service.linkRepository({ labelId: b, repositoryId: repoA });
      expect((yield* service.read(a)).label.repositoryIds).toEqual([]);
      yield* service.linkRepository({ labelId: a, repositoryId: repoA });
      expect((yield* service.getThreadLabels(threadId)).labels[0]?.labelId).toBe(b);
      expect(yield* service.moveThread({ threadId, folderId: null })).toEqual({
        threadId,
        projectFolderId: a,
      });
      const bad = yield* service.setThreadLabels({ threadId, labelIds: [a, b] }).pipe(Effect.flip);
      expect(bad.reason).toBe("invalid_membership");
      expect((yield* service.getThreadLabels(threadId)).labels[0]?.labelId).toBe(a);
      expect(
        (yield* service
          .moveThread({ threadId, folderId: ProjectLabelId.make("missing") })
          .pipe(Effect.flip)).reason,
      ).toBe("not_found");
      expect((yield* service.getThreadLabels(threadId)).labels[0]?.labelId).toBe(a);
      // Chats do not inherit a folder even if they have a repository record.
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"surface":"chat"}' WHERE thread_id = ${threadId}`;
      expect((yield* service.getThreadLabels(threadId)).labels).toEqual([]);
      expect(yield* service.moveThread({ threadId, folderId: b })).toEqual({
        threadId,
        projectFolderId: b,
      });
      yield* service.delete(b);
      expect((yield* service.getThreadLabels(threadId)).labels).toEqual([]);
      expect((yield* sql`SELECT * FROM projection_projects`).length).toBe(2);
      expect((yield* sql`SELECT * FROM orchestration_v2_projection_threads`).length).toBe(1);
      yield* service.moveThread({ threadId, folderId: a });
      yield* service.moveThread({ threadId, folderId: null });
      // No-repository work (the app's scratch project) can be explicitly filed.
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"surface":"work"}' WHERE thread_id = ${threadId}`;
      yield* service.unlinkRepository({ labelId: a, repositoryId: repoA });
      expect(yield* service.moveThread({ threadId, folderId: a })).toEqual({
        threadId,
        projectFolderId: a,
      });
      expect(yield* service.moveThread({ threadId, folderId: null })).toEqual({
        threadId,
        projectFolderId: null,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("re-homes chats with turns into a project, keeping the same thread", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Labels.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const folder = (yield* service.create({ name: "Folder" })).label.id;
      const other = (yield* service.create({ name: "Other" })).label.id;
      const at = "2026-01-01T00:00:00.000Z";
      for (const [id, payload] of [
        ["turned-chat", { surface: "chat" }],
        ["turned-work", { surface: "work" }],
        ["turned-unfiled-chat", { surface: "chat" }],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${id},${repoA},${id},'codex','full-access','default',${at},${at},${JSON.stringify(payload)})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES (${`${id}:run`},${id},1,'codex','completed',${at},'{}')`;
      }
      // A chat with turns re-files in place: same thread id, new folder.
      expect(
        yield* service.moveThread({ threadId: ThreadId.make("turned-chat"), folderId: folder }),
      ).toEqual({ threadId: ThreadId.make("turned-chat"), projectFolderId: folder });
      expect(
        (yield* service.getThreadLabels(ThreadId.make("turned-chat"))).labels.map(
          (tag) => tag.labelId,
        ),
      ).toEqual([folder]);
      // Moving between projects keeps the same thread too.
      expect(
        yield* service.moveThread({ threadId: ThreadId.make("turned-chat"), folderId: other }),
      ).toEqual({ threadId: ThreadId.make("turned-chat"), projectFolderId: other });
      // Unfiling stays allowed, and Work keeps its repo-following assignment.
      yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES ('turned-unfiled-chat',${folder})`;
      expect(
        yield* service.moveThread({
          threadId: ThreadId.make("turned-unfiled-chat"),
          folderId: null,
        }),
      ).toEqual({ threadId: ThreadId.make("turned-unfiled-chat"), projectFolderId: null });
      expect(
        yield* service.moveThread({ threadId: ThreadId.make("turned-work"), folderId: folder }),
      ).toEqual({ threadId: ThreadId.make("turned-work"), projectFolderId: folder });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses to move a thread while a run is active in it", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Labels.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const folder = (yield* service.create({ name: "Folder" })).label.id;
      const at = "2026-01-01T00:00:00.000Z";
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('active-chat',${repoA},'active-chat','codex','full-access','default',${at},${at},'{"surface":"chat"}')`;
      for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
        yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id = 'active-chat'`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('active-chat:run','active-chat',1,'codex',${status},${at},'{}')`;
        expect(
          (yield* service
            .moveThread({ threadId: ThreadId.make("active-chat"), folderId: folder })
            .pipe(Effect.flip)).reason,
        ).toBe("thread_active");
        // The refused move leaves the filing untouched.
        expect((yield* service.getThreadLabels(ThreadId.make("active-chat"))).labels).toEqual([]);
      }
      // Once the run settles, the same move goes through.
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE thread_id = 'active-chat'`;
      expect(
        yield* service.moveThread({ threadId: ThreadId.make("active-chat"), folderId: folder }),
      ).toEqual({ threadId: ThreadId.make("active-chat"), projectFolderId: folder });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("re-files an agent's conversation with turns instead of requiring a fork", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Labels.ProjectLabelService;
      const sql = yield* SqlClient.SqlClient;
      const first = (yield* service.create({ name: "First" })).label.id;
      const second = (yield* service.create({ name: "Second" })).label.id;
      const at = "2026-01-01T00:00:00.000Z";
      // One annotated conversation, and one migrated shell that only the
      // agents row identifies.
      for (const [id, payload] of [
        ["annotated-conversation", { agent: { id: "agent:annotated", role: "conversation" } }],
        ["migrated-conversation", {}],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${id},${repoA},${id},'codex','full-access','default',${at},${at},${JSON.stringify(payload)})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES (${`${id}:run`},${id},1,'codex','completed',${at},'{}')`;
      }
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled) VALUES ('agent:migrated', 'migrated-conversation', '{}', 1)`;
      for (const id of ["annotated-conversation", "migrated-conversation"]) {
        const conversation = ThreadId.make(id);
        expect(yield* service.moveThread({ threadId: conversation, folderId: first })).toEqual({
          threadId: conversation,
          projectFolderId: first,
        });
        // Moving between projects re-files the same thread, never a fork.
        expect(yield* service.moveThread({ threadId: conversation, folderId: second })).toEqual({
          threadId: conversation,
          projectFolderId: second,
        });
        expect(yield* service.moveThread({ threadId: conversation, folderId: null })).toEqual({
          threadId: conversation,
          projectFolderId: null,
        });
      }
      // An ordinary chat with turns re-homes the same way now.
      yield* sql`DELETE FROM agents WHERE agent_id = 'agent:migrated'`;
      expect(
        yield* service.moveThread({
          threadId: ThreadId.make("migrated-conversation"),
          folderId: first,
        }),
      ).toEqual({ threadId: ThreadId.make("migrated-conversation"), projectFolderId: first });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "cascades label and thread deletion while preserving tags across projection repair",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* Labels.ProjectLabelService;
        const sql = yield* SqlClient.SqlClient;
        const a = (yield* service.create({ name: "A" })).label.id;
        const b = (yield* service.create({ name: "B" })).label.id;
        yield* service.setThreadLabels({ threadId, labelIds: [b] });
        yield* service.delete(a);
        expect((yield* service.getThreadLabels(threadId)).labels.map((t) => t.labelId)).toEqual([
          b,
        ]);
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE thread_id = ${threadId}`;
        expect(yield* sql`SELECT * FROM thread_project_labels`).toEqual([]);
        expect(
          (yield* service.setThreadLabels({ threadId, labelIds: [b] }).pipe(Effect.flip)).reason,
        ).toBe("not_found");
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
        yield* service.setThreadLabels({ threadId, labelIds: [b] });
        // ProjectionMaintenance repairs thread projections by deleting/replaying them.
        // That is not domain deletion and must never erase independent label state.
        yield* sql`CREATE TEMP TABLE saved_thread AS SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads SELECT * FROM saved_thread`;
        expect((yield* service.getThreadLabels(threadId)).labels[0]?.labelId).toBe(b);
        yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE thread_id = ${threadId}`;
        expect(yield* sql`SELECT * FROM thread_project_labels`).toEqual([]);
        yield* service.linkRepository({ labelId: b, repositoryId: repoA });
        yield* sql`UPDATE projection_projects SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE project_id = ${repoA}`;
        expect((yield* service.list()).labels[0]?.repositoryIds).toEqual([]);
        expect(
          (yield* service.linkRepository({ labelId: b, repositoryId: repoA }).pipe(Effect.flip))
            .reason,
        ).toBe("not_found");
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "refreshes live repository links after the existing repository deletion lifecycle commits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* seed;
          const service = yield* Labels.ProjectLabelService;
          const events = yield* Events.OrchestrationEventStore;
          const sql = yield* SqlClient.SqlClient;
          const label = (yield* service.create({ name: "Linked" })).label;
          yield* service.linkRepository({ labelId: label.id, repositoryId: repoA });
          const live = yield* service.subscribe().pipe(Stream.toQueue({ capacity: 16 }));
          expect((yield* Queue.take(live)).labels[0]?.repositoryIds).toEqual([repoA]);
          const deletedAt = "2026-01-02T00:00:00.000Z";
          const event = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE projection_projects SET deleted_at = ${deletedAt} WHERE project_id = ${repoA}`;
              return yield* events.appendProjectEvent({
                eventId: EventId.make("repository-deleted"),
                type: "project.deleted",
                aggregateKind: "project",
                aggregateId: repoA,
                occurredAt: deletedAt,
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: { projectId: repoA, deletedAt },
              });
            }),
          );
          yield* events.publishCommitted([event]);
          expect((yield* Queue.take(live)).labels[0]?.repositoryIds).toEqual([]);
        }),
      ).pipe(Effect.provide(layer)),
  );

  it.effect("streams committed label and thread-tag changes to connected clients", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed;
        const service = yield* Labels.ProjectLabelService;
        const list = yield* service.subscribe().pipe(Stream.toQueue({ capacity: 16 }));
        const thread = yield* service
          .subscribeThreadLabels(threadId)
          .pipe(Stream.toQueue({ capacity: 16 }));
        expect((yield* Queue.take(list)).labels).toEqual([]);
        expect((yield* Queue.take(thread)).labels).toEqual([]);
        const label = (yield* service.create({ name: "Live" })).label;
        expect((yield* Queue.take(list)).labels[0]?.id).toBe(label.id);
        yield* Queue.take(thread); // Label-only changes invalidate open tag queries too.
        yield* service.setThreadLabels({ threadId, labelIds: [label.id] });
        expect((yield* Queue.take(thread)).labels[0]?.labelId).toBe(label.id);
        yield* service.delete(label.id);
        expect((yield* Queue.take(thread)).labels).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
  );
  it.effect("streams derived and explicitly filed folders without confirmation state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seed;
        const service = yield* Labels.ProjectLabelService;
        const a = (yield* service.create({ name: "A" })).label.id;
        const b = (yield* service.create({ name: "B" })).label.id;
        const live = yield* service
          .subscribeConfirmedThreadLabels()
          .pipe(Stream.toQueue({ capacity: 16 }));
        expect((yield* Queue.take(live)).labels).toEqual([]);
        yield* service.linkRepository({ labelId: a, repositoryId: repoA });
        expect((yield* Queue.take(live)).labels.map((t) => t.labelId)).toEqual([a]);
        yield* service.setThreadLabels({ threadId, labelIds: [b] }, false);
        expect((yield* Queue.take(live)).labels.map((t) => t.labelId)).toEqual([b]);
        yield* service.moveThread({ threadId, folderId: null });
        expect((yield* Queue.take(live)).labels.map((t) => t.labelId)).toEqual([a]);
        yield* service.unlinkRepository({ labelId: a, repositoryId: repoA });
        expect((yield* Queue.take(live)).labels).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
  );
  it.effect(
    "carries effective folders in full projections, initial shells and per-thread shell updates",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const payload = JSON.stringify({
          id: threadId,
          projectId: repoA,
          title: "Work",
          surface: "work",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: "codex",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          forkedFrom: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
        });
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload} WHERE thread_id = ${threadId}`;
        const projections = yield* Projections.ProjectionStoreV2.pipe(
          Effect.provide(Projections.layer),
        );
        const folders = yield* Labels.ProjectLabelService;
        const a = (yield* folders.create({ name: "A" })).label.id;
        const b = (yield* folders.create({ name: "B" })).label.id;
        expect(yield* projections.getThreadShell(threadId)).toMatchObject({
          projectFolderId: null,
          projectFolderSource: null,
        });
        yield* folders.linkRepository({ labelId: a, repositoryId: repoA });
        expect((yield* projections.getShellSnapshot()).threads[0]).toMatchObject({
          projectFolderId: a,
          projectFolderSource: "repository",
        });
        expect((yield* projections.getThreadProjection(threadId)).thread).toMatchObject({
          projectFolderId: a,
          projectFolderSource: "repository",
        });
        // A move to the same effective folder still changes its filing source.
        yield* folders.moveThread({ threadId, folderId: a });
        expect(yield* projections.getThreadShell(threadId)).toMatchObject({
          projectFolderId: a,
          projectFolderSource: "explicit",
        });
        yield* folders.moveThread({ threadId, folderId: null });
        yield* folders.linkRepository({ labelId: b, repositoryId: repoA });
        expect(yield* projections.getThreadShell(threadId)).toMatchObject({
          projectFolderId: b,
          projectFolderSource: "repository",
        });
        yield* folders.moveThread({ threadId, folderId: a });
        yield* folders.linkRepository({ labelId: a, repositoryId: repoA });
        yield* folders.linkRepository({ labelId: b, repositoryId: repoA });
        expect((yield* projections.getThreadProjection(threadId)).thread).toMatchObject({
          projectFolderId: a,
          projectFolderSource: "explicit",
        });
        yield* folders.delete(a);
        expect(yield* projections.getThreadShell(threadId)).toMatchObject({
          projectFolderId: b,
          projectFolderSource: "repository",
        });
        yield* folders.unlinkRepository({ labelId: b, repositoryId: repoA });
        expect((yield* projections.getThreadProjection(threadId)).thread).toMatchObject({
          projectFolderId: null,
          projectFolderSource: null,
        });
        yield* folders.linkRepository({ labelId: b, repositoryId: repoA });
        const liveCounts = yield* folders.subscribe().pipe(Stream.toQueue({ capacity: 16 }));
        expect((yield* Queue.take(liveCounts)).labels[0]?.threadCount).toBe(1);
        const events = yield* Events.OrchestrationEventStore;
        const thread = (yield* projections.getThreadProjection(threadId)).thread;
        for (const archived of [true, false]) {
          const event = {
            id: EventId.make(archived ? "folder-archive" : "folder-unarchive"),
            type: archived ? ("thread.archived" as const) : ("thread.unarchived" as const),
            threadId,
            occurredAt: thread.updatedAt,
            payload: { ...thread, archivedAt: archived ? thread.updatedAt : null },
          };
          const committed = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* projections.apply(event);
              return yield* events.appendAgentEvents({ events: [event] });
            }),
          );
          yield* events.publishCommitted(committed);
          expect((yield* Queue.take(liveCounts)).labels[0]?.threadCount).toBe(archived ? 0 : 1);
          if (archived)
            expect((yield* projections.getShellSnapshot()).archivedThreads[0]).toMatchObject({
              projectFolderId: b,
              projectFolderSource: "repository",
            });
        }
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect("removes deleted label metadata from facts while preserving change history", () =>
    Effect.gen(function* () {
      yield* seed;
      const labels = yield* Labels.ProjectLabelService;
      const facts = yield* Facts.FactService.pipe(
        Effect.provide(
          Facts.layer.pipe(Layer.provide(layerSharedIdentity), Layer.provide(NodeServices.layer)),
        ),
      );
      const label = (yield* labels.create({ name: "Context" })).label;
      const fact = (yield* facts.create({
        subject: "Decision",
        text: "Keep evidence",
        labelIds: [label.id],
        visibility: "labels",
        sourceRefs: [],
      })).fact;
      yield* labels.delete(label.id);
      expect((yield* facts.list({})).facts[0]?.labelIds).toEqual([]);
      const history = (yield* facts.history(fact.id)).history;
      expect(history.map((h) => h.fact.labelIds)).toEqual([[label.id], []]);
      expect((yield* facts.retract(fact.id)).fact.status).toBe("retracted");
    }).pipe(Effect.provide(layer)),
  );

  describe("repository folder names", () => {
    const remotes: Record<string, string> = {
      "/checkouts/spawn-platform": "git@github.com:Spawn-Partners/platform.git",
      "/checkouts/bartr-platform": "https://github.com/bartr-app/platform",
    };
    const repos = {
      spawn: ProjectId.make("spawn-platform"),
      bartr: ProjectId.make("bartr-platform"),
      notes: ProjectId.make("notes"),
    };
    const naming = (viewer: string | null) =>
      Labels.layer.pipe(Layer.provide(layerSharedIdentity)).pipe(
        Layer.provideMerge(
          Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
            resolve: (cwd) =>
              Effect.succeed(
                remotes[cwd] === undefined
                  ? null
                  : {
                      canonicalKey: cwd,
                      locator: {
                        source: "git-remote" as const,
                        remoteName: "origin",
                        remoteUrl: remotes[cwd],
                      },
                      rootPath: cwd,
                    },
              ),
          }),
        ),
        Layer.provideMerge(
          Layer.mock(GitHubRest.GitHubRest)({
            rest: () =>
              Effect.succeed({
                status: viewer === null ? 401 : 200,
                headers: {},
                body: JSON.stringify({ login: viewer }),
                truncated: false,
                invalidUtf8: false,
              }),
          }),
        ),
        Layer.provideMerge(persistence),
        Layer.provide(NodeServices.layer),
      );
    const seedCheckouts = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [id, root] of [
        [repos.spawn, "/checkouts/spawn-platform"],
        [repos.bartr, "/checkouts/bartr-platform"],
        [repos.notes, "/checkouts/notes"],
      ] as const)
        yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, ${id}, ${root}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    });
    const folders = (label: ProjectLabelWithRepositories) =>
      Object.fromEntries(
        (label.repositories ?? []).map((link) => [link.repositoryId, link.directoryName]),
      );

    it.effect(
      "names repositories after their remote under the home owner, whatever their folder",
      () =>
        Effect.gen(function* () {
          yield* seedCheckouts;
          const service = yield* Labels.ProjectLabelService;
          const sql = yield* SqlClient.SqlClient;
          const { label } = yield* service.create({ name: "Spawn Partners" });
          yield* service.linkSource({
            id: label.id,
            link: { kind: "github-owner", owner: "Spawn-Partners" },
          });
          for (const repositoryId of Object.values(repos))
            yield* service.linkRepository({ labelId: label.id, repositoryId });
          // Two `platform`s from two owners never collide; the local-only one
          // keeps its folder name.
          expect(folders((yield* service.read(label.id)).label)).toEqual({
            "spawn-platform": "platform",
            "bartr-platform": "bartr-app/platform",
            notes: "notes",
          });
          // Synced as derived, so every machine clones to the same place.
          expect(
            yield* sql`SELECT repository_id, directory_name FROM label_repositories ORDER BY repository_id`,
          ).toEqual([
            { repository_id: "bartr-platform", directory_name: "bartr-app/platform" },
            { repository_id: "notes", directory_name: "notes" },
            { repository_id: "spawn-platform", directory_name: "platform" },
          ]);
          // A stored name that disagrees (an older peer, a hand edit) is corrected on read.
          yield* sql`UPDATE label_repositories SET directory_name = 'spawn-platform' WHERE repository_id = ${repos.spawn}`;
          expect(folders((yield* service.read(label.id)).label)["spawn-platform"]).toBe("platform");
        }).pipe(Effect.provide(naming(null))),
    );

    it.effect("re-derives every folder when the project's owner changes", () =>
      Effect.gen(function* () {
        yield* seedCheckouts;
        const service = yield* Labels.ProjectLabelService;
        const { label } = yield* service.create({ name: "Platform" });
        const owner = (name: string) => ({
          id: label.id,
          link: { kind: "github-owner" as const, owner: name },
        });
        yield* service.linkSource(owner("Spawn-Partners"));
        yield* service.linkRepository({ labelId: label.id, repositoryId: repos.spawn });
        yield* service.linkRepository({ labelId: label.id, repositoryId: repos.bartr });
        yield* service.unlinkSource(owner("Spawn-Partners"));
        yield* service.linkSource(owner("bartr-app"));
        expect(folders((yield* service.read(label.id)).label)).toEqual({
          "spawn-platform": "spawn-partners/platform",
          "bartr-platform": "platform",
        });
      }).pipe(Effect.provide(naming(null))),
    );

    it.effect("makes the connected account the home owner of a project that links none", () =>
      Effect.gen(function* () {
        yield* seedCheckouts;
        const service = yield* Labels.ProjectLabelService;
        const { label } = yield* service.create({ name: "Personal" });
        yield* service.linkRepository({ labelId: label.id, repositoryId: repos.bartr });
        const read = (yield* service.read(label.id)).label;
        expect(read.sourceLinks).toContainEqual({ kind: "github-owner", owner: "bartr-app" });
        expect(folders(read)).toEqual({ "bartr-platform": "platform" });
      }).pipe(Effect.provide(naming("bartr-app"))),
    );
  });

  it.effect("records a checkout's icon on its link, so the project syncs it", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "label-icon-"));
    NodeFS.mkdirSync(NodePath.join(root, ".git"));
    NodeFS.mkdirSync(NodePath.join(root, "public"));
    NodeFS.writeFileSync(NodePath.join(root, "public", "favicon.svg"), "<svg/>");
    const withIcons = Labels.layer.pipe(Layer.provide(layerSharedIdentity)).pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (cwd) =>
            Effect.succeed({
              canonicalKey: cwd,
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "https://github.com/spawn-partners/platform.git",
              },
              rootPath: cwd,
            }),
        }),
      ),
      Layer.provideMerge(
        ProjectFaviconResolver.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provide(ProjectConfigFileLoader.layer),
        ),
      ),
      Layer.provideMerge(persistence),
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* Labels.ProjectLabelService;
      const repositoryId = ProjectId.make("platform");
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${repositoryId}, 'platform', ${root}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      const { label } = yield* service.create({ name: "Spawn" });
      yield* service.linkRepository({ labelId: label.id, repositoryId });
      const link = (yield* service.read(label.id)).label.repositories?.[0];
      expect(link?.iconPath).toBe("public/favicon.svg");
      const [document] = yield* sql<{
        repositories: string;
      }>`SELECT json_extract(fields_json, '$.repositories') AS repositories FROM shared_documents WHERE kind = 'project' AND id = ${label.id}`;
      expect(JSON.parse(document?.repositories ?? "[]")).toEqual([
        {
          remote: "github.com/spawn-partners/platform",
          // No owner linked and no GitHub account connected here.
          directoryName: "spawn-partners/platform",
          iconPath: "public/favicon.svg",
        },
      ]);
    }).pipe(Effect.provide(withIcons));
  });

  it.effect("reports each linked repository's checkout state on this machine", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "label-checkout-"));
    const clones = new Map<ProjectId, ProjectCloneSnapshot>();
    // The fake tracker's subscriber, handed over once the label stream listens.
    const listening = Deferred.makeUnsafe<(clones: ReadonlyArray<ProjectCloneSnapshot>) => void>();
    const snapshot = (projectId: ProjectId, phase: ProjectCloneSnapshot["phase"]) => ({
      projectId,
      remoteUrl: "https://github.com/org/repo.git",
      destinationPath: NodePath.join(root, projectId),
      repository: null,
      phase,
      stage: "receiving" as const,
      percent: null,
      detail: null,
      error: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      sequence: 0,
    });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* Labels.ProjectLabelService;
      const repos = {
        ready: ProjectId.make("ready"),
        plain: ProjectId.make("plain"),
        missing: ProjectId.make("missing"),
        cloning: ProjectId.make("cloning"),
        failed: ProjectId.make("failed"),
      };
      NodeFS.mkdirSync(NodePath.join(root, "ready", ".git"), { recursive: true });
      // A plain folder with files launches as it is, so it counts as ready.
      NodeFS.mkdirSync(NodePath.join(root, "plain"));
      NodeFS.writeFileSync(NodePath.join(root, "plain", "README.md"), "hi");
      for (const repo of Object.values(repos))
        yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${repo}, ${repo}, ${NodePath.join(root, repo)}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      const { label } = yield* service.create({ name: "Spawn" });
      for (const repo of Object.values(repos))
        yield* service.linkRepository({ labelId: label.id, repositoryId: repo });
      // Linked from another machine and never cloned here.
      yield* sql`INSERT INTO label_repositories(label_id, repository_id, remote, directory_name) VALUES (${label.id}, 'remote:github.com/org/elsewhere', 'github.com/org/elsewhere', 'elsewhere')`;
      clones.set(repos.cloning, snapshot(repos.cloning, "running"));
      clones.set(repos.failed, snapshot(repos.failed, "failed"));
      const states = (labels: ReadonlyArray<ProjectLabelWithRepositories>) =>
        Object.fromEntries(
          (labels[0]?.repositories ?? []).map((link) => [link.repositoryId, link.checkout]),
        );
      expect(states((yield* service.list()).labels)).toEqual({
        ready: "ready",
        plain: "ready",
        missing: "missing",
        cloning: "cloning",
        failed: "failed",
        "remote:github.com/org/elsewhere": "not_cloned",
      });

      // A clone changing phase re-emits the list; progress ticks do not.
      const updates = yield* Queue.unbounded<ReadonlyArray<ProjectLabelWithRepositories>>();
      yield* service.subscribe().pipe(
        Stream.runForEach((value) => Queue.offer(updates, value.labels)),
        Effect.forkScoped,
      );
      yield* Queue.take(updates);
      const emit = yield* Deferred.await(listening);
      emit([...clones.values()]);
      NodeFS.mkdirSync(NodePath.join(root, "cloning", ".git"), { recursive: true });
      clones.delete(repos.cloning);
      emit([...clones.values()]);
      expect(states(yield* Queue.take(updates)).cloning).toBe("ready");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Labels.layer.pipe(Layer.provide(layerSharedIdentity)).pipe(
          Layer.provideMerge(
            Layer.succeed(
              ProjectCloneTracker.ProjectCloneTracker,
              ProjectCloneTracker.ProjectCloneTracker.of({
                start: () => Effect.die("unused"),
                cancel: () => Effect.succeed(false),
                retry: () => Effect.succeed(false),
                discard: () => Effect.void,
                get: (projectId) => Effect.succeed(clones.get(projectId) ?? null),
                stream: Stream.callback<ReadonlyArray<ProjectCloneSnapshot>>((mailbox) =>
                  Effect.sync(() => {
                    Queue.offerUnsafe(mailbox, [...clones.values()]);
                  }).pipe(
                    Effect.andThen(
                      Deferred.succeed(listening, (next) => {
                        Queue.offerUnsafe(mailbox, next);
                      }),
                    ),
                  ),
                ),
              }),
            ),
          ),
          Layer.provideMerge(persistence),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  });
});
