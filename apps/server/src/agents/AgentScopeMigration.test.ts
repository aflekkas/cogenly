import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Agent } from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { agentFixture } from "./agent.testkit.ts";

const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeAgent = Schema.decodeEffect(Schema.fromJsonString(Agent));

it.effect("migration preserves the legacy capability ceiling without inferring label grants", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 64 });
    for (const enabled of [true, false]) {
      const {
        responsibility: _responsibility,
        scope: _scope,
        autonomy: _autonomy,
        permissions: _permissions,
        notifyPolicy: _notifyPolicy,
        paused: _paused,
        ...legacy
      } = agentFixture(enabled ? "enabled" : "paused");
      const payload = yield* encodeUnknown({
        ...legacy,
        enabled,
      });
      yield* sql`INSERT INTO agents(agent_id, conversation_thread_id, payload_json, enabled, daily_run_cap) VALUES (${legacy.id}, ${legacy.conversationThreadId}, ${payload}, ${enabled ? 1 : 0}, ${legacy.dailyRunCap})`;
    }
    yield* runMigrations();
    yield* runMigrations();
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM agents ORDER BY enabled DESC`;
    const agents = yield* Effect.forEach(rows, (r) => decodeAgent(r.payload_json));
    expect(agents.map((a) => a.paused)).toEqual([false, true]);
    for (const agent of agents) {
      expect(agent.autonomy).toBe("autonomous_within_policy");
      expect(Object.values(agent.permissions).every(Boolean)).toBe(true);
      expect(agent.scope).toEqual([]);
      expect(agent.notifyPolicy).toBe("all");
      expect(agent.runtimeMode).toBe("approval-required");
      expect(agent.responsibility).toBe("");
    }
  }).pipe(
    Effect.provide(
      NodeSqlite.layer({ filename: ":memory:" }).pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);
