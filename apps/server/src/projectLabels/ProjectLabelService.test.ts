import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Facts from "../context/FactService.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProjectId, ProjectLabelId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Labels from "./ProjectLabelService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const persistence = Events.layer.pipe(Layer.provideMerge(database));
const layer = Labels.layer.pipe(Layer.provideMerge(persistence), Layer.provide(NodeServices.layer));
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
      expect((yield* service.suggestLabels(threadId)).labels).toEqual([]);
      expect(
        (yield* service.reviewSuggestion({ threadId, labelId: a, accept: true }).pipe(Effect.flip))
          .reason,
      ).toBe("not_suggested");
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
        expect((yield* projections.getThreadShell(threadId))?.projectFolderId).toBeNull();
        yield* folders.linkRepository({ labelId: a, repositoryId: repoA });
        expect((yield* projections.getShellSnapshot()).threads[0]?.projectFolderId).toBe(a);
        expect((yield* projections.getThreadProjection(threadId)).thread.projectFolderId).toBe(a);
        yield* folders.moveThread({ threadId, folderId: b });
        expect((yield* projections.getThreadShell(threadId))?.projectFolderId).toBe(b);
        yield* folders.delete(b);
        expect((yield* projections.getThreadShell(threadId))?.projectFolderId).toBe(a);
        yield* folders.unlinkRepository({ labelId: a, repositoryId: repoA });
        expect(
          (yield* projections.getThreadProjection(threadId)).thread.projectFolderId,
        ).toBeNull();
      }).pipe(Effect.provide(layer)),
  );
  it.effect("removes deleted label metadata from facts while preserving change history", () =>
    Effect.gen(function* () {
      yield* seed;
      const labels = yield* Labels.ProjectLabelService;
      const facts = yield* Facts.FactService.pipe(
        Effect.provide(Facts.layer.pipe(Layer.provide(NodeServices.layer))),
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
});
