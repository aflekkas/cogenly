import * as NodeSqliteClient from "@cogenly/shared/nodeSqliteClient";
import {
  EnvironmentId,
  HybridClock,
  SharedChangeBatch,
  SharedDocumentChange,
  SharedDocumentChangeWire,
  SharedStateError,
  SHARED_BATCH_BYTES,
  SHARED_BATCH_LIMIT,
  type SharedDocumentKind,
} from "@cogenly/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  checkIntegrity,
  factDocumentId,
  preserveUnknown,
  splitChange,
  validateChange,
} from "./documentSchemas.ts";
import { compareClock, mergeDocument, tickClock } from "./merge.ts";
import { projectDocument, readConfiguration } from "./SharedDocumentProjection.ts";

export class SharedState extends Context.Service<
  SharedState,
  {
    readonly environmentId: EnvironmentId;
    readonly defaultOwner: Effect.Effect<EnvironmentId>;
    readonly setHub: (hub: EnvironmentId | null) => Effect.Effect<void>;
    readonly changes: Stream.Stream<void>;
    readonly get: (
      kind: SharedDocumentKind,
      id: string,
    ) => Effect.Effect<SharedDocumentChange | undefined, SharedStateError>;
    readonly write: (
      kind: SharedDocumentKind,
      id: string,
      fields: SharedDocumentChange["fields"],
      deleted?: boolean,
    ) => Effect.Effect<void, SharedStateError>;
    /**
     * `write` for fields that must bind the clock they are written at (a
     * synced vault item's sealed payload). Every field gets that clock.
     */
    readonly writeBuilt: (
      kind: SharedDocumentKind,
      id: string,
      build: (
        clock: HybridClock,
      ) => Effect.Effect<SharedDocumentChange["fields"], SharedStateError>,
    ) => Effect.Effect<void, SharedStateError>;
    /** Called inside the local domain mutation transaction, before its acknowledgement. */
    readonly capture: (
      kind: SharedDocumentKind,
      id: string,
      deleted?: boolean,
    ) => Effect.Effect<void, SharedStateError>;
    readonly bootstrap: (pairingKey?: string) => Effect.Effect<void, SharedStateError>;
    readonly readBatch: (
      after: number,
      target: EnvironmentId,
      localOnly: boolean,
    ) => Effect.Effect<SharedChangeBatch, SharedStateError>;
    /** trustedRelay is true only for this spoke's pinned hub, never for an arbitrary spoke. */
    readonly receive: (
      batch: SharedChangeBatch,
      source: EnvironmentId,
      trustedRelay: boolean,
    ) => Effect.Effect<{ acknowledged: number }, SharedStateError>;
    readonly cursors: (
      peer: EnvironmentId,
    ) => Effect.Effect<{ received: number; acknowledged: number }, SharedStateError>;
    readonly acknowledge: (
      peer: EnvironmentId,
      cursor: number,
    ) => Effect.Effect<void, SharedStateError>;
  }
>()("cogenly-server/sync/SharedState") {}

/**
 * Fields a machine may change on an agent or schedule it does not own.
 * Everything else — permissions, instructions, prompt, provider/model,
 * runtime mode and trigger fields — is owner-only, so a paired machine
 * cannot rewrite another machine's autonomous work.
 */
const NON_OWNER_EDITABLE_FIELDS: Readonly<Record<"agent" | "schedule", ReadonlySet<string>>> = {
  agent: new Set(["name"]),
  schedule: new Set(["title", "enabled"]),
};

/** Maximum future wall time observed by the local hybrid clock. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_LOGICAL_CLOCK = 1_000_000_000;

/**
 * Bounds local observation only. Stored and relayed clocks retain their original
 * identity: clamping those could collapse distinct edits or change replay order.
 */
function clampClock(
  clock: HybridClock,
  now: number,
): { readonly clock: HybridClock; readonly clamped: boolean } {
  const wall = Math.min(clock.wall, now + MAX_CLOCK_SKEW_MS);
  const logical = Math.min(clock.logical, MAX_LOGICAL_CLOCK);
  return wall === clock.wall && logical === clock.logical
    ? { clock, clamped: false }
    : { clock: { ...clock, wall, logical }, clamped: true };
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const storage = (cause: unknown) =>
  Schema.is(SharedStateError)(cause) ? cause : new SharedStateError({ reason: "storage", cause });
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const decodeChange = Schema.decodeUnknownEffect(Schema.fromJsonString(SharedDocumentChange));
const decodeClock = Schema.decodeUnknownEffect(Schema.fromJsonString(HybridClock));
const decodeBatch = Schema.decodeUnknownEffect(SharedChangeBatch);
const decodeWireChange = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SharedDocumentChangeWire),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const hub = yield* Ref.make<EnvironmentId | null>(null);
  const signals = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(signals, undefined).pipe(Effect.asVoid);
  const get = Effect.fn("SharedState.get")(function* (kind: SharedDocumentKind, id: string) {
    const rows = yield* sql<{
      fields_json: string;
      clocks_json: string;
      tombstone_json: string | null;
      updated_by_env: string;
    }>`SELECT * FROM shared_documents WHERE kind=${kind} AND id=${id}`;
    const row = rows[0];
    if (!row) return undefined;
    return yield* Effect.gen(function* () {
      return yield* Schema.decodeUnknownEffect(SharedDocumentChange)({
        kind,
        id,
        fields: yield* decodeJson(row.fields_json),
        clocks: yield* decodeJson(row.clocks_json),
        tombstone: row.tombstone_json ? yield* decodeClock(row.tombstone_json) : null,
        updatedBy: row.updated_by_env,
      });
    }).pipe(
      Effect.catchTags({
        SchemaError: () =>
          Effect.logWarning("Skipping undecodable shared document", { kind }).pipe(
            Effect.as(undefined),
          ),
      }),
    );
  }, Effect.mapError(storage));
  const observe = Effect.fn("SharedState.observe")(function* (received?: HybridClock) {
    const rows = yield* sql<{
      clock_json: string;
    }>`SELECT clock_json FROM shared_clock WHERE singleton=1`;
    const local = rows[0] ? yield* decodeClock(rows[0].clock_json) : undefined;
    const now = yield* Clock.currentTimeMillis;
    const observed = received ? clampClock(received, now) : undefined;
    if (observed?.clamped)
      yield* Effect.logWarning("Bounded local observation of a shared change clock", {
        source: received!.node,
      });
    const next = tickClock(environmentId, now, local, observed?.clock);
    yield* sql`INSERT INTO shared_clock(singleton,clock_json) VALUES (1,${encodeJson(next)}) ON CONFLICT(singleton) DO UPDATE SET clock_json=excluded.clock_json`;
    return next;
  });
  const persist = Effect.fn("SharedState.persist")(function* (
    change: SharedDocumentChange,
    project: boolean,
    preserveLocalBindings = false,
  ) {
    const current = yield* get(change.kind, change.id);
    for (const [key, clock] of Object.entries(change.clocks)) {
      if (
        current?.clocks[key] &&
        compareClock(clock, current.clocks[key]) === 0 &&
        encodeJson(change.fields[key]) !== encodeJson(current.fields[key])
      )
        return yield* new SharedStateError({ reason: "invalid-document" });
    }
    if (
      current &&
      change.kind === "fact" &&
      change.fields.factId !== undefined &&
      change.fields.factId !== (current.fields.factId ?? current.id)
    )
      return yield* new SharedStateError({ reason: "invalid-document" });
    const owner = current?.fields.ownerMachine;
    const ownerClock = current?.clocks.ownerMachine;
    const incomingOwner = change.fields.ownerMachine;
    // A regular configuration edit is never authority to move autonomous execution.
    // Only the owner hands it off, after moving the agent's conversation
    // (ThreadTransfer); the author survives hub relay as `updatedBy`.
    if (
      owner !== undefined &&
      incomingOwner !== undefined &&
      incomingOwner !== owner &&
      change.updatedBy !== owner &&
      (!ownerClock || compareClock(change.clocks.ownerMachine!, ownerClock) > 0)
    )
      return yield* new SharedStateError({ reason: "owner-change" });
    // An existing agent or schedule may only be rewritten by its owner
    // machine. The author is `updatedBy`, which a hub relay preserves, so a
    // relayed change is still checked against its original author. Creation
    // (no current document) is exempt: a spoke may create a hub-owned agent.
    if (
      current &&
      (change.kind === "agent" || change.kind === "schedule") &&
      typeof owner === "string" &&
      owner !== change.updatedBy
    ) {
      const editable = NON_OWNER_EDITABLE_FIELDS[change.kind];
      // Re-pairing replays original creation records through a new peer cursor.
      // Only fields that would advance the document require edit authority.
      if (
        Object.entries(change.clocks).some(
          ([key, clock]) =>
            !editable.has(key) &&
            (!current.clocks[key] || compareClock(clock, current.clocks[key]) > 0),
        )
      )
        return yield* new SharedStateError({ reason: "owner-change" });
    }
    const merged = mergeDocument(current, change);
    if (merged.kind === "schedule" && typeof merged.fields.agentId === "string") {
      const agent = yield* get("agent", merged.fields.agentId);
      if (
        agent &&
        agent.fields.ownerMachine !== undefined &&
        merged.fields.ownerMachine !== undefined &&
        merged.fields.ownerMachine !== agent.fields.ownerMachine
      )
        return yield* new SharedStateError({ reason: "owner-change" });
    }
    if (current && encodeJson(current) === encodeJson(merged)) return false;
    yield* sql`INSERT INTO shared_documents(kind,id,fields_json,clocks_json,tombstone_json,updated_by_env) VALUES (${merged.kind},${merged.id},${encodeJson(merged.fields)},${encodeJson(merged.clocks)},${merged.tombstone ? encodeJson(merged.tombstone) : null},${merged.updatedBy}) ON CONFLICT(kind,id) DO UPDATE SET fields_json=excluded.fields_json,clocks_json=excluded.clocks_json,tombstone_json=excluded.tombstone_json,updated_by_env=excluded.updated_by_env`;
    // Log the original delta, not the merged document: authorship must survive hub relay.
    yield* sql`INSERT INTO shared_changes(change_json) VALUES (${encodeJson(change)})`;
    if (project)
      yield* projectDocument(merged, preserveLocalBindings, Object.keys(change.fields)).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    if (project && change.kind === "agent" && !merged.tombstone) {
      const pending = yield* sql<{
        id: string;
      }>`SELECT id FROM shared_documents WHERE kind='schedule' AND json_extract(fields_json,'$.agentId')=${change.id} AND tombstone_json IS NULL`;
      for (const row of pending) {
        const document = yield* get("schedule", row.id);
        if (document)
          yield* projectDocument(document, preserveLocalBindings).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
      }
    }
    return true;
  });
  // A newer build's nested fields in the stored value survive this write.
  const changedFields = (
    kind: SharedDocumentKind,
    current: SharedDocumentChange | undefined,
    fields: SharedDocumentChange["fields"],
  ) =>
    Object.fromEntries(
      Object.entries(fields)
        .map(
          ([key, value]) => [key, preserveUnknown(kind, key, value, current?.fields[key])] as const,
        )
        .filter(
          ([key, value]) =>
            !current ||
            !Object.hasOwn(current.fields, key) ||
            encodeJson(value) !== encodeJson(current.fields[key]),
        ),
    ) as SharedDocumentChange["fields"];
  const commit = Effect.fn("SharedState.commit")(function* (
    kind: SharedDocumentKind,
    id: string,
    changed: SharedDocumentChange["fields"],
    clock: HybridClock,
    deleted: boolean,
    project: boolean,
    preserveLocalBindings: boolean,
  ) {
    const change: SharedDocumentChange = {
      kind,
      id,
      fields: changed,
      clocks: Object.fromEntries(Object.keys(changed).map((key) => [key, clock])),
      tombstone: deleted ? clock : null,
      updatedBy: environmentId,
    };
    yield* validateChange(change);
    return yield* persist(change, project, preserveLocalBindings);
  });
  const writeInternal = Effect.fn("SharedState.writeInternal")(function* (
    kind: SharedDocumentKind,
    id: string,
    fields: SharedDocumentChange["fields"],
    deleted: boolean,
    project: boolean,
    preserveLocalBindings = false,
  ) {
    const current = yield* get(kind, id);
    if (current?.tombstone) {
      if (deleted) return false;
      return yield* new SharedStateError({ reason: "invalid-document" });
    }
    const changed = changedFields(kind, current, fields);
    if (!deleted && Object.keys(changed).length === 0) return false;
    const clock = yield* observe();
    return yield* commit(kind, id, changed, clock, deleted, project, preserveLocalBindings);
  });
  const write: SharedState["Service"]["write"] = (kind, id, fields, deleted = false) =>
    sql.withTransaction(writeInternal(kind, id, fields, deleted, true)).pipe(
      Effect.mapError(storage),
      Effect.tap((changed) => (changed ? notify : Effect.void)),
      Effect.asVoid,
    );
  const writeBuilt: SharedState["Service"]["writeBuilt"] = (kind, id, build) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* get(kind, id);
          if (current?.tombstone)
            return yield* new SharedStateError({ reason: "invalid-document" });
          const clock = yield* observe();
          const changed = changedFields(kind, current, yield* build(clock));
          if (Object.keys(changed).length === 0) return false;
          return yield* commit(kind, id, changed, clock, false, true, false);
        }),
      )
      .pipe(
        Effect.mapError(storage),
        Effect.tap((changed) => (changed ? notify : Effect.void)),
        Effect.asVoid,
      );
  const capture: SharedState["Service"]["capture"] = (kind, id, deleted = false) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const configuration = deleted
            ? {}
            : yield* readConfiguration(kind, id).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
          if (configuration === null) return false;
          const fields = yield* Schema.decodeUnknownEffect(
            Schema.Record(Schema.String, Schema.Json),
          )(configuration);
          return yield* writeInternal(kind, id, fields, deleted, true, true);
        }),
      )
      .pipe(
        Effect.mapError(storage),
        Effect.tap((changed) => (changed ? notify : Effect.void)),
        Effect.asVoid,
      );
  const cursors = Effect.fn("SharedState.cursors")(
    function* (peer: EnvironmentId) {
      const rows = yield* sql<{
        received: number;
        acknowledged: number;
      }>`SELECT received,acknowledged FROM shared_peer_cursors WHERE environment_id=${peer}`;
      return rows[0] ?? { received: 0, acknowledged: 0 };
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(storage),
  );
  const readBatch = Effect.fn("SharedState.readBatch")(
    function* (after: number, target: EnvironmentId, localOnly: boolean) {
      const latest = yield* sql<{
        cursor: number;
      }>`SELECT COALESCE(MAX(cursor),0) AS cursor FROM shared_changes`;
      if (!Number.isSafeInteger(after) || after < 0 || after > latest[0]!.cursor)
        return yield* new SharedStateError({ reason: "invalid-cursor" });
      const rows = yield* sql<{
        cursor: number;
        change_json: string;
      }>`SELECT cursor,change_json FROM shared_changes WHERE cursor>${after} ORDER BY cursor LIMIT ${SHARED_BATCH_LIMIT}`;
      const changes: SharedDocumentChange[] = [];
      let cursor = after,
        bytes = 0;
      for (const row of rows) {
        yield* NodeSqliteClient.eventLoopTurn;
        const change = yield* decodeChange(row.change_json).pipe(
          Effect.catchTags({
            SchemaError: () =>
              Effect.logWarning("Skipping undecodable shared change", { cursor: row.cursor }).pipe(
                Effect.as(undefined),
              ),
          }),
        );
        if (!change) {
          cursor = row.cursor;
          continue;
        }
        if (change.updatedBy !== target && (!localOnly || change.updatedBy === environmentId)) {
          const size = new TextEncoder().encode(row.change_json).length;
          // Domain text has no aggregate byte limit. Send a large document alone so
          // it cannot wedge the cursor, while keeping ordinary coalesced batches small.
          if (changes.length > 0 && bytes + size > Math.min(SHARED_BATCH_BYTES, 64 * 1024) - 1024)
            break;
          changes.push(change);
          bytes += size;
        }
        cursor = row.cursor;
      }
      return { after, cursor, changes };
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(storage),
  );
  const defer = (change: SharedDocumentChangeWire, source: EnvironmentId, trustedRelay: boolean) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("Keeping a shared change this build cannot read for a later one", {
        kind: change.kind,
        fields: Object.keys(change.fields),
      });
      yield* sql`INSERT INTO shared_deferred_changes(source_env,trusted_relay,change_json) VALUES (${source},${trustedRelay ? 1 : 0},${encodeJson(change)})`;
    });
  /**
   * After an update, apply what an older build kept back. Fields it applied
   * at the time merge again harmlessly; a change still unreadable waits on.
   */
  const applyDeferred = sql
    .withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          seq: number;
          change_json: string;
        }>`SELECT seq,change_json FROM shared_deferred_changes ORDER BY seq`;
        let changed = false;
        for (const row of rows) {
          const change = yield* decodeWireChange(row.change_json).pipe(Effect.option);
          if (Option.isSome(change) && splitChange(change.value).deferred) continue;
          if (Option.isSome(change)) {
            const { accepted } = splitChange(change.value);
            const applied = accepted
              ? yield* persist(accepted, true).pipe(
                  Effect.catchTags({
                    SharedStateError: (error) =>
                      Effect.logWarning("Dropping a kept shared change that no longer applies", {
                        reason: error.reason,
                      }).pipe(Effect.as(false)),
                  }),
                )
              : false;
            changed = applied || changed;
          }
          yield* sql`DELETE FROM shared_deferred_changes WHERE seq=${row.seq}`;
        }
        return changed;
      }),
    )
    .pipe(
      Effect.tap((changed) => (changed ? notify : Effect.void)),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not apply kept shared changes", { cause }),
      ),
    );
  const receive: SharedState["Service"]["receive"] = (input, source, trustedRelay) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Envelope keys a newer build adds are ignored, never a refusal.
          const batch = yield* decodeBatch(input);
          if (
            (batch.changes.length > 1 &&
              new TextEncoder().encode(encodeJson(batch)).length > SHARED_BATCH_BYTES) ||
            batch.cursor < batch.after ||
            batch.cursor - batch.after > SHARED_BATCH_LIMIT ||
            batch.changes.length > batch.cursor - batch.after ||
            (batch.cursor === batch.after && batch.changes.length > 0)
          )
            return yield* new SharedStateError({ reason: "invalid-cursor" });
          for (const change of batch.changes) {
            yield* checkIntegrity(change);
            if (!trustedRelay && change.updatedBy !== source)
              return yield* new SharedStateError({ reason: "invalid-document" });
          }
          const previous = (yield* cursors(source)).received;
          if (batch.cursor <= previous) return { acknowledged: previous, changed: false };
          if (batch.after > previous)
            return yield* new SharedStateError({ reason: "invalid-cursor" });
          let changed = false;
          for (const change of batch.changes) {
            // What this build cannot read waits for a newer one; the rest applies now.
            const { accepted, deferred } = splitChange(change);
            if (deferred) yield* defer(change, source, trustedRelay);
            if (accepted) changed = (yield* persist(accepted, true)) || changed;
            const latest = [
              ...Object.values(change.clocks),
              ...(change.tombstone ? [change.tombstone] : []),
            ]
              .sort(compareClock)
              .at(-1);
            if (latest) yield* observe(latest);
          }
          yield* sql`INSERT INTO shared_peer_cursors(environment_id,received) VALUES (${source},${batch.cursor}) ON CONFLICT(environment_id) DO UPDATE SET received=excluded.received`;
          return { acknowledged: batch.cursor, changed };
        }),
      )
      .pipe(
        Effect.mapError(storage),
        Effect.tap((result) => (result.changed ? notify : Effect.void)),
        Effect.map(({ acknowledged }) => ({ acknowledged })),
      );
  const acknowledge = Effect.fn("SharedState.acknowledge")(function* (
    peer: EnvironmentId,
    cursor: number,
  ) {
    const latest = yield* sql<{
      cursor: number;
    }>`SELECT COALESCE(MAX(cursor),0) AS cursor FROM shared_changes`;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > latest[0]!.cursor)
      return yield* new SharedStateError({ reason: "invalid-cursor" });
    yield* sql`INSERT INTO shared_peer_cursors(environment_id,acknowledged) VALUES (${peer},${cursor}) ON CONFLICT(environment_id) DO UPDATE SET acknowledged=max(acknowledged,excluded.acknowledged)`;
  }, Effect.mapError(storage));
  // Backfill ownership before any due-work source can run. Existing jobs keep this machine.
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE agents SET owner_machine=${environmentId} WHERE owner_machine IS NULL`;
        yield* sql`UPDATE scheduled_tasks SET owner_machine=${environmentId} WHERE owner_machine IS NULL`;
      }),
    )
    .pipe(Effect.mapError(storage));
  yield* applyDeferred;
  const bootstrapSources = {
    project: sql<{ id: string }>`SELECT label_id AS id FROM project_labels`,
    agent: sql<{ id: string }>`SELECT agent_id AS id FROM agents`,
    schedule: sql<{ id: string }>`SELECT task_id AS id FROM scheduled_tasks`,
    // After agents, so a peer receives a fact's agent before the fact.
    fact: sql<{ id: string }>`SELECT id FROM facts ORDER BY rowid`.pipe(
      Effect.map((rows) => rows.map((row) => ({ id: factDocumentId(row.id) }))),
    ),
  };
  const bootstrapKinds = Object.keys(bootstrapSources) as Array<keyof typeof bootstrapSources>;
  const bootstrap: SharedState["Service"]["bootstrap"] = Effect.fn("SharedState.bootstrap")(
    function* (pairingKey) {
      const key = encodeJson({
        pairing: pairingKey ?? (yield* Ref.get(hub)) ?? "standalone",
        kinds: [...bootstrapKinds].sort(),
      });
      // The common scheduler path is a read; only the first pass acquires a write transaction.
      if ((yield* sql`SELECT 1 FROM shared_bootstrap WHERE pairing_key=${key}`).length > 0) return;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if ((yield* sql`SELECT 1 FROM shared_bootstrap WHERE pairing_key=${key}`).length > 0)
              return;
            for (const kind of bootstrapKinds) {
              for (const row of yield* bootstrapSources[kind])
                yield* Effect.gen(function* () {
                  if (!(yield* get(kind, row.id))) yield* capture(kind, row.id);
                }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Skipping invalid shared configuration during bootstrap", {
                      kind,
                      reason: storage(error).reason,
                    }),
                  ),
                );
            }
            yield* sql`INSERT INTO shared_bootstrap(pairing_key) VALUES (${key})`;
          }),
        )
        .pipe(Effect.mapError(storage));
    },
    Effect.mapError(storage),
  );
  return SharedState.of({
    environmentId,
    defaultOwner: Effect.succeed(environmentId),
    setHub: (value) => Ref.set(hub, value),
    changes: Stream.fromPubSub(signals),
    get,
    write,
    writeBuilt,
    capture,
    bootstrap,
    cursors,
    readBatch,
    receive,
    acknowledge,
  });
});
export const layer = Layer.effect(SharedState, make);
