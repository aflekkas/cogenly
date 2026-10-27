import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Search from "./ThreadSearch.ts";

const layer = Search.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);
const at = "2026-01-01T00:00:00.000Z";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p', 'repo', '/repo', '[]', ${at}, ${at})`;
});
const thread = Effect.fnUntraced(function* (
  id: string,
  text: string,
  role = "user",
  payload = "{}",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, 'p', ${id}, 'codex', 'full-access', 'default', ${at}, ${at}, ${payload})`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES (${id}, ${id}, ${role}, 0, ${at}, ${at}, ${JSON.stringify({ text })})`;
});

it.effect(
  "searches the existing FTS index, prefers whole words, and hides subagents before limiting",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* thread("prefix", "rusty metal");
      yield* thread("whole", "use rust", "assistant");
      yield* thread("user", "learn rust");
      yield* thread("child", "rust", "user", '{"lineage":{"relationshipToParent":"subagent"}}');
      const search = yield* Search.ThreadSearch;
      expect((yield* search.search({ query: "rust" })).matches.map((m) => m.threadId)).toEqual([
        "user",
        "whole",
        "prefix",
      ]);
      expect((yield* search.search({ query: "rust", limit: 1 })).matches[0]?.threadId).toBe("user");
      expect((yield* search.search({ query: '" OR *' })).matches).toEqual([]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "tracks finished, replaced, archived and deleted messages through the existing triggers",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* thread("t", "quartz");
      const sql = yield* SqlClient.SqlClient;
      const search = yield* Search.ThreadSearch;
      expect((yield* search.search({ query: "quartz" })).matches).toHaveLength(1);
      yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 1 WHERE message_id = 't'`;
      expect((yield* search.search({ query: "quartz" })).matches).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0, payload_json = '{"text":"café nebula"}' WHERE message_id = 't'`;
      expect((yield* search.search({ query: "quartz" })).matches).toEqual([]);
      expect((yield* search.search({ query: "cafe neb" })).matches).toHaveLength(1);
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = ${at} WHERE thread_id = 't'`;
      expect((yield* search.search({ query: "nebula" })).matches).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = NULL WHERE thread_id = 't'`;
      expect((yield* search.search({ query: "nebula" })).matches).toHaveLength(1);
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 't'`;
      expect((yield* search.search({ query: "nebula" })).matches).toEqual([]);
    }).pipe(Effect.provide(layer)),
);

it.effect("uses the indexed prefix fallback on SQLite builds without FTS5", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* thread("t", "quartz nebula");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE search_config SET engine = 'like-prefix'`;
    const search = yield* Search.ThreadSearch;
    expect((yield* search.search({ query: "quartz" })).matches).toHaveLength(1);
    expect((yield* search.search({ query: "%" })).matches).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("shows the first indexed token in long, accent-folded, multi-token snippets", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* thread("long", `${"padding ".repeat(80)}café has alpha details ${"🙂 ".repeat(80)}`);
    const search = yield* Search.ThreadSearch;
    const result = (yield* search.search({ query: "cafe alp" })).matches[0];
    expect(result?.snippet).toContain("café has alpha");
    expect(result!.snippet.length).toBeLessThanOrEqual(240);
    expect(result!.snippet.isWellFormed()).toBe(true);
  }).pipe(Effect.provide(layer)),
);
