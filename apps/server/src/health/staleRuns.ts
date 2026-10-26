/**
 * Turns with no recent provider activity, and runs or subagents beyond the
 * absolute age limit. The `stuck-runs` check lists them.
 */
import { ThreadId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { type ActiveRun, RUN_INACTIVITY_AFTER_MS, STUCK_RUN_AFTER_MS } from "./healthChecks.ts";

/** Rows read per query; the check lists fewer. */
const STALE_RUN_QUERY_LIMIT = 200;

type Row = {
  readonly id: string;
  readonly thread_id: string;
  readonly title: string;
  readonly started_at: string;
  readonly inactive_since?: string | null;
};

const toActive = (kind: ActiveRun["kind"]) => (row: Row) =>
  Option.match(DateTime.make(row.started_at), {
    onNone: () => [],
    onSome: (startedAt): ActiveRun[] => [
      {
        kind,
        id: row.id,
        threadId: ThreadId.make(row.thread_id),
        threadTitle: row.title,
        startedAt: DateTime.toUtc(startedAt),
        ...(row.inactive_since == null
          ? {}
          : {
              inactiveSince: DateTime.toUtc(DateTime.makeUnsafe(row.inactive_since)),
            }),
      },
    ],
  });

/**
 * Silent runs and over-age runs or subagents still active, oldest first.
 * Replicas belong to their owner's report. `threadId` narrows to one thread.
 */
export const readStaleRuns = (now: DateTime.Utc, threadId?: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) - STUCK_RUN_AFTER_MS),
    );
    const inactiveCutoff = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) - RUN_INACTIVITY_AFTER_MS),
    );
    const thread = threadId === undefined ? sql`` : sql`AND t.thread_id = ${threadId}`;
    const [runs, subagents] = yield* Effect.all([
      sql<Row>`WITH activity AS (
          SELECT r.*,
            MAX(r.requested_at,
              COALESCE((SELECT MAX(i.updated_at)
                FROM orchestration_v2_projection_turn_items i WHERE i.run_id = r.run_id AND i.type <> 'user_message'), r.requested_at),
              COALESCE((SELECT MAX(COALESCE(json_extract(p.payload_json, '$.tokenUsage.updatedAt'), p.started_at))
                FROM orchestration_v2_projection_provider_turns p
                WHERE p.thread_id = r.thread_id AND p.run_attempt_id = json_extract(r.payload_json, '$.activeAttemptId')), r.requested_at)
            ) AS last_activity
          FROM orchestration_v2_projection_runs r
          WHERE r.status IN ('preparing', 'starting', 'running')
            AND r.requested_at < ${inactiveCutoff}
        )
        SELECT r.run_id AS id, r.thread_id, t.title, r.requested_at AS started_at,
          CASE WHEN r.last_activity < ${inactiveCutoff} THEN r.last_activity END AS inactive_since
        FROM activity r
        JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
        WHERE r.status IN ('preparing', 'starting', 'running')
          AND (r.requested_at < ${cutoff} OR r.last_activity < ${inactiveCutoff})
          AND t.deleted_at IS NULL
          ${thread}
          AND NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = r.thread_id AND o.local = 0)
        ORDER BY r.requested_at
        LIMIT ${STALE_RUN_QUERY_LIMIT}`,
      sql<Row>`SELECT s.subagent_id AS id, s.thread_id, t.title,
          COALESCE(s.started_at, s.updated_at) AS started_at
        FROM orchestration_v2_projection_subagents s
        JOIN orchestration_v2_projection_threads t ON t.thread_id = s.thread_id
        WHERE s.status IN ('pending', 'running')
          AND COALESCE(s.started_at, s.updated_at) < ${cutoff}
          AND t.deleted_at IS NULL
          ${thread}
          AND NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = s.thread_id AND o.local = 0)
        ORDER BY started_at
        LIMIT ${STALE_RUN_QUERY_LIMIT}`,
    ]);
    return [...runs.flatMap(toActive("run")), ...subagents.flatMap(toActive("subagent"))];
  });

/** Idle queues older than three minutes, owned by this environment. */
export const readStuckQueues = (now: DateTime.Utc) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 180_000));
    const rows = yield* sql<Row>`
      SELECT t.thread_id AS id, t.thread_id, t.title, MIN(q.requested_at) AS started_at
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_runs q ON q.thread_id = t.thread_id AND q.status = 'queued'
      WHERE t.archived_at IS NULL AND t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs held
          WHERE held.thread_id = t.thread_id AND held.status = 'queued'
            AND json_extract(held.payload_json, '$.queueHeld') = 1
            AND json_extract(held.payload_json, '$.queueHoldReason') = 'stopped')
        AND NOT EXISTS (SELECT 1 FROM thread_owners o WHERE o.thread_id = t.thread_id AND o.local = 0)
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id AND r.status IN ('preparing', 'starting', 'running'))
      GROUP BY t.thread_id HAVING MIN(q.requested_at) < ${cutoff}
      ORDER BY started_at LIMIT ${STALE_RUN_QUERY_LIMIT}`;
    return rows.flatMap(toActive("run"));
  });
