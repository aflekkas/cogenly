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

it.effect(
  "migrations keep the legacy capability ceiling, re-enable paused agents and drop scope",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      for (const enabled of [true, false]) {
        const {
          responsibility: _responsibility,
          permissions: _permissions,
          notifyPolicy: _notifyPolicy,
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
        enabled: number;
      }>`SELECT payload_json, enabled FROM agents`;
      expect(rows.map((row) => row.enabled)).toEqual([1, 1]);
      // Stored payloads lose the policy fields agents no longer have.
      for (const row of rows)
        expect(Object.keys(JSON.parse(row.payload_json))).not.toEqual(
          expect.arrayContaining(["scope"]),
        );
      const agents = yield* Effect.forEach(rows, (r) => decodeAgent(r.payload_json));
      for (const agent of agents) {
        expect(Object.values(agent.permissions).every(Boolean)).toBe(true);
        expect(agent.notifyPolicy).toBe("all");
        expect(agent.runtimeMode).toBe("full-access");
        expect(agent.responsibility).toBe("");
      }
    }).pipe(
      Effect.provide(
        NodeSqlite.layer({ filename: ":memory:" }).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
);
