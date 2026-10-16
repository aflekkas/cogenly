/**
 * Health - Unauthenticated liveness probe for supervisors and uptime monitors.
 *
 * `GET /health` answers without credentials and outside command readiness, so
 * it responds while the server is still starting. It exposes only build and
 * liveness facts: no paths, ids, tokens, or schedule contents.
 *
 * @module Health
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import packageJson from "../package.json" with { type: "json" };
import * as Scheduler from "./scheduling/Scheduler.ts";

export const HEALTH_PATH = "/health";

export interface HealthResponse {
  readonly ok: true;
  readonly version: string;
  readonly uptimeSeconds: number;
  /**
   * Seconds since the scheduler's last tick, or null before its first tick.
   * A healthy server ticks every 5 seconds; a large age means the event loop
   * stopped turning while the HTTP server still answers.
   */
  readonly schedulerHeartbeatAgeSeconds: number | null;
}

export function buildHealthResponse(input: {
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly nowMs: number;
  readonly lastTickAtMs: number | null;
}): HealthResponse {
  return {
    ok: true,
    version: input.version,
    uptimeSeconds: input.uptimeSeconds,
    schedulerHeartbeatAgeSeconds:
      input.lastTickAtMs === null
        ? null
        : Math.max(0, Math.round((input.nowMs - input.lastTickAtMs) / 100) / 10),
  };
}

export const layerHealthRoute = HttpRouter.add(
  "GET",
  HEALTH_PATH,
  Effect.gen(function* () {
    const [nowMs, lastTickAtMs] = yield* Effect.all([
      Clock.currentTimeMillis,
      Scheduler.lastSchedulerTickAtMs,
    ]);
    return yield* HttpServerResponse.json(
      buildHealthResponse({
        version: packageJson.version,
        uptimeSeconds: Math.floor(process.uptime()),
        nowMs,
        lastTickAtMs,
      }),
    );
  }),
);
