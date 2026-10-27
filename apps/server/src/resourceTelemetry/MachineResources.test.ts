import { expect, it } from "@effect/vitest";
import { MachineResourcesSnapshot } from "@cogenly/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as HostResources from "./HostResources.ts";
import * as MachineResources from "./MachineResources.ts";

const isResources = Schema.is(MachineResourcesSnapshot);

it.effect("samples local capacity and active work once per cache window, excluding replicas", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [id, status] of [
      ["local", "running"],
      ["remote", "running"],
      ["done", "completed"],
    ]) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${id}, 'project', ${id}, 'codex', 'full-access', 'default', 'now', 'now', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES (${id}, ${id}, 1, 'codex', ${status}, 'now', '{}')`;
    }
    yield* sql`INSERT INTO thread_owners (thread_id, owner_env, local, updated_at) VALUES ('remote', 'peer', 0, 'now')`;
    let samples = 0;
    yield* Effect.gen(function* () {
      const resources = yield* MachineResources.MachineResources;
      const first = yield* resources.read;
      expect(isResources(first)).toBe(true);
      expect(first).toMatchObject({
        cpuCores: 12,
        availableMemoryBytes: 1000,
        activeAgentRuns: 1,
        activeAgentTerminals: 3,
      });
      expect(first.freeDiskBytes).toBeGreaterThan(0);
      expect(yield* resources.read).toEqual(first);
      expect(samples).toBe(1);
    }).pipe(
      Effect.provide(
        MachineResources.layer.pipe(
          Layer.provide(
            Layer.succeed(
              HostResources.HostResources,
              HostResources.HostResources.of({
                read: Effect.sync(() => {
                  samples++;
                  return {
                    sampledAt: 42,
                    cpuCount: 12,
                    cpuUtilization: null,
                    availableMemoryBytes: 1000,
                    totalMemoryBytes: 2000,
                  };
                }),
              }),
            ),
          ),
          Layer.provide(
            Layer.mock(TerminalManager.TerminalManager)({ activeAgentCount: Effect.succeed(3) }),
          ),
          Layer.provide(Config.layerTest("/tmp", { prefix: "resource-placement" })),
        ),
      ),
    );
  }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
);
