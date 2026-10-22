/**
 * The data path of Import from T3 Code: classify T3 threads against the
 * import ledger, dry-run their events, and replay them through the event sink.
 *
 * Writes go through `EventSinkV2.write`, the same path a live command takes,
 * so projections, search and connected clients update as usual. Every write
 * carries a `command:t3-import:` command id; reactors that start agents or
 * notify skip those (see `T3ImportCommandIds.ts`).
 *
 * Idempotency has two layers. The ledger (`t3_import_threads`) remembers the
 * last T3 sequence written per thread, so a re-run reads only newer events.
 * Event ids are derived from T3's (`t3-import:v1:<id>`), and a batch drops ids
 * already stored, so an import interrupted between a write and its ledger
 * update repeats nothing.
 */
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type T3ImportProgress,
  type T3ImportSkippedEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type * as EventSink from "../orchestration-v2/EventSink.ts";
import { T3_IMPORT_COMMAND_PREFIX } from "./T3ImportCommandIds.ts";
import {
  mapT3Event,
  referencedAttachmentIds,
  type T3EventMappingContext,
} from "./T3EventMapping.ts";
import {
  mergeThreadEvents,
  type T3SourceDatabase,
  type T3SourceThreadRow,
} from "./T3SourceDatabase.ts";

export type T3ThreadMode =
  /** Not imported yet. */
  | "new"
  /** Imported before and T3 has newer events; only those are appended. */
  | "update"
  /** Imported and unchanged since. */
  | "up-to-date"
  /** Continued in Cogenly after it was imported; T3's newer events are left out. */
  | "diverged";

export interface T3ThreadPlan {
  readonly source: T3SourceThreadRow;
  /** The Cogenly thread id: T3's, unless it collides with an unrelated Cogenly thread. */
  readonly threadId: string;
  readonly projectId: ProjectId;
  readonly mode: T3ThreadMode;
  readonly afterSequence: number;
  readonly lastSequence: number;
  readonly events: number;
  readonly messages: number;
}

/** Replacement id for a T3 thread whose id an unrelated Cogenly thread already uses. */
export const collisionThreadId = (sourceThreadId: string) => `t3-${sourceThreadId}`;

export const classifyThreads = Effect.fn("T3Import.classifyThreads")(function* (input: {
  readonly source: Pick<T3SourceDatabase, "threadStats">;
  readonly threads: ReadonlyArray<T3SourceThreadRow>;
  readonly projectIds: ReadonlyMap<string, ProjectId>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const stats = new Map(
    input.source
      .threadStats(input.threads.map((thread) => thread.threadId))
      .map((row) => [row.threadId, row]),
  );
  const ledger = new Map(
    (yield* sql<{
      readonly source_thread_id: string;
      readonly thread_id: string;
      readonly source_last_sequence: number;
    }>`SELECT source_thread_id, thread_id, source_last_sequence FROM t3_import_threads`).map(
      (row) => [row.source_thread_id, row],
    ),
  );
  const plans: Array<T3ThreadPlan> = [];
  for (const thread of input.threads) {
    const projectId = input.projectIds.get(thread.projectId);
    if (projectId === undefined) continue;
    const stat = stats.get(thread.threadId);
    const lastSequence = stat?.lastSequence ?? 0;
    const base = {
      source: thread,
      projectId,
      lastSequence,
      events: stat?.events ?? 0,
      messages: stat?.messages ?? 0,
    };
    const recorded = ledger.get(thread.threadId);
    if (recorded !== undefined) {
      const foreign = yield* foreignEventCount(recorded.thread_id);
      plans.push({
        ...base,
        threadId: recorded.thread_id,
        afterSequence: recorded.source_last_sequence,
        mode:
          lastSequence <= recorded.source_last_sequence
            ? "up-to-date"
            : foreign > 0
              ? "diverged"
              : "update",
      });
      continue;
    }
    const existing = yield* sql<{ readonly imported: number; readonly foreign_events: number }>`
      SELECT
        COALESCE(SUM(event_id LIKE 't3-import:v1:%'), 0) AS imported,
        COALESCE(SUM(event_id NOT LIKE 't3-import:v1:%'), 0) AS foreign_events
      FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        AND stream_id = ${thread.threadId}
    `;
    const row = existing[0] ?? { imported: 0, foreign_events: 0 };
    if (row.foreign_events > 0 && row.imported === 0) {
      // An unrelated Cogenly thread owns this id.
      plans.push({
        ...base,
        threadId: collisionThreadId(thread.threadId),
        afterSequence: 0,
        mode: "new",
      });
      continue;
    }
    // Imported before without a ledger row: replay all, already-stored events drop out.
    plans.push({
      ...base,
      threadId: thread.threadId,
      afterSequence: 0,
      mode: row.foreign_events > 0 ? "diverged" : "new",
    });
  }
  return plans;

  function foreignEventCount(threadId: string) {
    return sql<{ readonly foreign_events: number }>`
      SELECT COUNT(*) AS foreign_events
      FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND (command_id IS NULL OR command_id NOT LIKE ${`${T3_IMPORT_COMMAND_PREFIX}%`})
    `.pipe(Effect.map((rows) => rows[0]?.foreign_events ?? 0));
  }
});

export function mappingContext(input: {
  readonly plans: ReadonlyArray<T3ThreadPlan>;
  readonly projectIds: ReadonlyMap<string, ProjectId>;
}): T3EventMappingContext {
  return {
    projectIds: input.projectIds,
    threadProjectIds: new Map(input.plans.map((plan) => [plan.source.threadId, plan.projectId])),
    threadIdRemap: new Map(
      input.plans
        .filter((plan) => plan.threadId !== plan.source.threadId)
        .map((plan) => [plan.source.threadId, plan.threadId]),
    ),
  };
}

const MAX_LISTED_SKIPS = 200;

export interface T3EventSummary {
  readonly events: number;
  readonly writtenEvents: number;
  readonly skippedEvents: number;
  readonly normalizedEvents: number;
  readonly skipped: ReadonlyArray<T3ImportSkippedEvent>;
  readonly attachmentIds: ReadonlySet<string>;
  /** Threads written, by Cogenly thread id. */
  readonly threads: ReadonlySet<string>;
}

/**
 * Replay the planned threads' events in T3's global order. With `write`
 * undefined this is the dry run: every event is decoded and mapped, nothing is
 * stored. A thread whose creation event cannot be imported is skipped whole.
 */
export const replayEvents = Effect.fn("T3Import.replayEvents")(function* (input: {
  readonly source: Pick<T3SourceDatabase, "readThreadEvents">;
  readonly plans: ReadonlyArray<T3ThreadPlan>;
  readonly context: T3EventMappingContext;
  readonly write?: {
    readonly eventSink: EventSink.EventSinkV2["Service"];
    /** Unique per import run; batch numbers are appended. */
    readonly commandIdPrefix: string;
    readonly batchSize?: number;
  };
  readonly onProgress?: (
    progress: Pick<T3ImportProgress, "processedEvents">,
  ) => Effect.Effect<void>;
  readonly isCancelled?: Effect.Effect<boolean>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const active = input.plans.filter((plan) => plan.mode === "new" || plan.mode === "update");
  const planBySource = new Map(active.map((plan) => [plan.source.threadId, plan]));
  const skipped: Array<T3ImportSkippedEvent> = [];
  let skippedEvents = 0;
  let normalizedEvents = 0;
  let events = 0;
  let writtenEvents = 0;
  const attachmentIds = new Set<string>();
  const written = new Set<string>();
  const dropped = new Set<string>();
  const lastNormalized = new Map<string, boolean>();
  const skip = (entry: T3ImportSkippedEvent) => {
    skippedEvents += 1;
    if (skipped.length < MAX_LISTED_SKIPS) skipped.push(entry);
  };

  interface Pending {
    readonly event: OrchestrationV2DomainEvent;
    readonly sourceThreadId: string;
    readonly sequence: number;
  }
  let batch: Array<Pending> = [];
  let batchNumber = 0;
  const batchSize = input.write?.batchSize ?? 500;
  // Highest T3 sequence handled per thread in this run, for the ledger.
  const handled = new Map<string, { sequence: number; events: number }>();

  const flush = Effect.fn("T3Import.flush")(function* () {
    const write = input.write;
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    if (write !== undefined) {
      const ids = current.map((pending) => pending.event.id);
      const stored = new Set(
        (yield* sql<{ readonly event_id: string }>`
          SELECT event_id FROM orchestration_events WHERE ${sql.in("event_id", ids)}
        `).map((row) => row.event_id),
      );
      const fresh = current.filter((pending) => !stored.has(pending.event.id));
      const commandId = CommandId.make(`${write.commandIdPrefix}:${batchNumber}`);
      batchNumber += 1;
      const committed = yield* write.eventSink
        .write({ commandId, events: fresh.map((pending) => pending.event) })
        .pipe(Effect.as(fresh), Effect.option);
      let applied: ReadonlyArray<Pending> = [];
      if (committed._tag === "Some") {
        applied = committed.value;
      } else {
        // Isolate the event the projections reject; the rest of the batch still lands.
        const singles: Array<Pending> = [];
        for (const pending of fresh) {
          const one = yield* write.eventSink
            .write({ commandId, events: [pending.event] })
            .pipe(Effect.option);
          if (one._tag === "Some") singles.push(pending);
          else
            skip({
              threadId: pending.sourceThreadId,
              sequence: pending.sequence,
              eventType: pending.event.type,
              reason: "Cogenly could not apply this event",
            });
        }
        applied = singles;
      }
      writtenEvents += applied.length;
      for (const pending of applied) {
        const plan = planBySource.get(pending.sourceThreadId);
        if (plan !== undefined) written.add(plan.threadId);
      }
      yield* recordLedger(current);
    }
    if (input.onProgress !== undefined) yield* input.onProgress({ processedEvents: events });
    yield* Effect.yieldNow;
  });

  const recordLedger = Effect.fn("T3Import.recordLedger")(function* (
    pendings: ReadonlyArray<Pending>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const perThread = new Map<string, { sequence: number; events: number }>();
    for (const pending of pendings) {
      const entry = perThread.get(pending.sourceThreadId) ?? { sequence: 0, events: 0 };
      entry.sequence = Math.max(entry.sequence, pending.sequence);
      entry.events += 1;
      perThread.set(pending.sourceThreadId, entry);
    }
    for (const [sourceThreadId, entry] of perThread) {
      const plan = planBySource.get(sourceThreadId);
      if (plan === undefined) continue;
      yield* upsertLedger(sql, plan, entry, now);
    }
  });

  const cursors = active.map((plan) => ({
    threadId: plan.source.threadId,
    afterSequence: plan.afterSequence,
  }));
  for (const row of mergeThreadEvents({ database: input.source, cursors })) {
    events += 1;
    const handledEntry = handled.get(row.threadId) ?? { sequence: 0, events: 0 };
    handledEntry.sequence = row.sequence;
    handledEntry.events += 1;
    handled.set(row.threadId, handledEntry);
    if (dropped.has(row.threadId)) {
      skip({
        threadId: row.threadId,
        sequence: row.sequence,
        eventType: row.eventType,
        reason: "Its thread could not be imported",
      });
    } else {
      const mapped = mapT3Event(row, input.context);
      if (mapped._tag === "Skipped") {
        if (row.eventType === "thread.created") dropped.add(row.threadId);
        skip({
          threadId: row.threadId,
          sequence: row.sequence,
          eventType: row.eventType,
          reason: mapped.reason,
        });
      } else {
        // Count entities whose final state was live, not every superseded step.
        const id = (mapped.event.payload as { readonly id?: unknown }).id;
        if (typeof id === "string") {
          lastNormalized.set(`${mapped.event.type.split(".")[0]}:${id}`, mapped.normalized);
        }
        for (const id of referencedAttachmentIds(mapped.event)) attachmentIds.add(id);
        batch.push({ event: mapped.event, sourceThreadId: row.threadId, sequence: row.sequence });
      }
    }
    if (batch.length >= batchSize || events % batchSize === 0) {
      yield* flush();
      if (input.isCancelled !== undefined && (yield* input.isCancelled)) {
        return yield* Effect.interrupt;
      }
    }
  }
  yield* flush();
  for (const normalized of lastNormalized.values()) if (normalized) normalizedEvents += 1;
  if (input.write !== undefined) {
    // Threads whose remaining events were all skipped still advance, so a
    // re-run does not retry what this build cannot decode.
    const now = DateTime.formatIso(yield* DateTime.now);
    for (const [sourceThreadId, entry] of handled) {
      const plan = planBySource.get(sourceThreadId);
      if (plan === undefined || dropped.has(sourceThreadId)) continue;
      yield* upsertLedger(sql, plan, { sequence: entry.sequence, events: 0 }, now);
    }
  }
  return {
    events,
    writtenEvents,
    skippedEvents,
    normalizedEvents,
    skipped,
    attachmentIds,
    threads: written,
  } satisfies T3EventSummary;
});

function upsertLedger(
  sql: SqlClient.SqlClient,
  plan: T3ThreadPlan,
  entry: { readonly sequence: number; readonly events: number },
  now: string,
) {
  return sql`
    INSERT INTO t3_import_threads (
      source_thread_id, thread_id, source_project_id, project_id,
      source_last_sequence, imported_events, first_imported_at, last_imported_at
    ) VALUES (
      ${plan.source.threadId}, ${plan.threadId}, ${plan.source.projectId}, ${plan.projectId},
      ${entry.sequence}, ${entry.events}, ${now}, ${now}
    )
    ON CONFLICT(source_thread_id) DO UPDATE SET
      thread_id = excluded.thread_id,
      project_id = excluded.project_id,
      source_last_sequence = MAX(source_last_sequence, excluded.source_last_sequence),
      imported_events = imported_events + excluded.imported_events,
      last_imported_at = excluded.last_imported_at
  `;
}
