import * as Access from "../agents/AgentAccessScope.ts";
import { SearchError, SearchQueryResult, type SearchQueryInput } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import * as Store from "../agents/AgentStore.ts";
import * as Config from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

export class GlobalSearch extends Context.Service<
  GlobalSearch,
  {
    readonly query: (
      input: SearchQueryInput,
      scope?: McpInvocationScope,
    ) => Effect.Effect<SearchQueryResult, SearchError>;
  }
>()("cogenly-server/search/GlobalSearch") {}

const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeStrings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const decode = Schema.decodeUnknownEffect(SearchQueryResult);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* Access.AgentAccessScope;
  const store = yield* Store.AgentStore;
  const config = yield* Config.ServerConfig;
  const settings = yield* sql<{ engine: string }>`SELECT engine FROM search_config`.pipe(
    Effect.mapError((cause) => new SearchError({ operation: "query", cause })),
  );
  const fts = settings[0]?.engine === "fts5";
  const query: GlobalSearch["Service"]["query"] = Effect.fn("GlobalSearch.query")(
    function* (input, scope) {
      // Scope is authenticated transport context, never an input field. Reuse the
      // same principal resolution as AgentMcpPolicy, including governed Work runs.
      const agent =
        scope?.thread === undefined
          ? null
          : yield* store
              .forThread(scope.thread.threadId)
              .pipe(Effect.mapError((cause) => new SearchError({ operation: "authorize", cause })));
      if (agent !== null && !agent.permissions.read) return { results: [] };
      const resolved =
        agent === null
          ? null
          : yield* access
              .resolve(agent.id)
              .pipe(Effect.mapError((cause) => new SearchError({ operation: "authorize", cause })));
      const readableLabels = resolved?.readableLabelIds ?? [];
      const repositories = resolved?.readableRepositoryIds ?? [];
      const text = input.query.trim().slice(0, 500);
      // Quote every token; FTS operators, quotes and punctuation are user text.
      const tokens = text.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
      if (tokens.length === 0 || input.kinds?.length === 0) return { results: [] };
      const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
      const pattern = text.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_") + "%";
      const now = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* sql
        .withTransaction(
          sql.unsafe<{
            kind: string;
            id: string;
            threadId: string | null;
            title: string;
            snippet: string;
            matchedAt: string | null;
            labelIds: string;
          }>(
            `
      WITH matches AS MATERIALIZED (
        ${
          fts
            ? `SELECT d.*, bm25(search_fts, 8.0, 1.0) AS relevance,
          substr(snippet(search_fts, -1, '', '', '…', 32), 1, 240) AS excerpt
          FROM search_fts JOIN search_documents d ON d.rowid = search_fts.rowid
          WHERE search_fts MATCH ?`
            : `SELECT d.*, -1.0 AS relevance,
          substr(CASE WHEN title LIKE ? ESCAPE '!' THEN title ELSE body END, 1, 240) AS excerpt
          FROM search_documents d WHERE title LIKE ? ESCAPE '!' OR body LIKE ? ESCAPE '!'`
        }
      ), eligible AS (
        SELECT m.*,
          CASE WHEN m.kind = 'thread' THEN
            CASE WHEN a.agent_id IS NOT NULL THEN 'agent'
              WHEN json_extract(t.payload_json, '$.agent.role') = 'work' THEN 'work'
              WHEN p.workspace_root = ? THEN 'chat' ELSE 'work' END
            ELSE m.kind END AS result_kind,
          CASE WHEN m.kind = 'thread' AND a.agent_id IS NOT NULL THEN a.agent_id ELSE m.id END AS result_id,
          CASE WHEN m.kind = 'thread' THEN coalesce(json_extract(a.payload_json, '$.name'), t.title) ELSE m.title END AS result_title,
          CASE
            WHEN m.kind = 'project' THEN json_array(m.id)
            WHEN m.kind = 'fact' THEN (SELECT json_group_array(label_id) FROM
              (SELECT label_id FROM fact_labels WHERE fact_id = m.id ORDER BY label_id))
            WHEN m.kind = 'commitment' THEN (SELECT json_group_array(label_id) FROM
              (SELECT label_id FROM commitment_labels WHERE commitment_id = m.id ORDER BY label_id))
            WHEN a.agent_id IS NOT NULL THEN json_array()
            ELSE (SELECT json_group_array(label_id) FROM
              (SELECT folder_id AS label_id FROM effective_thread_project_folders WHERE thread_id = m.thread_id AND folder_id IS NOT NULL)) END AS labels
        FROM matches m
        LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
        LEFT JOIN projection_projects p ON p.project_id = t.project_id
        LEFT JOIN agents a ON (m.kind = 'agent' AND a.agent_id = m.id)
          OR (m.kind = 'thread' AND a.conversation_thread_id = m.thread_id AND coalesce(json_extract(t.payload_json, '$.agent.role'), '') <> 'work')
        LEFT JOIN facts f ON m.kind = 'fact' AND f.id = m.id
        LEFT JOIN commitments c ON m.kind = 'commitment' AND c.id = m.id
        WHERE (m.thread_id IS NULL OR (t.thread_id IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
          AND p.project_id IS NOT NULL AND p.deleted_at IS NULL))
        AND (? IS NULL OR
          (m.kind IN ('thread', 'pr') AND t.project_id IN (SELECT value FROM json_each(?))) OR
          (m.kind = 'agent' AND a.agent_id = ?) OR
          (m.kind = 'project' AND m.id IN (SELECT value FROM json_each(?))) OR
          (m.kind = 'fact' AND (f.agent_id = ? OR (json_extract(f.payload_json, '$.visibility') = 'labels' AND EXISTS (
            SELECT 1 FROM fact_labels fl WHERE fl.fact_id = f.id
              AND fl.label_id IN (SELECT value FROM json_each(?)))))) OR
          (m.kind = 'commitment' AND (c.agent_id = ? OR EXISTS (
            SELECT 1 FROM commitment_labels cl WHERE cl.commitment_id = c.id
              AND cl.label_id IN (SELECT value FROM json_each(?))))))
      ), filtered AS (
        SELECT *, relevance / (1.0 + max(0.0, coalesce(julianday(?) - julianday(matched_at), 0.0)) / 365.0) AS score
        FROM eligible WHERE (? IS NULL OR result_kind IN (SELECT value FROM json_each(?)))
          AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?))
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY result_kind, result_id
          ORDER BY score, matched_at DESC, key) AS position FROM filtered
      )
      SELECT result_kind AS kind, result_id AS id, thread_id AS threadId,
        substr(result_title, 1, 500) AS title, excerpt AS snippet, matched_at AS matchedAt,
        labels AS labelIds FROM ranked WHERE position = 1
      ORDER BY score, matched_at DESC, result_kind, result_id LIMIT ?`,
            [
              ...(fts ? [match] : [pattern, pattern, pattern]),
              `${config.baseDir.replace(/[\\/]$/, "")}/scratch`,
              agent?.id ?? null,
              encodeStrings(repositories),
              agent?.id ?? null,
              encodeStrings(readableLabels),
              agent?.id ?? null,
              encodeStrings(readableLabels),
              agent?.id ?? null,
              encodeStrings(readableLabels),
              now,
              input.kinds === undefined ? null : encodeStrings(input.kinds),
              encodeStrings(input.kinds ?? []),
              input.labelId ?? null,
              input.labelId ?? null,
              Math.max(1, Math.min(input.limit ?? 50, 100)),
            ],
          ),
        )
        .pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError((cause) => new SearchError({ operation: "query", cause })),
        );
      const results = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const labelIds = yield* decodeStrings(row.labelIds).pipe(
            Effect.mapError((cause) => new SearchError({ operation: "query", cause })),
          );
          return {
            kind: row.kind,
            id: row.id,
            ...(row.threadId === null ? {} : { threadId: row.threadId }),
            title: row.title.slice(0, 500).replace(/[\uD800-\uDBFF]$/, ""),
            snippet: row.snippet.slice(0, 240).replace(/[\uD800-\uDBFF]$/, ""),
            ...(row.matchedAt === null ? {} : { matchedAt: row.matchedAt }),
            labelIds,
          };
        }),
      );
      return yield* decode({ results }).pipe(
        Effect.mapError((cause) => new SearchError({ operation: "query", cause })),
      );
    },
  );
  return GlobalSearch.of({ query });
});
export const layer = Layer.effect(GlobalSearch, make).pipe(Layer.provide(Access.layer));
