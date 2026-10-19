import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./AgentStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import {
  agentSessionSeedItems,
  conversationCarryOver,
  memoryContext,
  shouldRotateAgentSession,
} from "./context.ts";
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
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO agent_approvals(id, agent_id, action_json, status, requested_at) VALUES ('approval:delete', ${agent.id}, '{}', 'pending', ${agent.createdAt})`;
      yield* sql`INSERT INTO agent_run_actions(id, agent_id, kind, at) VALUES ('action:delete', ${agent.id}, 'read', ${agent.createdAt})`;
      yield* sql`INSERT INTO agent_run_threads(thread_id, agent_id, trigger_kind) VALUES ('run:delete', ${agent.id}, 'owner')`;
      expect(yield* store.delete(agent.id)).toBe(true);
      expect(yield* sql`SELECT * FROM agent_approvals`).toEqual([]);
      expect(yield* sql`SELECT * FROM agent_run_actions`).toEqual([]);
      expect(yield* sql`SELECT * FROM agent_run_threads`).toEqual([]);
      expect(yield* sql`SELECT * FROM agent_memory`).toEqual([]);
      expect(yield* store.list()).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "persists read watermarks, counts only completed replies, and never moves backwards",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const sql = yield* SqlClient.SqlClient;
        const agent = yield* store.save(agentFixture());
        const other = yield* store.save(agentFixture("other"));
        const at = "2026-01-01T01:00:00.000Z";
        const insert = (
          id: string,
          role = "assistant",
          streaming = 0,
          text = "reply",
          threadId = agent.conversationThreadId,
        ) =>
          sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES (${id}, ${threadId}, ${role}, ${streaming}, ${at}, ${at}, ${JSON.stringify({ text })})`;
        yield* insert("a");
        yield* insert("b");
        yield* insert("owner", "user", 0, "x".repeat(500));
        yield* insert("stream", "assistant", 1);
        yield* insert("empty", "assistant", 0, "  ");
        yield* insert("foreign", "assistant", 0, "other reply", other.conversationThreadId);
        expect((yield* store.list()).find((a) => a.id === agent.id)?.unreadCount).toBe(2);
        expect(
          (yield* store.markRead({ agentId: agent.id, lastReadMessageId: MessageId.make("a") }))
            .unreadCount,
        ).toBe(1);
        expect((yield* store.get(agent.id)).unreadCount).toBe(1);
        expect((yield* store.get(agent.id)).latestMessage).toMatchObject({
          id: "owner",
          text: "x".repeat(240),
          role: "user",
        });
        yield* store.markRead({ agentId: agent.id, lastReadMessageId: MessageId.make("b") });
        // An older device's read and an ordinary profile edit cannot reset the cursor.
        yield* store.markRead({ agentId: agent.id, lastReadMessageId: MessageId.make("a") });
        yield* store.save({ ...agent, name: "Edited" });
        expect((yield* store.get(agent.id)).unreadCount).toBe(0);
        yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0, updated_at = '2026-01-01T01:00:01.000Z' WHERE message_id = 'stream'`;
        expect((yield* store.list()).find((a) => a.id === agent.id)?.unreadCount).toBe(1);
        // Reconstructing the store (as after a server restart) uses the same persisted cursor.
        const persisted = yield* store
          .get(agent.id)
          .pipe(Effect.provide(Store.layer.pipe(Layer.provide(NodeServices.layer))));
        expect(persisted.unreadCount).toBe(1);
        for (const id of ["foreign", "owner", "empty", "missing"]) {
          expect(
            (yield* Effect.result(
              store.markRead({ agentId: agent.id, lastReadMessageId: MessageId.make(id) }),
            ))._tag,
          ).toBe("Failure");
        }
        expect((yield* store.get(other.id)).unreadCount).toBe(1);
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

  it.effect(
    "starts a fresh session seeded with summary, memory and recent texts on a provider switch",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.AgentStore;
        const agent = yield* store.save(agentFixture());
        yield* store.remember({ agentId: agent.id, text: "The owner's codeword is heron." });
        const codex = { instanceId: agent.modelSelection.instanceId, model: "gpt-codex" };
        const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" };
        // Switching provider, or model on one provider, rotates; effort or a steady model does not.
        const rotate = (previous: typeof codex | undefined, next: typeof codex) =>
          shouldRotateAgentSession({ runOrdinal: 7, latestSummaryOrdinal: 0, previous, next });
        expect(rotate(codex, claude)).toBe(true);
        expect(rotate(claude, codex)).toBe(true);
        expect(rotate(codex, { ...codex, model: "gpt-codex-mini" })).toBe(true);
        expect(rotate(codex, codex)).toBe(false);
        expect(rotate(undefined, claude)).toBe(false);
        expect(
          shouldRotateAgentSession({
            runOrdinal: 42,
            latestSummaryOrdinal: 1,
            previous: codex,
            next: codex,
          }),
        ).toBe(true);

        const messages = Array.from({ length: 30 }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          text: `text ${i}`,
        }));
        yield* store.carryOver(agent.id, 15, messages);
        const context = yield* store.context(agent.conversationThreadId);
        expect(context).toContain("heron");
        expect(context).toContain("user: text 0");
        expect(context).toContain("assistant: text 9");
        expect(context).not.toContain("text 10");

        const history = [
          ...messages.map((m, i) => ({
            id: `item:${i}`,
            type: `${m.role}_message`,
            runId: `run:${Math.floor(i / 2) + 1}`,
          })),
          { id: "item:tool", type: "command_execution", runId: "run:15" },
          { id: "item:current", type: "user_message", runId: "run:16" },
        ];
        const earlier = new Set(Array.from({ length: 15 }, (_, i) => `run:${i + 1}`));
        const seed = agentSessionSeedItems(history, earlier).map((item) => item.id);
        expect(seed).toHaveLength(20);
        expect(seed[0]).toBe("item:10");
        expect(seed.at(-1)).toBe("item:29");
        expect(seed).not.toContain("item:tool");
        expect(seed).not.toContain("item:current");
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
