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

  it.effect(
    "replaces multiple tags atomically, deduplicates, and keeps MCP assignments unconfirmed",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* Labels.ProjectLabelService;
        const a = (yield* service.create({ name: "A" })).label.id;
        const b = (yield* service.create({ name: "B" })).label.id;
        const both = yield* service.setThreadLabels({ threadId, labelIds: [a, b, a] });
        expect(both.labels).toHaveLength(2);
        expect(
          both.labels.every(
            (t) => t.source === "user" && t.confirmedByUser && t.confidence === null,
          ),
        ).toBe(true);
        const bad = yield* service
          .setThreadLabels({ threadId, labelIds: [b, ProjectLabelId.make("missing")] })
          .pipe(Effect.flip);
        expect(bad.reason).toBe("not_found");
        expect((yield* service.getThreadLabels(threadId)).labels).toHaveLength(2);
        const replaced = yield* service.setThreadLabels({ threadId, labelIds: [b] }, false);
        expect(replaced.labels).toEqual([
          { threadId, labelId: b, confidence: null, source: "user", confirmedByUser: false },
        ]);
        expect((yield* service.setThreadLabels({ threadId, labelIds: [] })).labels).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "suggests from repository and first-message keywords, never confirms, and respects rejections",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* Labels.ProjectLabelService;
        const repoLabel = (yield* service.create({ name: "Spawn" })).label;
        const keywordLabel = (yield* service.create({ name: "Bartr" })).label;
        yield* service.create({ name: "Unrelated" });
        yield* service.linkRepository({ labelId: repoLabel.id, repositoryId: repoA });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES ('message', ${threadId}, 'user', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{"text":"Discuss Bartr pricing"}')`;
        const suggested = yield* service.suggestLabels(threadId);
        expect(suggested.labels).toHaveLength(2);
        expect(
          suggested.labels.every(
            (t) =>
              t.source === "suggested" &&
              !t.confirmedByUser &&
              t.confidence! > 0 &&
              t.confidence! <= 1,
          ),
        ).toBe(true);
        yield* service.reviewSuggestion({ threadId, labelId: repoLabel.id, accept: true });
        yield* service.reviewSuggestion({ threadId, labelId: keywordLabel.id, accept: false });
        const again = yield* service.suggestLabels(threadId);
        expect(again.labels).toEqual([
          { ...suggested.labels.find((t) => t.labelId === repoLabel.id)!, confirmedByUser: true },
        ]);
        expect(
          (yield* service
            .reviewSuggestion({ threadId, labelId: repoLabel.id, accept: false })
            .pipe(Effect.flip)).reason,
        ).toBe("not_suggested");
        // Explicit edits can restore a rejected suggestion.
        yield* service.setThreadLabels({ threadId, labelIds: [keywordLabel.id] });
        expect((yield* service.getThreadLabels(threadId)).labels[0]?.confirmedByUser).toBe(true);
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
        yield* service.setThreadLabels({ threadId, labelIds: [a, b] });
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
});
