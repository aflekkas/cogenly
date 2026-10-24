import { layerIdentity as layerSharedIdentity } from "../sync/testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Fact, ProjectLabelId, RunId, ThreadId, type FactCreateInput } from "@cogenly/contracts";
import * as NodeSqlite from "@cogenly/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Facts from "./FactService.ts";
import * as Retrieval from "./ContextRetrievalService.ts";
import * as Store from "../agents/AgentStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { agentFixture } from "../agents/agent.testkit.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const layer = Layer.mergeAll(
  Facts.layer,
  Retrieval.layer,
  Store.layer.pipe(Layer.provide(layerSharedIdentity)),
).pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer));
const a = ProjectLabelId.make("a"),
  b = ProjectLabelId.make("b");
const threadId = ThreadId.make("chat");
const at = "2026-01-01T00:00:00.000Z";
const decodeFact = Schema.decodeUnknownEffect(Schema.fromJsonString(Fact));
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of [a, b])
    yield* sql`INSERT INTO project_labels(label_id,name,created_at,updated_at) VALUES (${id},${id},${at},${at})`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${threadId},'repo','Chat','codex','full-access','default',${at},${at},'{}')`;
});
const input = (text: string, labels: ReadonlyArray<ProjectLabelId> = [a]): FactCreateInput => ({
  subject: "Decision",
  text,
  labelIds: labels,
  visibility: "labels",
  sourceRefs: [{ kind: "url", id: `https://example.com/${text.slice(0, 10)}` }],
});

describe("shared facts and scoped context", () => {
  it.effect("migrates notes with identity, readable scope, trust, provenance and history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      for (const id of [a, b])
        yield* sql`INSERT INTO project_labels(label_id,name,created_at,updated_at) VALUES (${id},${id},${at},${at})`;
      const scoped = {
        ...agentFixture("scoped"),
        scope: [{ labelId: a, permissions: agentFixture().permissions }],
      };
      for (const agent of [scoped, agentFixture("private")]) {
        yield* sql`INSERT INTO agents(agent_id,conversation_thread_id,payload_json,enabled,daily_run_cap) VALUES (${agent.id},${agent.conversationThreadId},${JSON.stringify(agent)},1,2)`;
        for (const source of ["owner", "thread:evidence"])
          yield* sql`INSERT INTO agent_memory(note_id,agent_id,text,source,created_at,updated_at) VALUES (${source},${agent.id},'remembered',${source},${at},${at})`;
      }
      yield* runMigrations();
      yield* runMigrations();
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM facts ORDER BY agent_id,legacy_note_id`;
      const migrated = yield* Effect.forEach(rows, (r) => decodeFact(r.payload_json));
      expect(migrated).toHaveLength(4);
      expect(migrated.filter((f) => f.status === "confirmed")).toHaveLength(2);
      expect(migrated.find((f) => f.agentId === scoped.id)?.labelIds).toEqual([a]);
      expect(migrated.find((f) => f.agentId === agentFixture("private").id)?.visibility).toBe(
        "user",
      );
      expect(migrated.find((f) => f.status === "proposed")?.sourceRefs).toEqual([
        { kind: "thread", id: "evidence" },
      ]);
      expect(yield* sql`SELECT * FROM fact_history`).toHaveLength(4);
      expect(yield* sql`SELECT * FROM agent_memory`).toEqual([]);
      const aliases = yield* Store.AgentStore.pipe(
        Effect.flatMap((store) => store.memory(scoped.id)),
        Effect.provide(Store.layer.pipe(Layer.provide(layerSharedIdentity))),
      );
      expect(aliases.map((n) => n.id).sort()).toEqual(["owner", "thread:evidence"]);
    }).pipe(
      Effect.provide(
        NodeSqlite.layer({ filename: ":memory:" }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );

  it.effect(
    "agents read shared facts in every project but never another owner's private facts",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.AgentStore,
          facts = yield* Facts.FactService,
          retrieval = yield* Retrieval.ContextRetrievalService;
        const agent = yield* store.save(agentFixture());
        const other = yield* store.save(agentFixture("other"));
        yield* facts.create(input("allowed"));
        yield* facts.create(input("unscoped", [b]));
        yield* facts.create({ ...input("owner private"), visibility: "user" });
        yield* facts.create({
          ...input("other private", []),
          visibility: "user",
          agentId: other.id,
        });
        yield* store.remember({ agentId: agent.id, text: "own private" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${b})`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES ('secret',${threadId},'user',0,${at},${at},'{"text":"foreign transcript"}')`;
        const principal = `agent:${agent.id}` as const;
        const visible = (yield* facts.list({}, principal)).facts.map((f) => f.text);
        expect(visible).toEqual(expect.arrayContaining(["allowed", "unscoped", "own private"]));
        expect(visible).not.toContain("owner private");
        expect(visible).not.toContain("other private");
        const result = yield* retrieval.retrieve({ principal, threadId, budgetChars: 16000 });
        expect(result.text).toContain("allowed");
        expect(result.text).not.toContain("foreign transcript");
        expect(
          (yield* retrieval.retrieve({ principal, threadId, labelIds: [b], budgetChars: 16000 }))
            .text,
        ).toContain("unscoped");
        expect(
          (yield* facts.create({ ...input("proposal", [b]), agentId: agent.id }, principal)).fact
            .status,
        ).toBe("proposed");
        expect(
          (yield* facts
            .create({ ...input("forbidden", [b]), agentId: other.id }, principal)
            .pipe(Effect.flip)).reason,
        ).toBe("forbidden");
        yield* store.save({ ...agent, permissions: { ...agent.permissions, read: false } });
        expect((yield* facts.list({}, principal)).facts).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves immutable contents and links supersede chains with ordered history", () =>
    Effect.gen(function* () {
      yield* seed;
      const facts = yield* Facts.FactService;
      const first = (yield* facts.create(input("first"))).fact;
      const second = (yield* facts.supersede({ id: first.id, replacement: input("second") })).fact;
      const third = (yield* facts.supersede({ id: second.id, replacement: input("third") })).fact;
      const all = (yield* facts.list({})).facts;
      expect(all.find((f) => f.id === first.id)).toMatchObject({
        text: "first",
        status: "superseded",
        supersededBy: second.id,
      });
      expect(all.find((f) => f.id === second.id)).toMatchObject({
        text: "second",
        status: "superseded",
        supersededBy: third.id,
      });
      expect((yield* facts.list({ status: "confirmed" })).facts.map((f) => f.id)).toEqual([
        third.id,
      ]);
      expect((yield* facts.history(first.id)).history.map((h) => h.fact.status)).toEqual([
        "confirmed",
        "superseded",
      ]);
      expect(
        (yield* facts
          .supersede({ id: first.id, replacement: input("duplicate") })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid_state");
      yield* facts.retract(third.id);
      expect((yield* facts.list({ status: "confirmed" })).facts).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps agent proposals out of injected context until confirmed by the owner", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.AgentStore,
        facts = yield* Facts.FactService,
        retrieval = yield* Retrieval.ContextRetrievalService;
      const agent = yield* store.save(agentFixture());
      const principal = `agent:${agent.id}` as const;
      const proposed = (yield* facts.create({ ...input("inferred"), agentId: agent.id }, principal))
        .fact;
      expect(proposed.status).toBe("proposed");
      expect((yield* retrieval.retrieve({ principal, budgetChars: 16000 })).text).not.toContain(
        "inferred",
      );
      const successor = (yield* facts.supersede(
        { id: proposed.id, replacement: { ...input("corrected"), agentId: agent.id } },
        principal,
      )).fact;
      yield* facts.update({ id: successor.id, status: "confirmed" });
      expect((yield* retrieval.retrieve({ principal, budgetChars: 16000 })).text).toContain(
        "corrected",
      );
      const correction = (yield* facts.supersede(
        { id: successor.id, replacement: { ...input("new correction"), agentId: agent.id } },
        principal,
      )).fact;
      expect(correction.status).toBe("proposed");
      expect((yield* facts.list({ status: "confirmed" })).facts.map((f) => f.id)).toContain(
        successor.id,
      );
      yield* facts.update({ id: correction.id, status: "confirmed" });
      expect((yield* facts.list({ status: "confirmed" })).facts.map((f) => f.id)).toEqual([
        correction.id,
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps compatibility aliases stable while agent edits remain proposals", () =>
    Effect.gen(function* () {
      const store = yield* Store.AgentStore,
        facts = yield* Facts.FactService;
      const agent = yield* store.save(agentFixture());
      const note = yield* store.remember({ agentId: agent.id, text: "owner original" });
      const edited = yield* store.remember(
        {
          agentId: agent.id,
          id: note.id,
          text: "agent correction",
          source: `thread:${agent.conversationThreadId}`,
        },
        `agent:${agent.id}`,
      );
      expect(edited).toMatchObject({ id: note.id, text: "agent correction" });
      expect(yield* store.memory(agent.id)).toHaveLength(1);
      expect((yield* facts.list({ status: "confirmed" })).facts.map((f) => f.text)).toEqual([
        "owner original",
      ]);
      yield* store.remember(
        {
          agentId: agent.id,
          id: note.id,
          text: "second correction",
          source: `thread:${agent.conversationThreadId}`,
        },
        `agent:${agent.id}`,
      );
      expect((yield* store.memory(agent.id))[0]?.text).toBe("second correction");
      const pending = (yield* facts.list({ status: "proposed" })).facts[0]!;
      yield* facts.update({ id: pending.id, status: "confirmed" });
      expect((yield* facts.list({ status: "confirmed" })).facts.map((f) => f.text)).toEqual([
        "second correction",
      ]);
      expect(yield* store.forget(agent.id, note.id, `agent:${agent.id}`)).toBe(true);
      expect(yield* store.memory(agent.id)).toEqual([]);
      expect((yield* facts.history(pending.id)).history.at(-1)?.who).toBe(`agent:${agent.id}`);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "retrieves open commitments and observable Work outcomes with refs, never own messages",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const retrieval = yield* Retrieval.ContextRetrievalService,
          sql = yield* SqlClient.SqlClient;
        const agent = yield* (yield* Store.AgentStore).save(agentFixture());
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('repo','Repo','/repo','[]',${at},${at})`;
        yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${a},'repo')`;
        yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${a})`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES ('recent',${threadId},'assistant',0,${at},${at},'{"text":"A recent message"}')`;
        for (const [id, status, label] of [
          ["open", "open", a],
          ["done", "done", a],
          ["private", "open", b],
        ] as const) {
          const item = {
            id,
            title: id,
            description: "Follow up",
            status,
            owner: { kind: "user" },
            dueAt: null,
            reminderAt: null,
            waitingOn: null,
            labelIds: [label],
            agentId: null,
            sourceRefs: [{ kind: "message", id: "origin" }],
            evidenceRefs: [],
            createdAt: at,
            updatedAt: at,
          };
          yield* sql`INSERT INTO commitments(id,status,payload_json,created_at,updated_at) VALUES (${id},${status},${JSON.stringify(item)},${at},${at})`;
          yield* sql`INSERT INTO commitment_labels(commitment_id,label_id) VALUES (${id},${label})`;
        }
        const payload = JSON.stringify({
          workOrigin: "direct",
          pullRequests: [
            { url: "https://github.com/acme/repo/pull/1", source: "manual" },
            { url: "https://github.com/acme/repo/pull/2", source: "stack-dismissed" },
          ],
        });
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('work','repo','Shipped fix','codex','full-access','default',${at},${at},${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES ('work-run','work',1,'codex','completed',${at},${at},'{}')`;
        const result = yield* retrieval.retrieve({
          principal: "user",
          threadId,
          budgetChars: 4000,
        });
        expect(result.items.map((i) => i.kind).sort()).toEqual(["commitment", "work"]);
        // The thread's own messages stay in its transcript, out of retrieved context.
        expect(result.text).not.toContain("A recent message");
        expect(result.items.some((i) => i.kind === "message")).toBe(false);
        expect(result.items.find((i) => i.kind === "work")?.refs).toEqual([
          { kind: "thread", id: "work" },
          { kind: "run", id: "work-run" },
          { kind: "pr", id: "https://github.com/acme/repo/pull/1" },
        ]);
        const scoped = yield* retrieval.retrieve({
          principal: `agent:${agent.id}`,
          threadId,
          labelIds: [b],
          budgetChars: 4000,
        });
        expect(scoped.items.map((item) => item.id)).toEqual(["private"]);
        const principal = `agent:${agent.id}` as const;
        expect(
          (yield* retrieval.retrieve({ principal, budgetChars: 4000 })).items.some(
            (item) => item.id === "work",
          ),
        ).toBe(true);
        yield* sql`DELETE FROM label_repositories WHERE label_id=${a} AND repository_id='repo'`;
        // Agents read every live repository, linked to a project tag or not.
        const unlinked = yield* retrieval.retrieve({ principal, budgetChars: 4000 });
        expect(unlinked.items.some((item) => item.id === "work")).toBe(true);
        expect(unlinked.items.some((item) => item.id === "open")).toBe(true);
        yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${a},'repo')`;
        // A newer live run means the old completed run is no longer a current outcome.
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES ('new-run','work',2,'codex','running',${at},'{}')`;
        expect(
          (yield* retrieval.retrieve({
            principal: "user",
            threadId,
            budgetChars: 4000,
          })).items.filter((i) => i.kind === "work"),
        ).toEqual([]);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "uses repository defaults for Work context and explicit folder filing for chats and Work outcomes",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const facts = yield* Facts.FactService;
        const retrieval = yield* Retrieval.ContextRetrievalService;
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('repo','Repo','/repo','[]',${at},${at})`;
        yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${a},'repo')`;
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json='{"surface":"work","workOrigin":"direct"}' WHERE thread_id=${threadId}`;
        yield* facts.create(input("Repository context"));
        yield* facts.create(input("Explicit context", [b]));
        expect(yield* retrieval.settings(threadId)).toEqual({ enabled: true });
        expect(
          (yield* retrieval.forTurn({ threadId, principal: "user", budgetChars: 4000 })).text,
        ).toContain("Repository context");
        yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${b})`;
        expect(
          (yield* retrieval.forTurn({ threadId, principal: "user", budgetChars: 4000 })).text,
        ).toContain("Explicit context");
        expect(
          (yield* retrieval.forTurn({ threadId, principal: "user", budgetChars: 4000 })).text,
        ).not.toContain("Repository context");
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('outcome','repo','Outcome','codex','full-access','default',${at},${at},'{"surface":"work","workOrigin":"direct"}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES ('outcome-run','outcome',1,'codex','completed',${at},${at},'{}')`;
        expect(
          (yield* retrieval.retrieve({
            principal: "user",
            threadId,
            budgetChars: 4000,
          })).items.some((i) => i.id === "outcome"),
        ).toBe(false);
        yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES ('outcome',${b})`;
        expect(
          (yield* retrieval.retrieve({
            principal: "user",
            threadId,
            budgetChars: 4000,
          })).items.find((i) => i.id === "outcome")?.labelIds,
        ).toEqual([b]);
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json='{"surface":"chat"}' WHERE thread_id=${threadId}`;
        expect(
          (yield* retrieval.forTurn({ threadId, principal: "user", budgetChars: 4000 })).text,
        ).toContain("Explicit context");
        yield* sql`DELETE FROM thread_project_labels WHERE thread_id=${threadId}`;
        expect(yield* retrieval.settings(threadId)).toEqual({ enabled: false });
        expect(
          (yield* retrieval.forTurn({ threadId, principal: "user", budgetChars: 4000 })).text,
        ).toBe("");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("records title, snippet, source and reason for every context kind", () =>
    Effect.gen(function* () {
      yield* seed;
      const facts = yield* Facts.FactService,
        retrieval = yield* Retrieval.ContextRetrievalService,
        sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('repo','Repo','/repo','[]',${at},${at})`;
      yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${a},'repo')`;
      yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${a})`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES ('recent',${threadId},'assistant',0,${at},${at},'{"text":"A recent message"}')`;
      const commitment = {
        id: "open",
        title: "Follow up",
        description: "File the report",
        status: "open",
        owner: { kind: "user" },
        dueAt: null,
        reminderAt: null,
        waitingOn: null,
        labelIds: [a],
        agentId: null,
        sourceRefs: [{ kind: "message", id: "origin" }],
        evidenceRefs: [],
        createdAt: at,
        updatedAt: at,
      };
      yield* sql`INSERT INTO commitments(id,status,payload_json,created_at,updated_at) VALUES ('open','open',${JSON.stringify(commitment)},${at},${at})`;
      yield* sql`INSERT INTO commitment_labels(commitment_id,label_id) VALUES ('open',${a})`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('work','repo','Shipped fix','codex','full-access','default',${at},${at},'{"workOrigin":"direct","pullRequests":[{"url":"https://github.com/acme/repo/pull/1","source":"manual"}]}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES ('work-run','work',1,'codex','completed',${at},${at},'{}')`;
      yield* facts.create(input("Shared decision"));
      const runId = RunId.make("run-display");
      const selected = yield* retrieval.forTurn({
        threadId,
        runId,
        principal: "user",
        budgetChars: 4000,
      });
      expect(selected.items.map((i) => i.kind).sort()).toEqual(["commitment", "fact", "work"]);
      expect(selected.items.some((i) => i.kind === "message")).toBe(false);
      const recorded = yield* retrieval.forRun(runId);
      for (const item of recorded.items) {
        expect(item.title, `${item.kind} title`).toBeTruthy();
        expect(item.snippet, `${item.kind} snippet`).toBeTruthy();
        expect(item.snippet!.length).toBeLessThanOrEqual(280);
        expect(item.reason, `${item.kind} reason`).toBeTruthy();
        expect(item.text, `${item.kind} text`).not.toBe("");
      }
      expect(recorded.items.find((i) => i.kind === "work")).toMatchObject({
        title: "Shipped fix",
        sourceThreadId: "work",
        sourceThreadTitle: "Shipped fix",
        reason: "Work outcome from Repo",
      });
      expect(recorded.items.find((i) => i.kind === "fact")?.reason).toContain("Confirmed fact");
      expect(recorded.items.find((i) => i.kind === "commitment")).toMatchObject({
        title: "Follow up",
        reason: "Open commitment",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("backfills display metadata for runs recorded without it", () =>
    Effect.gen(function* () {
      yield* seed;
      const retrieval = yield* Retrieval.ContextRetrievalService,
        sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('repo','Repo','/repo','[]',${at},${at})`;
      yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${a},'repo')`;
      yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${a})`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES ('recent',${threadId},'assistant',0,${at},${at},'{"text":"A recent message"}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES ('work','repo','Shipped fix','codex','full-access','default',${at},${at},'{"workOrigin":"direct"}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES ('work-run','work',1,'codex','completed',${at},${at},'{}')`;
      const legacy = {
        runId: "legacy-run",
        refs: [
          { kind: "thread", id: threadId },
          { kind: "message", id: "recent" },
          { kind: "thread", id: "work" },
        ],
        items: [
          {
            kind: "message",
            id: "recent",
            text: "",
            refs: [
              { kind: "thread", id: threadId },
              { kind: "message", id: "recent" },
            ],
            labelIds: [a],
            updatedAt: at,
          },
          {
            kind: "work",
            id: "work",
            text: "",
            refs: [
              { kind: "thread", id: "work" },
              { kind: "run", id: "work-run" },
            ],
            labelIds: [a],
            updatedAt: at,
          },
        ],
      };
      yield* sql`INSERT INTO context_refs(run_id,thread_id,payload_json) VALUES ('legacy-run',${threadId},${JSON.stringify(legacy)})`;
      const recorded = yield* retrieval.forRun(RunId.make("legacy-run"));
      expect(recorded.items.find((i) => i.kind === "message")).toMatchObject({
        title: "Chat",
        sourceThreadId: threadId,
        sourceMessageId: "recent",
        reason: "Recent message in this project",
      });
      expect(recorded.items.find((i) => i.kind === "message")?.snippet).toContain(
        "A recent message",
      );
      expect(recorded.items.find((i) => i.kind === "work")).toMatchObject({
        title: "Shipped fix",
        sourceThreadTitle: "Shipped fix",
        reason: "Work outcome from Repo",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "enforces the complete rendered budget, records exact selected refs, and respects opt-out and untagged chats",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const facts = yield* Facts.FactService,
          retrieval = yield* Retrieval.ContextRetrievalService,
          store = yield* Store.AgentStore;
        const sql = yield* SqlClient.SqlClient;
        yield* facts.create(input("large".repeat(2000)));
        yield* facts.create({ ...input("unrelated private", []), visibility: "user" });
        const runId = RunId.make("run-context");
        expect(yield* store.context(threadId, runId)).toBe("");
        expect((yield* retrieval.forRun(runId)).refs).toEqual([]);
        yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${a})`;
        const selected = yield* retrieval.forTurn({
          threadId,
          runId,
          principal: "user",
          budgetChars: 300,
        });
        expect(selected.text.length).toBeLessThanOrEqual(300);
        expect(selected.items).toHaveLength(1);
        expect(selected.text).not.toContain("unrelated private");
        expect((yield* retrieval.forRun(runId)).refs).toEqual(
          selected.items.flatMap((i) => i.refs),
        );
        expect(
          (yield* retrieval.forRun(runId)).items.every(
            (i) => i.text !== "" && i.snippet !== undefined,
          ),
        ).toBe(true);
        expect((yield* retrieval.forRun(RunId.make("missing"))).refs).toEqual([]);
        expect(
          (yield* retrieval.retrieve({ principal: "user", labelIds: [a], budgetChars: 0 })).text,
        ).toBe("");
        expect(
          (yield* retrieval.retrieve({ principal: "user", labelIds: [a], budgetChars: 1 })).text,
        ).toBe("");
        yield* retrieval.setEnabled({ threadId, enabled: false });
        yield* retrieval.forTurn({ threadId, runId, principal: "user", budgetChars: 4000 });
        expect((yield* retrieval.forRun(runId)).refs).toEqual(
          selected.items.flatMap((i) => i.refs),
        );
        expect(yield* store.context(threadId, RunId.make("opt-out"))).toBe("");
        yield* retrieval.setEnabled({ threadId, enabled: true });
        expect(yield* store.context(threadId, RunId.make("opt-in"))).toContain("large");
        yield* sql`DELETE FROM thread_project_labels WHERE thread_id=${threadId}`;
        expect(yield* store.context(threadId, RunId.make("untagged"))).toBe("");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("never injects a thread's own messages back into its prompt", () =>
    Effect.gen(function* () {
      yield* seed;
      const retrieval = yield* Retrieval.ContextRetrievalService,
        facts = yield* Facts.FactService,
        sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${threadId},${a})`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES ('own-1',${threadId},'user',0,${at},${at},'{"text":"What is the deploy checklist?"}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES ('own-2',${threadId},'assistant',0,${at},${at},'{"text":"Here is the deploy checklist."}')`;
      yield* facts.create(input("Repository context"));
      const result = yield* retrieval.retrieve({
        principal: "user",
        threadId,
        budgetChars: 4000,
      });
      expect(result.text).not.toContain("deploy checklist");
      expect(result.items.some((item) => item.kind === "message")).toBe(false);
      // The freed budget still serves the remaining evidence.
      expect(result.text).toContain("Repository context");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("dedupes near-identical items across threads and keeps distinct ones", () =>
    Effect.gen(function* () {
      yield* seed;
      const retrieval = yield* Retrieval.ContextRetrievalService,
        facts = yield* Facts.FactService,
        sql = yield* SqlClient.SqlClient;
      const agent = yield* (yield* Store.AgentStore).save(agentFixture());
      const principal = `agent:${agent.id}` as const;
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('repo','Repo','/repo','[]',${at},${at})`;
      yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${a},'repo')`;
      const shared =
        "the deploy checklist requires a green build, a reviewed migration, and a staged rollout plan";
      yield* facts.create(input(shared, [a]));
      yield* facts.create(input(shared, [b]));
      yield* facts.create(
        input(`${shared} plus an on-call acknowledgement in the handoff notes`, [a]),
      );
      yield* facts.create(input("unrelated decision with entirely different wording here", [a]));
      for (const filed of [a, b]) {
        const id = `work-${filed}`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${id},'repo','Shipped fix','codex','full-access','default',${at},${at},'{"surface":"work","workOrigin":"direct"}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES (${`${id}-run`},${id},1,'codex','completed',${at},${at},'{}')`;
        yield* sql`INSERT INTO thread_project_labels(thread_id,label_id) VALUES (${id},${filed})`;
      }
      const result = yield* retrieval.retrieve({ principal, budgetChars: 16000 });
      // The exact copy and the extended copy collapse into one surviving item.
      expect(
        result.items.filter(
          (item) => item.kind === "fact" && item.text.includes("deploy checklist"),
        ),
      ).toHaveLength(1);
      expect(result.text).toContain("unrelated decision");
      // Identical outcomes from two different threads show up once.
      expect(result.items.filter((item) => item.kind === "work")).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );
});
