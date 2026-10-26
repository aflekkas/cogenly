import { expect, it } from "@effect/vitest";
import { ThreadId } from "@cogenly/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import { readStaleRuns } from "./staleRuns.ts";
import { stuckRunsCheck } from "./healthChecks.ts";

it.effect(
  "reports silent first turns after five minutes, clears on provider activity, and excludes replicas",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.makeUnsafe("2026-10-26T12:00:00.000Z");
      const old = "2026-10-26T11:54:00.000Z";
      const recent = "2026-10-26T11:59:00.000Z";
      for (const [id, status] of [
        ["preparing", "preparing"],
        ["starting", "starting"],
        ["silent", "running"],
        ["active", "running"],
        ["tokens", "running"],
        ["finished", "completed"],
        ["replica", "starting"],
      ]) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default', ${old}, ${old}, '{}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${id}, ${id}, 1, 'codex', ${status}, ${old}, ${JSON.stringify({ activeAttemptId: id })})`;
      }
      yield* sql`INSERT INTO thread_owners (thread_id, owner_env, local, updated_at)
      VALUES ('replica', 'other', 0, ${old})`;
      const activity = (
        id: string,
        at: string,
      ) => sql`INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${id}, ${id}, ${id}, 1, 'assistant_message', 'running', ${at}, '{}')`;
      yield* activity("active", recent);
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
      (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, payload_json)
      VALUES ('turn', 'tokens', 'provider-thread', 'node', 'tokens', 1, 'running', ${old}, ${JSON.stringify({ tokenUsage: { updatedAt: recent } })})`;
      const stale = yield* readStaleRuns(now);
      expect(stale.map((run) => run.id).sort()).toEqual(["preparing", "silent", "starting"]);
      const report = stuckRunsCheck({ active: stale, now });
      expect(report.status).toBe("warn");
      expect(
        report.items.every((item) => item.title.includes("no provider activity for 6 minutes")),
      ).toBe(true);
      yield* activity("silent", recent);
      expect(yield* readStaleRuns(now, ThreadId.make("silent"))).toEqual([]);
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
);
