import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./AgentStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { memoryContext, conversationCarryOver } from "./context.ts";
import { callingAgent } from "./MemoryMcp.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { EnvironmentId } from "@t3tools/contracts";

import { agentFixture } from "./agent.testkit.ts";
const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const layer = Store.layer.pipe(Layer.provideMerge(database), Layer.provide(NodeServices.layer));

describe("persistent agents", () => {
  it.effect("creates, edits, lists and deletes identities and their memory", () =>
    Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const agent = yield* store.save(agentFixture());
      expect(yield* store.list()).toHaveLength(1);
      yield* store.save({ ...agent, name: "Pine" });
      expect((yield* store.get(agent.id)).name).toBe("Pine");
      const note = yield* store.remember({ agentId: agent.id, text: "Favourite colour is green" });
      yield* store.remember({ agentId: agent.id, id: note.id, text: "Favourite colour is blue" });
      expect(yield* store.memory(agent.id)).toHaveLength(1);
      expect(yield* store.context(agent.conversationThreadId)).toContain("blue");
      expect(yield* store.context(agent.conversationThreadId)).toContain(agent.instructions);
      yield* store.forget(agent.id, note.id);
      expect(yield* store.memory(agent.id)).toEqual([]);
      expect(yield* store.delete(agent.id)).toBe(true);
      expect(yield* store.list()).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("scopes memory tools by calling thread and rejects unrelated threads", () =>
    Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const a = yield* store.save(agentFixture());
      const b = yield* store.save(agentFixture("two"));
      yield* store.remember({ agentId: a.id, id: "same-id", text: "green" });
      yield* store.remember({ agentId: b.id, id: "same-id", text: "red" });
      const invoke = (threadId: ThreadId) =>
        callingAgent.pipe(
          Effect.provideService(Invocation.McpInvocationContext, {
            environmentId: EnvironmentId.make("test"),
            capabilities: new Set<Invocation.McpCapability>(["orchestration"]),
            issuedAt: 0,
            requestNamespace: "test",
            client: undefined,
            thread: {
              threadId,
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          }),
        );
      const caller = yield* invoke(a.conversationThreadId);
      expect(caller.agent.id).toBe(a.id);
      yield* caller.store.forget(caller.agent.id, "same-id");
      expect((yield* store.memory(b.id))[0]?.text).toBe("red");
      expect((yield* Effect.result(invoke(ThreadId.make("unrelated"))))._tag).toBe("Failure");
      expect(
        (yield* Effect.result(
          callingAgent.pipe(
            Effect.provideService(Invocation.McpInvocationContext, {
              environmentId: EnvironmentId.make("test"),
              capabilities: new Set<Invocation.McpCapability>(),
              issuedAt: 0,
              requestNamespace: "test",
              client: undefined,
              thread: undefined,
            }),
          ),
        ))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("enforces a daily cap, exponential backoff, auto-pause, and explicit resume", () =>
    Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const sql = yield* SqlClient.SqlClient;
      const agent = yield* store.save(agentFixture());
      expect(yield* store.reserve(agent.id)).toBe(true);
      expect(yield* store.reserve(agent.id)).toBe(true);
      expect(yield* store.reserve(agent.id)).toBe(false);
      yield* sql`UPDATE agents SET run_day = '2000-01-01' WHERE agent_id = ${agent.id}`;
      expect(yield* store.reserve(agent.id)).toBe(true);
      yield* store.outcome(agent.id, false);
      expect(yield* store.reserve(agent.id)).toBe(false);
      yield* store.outcome(agent.id, false);
      yield* store.outcome(agent.id, false);
      yield* store.outcome(agent.id, false);
      const paused = yield* store.outcome(agent.id, false);
      expect(paused.enabled).toBe(false);
      expect(paused.pauseReason).toContain("five");
      const resumed = yield* store.save({ ...paused, enabled: true });
      expect(resumed.consecutiveFailures).toBe(0);
      expect(resumed.backoffUntil).toBeNull();
      yield* store.outcome(agent.id, true);
      expect((yield* store.get(agent.id)).consecutiveFailures).toBe(0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("persists rolling conversation summaries and ignores duplicate compaction", () =>
    Effect.gen(function* () {
      const store = yield* Store.AgentStore;
      const agent = yield* store.save(agentFixture());
      const messages = Array.from({ length: 50 }, (_, i) => ({ role: "user", text: `text ${i}` }));
      yield* store.carryOver(agent.id, 40, messages);
      yield* store.carryOver(agent.id, 40, [
        { role: "user", text: "duplicate should not overwrite" },
      ]);
      const context = yield* store.context(agent.conversationThreadId);
      expect(context).toContain("text 0");
      expect(context).toContain("text 29");
      expect(context).not.toContain("duplicate should not overwrite");
      const carry = conversationCarryOver("earlier summary", messages);
      expect(carry.summary).toContain("earlier summary");
      expect(carry.recent).toContain("text 49");
      expect(carry.recent).not.toContain("text 29");
    }).pipe(Effect.provide(layer)),
  );

  it("injects all small memory and bounds large memory with recent facts and older summaries", () => {
    const notes = Array.from({ length: 30 }, (_, i) => ({
      id: `note:${i}`,
      text: `fact ${i} ${"x".repeat(100)}`,
      source: "owner",
      updatedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    expect(memoryContext(notes.slice(0, 2))).toContain("fact 0");
    const context = memoryContext(notes, 1500);
    expect(context.length).toBeLessThanOrEqual(1500);
    expect(context).toContain("fact 29");
    expect(context).toContain("Older memory summary");
  });
});
