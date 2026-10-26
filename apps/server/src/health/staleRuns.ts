/**
 * Turns and subagents on this machine still active far longer than any real
 * one runs. The `stuck-runs` check lists them; its Fix stops them.
 */
import { ThreadId } from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { type ActiveRun, STUCK_RUN_AFTER_MS } from "./healthChecks.ts";

/** Rows read per query; the check lists fewer. */
const STALE_RUN_QUERY_LIMIT = 200;

type Row = {
  readonly id: string;
  readonly thread_id: string;
  readonly title: string;
  readonly started_at: string;
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
      },
    ],
  });

/**
 * Runs and subagents started before `now` minus the stuck threshold and still
 * active, oldest first. Replicas of threads another machine runs are that
 * machine's to report and stop. `threadId` narrows to one thread.
 */
export const readStaleRuns = (now: DateTime.Utc, threadId?: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cutoff = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) - STUCK_RUN_AFTER_MS),
    );
    const thread = threadId === undefined ? sql`` : sql`AND t.thread_id = ${threadId}`;
    const [runs, subagents] = yield* Effect.all([
      sql<Row>`SELECT r.run_id AS id, r.thread_id, t.title, r.requested_at AS started_at
        FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
        WHERE r.status IN ('preparing', 'starting', 'running')
          AND r.requested_at < ${cutoff}
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
