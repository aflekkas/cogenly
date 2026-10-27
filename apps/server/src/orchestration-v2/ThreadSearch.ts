import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";

/** Carries no query text: search input is user content. */
export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const SearchRequest = Schema.Struct({
  match: Schema.String,
  pattern: Schema.String,
  fts: Schema.Boolean,
});
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
  threadUpdatedAt: IsoDateTime,
});

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

/** At most 240 characters, centred near the first match. */
function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }
  const foldedText = foldSearchText(normalizedText);
  const tokens = foldSearchText(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  const offsets = tokens.map((token) => foldedText.indexOf(token)).filter((offset) => offset >= 0);
  const matchIndex = offsets.length > 0 ? Math.min(...offsets) : 0;
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  let start = Math.min(idealStart, normalizedText.length - bodyLength);
  if (isLowSurrogate(normalizedText.charCodeAt(start))) start--;
  let end = Math.min(normalizedText.length, start + bodyLength);
  if (isLowSurrogate(normalizedText.charCodeAt(end))) end--;
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function messageMatchQuality(text: string, tokens: readonly string[]): number {
  const words = Array.from(foldSearchText(text).matchAll(/[\p{L}\p{N}]+/gu), (match) => match[0]);
  if (tokens.every((token) => words.includes(token))) return 2;
  return tokens.every((token) => words.some((word) => word.startsWith(token))) ? 1 : 0;
}

/**
 * Searches the finished user and assistant messages of active V2 threads in
 * active projects. Legacy V1 transcripts that have not been imported yet are
 * not searched.
 */
export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
  }
>()("cogenly-server/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ match, pattern, fts }) => sql`
      WITH hits AS MATERIALIZED (
        ${
          fts
            ? sql`
          SELECT d.rowid AS document_rowid, d.key, d.thread_id, d.matched_at
          FROM search_fts JOIN search_documents d ON d.rowid = search_fts.rowid
          WHERE search_fts MATCH ${match} AND d.key LIKE 'message:%'
          ORDER BY search_fts.rowid DESC LIMIT 10000
        `
            : sql`
          SELECT rowid AS document_rowid, key, thread_id, matched_at FROM search_documents
          WHERE body LIKE ${pattern} ESCAPE '!' AND key LIKE 'message:%'
          ORDER BY rowid DESC LIMIT 10000
        `
        }
      )
      SELECT threads.thread_id AS "threadId", threads.project_id AS "projectId",
        threads.title, messages.role AS source, documents.body AS "matchText",
        hits.matched_at AS "messageCreatedAt", threads.updated_at AS "threadUpdatedAt"
      FROM hits
      JOIN search_documents documents ON documents.rowid = hits.document_rowid
      JOIN orchestration_v2_projection_messages messages
        ON messages.message_id = substr(hits.key, 9)
      JOIN orchestration_v2_projection_threads threads ON threads.thread_id = hits.thread_id
      JOIN projection_projects projects ON projects.project_id = threads.project_id
      WHERE hits.key LIKE 'message:%' AND threads.deleted_at IS NULL AND threads.archived_at IS NULL
        AND projects.deleted_at IS NULL
        AND json_extract(threads.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
        AND messages.message_id NOT LIKE 'async-answer:%'
        AND messages.streaming = 0 AND messages.role IN ('user', 'assistant')
      ORDER BY hits.document_rowid DESC LIMIT 2000
    `,
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      const tokens = input.query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 32) ?? [];
      if (tokens.length === 0) return { matches: [] };
      const rows = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const settings = yield* sql<{ engine: string }>`SELECT engine FROM search_config`;
            return yield* searchRows({
              match: `body : (${tokens.map((token) => `"${token}"*`).join(" AND ")})`,
              pattern: `${escapeLikePattern(input.query)}%`,
              fts: settings[0]?.engine === "fts5",
            });
          }),
        )
        .pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(
            (cause) =>
              new ThreadSearchError({
                operation: Schema.isSchemaError(cause) ? "decode" : "query",
                cause,
              }),
          ),
        );
      // Prefer whole words, then word starts, then mid-word matches. At the
      // same quality, what the user wrote wins, followed by thread recency.
      const foldedTokens = tokens.map(foldSearchText);
      const ranked = rows
        .map((row) => ({ row, quality: messageMatchQuality(row.matchText, foldedTokens) }))
        .sort(
          (a, b) =>
            b.quality - a.quality ||
            Number(a.row.source !== "user") - Number(b.row.source !== "user") ||
            b.row.threadUpdatedAt.localeCompare(a.row.threadUpdatedAt) ||
            (b.row.messageCreatedAt ?? "").localeCompare(a.row.messageCreatedAt ?? "") ||
            a.row.threadId.localeCompare(b.row.threadId),
        );
      const best = new Map<ThreadId, typeof SearchRow.Type>();
      for (const { row } of ranked) {
        if (!best.has(row.threadId)) best.set(row.threadId, row);
      }
      return {
        matches: [...best.values()].slice(0, input.limit ?? 50).map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          title: row.title,
          source: row.source,
          snippet: buildSearchSnippet(row.matchText, input.query),
          messageCreatedAt: row.messageCreatedAt,
        })),
      };
    },
  );

  return ThreadSearch.of({ search });
});

export const layer = Layer.effect(ThreadSearch, make);
