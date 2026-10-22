import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OrchestrationV2DomainEvent, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { classifyThreads, mappingContext, replayEvents } from "./T3ImportEngine.ts";
import { importedEventId, mapT3Event } from "./T3EventMapping.ts";
import { planPreferences, planProviderInstances } from "./T3SettingsPlan.ts";
import { mergeThreadEvents, openT3SourceDatabase } from "./T3SourceDatabase.ts";
import {
  COGENLY_PROJECT,
  created,
  encodeEvent,
  makeT3Fixture,
  message,
  run,
  T3_PROJECT,
} from "./T3Import.testkit.ts";

const layer = RuntimeLayer.layerEventSink.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);

describe("T3 event mapping", () => {
  const context = {
    projectIds: new Map([[T3_PROJECT, COGENLY_PROJECT]]),
    threadProjectIds: new Map<string, ProjectId>(),
    threadIdRemap: new Map<string, string>(),
  };
  const row = (event: OrchestrationV2DomainEvent, payloadJson?: string) => {
    const encoded = encodeEvent(event);
    return {
      sequence: 1,
      eventId: event.id,
      threadId: event.threadId,
      eventType: event.type,
      occurredAt: encoded.occurredAt,
      payloadJson: payloadJson ?? JSON.stringify(encoded.payload),
      metadataJson: "{}",
    };
  };

  it("moves threads into the mapped project and drops T3-only background work", () => {
    const mapped = mapT3Event(
      row(created("a", { limitRecovery: null, titleRegeneration: null })),
      context,
    );
    expect(mapped._tag).toBe("Mapped");
    if (mapped._tag !== "Mapped" || mapped.event.type !== "thread.created") return;
    expect(mapped.event.id).toBe(importedEventId("evt-a-created"));
    expect(mapped.event.payload.projectId).toBe(COGENLY_PROJECT);
  });

  it("records a running run as interrupted so nothing resumes it", () => {
    const mapped = mapT3Event(row(run("a", "running")), context);
    expect(mapped._tag === "Mapped" && mapped.normalized).toBe(true);
    if (mapped._tag !== "Mapped" || mapped.event.type !== "run.created") return;
    expect(mapped.event.payload.status).toBe("interrupted");
    expect(mapped.event.payload.completedAt).not.toBeNull();
  });

  it("skips an undecodable event without quoting its content", () => {
    const broken = mapT3Event(
      row(message("a", 1), JSON.stringify({ id: "m", text: "SECRET MESSAGE TEXT" })),
      context,
    );
    expect(broken._tag).toBe("Skipped");
    if (broken._tag === "Skipped") expect(broken.reason).not.toContain("SECRET");
  });

  it("rewrites a colliding thread id everywhere it appears", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const mapped = mapT3Event(row(message(id, 1)), {
      ...context,
      threadIdRemap: new Map([[id, `t3-${id}`]]),
    });
    if (mapped._tag !== "Mapped" || mapped.event.type !== "message.updated")
      throw new Error("unmapped");
    expect(mapped.event.threadId).toBe(`t3-${id}`);
    expect(mapped.event.payload.threadId).toBe(`t3-${id}`);
    expect(mapped.event.payload.id).toBe(`t3-${id}:msg:1`);
  });
});

describe("T3 source", () => {
  it("merges thread events in T3's global order", () => {
    const fixture = makeT3Fixture();
    fixture.append(created("p"));
    fixture.append(created("c"));
    fixture.append(message("p", 1));
    fixture.append(message("c", 1));
    fixture.close();
    const source = openT3SourceDatabase(fixture.dbPath);
    const order = [
      ...mergeThreadEvents({
        database: source,
        cursors: [
          { threadId: "c", afterSequence: 0 },
          { threadId: "p", afterSequence: 0 },
        ],
        pageSize: 1,
      }),
    ].map((event) => event.sequence);
    source.close();
    expect(order).toEqual([1, 2, 3, 4]);
  });
});

describe("T3 import engine", () => {
  it.effect("imports once, appends only new T3 events, and stops at Cogenly activity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventSink = yield* EventSink.EventSinkV2;
      const fixture = makeT3Fixture();
      fixture.append(created("a"));
      fixture.append(message("a", 1));
      fixture.append(run("a", "running"));
      const projectIds = new Map([[T3_PROJECT, COGENLY_PROJECT]]);
      const importOnce = Effect.gen(function* () {
        const source = openT3SourceDatabase(fixture.dbPath);
        const plans = yield* classifyThreads({
          source,
          threads: source.listThreads([T3_PROJECT]),
          projectIds,
        });
        const summary = yield* replayEvents({
          source,
          plans,
          context: mappingContext({ plans, projectIds }),
          write: { eventSink, commandIdPrefix: "command:t3-import:test" },
        });
        source.close();
        return { plans, summary };
      });
      const eventCount = sql<{ n: number }>`SELECT COUNT(*) AS n FROM orchestration_events`.pipe(
        Effect.map((rows) => rows[0]!.n),
      );

      const first = yield* importOnce;
      expect(first.plans.map((plan) => plan.mode)).toEqual(["new"]);
      expect(first.summary.writtenEvents).toBe(3);
      const threads = yield* sql<{ project_id: string }>`
        SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id = 'a'`;
      expect(threads).toEqual([{ project_id: COGENLY_PROJECT }]);
      const runs = yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_v2_projection_runs`;
      expect(runs).toEqual([{ status: "interrupted" }]);
      const written = yield* eventCount;

      const second = yield* importOnce;
      expect(second.plans.map((plan) => plan.mode)).toEqual(["up-to-date"]);
      expect(yield* eventCount).toBe(written);

      // T3 kept working on the thread: only the new event is appended.
      fixture.append(run("a", "completed"));
      const third = yield* importOnce;
      expect(third.plans.map((plan) => plan.mode)).toEqual(["update"]);
      expect(third.summary.writtenEvents).toBe(1);
      expect(yield* eventCount).toBe(written + 1);
      expect(
        yield* sql<{ status: string }>`SELECT status FROM orchestration_v2_projection_runs`,
      ).toEqual([{ status: "completed" }]);

      // Once the user continues the thread in Cogenly, T3 changes are left out.
      yield* eventSink.write({
        events: [{ ...message("a", 2), id: "cogenly-own" as OrchestrationV2DomainEvent["id"] }],
      });
      fixture.append(message("a", 3));
      const fourth = yield* importOnce;
      expect(fourth.plans.map((plan) => plan.mode)).toEqual(["diverged"]);
      expect(fourth.summary.writtenEvents).toBe(0);
      fixture.close();
    }).pipe(Effect.provide(layer)),
  );
});

describe("T3 settings plan", () => {
  const t3Settings = {
    providerInstances: {
      "claude-personal": {
        driver: "claudeAgent",
        displayName: "Claude Personal",
        environment: [{ name: "ANTHROPIC_API_KEY", value: "sk-secret" }],
        config: { homePath: "~/.claude_personal" },
      },
    },
    favorites: [{ provider: "codex", model: "gpt-x" }],
    defaultModelSelection: { instanceId: "claude-personal", model: "claude-opus" },
  };

  it("creates the T3 instance with its config dir and without environment variables", () => {
    const plan = planProviderInstances({
      t3Settings,
      cogenlySettings: { providerInstances: {} },
      threadsByInstance: new Map([
        ["claude-personal", 2],
        ["codex", 1],
      ]),
    });
    expect(plan.bindings.map((binding) => [binding.instanceId, binding.status])).toEqual([
      ["claude-personal", "create"],
      ["codex", "builtin"],
    ]);
    expect(plan.creates[0]?.instance.config).toEqual({ homePath: "~/.claude_personal" });
    expect(plan.creates[0]?.instance).not.toHaveProperty("environment");
  });

  it("never overrides Cogenly preferences or keys", () => {
    const plan = planPreferences({
      t3Settings,
      t3Keybindings: [
        { key: "mod+b", command: "sidebar.toggle" },
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+q", command: "not.a.cogenly.command" },
      ],
      cogenlySettings: { favorites: null },
      cogenlySettingKeys: new Set(["defaultModelSelection"]),
      cogenlyKeybindings: [{ key: "mod+b", command: "terminal.toggle" }],
    });
    expect(plan.patch.defaultModelSelection).toBeUndefined();
    expect(plan.patch.favorites).toEqual([{ provider: "codex", model: "gpt-x" }]);
    expect(plan.keybindings).toEqual([{ key: "mod+j", command: "terminal.toggle" }]);
  });
});
