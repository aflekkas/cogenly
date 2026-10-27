import { layerIdentity as layerSharedIdentity } from "../sync/testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ThreadId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "../agents/AgentStore.ts";
import { agentFixture } from "../agents/agent.testkit.ts";
import * as Config from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Labels from "../projectLabels/ProjectLabelService.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Search from "./GlobalSearch.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-01-01T00:00:00.000Z";
const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const stores = Layer.mergeAll(
  Store.layer.pipe(Layer.provide(layerSharedIdentity)),
  Labels.layer.pipe(Layer.provide(layerSharedIdentity)).pipe(Layer.provide(Events.layer)),
).pipe(Layer.provideMerge(database));
const layer = Search.layer.pipe(
  Layer.provideMerge(stores),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "cogenly-search-" })),
  Layer.provide(NodeServices.layer),
);
const repo = ProjectId.make("project:one");
const other = ProjectId.make("project:other");
const thread = Effect.fnUntraced(function* (
  id: string,
  projectId: string,
  title = "A thread",
  payload: unknown = {},
  updatedAt = at,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${id}, ${projectId}, ${title}, 'codex', 'full-access', 'default', ${at}, ${updatedAt}, ${json(payload)})`;
});
const message = Effect.fnUntraced(function* (
  id: string,
  threadId: string,
  text: string,
  streaming = 0,
  role = "user",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES (${id}, ${threadId}, ${role}, ${streaming}, ${at}, ${at}, ${json({ text })})`;
});
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* Config.ServerConfig;
  for (const id of [repo, other, "scratch"])
    yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, ${id}, ${id === "scratch" ? `${config.baseDir}/scratch` : `/repos/${id}`}, '[]', ${at}, ${at})`;
});
const scope = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "test",
    providerInstanceId: agentFixture().modelSelection.instanceId,
  },
});
const pr = (url: string, title: string) => ({
  url,
  source: "manual",
  linkedAt: at,
  snapshot: { title, updatedAt: at },
});
const commitment = Effect.fnUntraced(function* (
  id: string,
  title: string,
  agentId: string | null = null,
  labelId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO commitments(id, agent_id, status, payload_json, created_at, updated_at) VALUES (${id}, ${agentId}, 'open', ${json({ title, description: "quartz description" })}, ${at}, ${at})`;
  if (labelId)
    yield* sql`INSERT INTO commitment_labels(commitment_id, label_id) VALUES (${id}, ${labelId})`;
});

describe("global search", () => {
  it.effect("omits subagent thread titles and bodies from palette results", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* thread("parent", repo, "Quartz parent");
      yield* thread("child", repo, "Quartz child", {
        lineage: { relationshipToParent: "subagent" },
      });
      yield* message("child-message", "child", "quartz");
      const search = yield* Search.GlobalSearch;
      expect((yield* search.query({ query: "quartz" })).results.map((r) => r.id)).toEqual([
        "parent",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "reads historical explicit filing ahead of repository defaults while refusing new mismatches",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const folders = yield* Labels.ProjectLabelService;
        const search = yield* Search.GlobalSearch;
        const a = (yield* folders.create({ name: "A" })).label.id;
        const b = (yield* folders.create({ name: "B" })).label.id;
        yield* folders.linkRepository({ labelId: a, repositoryId: repo });
        yield* thread("derived", repo, "Quartz derived", { surface: "work" });
        yield* thread("explicit", repo, "Quartz explicit", { surface: "work" });
        yield* thread("chat", "scratch", "Quartz chat", { surface: "chat" });
        const refused = yield* folders
          .moveThread({ threadId: ThreadId.make("explicit"), folderId: b })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("invalid_membership");
        // Existing history and replica imports retain their explicit filing even
        // when the repository no longer belongs to that project.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO thread_project_labels(thread_id, label_id) VALUES ('explicit', ${b})`;
        expect(
          (yield* search.query({ query: "quartz", labelId: a })).results.map((r) => r.id),
        ).toEqual(["derived"]);
        expect(
          (yield* search.query({ query: "quartz", labelId: b })).results.map((r) => r.id),
        ).toEqual(["explicit"]);
        yield* folders.moveThread({ threadId: ThreadId.make("explicit"), folderId: null });
        expect(
          (yield* search.query({ query: "quartz", labelId: a })).results.map((r) => r.id).sort(),
        ).toEqual(["derived", "explicit"]);
        yield* folders.moveThread({ threadId: ThreadId.make("chat"), folderId: b });
        expect(
          (yield* search.query({ query: "quartz", labelId: b })).results.map((r) => r.id),
        ).toEqual(["chat"]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "indexes only confirmed facts, enforces owner/label visibility, and cleans up retractions and cascades",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const search = yield* Search.GlobalSearch;
        const label = (yield* (yield* Labels.ProjectLabelService).create({ name: "Shared" })).label;
        const agent = {
          ...agentFixture(),
          scope: [{ labelId: label.id, permissions: agentFixture().permissions }],
        };
        const stranger = agentFixture("stranger");
        for (const a of [agent, stranger]) {
          yield* thread(a.conversationThreadId, repo);
          yield* (yield* Store.AgentStore).save(a);
        }
        for (const [id, owner, visibility, status] of [
          ["own", agent.id, "user", "confirmed"],
          ["shared", stranger.id, "labels", "confirmed"],
          ["private", stranger.id, "user", "confirmed"],
          ["proposed", agent.id, "labels", "proposed"],
          ["user", null, "user", "confirmed"],
        ] as const) {
          yield* sql`INSERT INTO facts(id, agent_id, status, payload_json, updated_at) VALUES (${id}, ${owner}, ${status}, ${json({ subject: "Quartz memory", text: "Nebula details", visibility })}, ${at})`;
          yield* sql`INSERT INTO fact_labels(fact_id, label_id) VALUES (${id}, ${label.id})`;
        }
        expect((yield* search.query({ query: "quartz", kinds: ["fact"] })).results).toHaveLength(4);
        const scoped = (yield* search.query(
          { query: "nebula", kinds: ["fact"], labelId: label.id },
          scope(agent.conversationThreadId),
        )).results;
        expect(new Set(scoped.map((r) => r.id))).toEqual(new Set(["own", "shared"]));
        expect(scoped.every((r) => r.labelIds.includes(label.id))).toBe(true);
        yield* (yield* Store.AgentStore).save({
          ...agent,
          permissions: { ...agent.permissions, read: false },
        });
        expect(
          (yield* search.query(
            { query: "quartz", kinds: ["fact"] },
            scope(agent.conversationThreadId),
          )).results,
        ).toEqual([]);
        yield* (yield* Store.AgentStore).save(agent);
        yield* sql`UPDATE facts SET status = 'confirmed' WHERE id = 'proposed'`;
        expect((yield* search.query({ query: "quartz", kinds: ["fact"] })).results).toHaveLength(5);
        yield* sql`UPDATE facts SET status = 'retracted' WHERE id = 'proposed'`;
        yield* sql`UPDATE facts SET status = 'retracted' WHERE id = 'own'`;
        yield* sql`UPDATE facts SET status = 'superseded' WHERE id = 'shared'`;
        yield* sql`DELETE FROM facts WHERE id = 'user'`;
        yield* sql`DELETE FROM agents WHERE agent_id = ${stranger.id}`;
        expect((yield* search.query({ query: "quartz", kinds: ["fact"] })).results).toEqual([]);
        expect(yield* sql`SELECT * FROM search_documents WHERE kind = 'fact'`).toEqual([]);
        yield* commitment("delete-me", "Quartz deleted", agent.id);
        yield* sql`DELETE FROM commitments WHERE id = 'delete-me'`;
        yield* commitment("cascade-me", "Quartz cascade", agent.id);
        yield* sql`DELETE FROM agents WHERE agent_id = ${agent.id}`;
        // Commitments intentionally survive agent deletion (ON DELETE SET NULL).
        expect(
          (yield* search.query({ query: "quartz", kinds: ["commitment"] })).results.map(
            (r) => r.id,
          ),
        ).toEqual(["cascade-me"]);
        yield* sql`DELETE FROM commitments WHERE id = 'cascade-me'`;
        expect((yield* search.query({ query: "quartz", kinds: ["commitment"] })).results).toEqual(
          [],
        );
        yield* sql`INSERT INTO search_fts(search_fts, rank) VALUES ('integrity-check', 1)`;
      }).pipe(Effect.provide(layer)),
  );

  it.effect("indexes all six kinds on their writes, updates text, and bounds snippets", () =>
    Effect.gen(function* () {
      yield* seed;
      const search = yield* Search.GlobalSearch;
      const sql = yield* SqlClient.SqlClient;
      const labels = yield* Labels.ProjectLabelService;
      const label = (yield* labels.create({
        name: "Quartz project",
        description: "Project grounding",
      })).label;
      yield* thread("chat", "scratch", "Quartz chat");
      yield* thread("work", repo, "Quartz Work", {
        pullRequests: [pr("https://github.com/acme/repo/pull/42", "Quartz PR")],
      });
      yield* message("m1", "chat", "Quartz " + "long content ".repeat(200));
      yield* labels.setThreadLabels({ threadId: ThreadId.make("chat"), labelIds: [label.id] });
      const agent = {
        ...agentFixture(),
        name: "Quartz agent",
        responsibility: "Quartz responsibilities",
      };
      yield* thread(agent.conversationThreadId, repo);
      yield* (yield* Store.AgentStore).save(agent);
      yield* commitment("item", "Quartz commitment", agent.id, label.id);
      const result = yield* search.query({ query: "quartz" });
      expect(new Set(result.results.map((r) => r.kind))).toEqual(
        new Set(["chat", "work", "agent", "commitment", "project", "pr"]),
      );
      expect(result.results.every((r) => r.snippet.length <= 240 && r.title.length <= 500)).toBe(
        true,
      );
      expect(result.results.find((r) => r.kind === "chat")?.labelIds).toEqual([label.id]);
      expect(
        (yield* search.query({ query: "responsibilities", kinds: ["agent"] })).results[0]?.id,
      ).toBe(agent.id);
      expect((yield* search.query({ query: "42", kinds: ["pr"] })).results[0]?.threadId).toBe(
        "work",
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET title = 'Renamed nebula' WHERE thread_id = 'work'`;
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${json({ text: "Nebula new text" })} WHERE message_id = 'm1'`;
      expect((yield* search.query({ query: "nebula" })).results.map((r) => r.id).sort()).toEqual([
        "chat",
        "work",
      ]);
      yield* labels.update({ id: label.id, name: "Nebula project" });
      expect((yield* search.query({ query: "nebula", kinds: ["project"] })).results[0]?.id).toBe(
        label.id,
      );
      yield* (yield* Store.AgentStore).save({ ...agent, instructions: "Nebula instructions" });
      expect((yield* search.query({ query: "nebula", kinds: ["agent"] })).results[0]?.id).toBe(
        agent.id,
      );
      yield* sql`UPDATE commitments SET payload_json = ${json({ title: "Nebula obligation", description: "Revised" })} WHERE id = 'item'`;
      expect((yield* search.query({ query: "nebula", kinds: ["commitment"] })).results[0]?.id).toBe(
        "item",
      );
      yield* thread("unicode", repo, "Quartz " + "😀".repeat(400));
      yield* message("unicode-body", "unicode", "Quartz " + "😀".repeat(400));
      const unicode = (yield* search.query({ query: "quartz" })).results.find(
        (r) => r.id === "unicode",
      );
      expect(unicode?.title.length).toBeLessThanOrEqual(500);
      expect(unicode?.snippet.length).toBeLessThanOrEqual(240);
      expect(unicode?.snippet.isWellFormed()).toBe(true);
      // A completed assistant message is searchable; a streaming or system row is not.
      yield* message("streaming", "chat", "Streamingneedle", 1, "assistant");
      yield* message("system", "chat", "Systemneedle", 0, "system");
      expect((yield* search.query({ query: "streamingneedle" })).results).toEqual([]);
      expect((yield* search.query({ query: "systemneedle" })).results).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0 WHERE message_id = 'streaming'`;
      expect((yield* search.query({ query: "streamingneedle" })).results[0]?.id).toBe("chat");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("removes deleted messages, links, threads, agents, commitments and labels", () =>
    Effect.gen(function* () {
      yield* seed;
      const search = yield* Search.GlobalSearch;
      const sql = yield* SqlClient.SqlClient;
      yield* thread("work", repo, "Quartz title", {
        pullRequests: [pr("https://example.com/pull/1", "Quartz PR")],
      });
      yield* message("m", "work", "Unique message");
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'm'`;
      expect((yield* search.query({ query: "unique" })).results).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = 'work'`;
      expect((yield* search.query({ query: "quartz", kinds: ["pr"] })).results).toEqual([]);
      yield* message("m2", "work", "Quartz message");
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${at} WHERE thread_id = 'work'`;
      expect((yield* search.query({ query: "quartz" })).results).toEqual([]);
      expect(yield* sql`SELECT key FROM search_documents WHERE thread_id = 'work'`).toEqual([]);
      yield* thread("hard", repo, "Quartz hard delete");
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'hard'`;
      const agent = agentFixture();
      yield* thread(agent.conversationThreadId, repo);
      yield* (yield* Store.AgentStore).save(agent);
      yield* (yield* Store.AgentStore).delete(agent.id);
      const label = (yield* (yield* Labels.ProjectLabelService).create({ name: "Quartz label" }))
        .label;
      yield* (yield* Labels.ProjectLabelService).delete(label.id);
      yield* commitment("item", "Quartz item");
      yield* sql`DELETE FROM commitments WHERE id = 'item'`;
      expect((yield* search.query({ query: "quartz" })).results).toEqual([]);
      expect((yield* search.query({ query: "juniper" })).results).toEqual([]);
      yield* thread("removed-repo", repo, "Quartz hidden repository");
      yield* sql`UPDATE projection_projects SET deleted_at = ${at} WHERE project_id = ${repo}`;
      expect((yield* search.query({ query: "quartz" })).results).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "ranks title relevance and recency, deduplicates threads and filters before limiting",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const search = yield* Search.GlobalSearch;
        const labels = yield* Labels.ProjectLabelService;
        const label = (yield* labels.create({ name: "Filter" })).label;
        yield* thread("older", repo, "Quartz design", {}, "2024-01-01T00:00:00.000Z");
        yield* thread("newer", repo, "Quartz design", {}, "2026-01-01T00:00:00.000Z");
        yield* thread("body", "scratch", "Long transcript");
        yield* message("noise", "body", "Words ".repeat(200) + "quartz");
        yield* message("duplicate", "newer", "quartz");
        const results = (yield* search.query({ query: "quartz" })).results;
        expect(results[0]?.id).toBe("newer");
        expect(results.map((r) => r.id)).toEqual(["newer", "older", "body"]);
        yield* labels.setThreadLabels({ threadId: ThreadId.make("body"), labelIds: [label.id] });
        expect(
          (yield* search.query({ query: "quartz", labelId: label.id, limit: 1 })).results[0]?.id,
        ).toBe("body");
        const sql = yield* SqlClient.SqlClient;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* thread("rollback", repo, "Rollbackneedle");
              return yield* Effect.fail("abort");
            }),
          )
          .pipe(Effect.flip);
        expect((yield* search.query({ query: "rollbackneedle" })).results).toEqual([]);
        expect((yield* search.query({ query: "quartz", kinds: [] })).results).toEqual([]);
        expect(
          (yield* search.query({ query: '" OR * ( ) NEAR -', kinds: ["chat"] })).results,
        ).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "agent search reaches every live repository and project, never other agents' identities",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const search = yield* Search.GlobalSearch;
        const labels = yield* Labels.ProjectLabelService;
        const store = yield* Store.AgentStore;
        const allowed = (yield* labels.create({ name: "Quartz allowed" })).label;
        const blocked = (yield* labels.create({ name: "Quartz blocked" })).label;
        yield* labels.linkRepository({ labelId: allowed.id, repositoryId: other });
        yield* labels.linkRepository({ labelId: blocked.id, repositoryId: repo });
        const agent = { ...agentFixture(), instructions: "Quartz instructions" };
        yield* thread(agent.conversationThreadId, repo);
        yield* store.save(agent);
        yield* thread("visible", repo, "Quartz authorized");
        yield* thread("secret", other, "Quartz secret", {
          pullRequests: [pr("https://private.example/pull/1", "Quartz private PR")],
        });
        yield* labels.setThreadLabels({
          threadId: ThreadId.make("secret"),
          labelIds: [allowed.id],
        });
        yield* labels.setThreadLabels({
          threadId: ThreadId.make("visible"),
          labelIds: [blocked.id],
        });
        const stranger = { ...agentFixture("stranger"), projectId: other, name: "Quartz stranger" };
        yield* thread(stranger.conversationThreadId, other);
        yield* store.save(stranger);
        yield* commitment("own", "Quartz own", agent.id);
        yield* commitment("shared", "Quartz shared", null, allowed.id);
        yield* commitment("elsewhere", "Quartz elsewhere", stranger.id, blocked.id);
        const caller = scope(agent.conversationThreadId);
        yield* message("agent-message", agent.conversationThreadId, "Moonstone context");
        expect((yield* search.query({ query: "moonstone" }, caller)).results[0]?.id).toBe(agent.id);
        // No project scope grant is needed: every repository and project is in reach.
        const results = (yield* search.query({ query: "quartz" }, caller)).results;
        expect(results.map((r) => r.id).sort()).toEqual(
          [
            agent.id,
            allowed.id,
            blocked.id,
            "own",
            "shared",
            "elsewhere",
            "visible",
            "secret",
            "https://private.example/pull/1",
          ].sort(),
        );
        expect(
          (yield* search.query({ query: "quartz", labelId: allowed.id }, caller)).results
            .map((r) => r.id)
            .sort(),
        ).toEqual([allowed.id, "shared", "secret", "https://private.example/pull/1"].sort());
        // Governed runs resolve to the same principal as its conversation.
        yield* thread("governed", repo, "Quartz governed Work", {
          agent: { id: agent.id, role: "work" },
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO agent_run_threads(thread_id, agent_id, trigger_kind) VALUES ('governed', ${agent.id}, 'manual')`;
        const governed = (yield* search.query(
          { query: "quartz" },
          scope(ThreadId.make("governed")),
        )).results;
        expect(governed.some((r) => r.id === "visible")).toBe(true);
        expect(governed.some((r) => r.id === "secret")).toBe(true);
        expect(governed.some((r) => r.id === stranger.id)).toBe(false);
        yield* store.save({ ...agent, permissions: { ...agent.permissions, read: false } });
        expect((yield* search.query({ query: "quartz" }, caller)).results).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );
});
