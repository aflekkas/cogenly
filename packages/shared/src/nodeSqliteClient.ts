// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fiber yields do not guarantee a socket/timer turn.
import * as NodeTimers from "node:timers";
/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

/** Yield a real event-loop turn for CPU-heavy decode and projection loops. */
export const eventLoopTurn = Effect.callback<void>((resume) => {
  const handle = NodeTimers.setImmediate(() => resume(Effect.void));
  return Effect.sync(() => NodeTimers.clearImmediate(handle));
});

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /**
   * Run transactions marked with `readOnly` on a second connection in a worker
   * thread, so long reads block neither the event loop nor writes. Ignored for
   * in-memory databases, which a second connection cannot share.
   */
  readonly readerWorker?: boolean | undefined;
  /** Execute writer statements and bounded lock waits off the event loop. */
  readonly writerWorker?: boolean | undefined;
  /** Connection-local settings applied to the fallback and every worker incarnation. */
  readonly connectionPragmas?: ReadonlyArray<string> | undefined;
  /** How long a reader worker may take to open the database before reads use the writer. Default 10 seconds. */
  readonly readerStartupTimeout?: Duration.Input | undefined;
  /**
   * Run WAL checkpoints on a read-write connection in a worker thread, so
   * copying pages into the database and syncing it never block the event loop.
   * Ignored for in-memory databases.
   */
  readonly checkpointWorker?: boolean | undefined;
}

/**
 * Set by `readOnly`. A top-level transaction started while it is true runs on
 * the reader worker when the client has one, and on the writer otherwise.
 */
const ReadOnly = Context.Reference<boolean>("@cogenly/shared/nodeSqliteClient/ReadOnly", {
  defaultValue: () => false,
});

/**
 * Marks the SQL in `effect` as read-only. Wrap the whole transaction, as in
 * `sql.withTransaction(reads).pipe(readOnly)`. Inside an open write
 * transaction the reads keep using the writer, and a write attempted on the
 * reader fails with "attempt to write a readonly database".
 */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReadOnly, true);

/** Interactive request context follows SQL through nested services. */
const Interactive = Context.Reference<boolean>("@cogenly/shared/nodeSqliteClient/Interactive", {
  defaultValue: () => false,
});
export const interactive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Interactive, true);

const loadKey = Symbol.for("@cogenly/shared/nodeSqliteClient/load");
interface Load {
  interactiveAt: number;
  writerWaitMs: number;
  writerWaitAt: number;
  writerWorkerUnavailable: boolean;
  writerBusyRetries: number;
}
/** Per-client pressure, including when tracing is disabled. */
export const load = (client: Client.SqlClient): Readonly<Load> | undefined =>
  (client as Client.SqlClient & { [loadKey]?: Load })[loadKey];

/**
 * Which connection ran the SQL, and how long it waited for that connection's
 * lock. The wait is time queued behind other SQL, not time the event loop was
 * blocked.
 */
interface Acquired {
  readonly connection: "writer" | "reader";
  readonly lockWaitMs: number;
}

const annotateAcquired = (fiber: Fiber.Fiber<unknown, unknown>, acquired: Acquired | undefined) => {
  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  if (span?._tag !== "Span" || acquired === undefined) return;
  span.attribute("db.connection", acquired.connection);
  span.attribute("db.lock_wait_ms", acquired.lockWaitMs);
};

/**
 * Provided by the client's `withTransaction`. Effect acquires a transaction's
 * connection before it makes the `sql.transaction` span current, so the acquire
 * leaves its result here and the transaction body puts it on the span.
 */
const TransactionAcquire = Context.Reference<{ acquired?: Acquired } | undefined>(
  "@cogenly/shared/nodeSqliteClient/TransactionAcquire",
  { defaultValue: () => undefined },
);

/**
 * A one-holder connection lock that hands over to interactive waiters first.
 * Background work (replication, scheduled sweeps, projections) queues behind
 * whatever a user is waiting on, so a backlog of it never delays a Stop or a
 * send by more than the statement or transaction currently running. After
 * `burst` interactive handoffs in a row with background work waiting, one
 * background waiter goes next, so a steady stream of interactive work cannot
 * starve background work.
 */
export const makePriorityLock = (burst = 8) => {
  let held = false;
  let urgentRun = 0;
  const urgent: Array<() => void> = [];
  const normal: Array<() => void> = [];
  const releaseUnsafe = () => {
    let next: (() => void) | undefined;
    if (urgent.length > 0 && (normal.length === 0 || urgentRun < burst)) {
      next = urgent.shift();
      urgentRun = normal.length === 0 ? 0 : urgentRun + 1;
    } else {
      next = normal.shift();
      urgentRun = 0;
    }
    if (next === undefined) held = false;
    else next();
  };
  const take = (interactive: boolean) =>
    Effect.callback<void>((resume) => {
      if (!held) {
        held = true;
        resume(Effect.void);
        return;
      }
      const queue = interactive ? urgent : normal;
      let granted = false;
      const waiter = () => {
        granted = true;
        resume(Effect.void);
      };
      queue.push(waiter);
      return Effect.sync(() => {
        const at = queue.indexOf(waiter);
        if (at !== -1) queue.splice(at, 1);
        // Granted as the waiter was interrupted: pass the lock on.
        else if (granted) releaseUnsafe();
      });
    });
  return { take, release: Effect.sync(releaseUnsafe) };
};

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient`, specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

/**
 * SQLite keeps its copy of a statement's text and blob parameters until the
 * statement is bound again or finalized, and `node:sqlite` cannot clear them.
 * A cached statement would hold its last payload for as long as it stays
 * cached, so executions binding more than this many string code units and
 * blob bytes, or a named parameter behind a getter, get a throwaway statement
 * instead.
 */
const LARGE_BINDING_SIZE = 64 * 1024;

// `node:sqlite` binds both buffer views and raw buffers as blobs.
const isBlob = (value: unknown): value is ArrayBufferView | ArrayBufferLike =>
  ArrayBuffer.isView(value) || NodeUtil.types.isAnyArrayBuffer(value);

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // `node:sqlite` takes named parameters as one object, callable or not.
        // Read data properties only: calling a getter here would run it twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    // A parameter that cannot be measured is left for the statement to report.
    return true;
  }
};

// Evaluated source instead of a worker file, so the reader also starts from
// bundles and single-executable builds that have no module file on disk.
const connectionWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: !workerData.writable,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = " + (workerData.writable ? 100 : 5000));
  if (workerData.writable) {
    next.exec("PRAGMA wal_autocheckpoint = " + workerData.checkpointFrames);
    for (const pragma of workerData.connectionPragmas) next.exec(pragma);
  }
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (!workerData.writable && mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", message: String(error && error.message ? error.message : error) });
}
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
const requests = [];
let executing = false;
const nextRequest = () => {
  if (executing || requests.length === 0) return;
  executing = true;
  const request = requests.shift();
  const finish = (reply) => {
    parentPort.postMessage(reply);
    executing = false;
    nextRequest();
  };
  if (request.checkpointFrames !== undefined) {
    db.exec("PRAGMA wal_autocheckpoint = " + request.checkpointFrames);
    executing = false;
    nextRequest();
    return;
  }
  const { id, sql, params, cached, values, raw, safeIntegers } = request;
  const startedAt = performance.now();
  let attempts = 0;
  const execute = () => {
    let operation = "open";
    try {
      if (db === undefined) throw new Error("database reader is unavailable");
      operation = "prepare";
      const statement = prepare(sql, cached);
      operation = "execute";
      statement.setReadBigInts(safeIntegers);
      if (statement.columns().length > 0) {
        statement.setReturnArrays(values);
        finish({ id, rows: statement.all(...params) });
      } else {
        const result = statement.run(...params);
        finish({ id, rows: raw ? result : [] });
      }
    } catch (error) {
      if (workerData.writable && ((error.errcode & 255) === 5 || (error.errcode & 255) === 6)
          && performance.now() - startedAt < 5000) {
        // Each native attempt blocks only this worker for 100 ms; the total
        // contention budget matches SQLite's former five-second timeout.
        parentPort.postMessage({ type: "busy" });
        setTimeout(execute, Math.min(100, 10 * ++attempts));
        return;
      }
      finish({
        id,
        error: {
          operation,
          message: String(error && error.message ? error.message : error),
          code: error && error.code,
          errcode: error && error.errcode,
          errstr: error && error.errstr,
        },
      });
    }
  };
  execute();
};
parentPort.on("message", (request) => { requests.push(request); nextRequest(); });
`;

interface WorkerRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

type WorkerStartup =
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly message: string };

type WorkerReply =
  | { readonly id: number; readonly rows: ReadonlyArray<any> }
  | {
      readonly id: number;
      readonly error: {
        readonly operation: "open" | "prepare" | "execute";
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
        readonly errstr?: unknown;
      };
    };

const workerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

// COMMIT, ROLLBACK and ROLLBACK TO SAVEPOINT. On a reader they change nothing,
// so they succeed once the worker is gone instead of failing the cleanup.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

/**
 * Connections served by one worker thread at a time. Each worker
 * gets its own `Connection`, so a transaction stays on the worker it began on:
 * once that worker exits, its statements fail rather than silently continuing
 * outside the transaction on a replacement. The next acquire starts a new one.
 * A worker that cannot open the database read-only, or finds it outside WAL
 * mode, turns the reader off for the life of the client: reads use the writer.
 */
const makeWorker = Effect.fnUntraced(function* (
  options: SqliteClientConfig,
  writable = false,
  onStatement?: (worker: NodeWorkerThreads.Worker) => void,
  onAvailability?: (available: boolean) => void,
  onBusy?: () => void,
) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const clock = yield* Clock.Clock;
  let closing = false;
  let retryAt = 0;
  let current:
    | {
        readonly worker: NodeWorkerThreads.Worker;
        readonly connection: Connection;
        readonly started: Promise<WorkerStartup>;
      }
    | undefined;
  let unavailable = false;
  let nextRequestId = 0;

  const start = () => {
    const worker = new NodeWorkerThreads.Worker(connectionWorkerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        writable,
        checkpointFrames: options.checkpointWorker ? WRITER_BACKSTOP_FRAMES : CHECKPOINT_FRAMES,
        allowExtension: options.allowExtension ?? false,
        prepareCacheSize: options.prepareCacheSize ?? 200,
        connectionPragmas: options.connectionPragmas ?? [],
      },
    });
    let announce: (startup: WorkerStartup) => void = () => {};
    const started = new Promise<WorkerStartup>((resolve) => {
      announce = resolve;
    });
    let stoppedMessage: string | undefined;
    const pending = new Map<
      number,
      { readonly endsTransaction: boolean; readonly resume: (reply: WorkerReply) => void }
    >();
    const stop = (message: string) => {
      if (stoppedMessage !== undefined) return;
      stoppedMessage = message;
      if (writable && !closing) {
        onAvailability?.(false);
        runFork(
          Effect.logWarning("SQLite writer worker exited; the next write reacquires a connection"),
        );
      }
      announce({ type: "unavailable", message });
      if (current?.worker === worker) current = undefined;
      for (const [id, request] of pending) {
        request.resume(
          request.endsTransaction
            ? { id, rows: [] }
            : { id, error: { operation: "execute", message } },
        );
      }
      pending.clear();
    };
    worker.on("message", (reply: WorkerReply | WorkerStartup | { readonly type: "busy" }) => {
      if ("type" in reply && reply.type === "busy") {
        onBusy?.();
        return;
      }
      if ("type" in reply) {
        announce(reply);
        // An idle reader must not keep the process alive.
        if (pending.size === 0) worker.unref();
        return;
      }
      const request = pending.get(reply.id);
      if (request === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      request.resume(reply);
    });
    worker.on("error", (cause) =>
      stop(`Database ${writable ? "writer" : "reader"} failed: ${cause.message}`),
    );
    worker.on("exit", (code) =>
      stop(`Database ${writable ? "writer" : "reader"} exited with code ${code}`),
    );

    const request = (input: WorkerRequest) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const endsTransaction = !writable && endsReadTransaction(input.sql);
        if (stoppedMessage !== undefined) {
          return endsTransaction
            ? Effect.succeed([])
            : Effect.fail(
                failed(new Error(stoppedMessage), workerFailureMessages.execute, "execute"),
              );
        }
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          const id = nextRequestId++;
          pending.set(id, {
            endsTransaction,
            resume: (reply) => {
              if ("rows" in reply) {
                onStatement?.(worker);
                resume(Effect.succeed(reply.rows));
                return;
              }
              const { operation, message, ...codes } = reply.error;
              resume(
                Effect.fail(
                  failed(
                    Object.assign(new Error(message), codes),
                    workerFailureMessages[operation],
                    operation,
                  ),
                ),
              );
            },
          });
          if (pending.size === 1) worker.ref();
          // The worker's statement cache would pin large parameters the same way.
          const cached = input.cached && !hasLargeBinding(input.params);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ id, safeIntegers, ...input, cached });
        }).pipe(
          // An accepted native write cannot be cancelled. Keep its connection
          // leased until the reply, before rollback or the next transaction.
          writable ? Effect.uninterruptible : identity,
        );
      });

    const connection = identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = request({ sql, params, cached: true, values: false, raw: false });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return request({ sql, params, cached: true, values: false, raw: true });
      },
      executeValues(sql, params) {
        return request({ sql, params, cached: true, values: true, raw: false });
      },
      executeValuesUnprepared(sql, params) {
        return request({ sql, params: params ?? [], cached: false, values: true, raw: false });
      },
      executeUnprepared(sql, params, rowTransform) {
        // A read-only connection rejects BEGIN IMMEDIATE and BEGIN EXCLUSIVE,
        // and a deferred BEGIN is all a read snapshot needs.
        const statement = !writable && /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
        const effect = request({
          sql: statement,
          params: params ?? [],
          cached: false,
          values: false,
          raw: false,
        });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
    current = { worker, connection, started };
    return current;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closing = true;
      await current?.worker.terminate();
    }),
  );

  const startupTimeout = Duration.fromInputUnsafe(
    options.readerStartupTimeout ?? Duration.seconds(10),
  );

  // Runs once: concurrent first acquires share one startup and may all see it fail.
  const turnOff = (reader: typeof current, reason: string) =>
    Effect.suspend(() => {
      if (reader !== undefined) {
        if (current === reader) current = undefined;
        void reader.worker.terminate();
      }
      if (unavailable) return Effect.succeed(undefined);
      unavailable = !writable;
      retryAt = clock.currentTimeMillisUnsafe() + 1000;
      onAvailability?.(false);
      return Effect.logWarning(
        writable
          ? "SQLite writer worker unavailable; writes use the main-thread connection"
          : "SQLite reader worker unavailable; reads use the writer",
        { reason },
      ).pipe(Effect.as(undefined));
    });

  /** The live worker's connection once it is ready, or undefined to use the writer. */
  return Effect.suspend((): Effect.Effect<Connection | undefined> => {
    if (unavailable || (writable && clock.currentTimeMillisUnsafe() < retryAt))
      return Effect.succeed(undefined);
    let reader: NonNullable<typeof current>;
    try {
      reader = current ?? start();
    } catch (cause) {
      return turnOff(undefined, String(cause));
    }
    // SqlClient acquires transaction connections uninterruptibly. Startup has not
    // begun a transaction, so cancellation can still release the acquired lease.
    return Effect.flatMap(
      Effect.interruptible(
        Effect.timeoutOption(
          Effect.promise(() => reader.started),
          startupTimeout,
        ),
      ),
      (startup): Effect.Effect<Connection | undefined> =>
        // Another acquire may have timed out and retired this worker while this one
        // waited; a late "ready" must not hand out a worker that is being terminated.
        unavailable || current !== reader
          ? Effect.succeed(undefined)
          : Option.isSome(startup) && startup.value.type === "ready"
            ? Effect.sync(() => {
                onAvailability?.(true);
                return reader.connection;
              })
            : turnOff(
                reader,
                Option.isSome(startup) && startup.value.type === "unavailable"
                  ? startup.value.message
                  : `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`,
              ),
    );
  });
});

// SQLite's default wal_autocheckpoint, in WAL frames (pages).
const CHECKPOINT_FRAMES = 1000;
// While the worker runs, the writer still checkpoints a WAL this long. Writes
// with no pause leave the worker behind, and the WAL can only restart once
// every frame is checkpointed, so this keeps the file from growing forever.
const WRITER_BACKSTOP_FRAMES = 10 * CHECKPOINT_FRAMES;
// How long writes must pause before the worker checkpoints the rest of a long WAL.
const CHECKPOINT_IDLE_MS = 100;

// Each message asks the worker to checkpoint if CHECKPOINT_FRAMES frames are
// waiting, and it replies with the same message when done. Once writes pause, it also checkpoints the
// frames that arrived during its last checkpoint, so the writer can restart the
// WAL. NOOP only counts frames. SQLite before 3.51 reads NOOP as PASSIVE and
// would checkpoint on every request, so the worker refuses to start there and
// the writer keeps checkpointing.
const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.filename);
db.exec("PRAGMA busy_timeout = 100;");
const busy = (error) => error.errcode === 5 || error.errcode === 6;
let attempts = 0;
const start = () => {
  try {
    const version = db.prepare("SELECT sqlite_version() AS version").get().version;
    const [major, minor] = version.split(".").map(Number);
    if (major < 3 || (major === 3 && minor < 51)) throw new Error("SQLite " + version + " has no NOOP checkpoint");
    // macOS fsync() does not flush the drive cache; F_FULLFSYNC does.
    db.exec("PRAGMA checkpoint_fullfsync = ON;");
    const frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
    const check = (finishing) => {
      try {
        const { log, checkpointed } = frames.get();
        if (finishing ? log >= workerData.frames && checkpointed < log : log - checkpointed >= workerData.frames)
          checkpoint.get();
      } catch (error) {
        // A concurrent writer is temporary; leave its WAL for the next check.
        if (!busy(error)) throw error;
      }
    };
    let idle;
    parentPort.on("message", (request) => {
      check(false);
      clearTimeout(idle);
      idle = setTimeout(() => check(true), workerData.idleMs);
      parentPort.postMessage(request);
    });
  } catch (error) {
    if (!busy(error) || attempts++ >= 3) throw error;
    setTimeout(start, 10 * attempts);
  }
};
start();
`;

/**
 * Moves the writer's WAL checkpoints to a worker. Call the returned function
 * after each statement on the writer. While the worker runs, the writer only
 * checkpoints at WRITER_BACKSTOP_FRAMES. If the worker cannot start, fails or
 * exits, the writer goes back to SQLite's default and one warning says why.
 */
const startCheckpointWorker = Effect.fnUntraced(function* (
  filename: string,
  writer: NodeSqlite.DatabaseSync,
) {
  const warn = (reason: string) =>
    Effect.logWarning("SQLite checkpoint worker unavailable; the writer checkpoints the WAL", {
      reason,
    });
  let worker: NodeWorkerThreads.Worker;
  try {
    worker = new NodeWorkerThreads.Worker(checkpointWorkerSource, {
      eval: true,
      workerData: { filename, frames: CHECKPOINT_FRAMES, idleMs: CHECKPOINT_IDLE_MS },
    });
  } catch (cause) {
    // No worker threads here: the writer keeps checkpointing.
    yield* warn(String(cause));
    return undefined;
  }
  writer.exec(`PRAGMA wal_autocheckpoint = ${WRITER_BACKSTOP_FRAMES};`);
  // Worker events arrive outside any fiber; this keeps the client's loggers.
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let stopped = false;
  let checking = false;
  let checkAgain = false;
  const handBack = (reason: string) => {
    if (stopped) return;
    stopped = true;
    try {
      writer.exec(`PRAGMA wal_autocheckpoint = ${CHECKPOINT_FRAMES};`);
    } catch {
      // The writer is already closed.
    }
    runFork(warn(reason));
  };
  // A worker that throws, such as on SQLite before 3.51, emits "error" before "exit".
  worker.on("error", (cause) => handBack(cause.message));
  worker.on("exit", (code) => handBack(`exited with code ${code}`));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      // A normal shutdown: the writer closes next, so there is nothing to hand back or report.
      stopped = true;
      return worker.terminate();
    }),
  );

  // At most one request is in flight. A statement that runs during it asks for
  // one more check, so the frames of a last commit before idle still get one.
  const check = () => {
    if (stopped) return;
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
    worker.postMessage(null);
  };
  worker.on("message", () => {
    checking = false;
    if (checkAgain) {
      checkAgain = false;
      check();
    }
  });
  // After the listeners: adding a "message" listener refs the worker again.
  // A checkpoint in progress must not keep the process alive.
  worker.unref();
  return Object.assign(check, { active: () => !stopped });
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const pressure: Load = {
    interactiveAt: -Infinity,
    writerWaitMs: 0,
    writerWaitAt: -Infinity,
    writerWorkerUnavailable: false,
    writerBusyRetries: 0,
  };
  let acquireWriter: Effect.Effect<Connection | undefined> | undefined;
  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );
    // Started after the close finalizer, so the worker stops before the writer closes.
    const checkpoint =
      options.checkpointWorker && isFileDatabase
        ? yield* startCheckpointWorker(options.filename, db)
        : undefined;

    // The fallback must have the same connection-local settings as a respawned worker.
    yield* Effect.try({
      try: () => {
        db.exec("PRAGMA busy_timeout = 5000");
        for (const pragma of options.connectionPragmas ?? []) db.exec(pragma);
      },
      catch: (cause) => failed(cause, "Failed to initialize database connection", "open"),
    });
    if (options.writerWorker && !options.readonly && isFileDatabase) {
      const handedBack = new WeakSet<NodeWorkerThreads.Worker>();
      acquireWriter = yield* makeWorker(
        options,
        true,
        (worker) => {
          if (checkpoint?.active()) checkpoint();
          else if (!handedBack.has(worker)) {
            handedBack.add(worker);
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
            worker.postMessage({ checkpointFrames: CHECKPOINT_FRAMES });
          }
        },
        (available) => {
          pressure.writerWorkerUnavailable = !available;
        },
        () => {
          pressure.writerBusyRetries++;
        },
      );
    }

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => db.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: options.prepareCacheSize ?? 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
    });

    const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
      hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      raw: boolean,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        try {
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          if (hasRows(statement)) {
            const rows = statement.all(...(params as any));
            checkpoint?.();
            return Effect.succeed(rows);
          }
          const result = statement.run(...(params as any));
          checkpoint?.();
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyError(cause, "Failed to execute statement", "execute"),
            }),
          );
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(statementFor(sql, params), (s) => runStatement(s, params, raw));

    const runStatementValues = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
    ) =>
      Effect.acquireUseRelease(
        Effect.succeed(statement),
        (statement) =>
          Effect.try({
            try: () => {
              statement.setReadBigInts(
                Boolean(Context.get(Fiber.getCurrent()!.context, Client.SafeIntegers)),
              );
              if (hasRows(statement)) {
                statement.setReturnArrays(true);
                // Safe to cast to array after we've setReturnArrays(true)
                const rows = statement.all(...(params as any)) as unknown as ReadonlyArray<
                  ReadonlyArray<unknown>
                >;
                checkpoint?.();
                return rows;
              }
              statement.run(...(params as any));
              checkpoint?.();
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
          }),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(
                  cause,
                  "Failed to reset statement result mode",
                  "resetResultMode",
                ),
              }),
          }).pipe(Effect.orDie),
      );

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatementValues(statement, params),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatementValues(statement, params ?? []),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [], false)),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const writerLock = makePriorityLock();
  const connection = yield* makeConnection;
  const acquireReader =
    options.readerWorker && isFileDatabase ? yield* makeWorker(options) : undefined;
  const readerLock = makePriorityLock();

  const writer = {
    name: "writer" as const,
    lock: writerLock,
    acquire: Effect.suspend(() =>
      acquireWriter === undefined
        ? Effect.succeed(connection)
        : Effect.map(acquireWriter, (worker) => worker ?? connection),
    ),
  };
  // Picks the reader only for `readOnly` work, and the writer whenever the
  // reader is turned off.
  const route = Effect.withFiber((fiber) =>
    acquireReader !== undefined && Context.get(fiber.context, ReadOnly)
      ? Effect.map(acquireReader, (readerConnection) =>
          readerConnection === undefined
            ? writer
            : {
                name: "reader" as const,
                lock: readerLock,
                acquire: Effect.succeed(readerConnection),
              },
        )
      : Effect.succeed(writer),
  );

  const observe = (
    fiber: Fiber.Fiber<unknown, unknown>,
    name: "reader" | "writer",
    waitMs: number,
  ) => {
    const now = fiber.getRef(Clock.Clock).currentTimeMillisUnsafe();
    if (Context.get(fiber.context, Interactive)) pressure.interactiveAt = now;
    if (
      name === "writer" &&
      (waitMs > pressure.writerWaitMs || now - pressure.writerWaitAt > 5000)
    ) {
      pressure.writerWaitMs = waitMs;
      pressure.writerWaitAt = now;
    }
  };

  const acquired = (
    target: { readonly name: Acquired["connection"] },
    clock: Clock.Clock,
    start: bigint,
  ): Acquired => ({
    connection: target.name,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
  });

  const transactionAcquirer = Effect.flatMap(route, (target) =>
    Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!;
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      const interactive = Context.get(fiber.context, Interactive);
      if (interactive) pressure.interactiveAt = clock.currentTimeMillisUnsafe();
      return Effect.flatMap(
        Effect.tap(restore(target.lock.take(interactive)), () => {
          const pending = fiber.getRef(TransactionAcquire);
          const sample = acquired(target, clock, start);
          observe(fiber, target.name, sample.lockWaitMs);
          if (pending !== undefined) pending.acquired = sample;
          else if (
            fiber.getRef(References.TracerEnabled) &&
            fiber.getRef(Statement.SpanPropagationEnabled)
          )
            annotateAcquired(fiber, sample);
          return Scope.addFinalizer(scope, target.lock.release);
        }),
        () => target.acquire,
      );
    }),
  );

  const client = yield* Client.make({
    acquirer: transactionAcquirer,
    compiler,
    transactionAcquirer,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out. Taking
    // the lock up front makes it wait instead, at the cost of serializing
    // read-only transactions behind other processes' writers. Read-only
    // connections cannot write, so they keep the deferred BEGIN.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    [loadKey]: pressure,
    // Each run gets its own holder, so a reused transaction Effect never
    // carries an earlier run's attributes.
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const pending: { acquired?: Acquired } = {};
        // The body runs with the `sql.transaction` span current. A nested
        // transaction acquires nothing, so its span gets no attributes.
        const body = Effect.withFiber<A, E, R>((fiber) => {
          annotateAcquired(fiber, pending.acquired);
          return effect;
        });
        return withTransaction(body).pipe(Effect.provideService(TransactionAcquire, pending));
      }),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
