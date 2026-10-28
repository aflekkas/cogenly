/**
 * How often each provider account hit a 429 in the last hour, read from the
 * retry/failure items the adapters recorded. The providers health check
 * turns a streak into a warning; this module only counts.
 */
import { ProviderInstanceId } from "@cogenly/contracts";
import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { RateLimitStreak } from "./healthChecks.ts";

/** Window the repeated-rate-limit warning looks at. */
export const RATE_LIMIT_WINDOW_MS = 60 * 60_000;

type Row = {
  readonly provider_instance_id: string;
  readonly hits: number;
  readonly latest_at: string;
};

export const readRateLimitStreaks = (now: DateTime.Utc) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) - RATE_LIMIT_WINDOW_MS),
    );
    const rows = yield* sql<Row>`
      SELECT r.provider_instance_id AS provider_instance_id,
        COUNT(*) AS hits,
        MAX(i.updated_at) AS latest_at
      FROM orchestration_v2_projection_turn_items i
      JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
      JOIN orchestration_v2_projection_threads t ON t.thread_id = i.thread_id
      WHERE i.type = 'error'
        AND i.updated_at >= ${cutoff}
        AND t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = i.thread_id AND o.local = 0)
        AND (
          json_extract(i.payload_json, '$.failure.limitKind') = 'rate_limit'
          OR json_extract(i.payload_json, '$.failure.code') = 'rateLimitExceeded'
        )
      GROUP BY r.provider_instance_id`.pipe(NodeSqliteClient.readOnly);
    return rows.flatMap((row) =>
      Option.match(DateTime.make(row.latest_at), {
        onNone: () => [],
        onSome: (latestAt): RateLimitStreak[] => [
          {
            providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
            count: row.hits,
            latestAt: DateTime.toUtc(latestAt),
          },
        ],
      }),
    );
  });
