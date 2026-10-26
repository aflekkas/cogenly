import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@cogenly/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

/**
 * The ledger of process trees agents start, so stopping, settling, reaping and
 * restarts can kill exactly what an agent started and nothing else.
 *
 * Every kill goes through {@link killTargets}: a process is signalled only when
 * its PID still carries the start time recorded when it was tracked, and a
 * process group only when its leader is a verified ledger identity. Group
 * members are reached only through that verified leader, never by name.
 *
 * The ledger is written to the state directory, so the next server can clean
 * up what this one left behind after a crash or an update.
 */

/** A process as the kernel reports it: the PID plus its start time as identity. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** `ps -o lstart` text; with the PID it tells a process from a reused PID. */
  readonly startTime: string;
}

const ProcessIdentity = Schema.Struct({ pid: Schema.Number, startTime: Schema.String });
export type ProcessIdentity = typeof ProcessIdentity.Type;

const AgentProcessRecord = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  /**
   * `provider` is a provider CLI its session manager owns: stop, settle and
   * reaping leave it alone; only a restart's cleanup and an explicit kill end it.
   */
  kind: Schema.Literals(["terminal", "provider"]),
  command: Schema.String,
  startedAt: Schema.String,
  keepRunning: Schema.Boolean,
  root: ProcessIdentity,
  pgid: Schema.Number,
  /** The systemd scope the tree runs in on Linux; killing it reaches every descendant. */
  scopeUnit: Schema.NullOr(Schema.String),
  /** Captured from the unit and a verified member when registered. */
  scopeCgroup: Schema.optional(Schema.NullOr(Schema.String)),
  descendants: Schema.Array(ProcessIdentity),
});
export type AgentProcessRecord = typeof AgentProcessRecord.Type;

export const AgentProcessReapReason = Schema.Literals(["stopped", "idle", "restart", "orphan"]);
export type AgentProcessReapReason = typeof AgentProcessReapReason.Type;

const AgentProcessReap = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  command: Schema.String,
  pids: Schema.Array(Schema.Number),
  reason: AgentProcessReapReason,
  at: Schema.String,
});
export type AgentProcessReap = typeof AgentProcessReap.Type;

const LedgerFile = Schema.Struct({
  version: Schema.Literal(1),
  records: Schema.Array(AgentProcessRecord),
  /** Trees an earlier server left running, kept until they exit or are killed. */
  orphans: Schema.Array(AgentProcessRecord),
  reaped: Schema.Array(AgentProcessReap),
});
type LedgerFile = typeof LedgerFile.Type;
const decodeLedger = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerFile));
const encodeLedger = Schema.encodeSync(Schema.fromJsonString(LedgerFile));

export interface AgentProcessView extends AgentProcessRecord {
  /** Verified live PIDs of the tree, empty once it has exited. */
  readonly pids: ReadonlyArray<number>;
  readonly orphaned: boolean;
}

export interface AgentProcessesSnapshot {
  readonly processes: ReadonlyArray<AgentProcessView>;
  readonly reaped: ReadonlyArray<AgentProcessReap>;
}

export interface AgentProcessesShape {
  /** Records a freshly spawned tree. Its root PID's start time is read now. */
  readonly register: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly kind?: AgentProcessRecord["kind"] | undefined;
    readonly command: string;
    readonly pid: number;
    readonly scopeUnit?: string | null | undefined;
    readonly keepRunning: boolean;
  }) => Effect.Effect<void>;
  /** Adds descendants seen in the tree, so ones that leave its group can still be killed. */
  readonly observe: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly pids: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  /**
   * Kills the tree (SIGTERM, then SIGKILL after the grace period) and forgets
   * it. A reason records the kill in the reaped log. Returns the PIDs signalled.
   */
  readonly terminate: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly reason?: AgentProcessReapReason | undefined;
  }) => Effect.Effect<ReadonlyArray<number>>;
  /**
   * Kills every tree of the thread still in the ledger, including ones whose
   * terminal is gone. Kept trees stay unless included; ones started after
   * `before` stay.
   */
  readonly terminateThread: (input: {
    readonly threadId: string;
    readonly includeKeepRunning: boolean;
    readonly before?: string | undefined;
    readonly reason: AgentProcessReapReason;
  }) => Effect.Effect<ReadonlyArray<number>>;
  readonly setKeepRunning: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly keepRunning: boolean;
  }) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<AgentProcessesSnapshot>;
  /** Kills every tree an earlier server left running, including kept ones. */
  readonly killOrphans: Effect.Effect<ReadonlyArray<number>>;
}

const noop: AgentProcessesShape = {
  register: () => Effect.void,
  observe: () => Effect.void,
  terminate: () => Effect.succeed([]),
  terminateThread: () => Effect.succeed([]),
  setKeepRunning: () => Effect.void,
  snapshot: Effect.succeed({ processes: [], reaped: [] }),
  killOrphans: Effect.succeed([]),
};

export const AgentProcesses = Context.Reference<AgentProcessesShape>(
  "cogenly-server/process/AgentProcesses",
  { defaultValue: () => noop },
);

const MAX_DESCENDANTS = 256;
const MAX_REAPED = 50;
const DEFAULT_GRACE_MS = 2_000;

/**
 * What a kill may signal right now: the record's processes whose PID still has
 * the recorded start time, and the groups those verified processes lead. The
 * server, its own group and init are excluded. No extra PID is inferred here.
 */
export function killTargets(
  record: Pick<AgentProcessRecord, "root" | "pgid" | "descendants">,
  table: ReadonlyArray<ProcessRow>,
  selfPid: number,
): { readonly pids: ReadonlyArray<number>; readonly groups: ReadonlyArray<number> } {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const selfGroup = byPid.get(selfPid)?.pgid;
  const unsafe = (pid: number) => pid <= 1 || pid === selfPid || pid === selfGroup;
  const verified = new Map<number, ProcessRow>();
  for (const identity of [record.root, ...record.descendants]) {
    const row = byPid.get(identity.pid);
    if (row === undefined || row.startTime !== identity.startTime || unsafe(row.pid)) continue;
    if (verified.has(row.pid)) continue;
    verified.set(row.pid, row);
  }
  const groups = new Set<number>();
  for (const row of verified.values()) {
    if (row.pgid === row.pid) groups.add(row.pgid);
  }
  for (const group of groups) if (unsafe(group)) groups.delete(group);
  return { pids: [...verified.keys()], groups: [...groups] };
}

const LSTART_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/;

/** Parses `ps -A -o pid=,ppid=,pgid=,lstart=` output. */
export function parseProcessTable(stdout: string): ReadonlyArray<ProcessRow> {
  const rows: Array<ProcessRow> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = LSTART_ROW.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startTime: match[4]!.replace(/\s+/g, " "),
    });
  }
  return rows;
}

export interface AgentProcessesOptions {
  readonly statePath: string;
  readonly selfPid: number;
  readonly graceMs?: number;
  readonly readTable: Effect.Effect<ReadonlyArray<ProcessRow>>;
  /** Sends a signal; a negative target is a process group. Missing targets are ignored. */
  readonly signal: (target: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Returns the loaded unit's cgroup only when a verified PID belongs to it. */
  readonly scopeCgroup?: (
    unit: string,
    pids: ReadonlyArray<number>,
  ) => Effect.Effect<string | null>;
  readonly killScope: (unit: string, signal: "SIGTERM" | "SIGKILL") => Effect.Effect<void>;
}

const keyOf = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;

/**
 * Builds the ledger. Trees left in the state file by an earlier server are
 * loaded as orphans; call `cleanupPreviousRun` (the layer does) to kill the
 * ones not marked keep-running.
 */
export const make = Effect.fn("AgentProcesses.make")(function* (options: AgentProcessesOptions) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const writeLock = yield* Semaphore.make(1);

  const loaded = yield* fileSystem.readFileString(options.statePath).pipe(
    Effect.map((text) => decodeLedger(text)),
    Effect.orElseSucceed(() => undefined),
  );
  const previous = loaded?._tag === "Some" ? loaded.value : undefined;
  const records = new Map<string, AgentProcessRecord>();
  // Everything the earlier server tracked is now an orphan of this one.
  const orphans = new Map<string, AgentProcessRecord>(
    [...(previous?.orphans ?? []), ...(previous?.records ?? [])].map((record) => [
      keyOf(record.threadId, record.terminalId),
      record,
    ]),
  );
  let reaped: Array<AgentProcessReap> = [...(previous?.reaped ?? [])];
  const terminating = new Set<string>();

  const persist = writeLock.withPermit(
    Effect.gen(function* () {
      const file: LedgerFile = {
        version: 1,
        records: [...records.values()],
        orphans: [...orphans.values()],
        reaped,
      };
      yield* fileSystem.makeDirectory(path.dirname(options.statePath), { recursive: true });
      const temporary = `${options.statePath}.tmp`;
      yield* fileSystem.writeFileString(temporary, encodeLedger(file));
      yield* fileSystem.rename(temporary, options.statePath);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not save the agent process ledger", { cause }),
      ),
    ),
  );

  const signalAll = (
    record: AgentProcessRecord,
    targets: ReturnType<typeof killTargets>,
    signal: "SIGTERM" | "SIGKILL",
  ) =>
    Effect.gen(function* () {
      // A group can be reused while scope inspection or another signal runs.
      for (const group of targets.groups) {
        const current = killTargets(record, yield* options.readTable, options.selfPid);
        if (current.groups.includes(group)) options.signal(-group, signal);
      }
      const current = killTargets(record, yield* options.readTable, options.selfPid);
      for (const pid of targets.pids) if (current.pids.includes(pid)) options.signal(pid, signal);
    });

  const signalScope = (record: AgentProcessRecord, signal: "SIGTERM" | "SIGKILL") =>
    Effect.gen(function* () {
      if (!record.scopeUnit || !record.scopeCgroup || !options.scopeCgroup) return;
      const current = killTargets(record, yield* options.readTable, options.selfPid);
      if (current.pids.length === 0) return;
      const cgroup = yield* options.scopeCgroup(record.scopeUnit, current.pids);
      if (cgroup !== record.scopeCgroup) return;
      const refreshed = killTargets(record, yield* options.readTable, options.selfPid);
      if (current.pids.some((pid) => refreshed.pids.includes(pid)))
        yield* options.killScope(record.scopeUnit, signal);
    });

  const killRecord = Effect.fn("AgentProcesses.killRecord")(function* (record: AgentProcessRecord) {
    const first = killTargets(record, yield* options.readTable, options.selfPid);
    if (first.pids.length === 0) return [];
    yield* signalScope(record, "SIGTERM");
    yield* signalAll(record, first, "SIGTERM");
    yield* Effect.sleep(graceMs);
    const second = killTargets(record, yield* options.readTable, options.selfPid);
    yield* signalScope(record, "SIGKILL");
    yield* signalAll(record, second, "SIGKILL");
    return first.pids;
  });

  const recordReap = (
    record: AgentProcessRecord,
    pids: ReadonlyArray<number>,
    reason: AgentProcessReapReason,
  ) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      reaped = [
        {
          threadId: record.threadId,
          terminalId: record.terminalId,
          command: record.command,
          pids: [...pids],
          reason,
          at,
        },
        ...reaped,
      ].slice(0, MAX_REAPED);
      yield* Effect.logInfo("Killed agent processes", {
        threadId: record.threadId,
        terminalId: record.terminalId,
        reason,
        pids,
      });
    });

  const identities = (pids: ReadonlyArray<number>) =>
    Effect.map(options.readTable, (table) => {
      const wanted = new Set(pids);
      return table.filter((row) => wanted.has(row.pid));
    });

  const register: AgentProcessesShape["register"] = Effect.fn("AgentProcesses.register")(
    function* (input) {
      const [row] = yield* identities([input.pid]);
      // A root that is gone before it was read has nothing left to track.
      if (row === undefined) return;
      const startedAt = DateTime.formatIso(yield* DateTime.now);
      const scopeCgroup =
        input.scopeUnit && options.scopeCgroup
          ? yield* options.scopeCgroup(input.scopeUnit, [row.pid])
          : null;
      records.set(keyOf(input.threadId, input.terminalId), {
        threadId: input.threadId,
        terminalId: input.terminalId,
        kind: input.kind ?? "terminal",
        command: input.command.slice(0, 2_048),
        startedAt,
        keepRunning: input.keepRunning,
        root: { pid: row.pid, startTime: row.startTime },
        pgid: row.pgid,
        scopeUnit: input.scopeUnit ?? null,
        scopeCgroup,
        descendants: [],
      });
      yield* persist;
    },
  );

  const observe: AgentProcessesShape["observe"] = Effect.fn("AgentProcesses.observe")(
    function* (input) {
      const key = keyOf(input.threadId, input.terminalId);
      const record = records.get(key);
      if (record === undefined) return;
      const known = new Set([record.root.pid, ...record.descendants.map((entry) => entry.pid)]);
      const fresh = input.pids.filter((pid) => !known.has(pid));
      if (fresh.length === 0) return;
      const rows = yield* identities(fresh);
      if (rows.length === 0) return;
      const current = records.get(key);
      if (current === undefined) return;
      records.set(key, {
        ...current,
        descendants: [
          ...current.descendants,
          ...rows.map((row) => ({ pid: row.pid, startTime: row.startTime })),
        ].slice(-MAX_DESCENDANTS),
      });
      yield* persist;
    },
  );

  const terminate: AgentProcessesShape["terminate"] = Effect.fn("AgentProcesses.terminate")(
    function* (input) {
      const key = keyOf(input.threadId, input.terminalId);
      const record = records.get(key) ?? orphans.get(key);
      // A kill already under way finishes on its own.
      if (record === undefined || terminating.has(key)) return [];
      terminating.add(key);
      const pids = yield* killRecord(record).pipe(
        Effect.ensuring(Effect.sync(() => terminating.delete(key))),
      );
      records.delete(key);
      orphans.delete(key);
      if (input.reason !== undefined && pids.length > 0)
        yield* recordReap(record, pids, input.reason);
      yield* persist;
      return pids;
    },
    // Once started, a kill finishes its SIGKILL even if the caller is cancelled.
    Effect.uninterruptible,
  );

  const terminateThread: AgentProcessesShape["terminateThread"] = Effect.fn(
    "AgentProcesses.terminateThread",
  )(function* (input) {
    const matching = [...records.values(), ...orphans.values()].filter(
      (record) =>
        record.threadId === input.threadId &&
        record.kind === "terminal" &&
        (input.includeKeepRunning || !record.keepRunning) &&
        (input.before === undefined || record.startedAt <= input.before),
    );
    const killed = yield* Effect.forEach(
      matching,
      (record) =>
        terminate({
          threadId: record.threadId,
          terminalId: record.terminalId,
          reason: input.reason,
        }),
      { concurrency: "unbounded" },
    );
    return killed.flat();
  });

  const setKeepRunning: AgentProcessesShape["setKeepRunning"] = (input) =>
    Effect.gen(function* () {
      const key = keyOf(input.threadId, input.terminalId);
      const record = records.get(key);
      if (record === undefined || record.keepRunning === input.keepRunning) return;
      records.set(key, { ...record, keepRunning: input.keepRunning });
      yield* persist;
    });

  // Lists live trees and forgets ones that have fully exited.
  const snapshot: AgentProcessesShape["snapshot"] = Effect.gen(function* () {
    const table = yield* options.readTable;
    const views: Array<AgentProcessView> = [];
    let pruned = false;
    for (const [map, orphaned] of [
      [records, false],
      [orphans, true],
    ] as const) {
      for (const [key, record] of map) {
        const pids = killTargets(record, table, options.selfPid).pids;
        if (pids.length === 0) {
          map.delete(key);
          pruned = true;
          continue;
        }
        views.push({ ...record, pids, orphaned });
      }
    }
    if (pruned) yield* persist;
    return { processes: views, reaped };
  });

  const killOrphanSet = (keep: (record: AgentProcessRecord) => boolean) =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const table = yield* options.readTable;
      for (const [key, record] of orphans) {
        // An orphan whose processes are all gone needs no kill.
        const live = killTargets(record, table, options.selfPid);
        if (live.pids.length === 0 && live.groups.length === 0 && record.scopeUnit === null) {
          orphans.delete(key);
          continue;
        }
        if (keep(record)) continue;
        const pids = yield* killRecord(record);
        orphans.delete(key);
        if (pids.length > 0) {
          killed.push(...pids);
          yield* recordReap(record, pids, keep === keepNone ? "orphan" : "restart");
        }
      }
      yield* persist;
      return killed;
    });
  const keepNone = () => false;

  return {
    service: AgentProcesses.of({
      register,
      observe,
      terminate,
      terminateThread,
      setKeepRunning,
      snapshot,
      killOrphans: killOrphanSet(keepNone).pipe(Effect.uninterruptible),
    }),
    /** Kills what an earlier server left, sparing trees marked keep-running. */
    cleanupPreviousRun: killOrphanSet((record) => record.keepRunning).pipe(Effect.uninterruptible),
  };
});

const isMissingProcess = (error: unknown) =>
  error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM");

/** The real process table, signals and systemd scope kills, on macOS and Linux. */
export const liveOptions = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const fileSystem = yield* FileSystem.FileSystem;
  const readTable = runner
    .run({
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      env: { LC_ALL: "C" },
      timeout: "5 seconds",
      maxOutputBytes: 8 * 1024 * 1024,
    })
    .pipe(
      Effect.map((result) => parseProcessTable(result.stdout)),
      // An empty table verifies nothing, so a failed read kills nothing.
      Effect.catch((cause) =>
        Effect.logWarning("Could not read the process table", { cause }).pipe(Effect.as([])),
      ),
    );
  return {
    selfPid: process.pid,
    readTable,
    signal: (target: number, signal: "SIGTERM" | "SIGKILL") => {
      try {
        process.kill(target, signal);
      } catch (error) {
        if (!isMissingProcess(error)) throw error;
      }
    },
    scopeCgroup: (unit: string, pids: ReadonlyArray<number>) =>
      Effect.gen(function* () {
        if (platform !== "linux" || !/^cogenly-[a-zA-Z0-9_-]+\.scope$/.test(unit)) return null;
        const shown = yield* runner.run({
          command: "systemctl",
          args: ["--user", "show", "--property=LoadState,ControlGroup", unit],
          timeout: "5 seconds",
        });
        if (shown.code !== 0) return null;
        const values = new Map(
          shown.stdout
            .trim()
            .split("\n")
            .map((line) => {
              const index = line.indexOf("=");
              return [line.slice(0, index), line.slice(index + 1)] as const;
            }),
        );
        const cgroup = values.get("ControlGroup");
        if (values.get("LoadState") !== "loaded" || !cgroup?.endsWith(`/${unit}`)) return null;
        for (const pid of pids) {
          const membership = yield* fileSystem
            .readFileString(`/proc/${pid}/cgroup`)
            .pipe(Effect.orElseSucceed(() => ""));
          if (membership.split("\n").some((line) => line === `0::${cgroup}`)) return cgroup;
        }
        return null;
      }).pipe(Effect.orElseSucceed(() => null)),
    killScope: (unit: string, signal: "SIGTERM" | "SIGKILL") =>
      platform === "linux"
        ? runner
            .run({
              command: "systemctl",
              args: ["--user", "kill", `--signal=${signal}`, "--kill-whom=all", unit],
              timeout: "5 seconds",
            })
            .pipe(Effect.ignore)
        : Effect.void,
  } satisfies Omit<AgentProcessesOptions, "statePath">;
});

export const layer = Layer.effect(
  AgentProcesses,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    if (platform === "win32") return noop;
    const built = yield* make({
      ...(yield* liveOptions),
      statePath: path.join(stateDir, "agent-processes.json"),
    });
    yield* built.cleanupPreviousRun.pipe(
      Effect.tap((pids) =>
        pids.length > 0
          ? Effect.logWarning("Killed agent processes left by a previous server", { pids })
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    return built.service;
  }),
).pipe(Layer.provide(ProcessRunner.layer));
