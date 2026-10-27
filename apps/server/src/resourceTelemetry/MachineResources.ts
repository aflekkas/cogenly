// @effect-diagnostics nodeBuiltinImport:off -- Effect has no statfs or host load average API.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { MachineResourcesSnapshot } from "@cogenly/contracts";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as HostResources from "./HostResources.ts";

export class MachineResources extends Context.Service<
  MachineResources,
  {
    readonly read: Effect.Effect<MachineResourcesSnapshot>;
  }
>()("cogenly-server/resourceTelemetry/MachineResources") {}

const make = Effect.gen(function* () {
  const host = yield* HostResources.HostResources;
  const config = yield* ServerConfig.ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const terminals = yield* TerminalManager.TerminalManager;
  const read = yield* Effect.cachedWithTTL(
    Effect.gen(function* () {
      const capacity = yield* host.read;
      const [loadAverage1m = 0, loadAverage5m = 0] = NodeOS.loadavg();
      const disk = yield* Effect.tryPromise(() => NodeFSP.statfs(config.baseDir)).pipe(
        Effect.map((stat) => Number(stat.bavail) * Number(stat.bsize)),
        Effect.orElseSucceed(() => undefined),
      );
      const runs = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      WHERE r.status IN ('preparing', 'starting', 'running', 'waiting', 'finalizing')
        AND t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = r.thread_id AND o.local = 0)`.pipe(
        NodeSqliteClient.readOnly,
        Effect.orElseSucceed(() => undefined),
      );
      return {
        sampledAt: capacity.sampledAt,
        cpuCores: capacity.cpuCount,
        loadAverage1m,
        loadAverage5m,
        availableMemoryBytes: capacity.availableMemoryBytes,
        totalMemoryBytes: capacity.totalMemoryBytes,
        ...(disk === undefined ? {} : { freeDiskBytes: disk }),
        ...(runs === undefined ? {} : { activeAgentRuns: runs[0]?.count ?? 0 }),
        activeAgentTerminals: yield* terminals.activeAgentCount,
      };
    }),
    "5 seconds",
  );
  return MachineResources.of({ read });
});

export const layer = Layer.effect(MachineResources, make);
