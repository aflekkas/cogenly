import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgentHandoffBrief, AgentHandoffNarrative, TextGenerationError } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { layerIdentity } from "../sync/testkit.ts";
import * as Text from "../textGeneration/TextGeneration.ts";
import * as Store from "./AgentStore.ts";
import * as Handoff from "./AgentHandoff.ts";
import { agentFixture } from "./agent.testkit.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const storeLayer = Store.layer.pipe(
  Layer.provide(layerIdentity),
  Layer.provideMerge(database),
  Layer.provide(NodeServices.layer),
);
const narrative = {
  entries: [
    {
      text: "Keep the agreed ceiling at 1750. Do NOT email Ada.",
      messageIds: ["m:1"],
      runIds: ["r:1"],
    },
  ],
};
const encodeNarrative = Schema.encodeSync(Schema.fromJsonString(AgentHandoffNarrative));
const encodeBrief = Schema.encodeSync(Schema.fromJsonString(AgentHandoffBrief));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const seed = Effect.gen(function* () {
  const store = yield* Store.AgentStore;
  const agent = yield* store.save({
    ...agentFixture(),
    instructions: "Do NOT email Ada.\nBudget ceiling: 1750.",
  });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,status,requested_at,completed_at,payload_json) VALUES ('r:1',${agent.conversationThreadId},1,'codex','completed',${agent.createdAt},${agent.createdAt},'{}')`;
  const message = "x".repeat(700) + "Do NOT email Ada. Ceiling: 1750.";
  yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json) VALUES ('m:1',${agent.conversationThreadId},'r:1','user',0,${agent.createdAt},${agent.createdAt},${encodeJson({ text: message })})`;
  return { store, agent, sql, message };
});
const provide = (generation: Text.TextGeneration["Service"]["generateAgentNarrative"]) =>
  Handoff.layer.pipe(
    Layer.provide(Layer.mock(Text.TextGeneration)({ generateAgentNarrative: generation })),
    Layer.provideMerge(storeLayer),
  );

describe("agent handoff", () => {
  it.effect("uses a marked partial brief at the deadline after narrative generation fails", () =>
    Effect.gen(function* () {
      const { agent } = yield* seed;
      const handoff = yield* Handoff.AgentHandoff;
      const since = yield* DateTime.now;
      yield* handoff.request({
        agent,
        ordinal: 31,
        cwd: "/unused",
        selections: [agent.modelSelection],
      });
      yield* handoff.drain;
      yield* TestClock.adjust(Handoff.HANDOFF_WAIT_MS - 1);
      expect(yield* handoff.prepare(agent.id, 40, since)).toBeNull();
      yield* TestClock.adjust(1);
      const brief = yield* handoff.prepare(agent.id, 40, since);
      expect(brief?.text).toContain("PARTIAL HANDOFF");
      expect(brief?.text).toContain(agent.instructions);
      expect(brief!.text.length).toBeLessThanOrEqual(Handoff.HANDOFF_MAX_CHARS);
    }).pipe(
      Effect.provide(
        provide(() =>
          Effect.fail(
            new TextGenerationError({ operation: "generateThreadTitle", detail: "unavailable" }),
          ),
        ),
      ),
    ),
  );

  it.effect("compacts oversized facts deterministically while preserving pending approvals", () =>
    Effect.gen(function* () {
      const { agent, sql } = yield* seed;
      const handoff = yield* Handoff.AgentHandoff;
      const since = yield* DateTime.now;
      const fact = encodeJson({
        id: "fact:huge",
        status: "confirmed",
        text: "x".repeat(Handoff.HANDOFF_MAX_CHARS),
      });
      yield* sql`INSERT INTO facts(id,agent_id,status,payload_json,updated_at) VALUES ('fact:huge',${agent.id},'confirmed',${fact},${agent.createdAt})`;
      yield* sql`INSERT INTO agent_approvals(id,agent_id,action_json,status,requested_at) VALUES ('critical',${agent.id},'Never send without approval','pending',${agent.createdAt})`;
      yield* TestClock.adjust(Handoff.HANDOFF_WAIT_MS);
      const brief = yield* handoff.prepare(agent.id, 40, since);
      expect(brief?.text).toContain("1 facts");
      expect(brief?.text).toContain("[fact:fact:huge] status=confirmed");
      expect(brief?.text).toContain("Never send without approval");
      expect(brief!.text.length).toBeLessThanOrEqual(Handoff.HANDOFF_MAX_CHARS);
    }).pipe(Effect.provide(provide(() => Effect.succeed(narrative)))),
  );

  it.effect(
    "generates without blocking a turn, refreshes every exact record and carries core memory across rotations",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<AgentHandoffNarrative>();
        const layer = provide((input) =>
          Effect.gen(function* () {
            expect(input.transcript).toContain(
              "x".repeat(700) + "Do NOT email Ada. Ceiling: 1750.",
            );
            yield* Deferred.succeed(started, undefined);
            return yield* Deferred.await(finish);
          }),
        );
        yield* Effect.gen(function* () {
          const { store, agent, sql } = yield* seed;
          const handoff = yield* Handoff.AgentHandoff;
          yield* handoff.request({
            agent,
            ordinal: 31,
            cwd: "/unused",
            selections: [agent.modelSelection],
          });
          yield* Deferred.await(started);
          // The foreground can run and read memory while the model is still suspended.
          yield* store.updateCoreMemory(
            agent.id,
            "Timezone: Chicago. Do NOT email Ada. Ceiling: 1750.",
          );
          expect(yield* handoff.prepare(agent.id, 40)).toBeNull();
          expect(yield* store.context(agent.conversationThreadId)).toContain("Timezone: Chicago.");
          const commitment = encodeJson({
            owner: { kind: "agent", agentId: agent.id },
            labelIds: [],
            sourceRefs: [],
            evidenceRefs: [],
            agentId: agent.id,
            createdAt: agent.createdAt,
            updatedAt: agent.createdAt,
            id: "c:1",
            title: "Check 1750, never 1700",
            status: "waiting",
            dueAt: agent.createdAt,
            reminderAt: agent.createdAt,
            waitingOn: "Ada's approval",
            description: "x".repeat(15000) + "Do NOT email Ada.",
          });
          yield* sql`INSERT INTO commitments(id,agent_id,status,payload_json,created_at,updated_at) VALUES ('c:1',${agent.id},'waiting',${commitment},${agent.createdAt},${agent.createdAt})`;
          yield* sql`INSERT INTO agent_work_runs(run_id,agent_id,trigger_id,work_thread_id,status,created_at) VALUES ('job:1',${agent.id},'trigger:1','work:1','running',${agent.createdAt})`;
          yield* sql`INSERT INTO agent_approvals(id,agent_id,action_json,status,requested_at) VALUES ('approval:1',${agent.id},'Do NOT email Ada; ceiling 1750','pending',${agent.createdAt})`;
          yield* sql`INSERT INTO agent_work_runs(run_id,agent_id,trigger_id,work_thread_id,status,created_at,summary) VALUES ('job:unposted',${agent.id},'trigger:2','work:2','completed',${agent.createdAt},'Finished 1750 checks; do NOT rerun')`;
          const child = encodeJson({
            id: "child:pending",
            status: "completed",
            result: "Do NOT retry the send",
            completionDelivery: { state: "pending", observedByRunId: null },
          });
          yield* sql`INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json) VALUES ('child:pending',${agent.conversationThreadId},'node:1','codex','app_owned','completed',${agent.createdAt},${child})`;
          const runtimeApproval = encodeJson({
            id: "native-approval",
            kind: "approval",
            status: "pending",
            text: "Send exactly 1750?",
          });
          yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json) VALUES ('native-approval',${agent.conversationThreadId},'node:1','approval','pending',${agent.createdAt},${runtimeApproval})`;
          yield* Deferred.succeed(finish, narrative);
          yield* handoff.drain;
          const brief = yield* handoff.prepare(agent.id, 40);
          expect(brief?.text).toContain(commitment);
          expect(brief?.text).toContain(child);
          expect(brief?.text).toContain(runtimeApproval);
          expect(brief?.text).toContain("Finished 1750 checks; do NOT rerun");
          expect(brief?.text).toContain('"run_id":"job:1"');
          expect(brief?.text).toContain('"id":"approval:1"');
          expect(brief?.text).toContain("Do NOT email Ada; ceiling 1750");
          expect(brief?.text).toContain(agent.instructions);
          expect(brief?.text).toContain("Timezone: Chicago. Do NOT email Ada. Ceiling: 1750.");
          expect(brief?.text).toContain("[message:m:1] [run:r:1]");
          // Another rotation retains core memory without a retrieval match.
          yield* sql`INSERT INTO agent_handoff_narratives VALUES (${agent.id},71,${encodeNarrative(narrative)},${agent.createdAt})`;
          const second = yield* handoff.prepare(agent.id, 80);
          expect(second?.version).toBe(2);
          expect(second?.text).toContain("Timezone: Chicago.");
          expect(yield* sql`SELECT version FROM agent_handoff_briefs ORDER BY version`).toEqual([
            { version: 1 },
            { version: 2 },
          ]);
          expect((yield* store.get(agent.id)).coreMemory).toContain("Ceiling: 1750.");
          expect(yield* store.context(agent.conversationThreadId)).toContain("Timezone: Chicago.");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("refuses a lossy or stale saved brief and an oversized state snapshot", () =>
    Effect.gen(function* () {
      const { agent, sql } = yield* seed;
      const handoff = yield* Handoff.AgentHandoff;
      yield* sql`INSERT INTO agent_handoff_narratives VALUES (${agent.id},31,${encodeNarrative(narrative)},${agent.createdAt})`;
      yield* sql`INSERT INTO agent_approvals(id,agent_id,action_json,status,requested_at) VALUES ('pending:critical',${agent.id},'Need owner approval for 1750','pending',${agent.createdAt})`;
      const brief = yield* handoff.prepare(agent.id, 40);
      expect(brief).not.toBeNull();
      if (brief === null) return;
      yield* sql`UPDATE agent_handoff_briefs SET payload_json = ${encodeBrief({ ...brief, text: brief.text.replace("Need owner approval for 1750", "lost approval") })}`;
      expect(yield* handoff.prepare(agent.id, 40)).toBeNull();
      yield* handoff.request({
        agent,
        ordinal: 40,
        cwd: "/unused",
        selections: [agent.modelSelection],
      });
      yield* handoff.drain;
      expect((yield* handoff.prepare(agent.id, 40))?.version).toBe(2);
      yield* sql`DELETE FROM agent_handoff_briefs`;
      yield* sql`INSERT INTO agent_approvals(id,agent_id,action_json,status,requested_at) VALUES ('huge',${agent.id},${"z".repeat(Handoff.HANDOFF_MAX_CHARS)},'pending',${agent.createdAt})`;
      expect(yield* handoff.prepare(agent.id, 40)).toBeNull();
      expect(yield* sql`SELECT * FROM agent_handoff_briefs`).toEqual([]);
      const since = yield* DateTime.now;
      yield* TestClock.adjust(Handoff.HANDOFF_WAIT_MS);
      const result = yield* Effect.result(handoff.prepare(agent.id, 40, since));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("required state");
    }).pipe(Effect.provide(provide(() => Effect.succeed(narrative)))),
  );

  it.effect("rejects invented citations and leaves generation retryable", () =>
    Effect.gen(function* () {
      const { agent, sql } = yield* seed;
      const handoff = yield* Handoff.AgentHandoff;
      const input = { agent, ordinal: 31, cwd: "/unused", selections: [agent.modelSelection] };
      yield* handoff.request(input);
      yield* handoff.drain;
      expect(yield* handoff.prepare(agent.id, 40)).toBeNull();
      yield* handoff.request(input);
      yield* handoff.drain;
      expect(yield* sql`SELECT * FROM agent_handoff_narratives`).toEqual([]);
    }).pipe(
      Effect.provide(
        provide(() =>
          Effect.succeed({ entries: [{ text: "Invented", messageIds: ["missing"], runIds: [] }] }),
        ),
      ),
    ),
  );

  it.effect("tries the configured fallback when narrative generation fails", () =>
    Effect.gen(function* () {
      const { agent } = yield* seed;
      const handoff = yield* Handoff.AgentHandoff;
      yield* handoff.request({
        agent,
        ordinal: 31,
        cwd: "/unused",
        selections: [{ ...agent.modelSelection, model: "unavailable" }, agent.modelSelection],
      });
      yield* handoff.drain;
      expect((yield* handoff.prepare(agent.id, 40))?.text).toContain("ceiling: 1750");
    }).pipe(
      Effect.provide(
        provide((input) =>
          input.modelSelection.model === "unavailable"
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: "unavailable",
                }),
              )
            : Effect.succeed(narrative),
        ),
      ),
    ),
  );
});
