// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.readDirectory materializes all entries; opendir keeps recent-export discovery bounded.
import * as NodeFSP from "node:fs/promises";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  ExportError,
  ExportManifest,
  ExportRecord,
  type ExportCreateInput,
  type ExportResult,
  type ExportValidation,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";

// These are the entire storage allowlist. Never dump sqlite, provider bindings,
// settings, auth_sessions/auth_pairing_links, webhook tokens or the secrets directory.
const definitions = [
  [
    "threads",
    "threads",
    "thread_id, project_id, title, default_provider, created_at, updated_at, (SELECT workspace_root FROM projection_projects p WHERE p.project_id = export_source.project_id) AS repository_root, json_extract(payload_json, '$.branch') AS branch, json_extract(payload_json, '$.worktreePath') AS worktree_path, json_extract(payload_json, '$.workOrigin') AS work_origin, json_extract(payload_json, '$.sourceThreadId') AS source_thread_id, json_extract(payload_json, '$.sourceAgentId') AS source_agent_id, json_extract(payload_json, '$.sourceAgentRunId') AS source_agent_run_id, json_extract(payload_json, '$.modelSelection') AS model_selection, json_extract(payload_json, '$.pullRequests') AS pull_requests, json_extract(payload_json, '$.linkedPullRequest') AS linked_pull_request, json_extract(payload_json, '$.branchPullRequest') AS branch_pull_request, (SELECT status FROM orchestration_v2_projection_runs r WHERE r.thread_id = export_source.thread_id ORDER BY ordinal DESC LIMIT 1) AS status",
    "thread_id",
  ],
  [
    "messages",
    "orchestration_v2_projection_messages",
    "message_id, thread_id, run_id, role, created_at, updated_at, json_extract(payload_json, '$.text') AS text",
    "message_id",
  ],
  [
    "runs",
    "orchestration_v2_projection_runs",
    "run_id, thread_id, provider, provider_instance_id, status, requested_at, completed_at, json_extract(payload_json, '$.model') AS model, json_extract(payload_json, '$.modelSelection') AS model_selection",
    "run_id",
  ],
  ["agents", "agents", "agent_id, conversation_thread_id, payload_json", "agent_id"],
  [
    "triggers",
    "scheduled_tasks",
    "task_id, agent_id, title, prompt, enabled, schedule_json, project_id, thread_id, model_selection_json, created_at, updated_at",
    "task_id",
  ],
  [
    "agentRuns",
    "agent_work_runs",
    "run_id, agent_id, trigger_id, work_thread_id, status, created_at, completed_at, summary, trigger_kind, trigger_context_json",
    "run_id",
  ],
  [
    "agentRunThreads",
    "agent_run_threads",
    "thread_id, agent_id, trigger_kind, source_run_id",
    "thread_id",
  ],
  ["actions", "agent_run_actions", "id, agent_id, run_id, kind, target_id, at", "id"],
  [
    "approvals",
    "agent_approvals",
    "id, agent_id, action_json, status, requested_at, decided_at, decided_by, source_run_id, result_thread_id",
    "id",
  ],
  [
    "memory",
    "facts",
    "id, agent_id, legacy_note_id, legacy_source, status, payload_json, updated_at",
    "id",
  ],
  ["factHistory", "fact_history", "sequence, fact_id, payload_json", "sequence"],
  ["contextRefs", "context_refs", "run_id, thread_id, payload_json", "run_id"],
  [
    "eventDeliveries",
    "agent_event_deliveries",
    "agent_id, event_key, work_thread_id, context_json",
    "agent_id",
  ],
  [
    "commitments",
    "commitments",
    "id, agent_id, status, payload_json, created_at, updated_at",
    "id",
  ],
  ["commitmentHistory", "commitment_history", "id, commitment_id, payload_json", "id"],
  [
    "labels",
    "project_labels",
    "label_id, name, color, description, created_at, updated_at",
    "label_id",
  ],
  [
    "repositories",
    "projection_projects",
    "project_id, title, workspace_root, created_at, updated_at",
    "project_id",
  ],
  ["repositoryLabels", "label_repositories", "label_id, repository_id", "label_id"],
  ["threadLabels", "thread_project_labels", "thread_id, label_id", "thread_id"],
] as const;
function columnParts(columns: string) {
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < columns.length; i++) {
    if (columns[i] === "(") depth++;
    if (columns[i] === ")") depth--;
    if (columns[i] === "," && depth === 0) {
      parts.push(columns.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(columns.slice(start).trim());
  return parts;
}
function columnNames(columns: string) {
  return columnParts(columns).map((c) =>
    c.includes(" AS ") ? c.slice(c.lastIndexOf(" AS ") + 4) : c,
  );
}
const threadKinds = new Set(["threads", "messages", "runs", "threadLabels", "contextRefs"]);
const agentKinds = new Set([
  "agents",
  "triggers",
  "agentRuns",
  "agentRunThreads",
  "actions",
  "approvals",
  "eventDeliveries",
]);
const legacyMemory = [
  "memory",
  "agent_memory",
  "note_id, agent_id, text, source, created_at, updated_at",
  "note_id",
] as const;
const legacyAgentRuns = [
  "agentRuns",
  "agent_work_runs",
  "run_id, agent_id, trigger_id, work_thread_id, status, created_at, completed_at, summary",
  "run_id",
] as const;
const maxRecordBytes = 4 * 1024 * 1024;
const isExportError = Schema.is(ExportError);
const decodeRecord = Schema.decodeUnknownSync(ExportRecord);
const decodeManifest = Schema.decodeUnknownSync(ExportManifest);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeRow = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

export class ExportService extends Context.Service<
  ExportService,
  {
    readonly export: (input: ExportCreateInput) => Effect.Effect<ExportResult, ExportError>;
    /** Decode and validate only. Restoring/importing state is deliberately out of scope. */
    readonly validate: (input: { path: string }) => Effect.Effect<ExportValidation, ExportError>;
    readonly list: () => Effect.Effect<{ exports: ReadonlyArray<ExportResult> }, ExportError>;
  }
>()("cogenly-server/export/ExportService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const root = path.join(config.baseDir, "exports");
  const wrap = (operation: string) => (cause: unknown) =>
    isExportError(cause) ? cause : new ExportError({ operation, cause });
  const invalid = (operation: string) =>
    new ExportError({ operation, cause: new Error("Invalid export bundle") });
  // Existing paths are canonicalized so symlinks cannot escape the owning home.
  const contained = (candidate: string) =>
    Effect.gen(function* () {
      const home = yield* fs.realPath(config.baseDir);
      const base = yield* fs.realPath(root);
      const resolved = yield* fs.realPath(candidate);
      const relative = path.relative(base, resolved);
      if (
        !base.startsWith(home + path.sep) ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
      )
        return yield* invalid("path");
      return resolved;
    });
  const readManifest = (dir: string) =>
    Effect.gen(function* () {
      const file = yield* contained(path.join(dir, "manifest.json"));
      if (Number((yield* fs.stat(file)).size) > 64 * 1024) return yield* invalid("manifest");
      const text = yield* fs.readFileString(file);
      return yield* Effect.try({ try: () => decodeManifest(parse(text)), catch: wrap("manifest") });
    });
  const validate = (input: { path: string }) =>
    Effect.gen(function* () {
      const counts: Record<string, number> = {};
      const errors: string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* contained(input.path);
          const manifest = yield* readManifest(dir);
          const file = yield* fs.open(yield* contained(path.join(dir, "records.jsonl")));
          let pending = Buffer.alloc(0);
          while (true) {
            const chunk = yield* file.readAlloc(64 * 1024);
            if (Option.isNone(chunk)) break;
            pending = Buffer.concat([pending, chunk.value]);
            let end: number;
            while ((end = pending.indexOf(10)) >= 0) {
              if (end > maxRecordBytes) return yield* invalid("record");
              const line = pending.subarray(0, end).toString("utf8");
              pending = pending.subarray(end + 1);
              yield* Effect.try({
                try: () => {
                  const raw = parse(line);
                  decodeRecord(raw);
                  const envelope = decodeRow(raw);
                  const definition =
                    manifest.schemaVersion === 1 && envelope.kind === "memory"
                      ? legacyMemory
                      : manifest.schemaVersion === 1 && envelope.kind === "agentRuns"
                        ? legacyAgentRuns
                        : definitions.find((d) => d[0] === envelope.kind);
                  if (!definition) throw new Error("Unknown record kind");
                  const row = decodeRow(envelope.data);
                  if (typeof row[definition[3]] !== "string") throw new Error("Missing identity");
                  const allowed = columnNames(definition[2]);
                  if (Object.keys(row).some((k) => !allowed.includes(k)))
                    throw new Error("Unknown field");
                  for (const key of allowed) {
                    if (!(key in row)) throw new Error("Missing field");
                    if (key.endsWith("_json") && row[key] !== null) parse(String(row[key]));
                    if (row[key] !== null && !["string", "number"].includes(typeof row[key]))
                      throw new Error("Invalid field");
                  }
                  counts[definition[0]] = (counts[definition[0]] ?? 0) + 1;
                },
                catch: wrap("record"),
              });
            }
            if (pending.length > maxRecordBytes) return yield* invalid("record");
          }
          if (pending.length) return yield* invalid("record");
          for (const key of new Set([...Object.keys(counts), ...Object.keys(manifest.counts)]))
            if ((counts[key] ?? 0) !== (manifest.counts[key] ?? 0))
              errors.push(`Count mismatch: ${key}`);
        }),
      ).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            errors.push("Invalid, unsupported, truncated, or inaccessible export bundle.");
          }),
        ),
      );
      return { counts, errors };
    });
  return ExportService.of({
    validate,
    export: (input) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
        yield* contained(root);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const dir = path.join(
          yield* fs.realPath(root),
          `export-${createdAt.replaceAll(":", "-")}-${yield* crypto.randomUUIDv4()}`,
        );
        yield* fs.makeDirectory(dir, { mode: 0o700 });
        const counts: Record<string, number> = {};
        let bytes = 0;
        const append = (file: string, value: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              if (Buffer.byteLength(value) > maxRecordBytes) return yield* invalid("record_size");
              const handle = yield* fs.open(path.join(dir, file), {
                flag: "a",
                mode: 0o600,
                noFollow: true,
              });
              yield* handle.writeAll(Buffer.from(value));
              bytes += Buffer.byteLength(value);
            }),
          );
        const label = input.labelId;
        const labelPredicate =
          label === undefined
            ? sql`1`
            : sql`EXISTS (SELECT 1 FROM effective_thread_project_folders x WHERE x.thread_id = t.thread_id AND x.folder_id = ${label})`;
        // Both modes retain ordinary conversation history; Work-only exports select bounded Work metadata/conversations.
        const threads = sql`SELECT t.rowid AS rowid, t.* FROM orchestration_v2_projection_threads t WHERE t.deleted_at IS NULL AND ${labelPredicate} AND (${input.include.includes("chats") ? sql`1` : input.include.includes("work") ? sql`json_extract(t.payload_json, '$.agent.role') = 'work' OR (NOT EXISTS (SELECT 1 FROM agents a WHERE a.conversation_thread_id = t.thread_id) AND t.project_id IN (SELECT project_id FROM projection_projects WHERE workspace_root <> ${path.join(config.baseDir, "scratch")}))` : sql`0`})`;
        const agents =
          label === undefined
            ? sql`SELECT agent_id FROM agents`
            : // Agents reach every project; a project export carries those that worked in it.
              sql`SELECT agent_id FROM agents a WHERE EXISTS (SELECT 1 FROM effective_thread_project_folders x WHERE x.folder_id = ${label} AND (x.thread_id = a.conversation_thread_id OR x.thread_id IN (SELECT work_thread_id FROM agent_work_runs r WHERE r.agent_id = a.agent_id) OR x.thread_id IN (SELECT thread_id FROM agent_run_threads t WHERE t.agent_id = a.agent_id)))`;
        const commitments =
          label === undefined
            ? sql`SELECT id FROM commitments`
            : sql`SELECT commitment_id FROM commitment_labels WHERE label_id = ${label}`;
        // Labels select tagged facts regardless of owner. Unlabelled agent-private
        // facts follow only selected agents; unowned user facts require their label.
        const facts =
          label === undefined
            ? sql`SELECT id FROM facts`
            : sql`SELECT f.id FROM facts f
          WHERE EXISTS (SELECT 1 FROM fact_labels fl WHERE fl.fact_id = f.id AND fl.label_id = ${label})
          OR (f.agent_id IN (${agents}) AND NOT EXISTS (SELECT 1 FROM fact_labels fl WHERE fl.fact_id = f.id))`;
        yield* append("records.jsonl", "");
        for (const [kind, table, columns] of definitions) {
          if (
            threadKinds.has(kind) &&
            !input.include.some((s) => s === "chats" || s === "work") &&
            !((kind === "runs" || kind === "contextRefs") && input.include.includes("agents")) &&
            !(kind === "threadLabels" && input.include.includes("projects"))
          )
            continue;
          if (agentKinds.has(kind) && !input.include.includes("agents")) continue;
          if (["memory", "factHistory"].includes(kind) && !input.include.includes("memory"))
            continue;
          if (
            ["commitments", "commitmentHistory"].includes(kind) &&
            !input.include.includes("commitments")
          )
            continue;
          if (
            ["labels", "repositories", "repositoryLabels"].includes(kind) &&
            !input.include.includes("projects")
          )
            continue;
          let predicate = sql`1`;
          if (threadKinds.has(kind))
            predicate = sql`thread_id IN (SELECT thread_id FROM (${threads}))`;
          if ((kind === "runs" || kind === "contextRefs") && input.include.includes("agents"))
            predicate = sql`${predicate} OR thread_id IN (
          SELECT conversation_thread_id FROM agents WHERE agent_id IN (${agents})
          UNION SELECT thread_id FROM agent_run_threads WHERE agent_id IN (${agents})
          UNION SELECT work_thread_id FROM agent_work_runs WHERE agent_id IN (${agents})
        )`;
          if (kind === "runs" || kind === "contextRefs")
            predicate = sql`(${predicate}) AND thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL)`;
          if ((kind === "runs" || kind === "contextRefs") && label !== undefined)
            predicate = sql`(${predicate}) AND thread_id IN (SELECT thread_id FROM effective_thread_project_folders WHERE folder_id = ${label})`;
          if (agentKinds.has(kind)) predicate = sql`agent_id IN (${agents})`;
          if (
            label !== undefined &&
            (kind === "agentRuns" || kind === "agentRunThreads" || kind === "eventDeliveries")
          ) {
            const key = sql.unsafe(
              kind === "agentRuns" || kind === "eventDeliveries" ? "work_thread_id" : "thread_id",
            );
            predicate = sql`${predicate} AND ${key} IN (SELECT thread_id FROM effective_thread_project_folders WHERE folder_id = ${label})`;
          }
          if (kind === "threadLabels" && input.include.includes("projects"))
            predicate = sql`thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL)`;
          if (kind === "memory") predicate = sql`id IN (${facts})`;
          if (kind === "factHistory") predicate = sql`fact_id IN (${facts})`;
          if (kind === "contextRefs")
            predicate = sql`${predicate} AND run_id IN (SELECT run_id FROM orchestration_v2_projection_runs)`;
          if (kind === "commitments") predicate = sql`id IN (${commitments})`;
          if (kind === "commitmentHistory") predicate = sql`commitment_id IN (${commitments})`;
          if ((kind === "labels" || kind === "repositoryLabels") && label !== undefined)
            predicate = sql`label_id = ${label}`;
          if (kind === "threadLabels" && label !== undefined)
            predicate = sql`${predicate} AND label_id = ${label}`;
          if (kind === "repositories")
            predicate =
              label === undefined
                ? sql`deleted_at IS NULL`
                : sql`deleted_at IS NULL AND project_id IN (SELECT repository_id FROM label_repositories WHERE label_id = ${label})`;
          const source =
            kind === "threads"
              ? sql`(${threads})`
              : kind === "threadLabels"
                ? sql`(SELECT t.rowid AS rowid, f.thread_id, f.folder_id AS label_id
              FROM effective_thread_project_folders f JOIN orchestration_v2_projection_threads t ON t.thread_id = f.thread_id
              WHERE f.folder_id IS NOT NULL)`
                : sql.unsafe(table);
          const fields = columnParts(columns).map((expression, index) => {
            const name = columnNames(columns)[index]!;
            const value = expression.includes(" AS ")
              ? expression.slice(0, expression.lastIndexOf(" AS "))
              : expression;
            return `'${name}', ${name === "enabled" ? value : `(${value}) || ''`}`;
          });
          const json = sql.unsafe(`json_object(${fields.join(", ")})`);
          // Enforce the size limit in SQLite before materializing text in JavaScript.
          // One row per read: peak memory is bounded by the maximum supported record,
          // never by the number of messages, runs or entities in the environment.
          let cursor = 0;
          while (true) {
            const rows =
              yield* sql`SELECT export_source.rowid AS export_cursor, CASE WHEN length(CAST(${json} AS BLOB)) < ${maxRecordBytes - 256} THEN ${json} ELSE NULL END AS export_data FROM ${source} AS export_source WHERE (${predicate}) AND export_source.rowid > ${cursor} ORDER BY export_source.rowid LIMIT 1`.pipe(
                Effect.mapError((cause) => new ExportError({ operation: "read", cause })),
              );
            const result = rows[0];
            if (!result) break;
            cursor = Number(result.export_cursor);
            if (result.export_data === null) return yield* invalid("record_size");
            const row = yield* Effect.try({
              try: () => decodeRow(parse(result.export_data)),
              catch: wrap("read"),
            });
            yield* append("records.jsonl", encode({ kind, data: row }) + "\n");
            counts[kind] = (counts[kind] ?? 0) + 1;
            if (kind === "threads" || kind === "messages") {
              const name = `chat-${Buffer.from(yield* crypto.digest("SHA-256", Buffer.from(String(row.thread_id)))).toString("hex")}.md`;
              yield* append(
                name,
                kind === "threads"
                  ? `# ${row.title}\n\nThread: ${row.thread_id}\n\n`
                  : `## ${row.role} — ${row.created_at}\n\n${row.text ?? ""}\n\n`,
              );
            }
          }
        }
        const manifest = {
          schemaVersion: 2,
          format: "cogenly-jsonl",
          createdAt: createdAt,
          ...input,
          counts,
          contentBytes: bytes,
        };
        yield* append("manifest.json", encode(manifest));
        return { path: dir, bytes, counts };
      }).pipe(Effect.mapError(wrap("create"))),
    list: () =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
        yield* contained(root);
        const exports: ExportResult[] = [];
        const dirs = yield* Effect.tryPromise({
          try: () => NodeFSP.opendir(root),
          catch: wrap("list"),
        });
        // Retain only the newest 20 names, even when years of exports exist.
        const recent: string[] = [];
        yield* Effect.tryPromise({
          try: async () => {
            for await (const entry of dirs)
              if (entry.isDirectory() && /^export-[\dTZ.-]+-[\da-f-]+$/.test(entry.name)) {
                recent.push(entry.name);
                recent.sort().reverse();
                recent.splice(20);
              }
          },
          catch: wrap("list"),
        });
        for (const name of recent) {
          yield* Effect.gen(function* () {
            const dir = yield* contained(path.join(root, name));
            const manifest = yield* readManifest(dir);
            const bytes =
              manifest.contentBytes +
              Number((yield* fs.stat(path.join(dir, "manifest.json"))).size);
            exports.push({ path: dir, bytes, counts: manifest.counts });
          }).pipe(Effect.ignore); // An interrupted export has no committed manifest.
        }
        return { exports };
      }).pipe(Effect.mapError(wrap("list"))),
  });
});
export const layer = Layer.effect(ExportService, make);
