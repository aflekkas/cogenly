import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import {
  EventId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProjectLabelId,
} from "@t3tools/contracts";
import * as Exports from "./ExportService.ts";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { agentFixture } from "../agents/agent.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const layer = Exports.layer.pipe(
  Layer.provideMerge(Projections.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "cogenly-export-" })),
  Layer.provideMerge(NodeServices.layer),
);
const at = "2026-01-01T00:00:00.000Z";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('repo', 'Repo', '/repos/repo', '[]', ${at}, ${at})`;
  for (const id of ["a", "b"]) {
    yield* sql`INSERT INTO project_labels(label_id, name, created_at, updated_at) VALUES (${id}, ${id}, ${at}, ${at})`;
    yield* sql`INSERT INTO label_repositories(label_id, repository_id) VALUES (${id}, 'repo')`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, 'repo', ${id}, 'codex', 'full-access', 'default', ${at}, ${at}, ${encode({ workOrigin: "direct", branch: "main", pullRequests: [{ url: "https://github.com/org/repo/pull/1" }] })})`;
    yield* sql`INSERT INTO thread_project_labels(thread_id, label_id, confidence, confirmed_by_user, source) VALUES (${id}, ${id}, NULL, 1, 'user')`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES (${id}, ${id}, 'user', 0, ${at}, ${at}, ${encode({ text: `Message ${id}` })})`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${id}, ${id}, 1, 'codex', 'completed', ${at}, ${encode({ modelSelection: { instanceId: "codex", model: "gpt-5" } })})`;
    const agent = {
      ...agentFixture(id),
      scope: [{ labelId: id, permissions: agentFixture().permissions }],
    };
    yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled) VALUES (${agent.id}, ${agent.conversationThreadId}, ${encode(agent)}, 1)`;
    yield* sql`INSERT INTO agent_memory(note_id, agent_id, text, source, created_at, updated_at) VALUES (${id}, ${agent.id}, ${`Memory ${id}`}, 'owner', ${at}, ${at})`;
    yield* sql`INSERT INTO commitments(id, agent_id, status, payload_json, created_at, updated_at) VALUES (${id}, ${agent.id}, 'open', ${encode({ id, title: `Item ${id}`, labelIds: [id] })}, ${at}, ${at})`;
    yield* sql`INSERT INTO commitment_labels(commitment_id, label_id) VALUES (${id}, ${id})`;
    yield* sql`INSERT INTO commitment_history(id, commitment_id, payload_json) VALUES (${id}, ${id}, ${encode({ why: "Owner confirmed" })})`;
    yield* sql`INSERT INTO agent_work_runs(run_id, agent_id, trigger_id, work_thread_id, status, created_at, completed_at, summary) VALUES (${`work:${id}`}, ${agent.id}, ${id}, ${id}, 'completed', ${at}, ${at}, 'Reviewed work')`;
    yield* sql`INSERT INTO agent_run_actions(id, agent_id, kind, at) VALUES (${id}, ${agent.id}, 'commitment_created', ${at})`;
    yield* sql`INSERT INTO agent_approvals(id, agent_id, action_json, status, requested_at) VALUES (${id}, ${agent.id}, '{"actionKind":"change_permissions","payload":{}}', 'pending', ${at})`;
    yield* sql`INSERT INTO scheduled_tasks(task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, last_run_status, run_count, agent_id, webhook_token, webhook_secret) VALUES (${id}, 'Trigger', 'Check', 1, '{}', 'repo', '{}', '{}', 'full-access', 'default', 'user', 'web', ${at}, ${at}, 'never', 0, ${agent.id}, 'WEBHOOK_TOKEN_SENTINEL', 'WEBHOOK_SECRET_SENTINEL')`;
  }
  // Auth tables, provider sessions, and filesystem secrets are never part of the allowlist.
  yield* sql`INSERT INTO auth_pairing_links(id, credential, method, scopes, subject, created_at, expires_at) VALUES ('pair', 'PAIRING_SECRET_SENTINEL', 'token', '[]', 'owner', ${at}, ${at})`;
  yield* sql`INSERT INTO auth_sessions(session_id, subject, scopes, method, issued_at, expires_at) VALUES ('AUTH_SESSION_SENTINEL', 'owner', '[]', 'token', ${at}, ${at})`;
  const config = yield* Config.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(config.secretsDir, { recursive: true });
  yield* fs.writeFileString(config.secretsDir + "/credential", "FILE_SECRET_SENTINEL");
});

describe("portable exports", () => {
  it.effect("round trips fixtures, transcripts and model provenance without secret stores", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Exports.ExportService;
      const fs = yield* FileSystem.FileSystem;
      const result = yield* service.export({
        include: ["chats", "work", "agents", "commitments", "projects", "memory"],
      });
      expect(
        result.path.startsWith(
          (yield* fs.realPath((yield* Config.ServerConfig).baseDir)) + "/exports/",
        ),
      ).toBe(true);
      expect(result.counts).toMatchObject({
        threads: 2,
        messages: 2,
        runs: 2,
        agents: 2,
        memory: 2,
        commitments: 2,
        commitmentHistory: 2,
        approvals: 2,
        triggers: 2,
      });
      expect(yield* service.validate({ path: result.path })).toEqual({
        counts: result.counts,
        errors: [],
      });
      const files = yield* fs.readDirectory(result.path);
      expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(2);
      const content = yield* fs.readFileString(result.path + "/records.jsonl");
      expect(content).toContain("gpt-5");
      expect(content).toContain("https://github.com/org/repo/pull/1");
      expect(content).not.toContain("SENTINEL");
      expect(content).not.toMatch(
        /auth_sessions|auth_pairing_links|webhook_token|webhook_secret|provider_session/,
      );
      const listed = (yield* service.list()).exports;
      expect(listed).toContainEqual(result);
      expect(
        yield* fs.readFileString(result.path + "/" + files.find((f) => f.endsWith(".md"))),
      ).toMatch(/## user.*2026/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("filters each kind by label and honors section selection", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Exports.ExportService;
      const fs = yield* FileSystem.FileSystem;
      const result = yield* service.export({
        include: ["chats", "agents", "memory", "commitments", "projects"],
        labelId: ProjectLabelId.make("a"),
      });
      expect(result.counts).toMatchObject({
        threads: 1,
        messages: 1,
        agents: 1,
        memory: 1,
        commitments: 1,
        commitmentHistory: 1,
        triggers: 1,
        labels: 1,
        threadLabels: 1,
      });
      const content = yield* fs.readFileString(result.path + "/records.jsonl");
      expect(content).toContain("Message a");
      expect(content).not.toContain("Message b");
      expect(content).not.toContain("Memory b");
      expect(content).not.toContain("Item b");
      expect(yield* service.validate({ path: result.path })).toEqual({
        counts: result.counts,
        errors: [],
      });
      const onlyMemory = yield* service.export({ include: ["memory"] });
      expect(onlyMemory.counts).toEqual({ memory: 2 });
      const projectsOnly = yield* service.export({ include: ["projects"] });
      expect(projectsOnly.counts.threadLabels).toBe(2);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE agent_work_runs SET agent_id = 'agent:a' WHERE work_thread_id = 'b'`;
      yield* sql`INSERT INTO agent_run_threads(thread_id, agent_id, trigger_kind) VALUES ('b', 'agent:a', 'owner')`;
      const scoped = yield* service.export({
        include: ["agents"],
        labelId: ProjectLabelId.make("a"),
      });
      expect(scoped.counts.agentRuns).toBe(1);
      expect(scoped.counts.agentRunThreads).toBeUndefined();
      expect(scoped.counts.runs).toBe(1);
      expect(yield* service.validate({ path: scoped.path })).toEqual({
        counts: scoped.counts,
        errors: [],
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "reports unsupported versions, truncated records and paths outside home without importing",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* Exports.ExportService;
        const fs = yield* FileSystem.FileSystem;
        const result = yield* service.export({ include: ["chats"] });
        const manifest = parse(yield* fs.readFileString(result.path + "/manifest.json")) as Record<
          string,
          unknown
        >;
        yield* fs.writeFileString(
          result.path + "/manifest.json",
          encode({ ...manifest, schemaVersion: 99 }),
        );
        expect((yield* service.validate({ path: result.path })).errors).toHaveLength(1);
        yield* fs.writeFileString(result.path + "/manifest.json", encode(manifest));
        yield* fs.writeFileString(result.path + "/records.jsonl", '{"kind":');
        expect((yield* service.validate({ path: result.path })).errors).toHaveLength(1);
        expect(
          (yield* service.validate({ path: (yield* Config.ServerConfig).baseDir })).errors,
        ).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "thread deletion removes tag and agent associations and excludes the retained tombstone",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("a");
        yield* sql`INSERT INTO agent_run_threads(thread_id, agent_id, trigger_kind) VALUES ('a', 'agent:a', 'owner')`;
        const now = DateTime.makeUnsafe(at);
        const projection = yield* Projections.ProjectionStoreV2;
        yield* projection.apply({
          id: EventId.make("delete:a"),
          type: "thread.deleted",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId: ProjectId.make("repo"),
            title: "a",
            providerInstanceId: ProviderInstanceId.make("codex"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            createdBy: "user",
            creationSource: "web",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: now,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            lastVisitedAt: null,
          },
        });
        expect(yield* sql`SELECT * FROM thread_project_labels WHERE thread_id = 'a'`).toEqual([]);
        expect(yield* sql`SELECT * FROM agent_run_threads WHERE thread_id = 'a'`).toEqual([]);
        const service = yield* Exports.ExportService;
        const result = yield* service.export({ include: ["chats"] });
        expect(result.counts.threads).toBe(1);
        expect(result.counts.messages).toBe(1);
        expect(yield* service.validate({ path: result.path })).toEqual({
          counts: result.counts,
          errors: [],
        });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("bounds records and rejects malformed row shapes and count mismatches", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Exports.ExportService;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const result = yield* service.export({ include: ["memory"] });
      yield* fs.writeFileString(
        result.path + "/records.jsonl",
        encode({ kind: "memory", data: { note_id: 17 } }) + "\n",
      );
      expect((yield* service.validate({ path: result.path })).errors).toHaveLength(1);
      yield* fs.writeFileString(result.path + "/records.jsonl", "");
      expect((yield* service.validate({ path: result.path })).errors).toContain(
        "Count mismatch: memory",
      );
      const large = "x".repeat(4 * 1024 * 1024 + 1);
      yield* sql`UPDATE agent_memory SET text = ${large} WHERE note_id = 'a'`;
      expect((yield* Effect.result(service.export({ include: ["memory"] })))._tag).toBe("Failure");
      yield* fs.writeFileString(result.path + "/records.jsonl", large);
      expect((yield* service.validate({ path: result.path })).errors).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("streams a multi-chunk history and retains finite agent-run associations", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 500)
      INSERT INTO agent_memory(note_id, agent_id, text, source, created_at, updated_at)
      SELECT 'bulk:' || x, 'agent:a', ${"q".repeat(2048)}, 'owner', ${at}, ${at} FROM n`;
      yield* sql`INSERT INTO agent_run_threads(thread_id, agent_id, trigger_kind) VALUES ('a', 'agent:a', 'owner')`;
      const service = yield* Exports.ExportService;
      const result = yield* service.export({
        include: ["memory", "agents"],
        labelId: ProjectLabelId.make("a"),
      });
      expect(result.counts.memory).toBe(501);
      expect(result.counts.agentRunThreads).toBe(1);
      expect(result.counts.runs).toBe(1);
      expect(result.bytes).toBeGreaterThan(1024 * 1024);
      expect(yield* service.validate({ path: result.path })).toEqual({
        counts: result.counts,
        errors: [],
      });
    }).pipe(Effect.provide(layer)),
  );
});
