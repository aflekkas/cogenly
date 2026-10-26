// @effect-diagnostics nodeBuiltinImport:off -- the test needs a real detached process group to kill.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@cogenly/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentProcesses from "./AgentProcesses.ts";

const SERVER = { pid: 10, ppid: 1, pgid: 10, startTime: "server" };
const GRACE_MS = 2_000;

/**
 * A process table that signals act on: SIGTERM ends everything but the
 * stubborn PIDs, SIGKILL ends everything. A negative target is a group.
 */
function makeWorld(
  rows: ReadonlyArray<AgentProcesses.ProcessRow>,
  stubborn: ReadonlyArray<number> = [],
) {
  const alive = new Map(rows.map((row) => [row.pid, row]));
  const signals: Array<readonly [number, "SIGTERM" | "SIGKILL"]> = [];
  return {
    alive,
    signals,
    signalled: (pid: number) =>
      signals.some(([target]) => target === pid || target === -(alive.get(pid)?.pgid ?? NaN)),
    options: {
      selfPid: SERVER.pid,
      graceMs: GRACE_MS,
      readTable: Effect.sync(() => [...alive.values()]),
      signal: (target: number, signal: "SIGTERM" | "SIGKILL") => {
        signals.push([target, signal]);
        const victims = [...alive.values()].filter((row) =>
          target < 0 ? row.pgid === -target : row.pid === target,
        );
        for (const victim of victims) {
          if (signal === "SIGKILL" || !stubborn.includes(victim.pid)) alive.delete(victim.pid);
        }
      },
      killScope: () => Effect.void,
    },
  };
}

const tempStatePath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-agent-processes-" });
  return path.join(dir, "agent-processes.json");
});

/** Runs a kill past its SIGTERM grace on the test clock. */
const pastGrace = <A>(effect: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);
    yield* TestClock.adjust(GRACE_MS);
    return yield* Fiber.join(fiber);
  });

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect("stopping a command kills its child and a grandchild that left the group", () =>
  provide(
    Effect.gen(function* () {
      const world = makeWorld(
        [
          SERVER,
          { pid: 100, ppid: 10, pgid: 100, startTime: "root" },
          { pid: 101, ppid: 100, pgid: 100, startTime: "child" },
          // setsid'd: its own group, out of reach of a group kill.
          { pid: 102, ppid: 101, pgid: 102, startTime: "grandchild" },
          { pid: 200, ppid: 1, pgid: 200, startTime: "unrelated" },
        ],
        [101],
      );
      const { service } = yield* AgentProcesses.make({
        ...world.options,
        statePath: yield* tempStatePath,
      });
      yield* service.register({
        threadId: "T",
        terminalId: "agent-1",
        command: "npm run dev",
        pid: 100,
        keepRunning: false,
      });
      yield* service.observe({ threadId: "T", terminalId: "agent-1", pids: [100, 101, 102] });
      // The shell exits; its child and grandchild are re-parented to init.
      world.alive.delete(100);
      world.alive.set(101, { pid: 101, ppid: 1, pgid: 100, startTime: "child" });
      world.alive.set(102, { pid: 102, ppid: 1, pgid: 102, startTime: "grandchild" });

      const killed = yield* pastGrace(
        service.terminate({ threadId: "T", terminalId: "agent-1", reason: "stopped" }),
      );

      expect([...killed].toSorted()).toEqual([101, 102]);
      expect(world.alive.has(101)).toBe(false);
      expect(world.alive.has(102)).toBe(false);
      // The stubborn child ignored SIGTERM and got SIGKILL after the grace.
      expect(world.signals).toContainEqual([101, "SIGKILL"]);
      expect(world.alive.has(200)).toBe(true);
      expect(world.alive.has(SERVER.pid)).toBe(true);
      expect(world.signals.map(([target]) => target)).not.toContain(200);
      expect(world.signals.map(([target]) => target)).not.toContain(-200);
      expect(world.signals.map(([target]) => Math.abs(target))).not.toContain(SERVER.pid);
      const snapshot = yield* service.snapshot;
      expect(snapshot.processes).toEqual([]);
      expect(snapshot.reaped[0]).toMatchObject({ threadId: "T", reason: "stopped" });
    }),
  ),
);

it.effect("a reused PID or group is never signalled, nor an untracked process", () =>
  provide(
    Effect.gen(function* () {
      const world = makeWorld([
        SERVER,
        { pid: 100, ppid: 10, pgid: 100, startTime: "root" },
        { pid: 101, ppid: 100, pgid: 100, startTime: "child" },
      ]);
      const { service } = yield* AgentProcesses.make({
        ...world.options,
        statePath: yield* tempStatePath,
      });
      yield* service.register({
        threadId: "T",
        terminalId: "agent-1",
        command: "sleep",
        pid: 100,
        keepRunning: false,
      });
      yield* service.observe({ threadId: "T", terminalId: "agent-1", pids: [101] });
      // Everything exits; new, unrelated processes take the same PIDs and group.
      world.alive.clear();
      world.alive.set(SERVER.pid, SERVER);
      world.alive.set(100, { pid: 100, ppid: 1, pgid: 100, startTime: "someone else" });
      world.alive.set(101, { pid: 101, ppid: 100, pgid: 100, startTime: "someone else too" });
      world.alive.set(300, { pid: 300, ppid: 1, pgid: 300, startTime: "untracked" });

      const killed = yield* pastGrace(service.terminate({ threadId: "T", terminalId: "agent-1" }));

      expect(killed).toEqual([]);
      expect(world.signals).toEqual([]);
      expect([...world.alive.keys()].toSorted()).toEqual([10, 100, 101, 300]);
    }),
  ),
);

it.effect("restart cleanup kills only tracked trees and keeps kept ones as orphans", () =>
  provide(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const statePath = yield* tempStatePath;
      const record = (pid: number, startTime: string, keepRunning: boolean) => ({
        threadId: `thread-${pid}`,
        terminalId: `agent-${pid}`,
        kind: "terminal",
        command: `command ${pid}`,
        startedAt: "2026-10-25T00:00:00.000Z",
        keepRunning,
        root: { pid, startTime },
        pgid: pid,
        scopeUnit: null,
        descendants: [],
      });
      // What the previous server left in its state file.
      yield* fs.writeFileString(
        statePath,
        JSON.stringify({
          version: 1,
          records: [
            record(400, "dev", false),
            record(500, "kept", true),
            record(600, "gone", false),
          ],
          orphans: [],
          reaped: [],
        }),
      );
      const world = makeWorld([
        SERVER,
        { pid: 400, ppid: 1, pgid: 400, startTime: "dev" },
        { pid: 401, ppid: 400, pgid: 400, startTime: "dev child" },
        { pid: 500, ppid: 1, pgid: 500, startTime: "kept" },
        // PID 600 was reused by a process the old server never started.
        { pid: 600, ppid: 1, pgid: 600, startTime: "reused" },
        { pid: 700, ppid: 1, pgid: 700, startTime: "untracked" },
      ]);
      const built = yield* AgentProcesses.make({ ...world.options, statePath });

      const killed = yield* pastGrace(built.cleanupPreviousRun);

      expect([...killed].toSorted()).toEqual([400, 401]);
      expect([...world.alive.keys()].toSorted()).toEqual([10, 500, 600, 700]);
      const snapshot = yield* built.service.snapshot;
      expect(snapshot.processes.map((entry) => [entry.root.pid, entry.orphaned])).toEqual([
        [500, true],
      ]);
      expect(snapshot.reaped[0]).toMatchObject({ threadId: "thread-400", reason: "restart" });

      // Machine health's Fix kills the kept orphan too, and still nothing untracked.
      const fixed = yield* pastGrace(built.service.killOrphans);
      expect(fixed).toEqual([500]);
      expect([...world.alive.keys()].toSorted()).toEqual([10, 600, 700]);
      const targets = world.signals.map(([target]) => Math.abs(target));
      expect(targets).not.toContain(600);
      expect(targets).not.toContain(700);
    }),
  ),
);

it.effect("a thread's kept commands survive settle and stop, not archive", () =>
  provide(
    Effect.gen(function* () {
      const world = makeWorld([
        SERVER,
        { pid: 100, ppid: 10, pgid: 100, startTime: "plain" },
        { pid: 200, ppid: 10, pgid: 200, startTime: "kept" },
      ]);
      const { service } = yield* AgentProcesses.make({
        ...world.options,
        statePath: yield* tempStatePath,
      });
      for (const [pid, keepRunning] of [
        [100, false],
        [200, true],
      ] as const) {
        yield* service.register({
          threadId: "T",
          terminalId: `agent-${pid}`,
          command: "serve",
          pid,
          keepRunning,
        });
      }
      yield* pastGrace(
        service.terminateThread({ threadId: "T", includeKeepRunning: false, reason: "stopped" }),
      );
      expect([...world.alive.keys()].toSorted()).toEqual([10, 200]);
      yield* pastGrace(
        service.terminateThread({ threadId: "T", includeKeepRunning: true, reason: "stopped" }),
      );
      expect([...world.alive.keys()]).toEqual([10]);
    }),
  ),
);

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "a real command's child and grandchild die when it is terminated",
  () =>
    Effect.gen(function* () {
      const statePath = yield* tempStatePath;
      const live = yield* AgentProcesses.liveOptions;
      // A detached shell leads its own group, as a PTY shell does.
      const child = NodeChildProcess.spawn(
        "/bin/sh",
        // Each shell prints once its sleep is forked, so two lines mean all four run.
        ["-c", `sh -c 'sleep 1000 & echo a; wait' & sleep 1000 & echo b; wait`],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const rootPid = child.pid!;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(-rootPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }),
      );
      const ready = yield* Deferred.make<void>();
      const closed = yield* Deferred.make<void>();
      // Every process in the tree holds stdout; it closes once all of them exit.
      let printed = "";
      child.stdout.on("data", (chunk: Buffer) => {
        printed += chunk.toString();
        if (printed.includes("a") && printed.includes("b")) Deferred.doneUnsafe(ready, Effect.void);
      });
      child.stdout.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
      yield* Deferred.await(ready);

      const { service } = yield* AgentProcesses.make({ ...live, statePath, graceMs: 0 });
      yield* service.register({
        threadId: "T",
        terminalId: "agent-real",
        command: "sleep",
        pid: rootPid,
        keepRunning: false,
      });
      const table = yield* live.readTable;
      const tree = new Set([rootPid]);
      for (let grew = true; grew;) {
        grew = false;
        for (const row of table) {
          if (tree.has(row.ppid) && !tree.has(row.pid)) {
            tree.add(row.pid);
            grew = true;
          }
        }
      }
      // The root, its sh child, two sleeps: a child and a grandchild.
      expect(tree.size).toBe(4);
      yield* service.observe({ threadId: "T", terminalId: "agent-real", pids: [...tree] });

      const killed = yield* service.terminate({ threadId: "T", terminalId: "agent-real" });

      expect([...killed].toSorted()).toEqual([...tree].toSorted());
      yield* Deferred.await(closed);
      const after = new Set((yield* live.readTable).map((row) => row.pid));
      expect([...tree].filter((pid) => after.has(pid) && pid !== rootPid)).toEqual([]);
    }).pipe(
      Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);

it("parses ps lstart rows", () => {
  expect(
    AgentProcesses.parseProcessTable(
      "  101     1   101 Sun Oct 25 09:00:01 2026\n  102   101   101 Sun Oct  5 09:00:02 2026\n",
    ),
  ).toEqual([
    { pid: 101, ppid: 1, pgid: 101, startTime: "Sun Oct 25 09:00:01 2026" },
    { pid: 102, ppid: 101, pgid: 101, startTime: "Sun Oct 5 09:00:02 2026" },
  ]);
});
