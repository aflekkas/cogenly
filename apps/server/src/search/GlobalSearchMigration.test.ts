import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Search from "./GlobalSearch.ts";
import * as Store from "../agents/AgentStore.ts";
import * as Config from "../config.ts";
import { agentFixture } from "../agents/agent.testkit.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-01-01T00:00:00.000Z";
const database = NodeSqlite.layer({ filename: ":memory:" });
const layer = database.pipe(Layer.provide(NodeServices.layer));

it.effect(
  "backfills more than one batch once, excludes deleted/streaming text, and keeps replay idempotent",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('repo', 'repo', '/repo', '[]', ${at}, ${at})`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES ('t', 'repo', 'Quartz thread', 'codex', 'full-access', 'default', ${at}, ${at}, ${json({ pullRequests: [{ url: "https://example.com/pull/1", source: "manual", snapshot: { title: "Quartz PR" }, linkedAt: at }] })})`;
      for (let i = 0; i < 503; i++)
        yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES (${`m:${i}`}, 't', 'assistant', 0, ${at}, ${at}, '{"text":"Quartz backfill"}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES ('stream', 't', 'assistant', 1, ${at}, ${at}, '{"text":"Should not index"}')`;
      yield* sql`INSERT INTO project_labels(label_id, name, description, created_at, updated_at) VALUES ('label', 'Quartz project', 'Quartz details', ${at}, ${at})`;
      const agent = agentFixture();
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled) VALUES (${agent.id}, 't', ${json(agent)}, 1)`;
      yield* sql`INSERT INTO commitments(id, status, payload_json, created_at, updated_at) VALUES ('item', 'open', '{"title":"Quartz item","description":"Quartz body"}', ${at}, ${at})`;
      const migrated = yield* runMigrations({ toMigrationInclusive: 68 });
      expect(migrated).toEqual([[68, "GlobalSearch"]]);
      expect(yield* sql`SELECT engine FROM search_config`).toEqual([{ engine: "fts5" }]);
      expect((yield* sql`SELECT count(*) AS count FROM search_documents`)[0]?.count).toBe(508);
      expect(
        (yield* sql`SELECT count(*) AS count FROM search_fts WHERE search_fts MATCH 'quartz'`)[0]
          ?.count,
      ).toBe(507);
      expect(yield* runMigrations({ toMigrationInclusive: 68 })).toEqual([]);
      expect((yield* sql`SELECT count(*) AS count FROM search_documents`)[0]?.count).toBe(508);
      // REPLACE is used by some projection import/repair paths and must not leave
      // stale FTS postings when recursive_triggers is off.
      yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES ('m:0', 't', 'user', 0, ${at}, ${at}, '{"text":"Nebula replacement"}')`;
      expect(
        (yield* sql`SELECT count(*) AS count FROM search_fts WHERE search_fts MATCH 'nebula'`)[0]
          ?.count,
      ).toBe(1);
      expect(
        (yield* sql`SELECT count(*) AS count FROM search_fts WHERE search_fts MATCH 'quartz'`)[0]
          ?.count,
      ).toBe(506);
      yield* sql`INSERT INTO search_fts(search_fts, rank) VALUES ('integrity-check', 1)`;
      // Updating unrelated thread payload fields must not rewrite PR postings.
      const before = yield* sql`SELECT rowid FROM search_documents WHERE kind = 'pr'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET title = title, payload_json = json_set(payload_json, '$.workOrigin', 'direct') WHERE thread_id = 't'`;
      expect(yield* sql`SELECT rowid FROM search_documents WHERE kind = 'pr'`).toEqual(before);
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = 't'`;
      expect(
        (yield* sql`SELECT count(*) AS count FROM search_fts WHERE search_fts MATCH 'nebula'`)[0]
          ?.count,
      ).toBe(0);
      yield* sql`INSERT INTO search_fts(search_fts, rank) VALUES ('integrity-check', 1)`;
    }).pipe(Effect.provide(layer)),
);

it.effect("uses indexed prefix LIKE if the migration selected the non-FTS engine", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    // Exercise the fallback on the bundled FTS-capable SQLite without mocking
    // the search implementation or its database queries.
    yield* sql`DROP TRIGGER search_documents_insert`;
    yield* sql`DROP TRIGGER search_documents_update`;
    yield* sql`DROP TRIGGER search_documents_delete`;
    yield* sql`DROP TABLE search_fts`;
    yield* sql`UPDATE search_config SET engine = 'like-prefix'`;
    yield* sql`CREATE INDEX search_documents_title ON search_documents(title COLLATE NOCASE)`;
    yield* sql`CREATE INDEX search_documents_body ON search_documents(body COLLATE NOCASE)`;
    yield* sql`INSERT INTO project_labels(label_id, name, description, created_at, updated_at) VALUES ('label', 'Quartz fallback', 'Nebula details', ${at}, ${at})`;
    const search = yield* Search.GlobalSearch.pipe(
      Effect.provide(Search.layer.pipe(Layer.provide(Store.layer))),
    );
    expect((yield* search.query({ query: "quartz" })).results[0]?.id).toBe("label");
    expect((yield* search.query({ query: "nebula" })).results[0]?.id).toBe("label");
    expect((yield* search.query({ query: "%" })).results).toEqual([]);
    const plans = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT rowid FROM search_documents WHERE title LIKE ${"Quartz%"} ESCAPE '!' OR body LIKE ${"Quartz%"} ESCAPE '!'`;
    expect(plans.filter((p) => p.detail.includes("SEARCH search_documents USING")).length).toBe(2);
    yield* sql`UPDATE project_labels SET name = 'Renamed' WHERE label_id = 'label'`;
    expect((yield* search.query({ query: "quartz" })).results).toEqual([]);
    yield* sql`DELETE FROM project_labels WHERE label_id = 'label'`;
    expect((yield* search.query({ query: "nebula" })).results).toEqual([]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        database,
        Config.layerTest(process.cwd(), { prefix: "search-fallback-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
