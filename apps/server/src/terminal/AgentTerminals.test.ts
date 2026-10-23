import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";
import type { PtyProcess, PtyExitEvent } from "@t3tools/shared/PtyAdapter";
import * as ProcessRunner from "../processRunner.ts";
import * as Manager from "./Manager.ts";
import * as NodePtyAdapter from "./NodePtyAdapter.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

class FakePty implements PtyProcess {
  readonly pid = 12345;
  readonly signals: Array<string | undefined> = [];
  readonly input: string[] = [];
  private data = (_data: string) => {};
  private exit = (_event: PtyExitEvent) => {};
  write(data: string) {
    this.input.push(data);
  }
  resize() {}
  kill(signal?: string) {
    this.signals.push(signal);
  }
  onData(callback: (data: string) => void) {
    this.data = callback;
    return () => {
      this.data = () => {};
    };
  }
  onExit(callback: (event: PtyExitEvent) => void) {
    this.exit = callback;
    return () => {
      this.exit = () => {};
    };
  }
  output(data: string) {
    this.data(data);
  }
  finish(exitCode: number) {
    this.exit({ exitCode, signal: null });
  }
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-terminal-test-" });
  const process = new FakePty();
  const manager = yield* Manager.makeWithOptions({
    logsDir: cwd,
    ptyAdapter: { spawn: () => Effect.succeed(process) },
    processKillGraceMs: 0,
    processTable: Effect.succeed([]),
  });
  return { cwd, process, manager };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.scoped,
  );

it.effect(
  "background run streams output, reads incremental output, writes input and kills only its owner",
  () =>
    provide(
      Effect.gen(function* () {
        const { cwd, process, manager } = yield* make;
        const seen = yield* Deferred.make<void>();
        yield* manager.subscribe((event) =>
          event.type === "output"
            ? Deferred.succeed(seen, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        const started = yield* manager.runAgent({
          threadId: "A",
          command: "echo hello",
          cwd,
          background: true,
        });
        expect(started.status).toBe("running");
        expect((yield* manager.listAgents("A"))[0]?.label).toContain("agent · echo hello");
        expect(yield* manager.listAgents("B")).toEqual([]);
        expect(
          (yield* manager
            .readAgent({ threadId: "B", terminalId: started.terminalId })
            .pipe(Effect.flip))._tag,
        ).toBe("TerminalSessionLookupError");
        expect(
          (yield* manager
            .killAgent({ threadId: "B", terminalId: started.terminalId })
            .pipe(Effect.flip))._tag,
        ).toBe("TerminalSessionLookupError");
        expect(process.signals).toEqual([]);
        process.output("hello\r\n");
        yield* Deferred.await(seen);
        const output = yield* manager.readAgent({ threadId: "A", terminalId: started.terminalId });
        expect(output.output).toBe("hello\r\n");
        expect(
          (yield* manager.readAgent({
            threadId: "A",
            terminalId: started.terminalId,
            sinceOffset: output.nextOffset,
          })).output,
        ).toBe("");
        yield* manager.write({ threadId: "A", terminalId: started.terminalId, data: "yes\r" });
        expect(process.input).toEqual(["yes\r"]);
        yield* manager.killAgent({ threadId: "A", terminalId: started.terminalId });
        expect(process.signals).toContain("SIGKILL");
        expect(
          (yield* manager.readAgent({ threadId: "A", terminalId: started.terminalId })).status,
        ).toBe("exited");
      }),
    ),
);

it.effect("an agent run's summary carries its whole command past the label's cap", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, manager } = yield* make;
      const command = `export PATH="$PWD/node_modules/.bin:$PATH"\ncd apps/web && vp test run ${"packages/client-runtime/src/preview/serverBrowserStream.test.ts ".repeat(3).trim()}`;
      yield* manager.runAgent({ threadId: "A", command, cwd, background: true });
      const [listed] = yield* manager.listAgents("A");
      expect(listed?.label.length).toBeLessThanOrEqual(128);
      expect(listed?.command).toBe(command);
    }),
  ),
);

it.effect("foreground timeout kills the command and preserves output", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, process, manager } = yield* make;
      const started = yield* Deferred.make<void>();
      yield* manager.subscribe((event) =>
        event.type === "started"
          ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      const result = yield* manager
        .runAgent({ threadId: "A", command: "sleep 1000", cwd, timeoutMs: 50 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(50);
      const ended = yield* Fiber.join(result);
      expect(ended.timedOut).toBe(true);
      expect(ended.status).toBe("exited");
      expect(process.signals).toContain("SIGKILL");
    }),
  ),
);

it.live("settle cleanup kills both sleeps in an owned PTY process group", () =>
  provide(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-terminal-tree-" });
      const adapter = yield* PtyAdapter.PtyAdapter;
      const manager = yield* Manager.makeWithOptions({
        logsDir: cwd,
        ptyAdapter: adapter,
        processKillGraceMs: 30,
        processTable: Effect.succeed([]),
      });
      const children = yield* Deferred.make<ReadonlyArray<number>>();
      let text = "";
      yield* manager.subscribe((event) =>
        Effect.gen(function* () {
          if (event.type !== "output") return;
          text += event.data;
          const match = /CHILD:(\d+),(\d+)/u.exec(text);
          if (match) yield* Deferred.succeed(children, [Number(match[1]), Number(match[2])]);
        }),
      );
      yield* manager.runAgent({
        threadId: "A",
        command: "sh -c 'sleep 1000 & a=$!; sleep 1000 & b=$!; echo CHILD:$a,$b; wait'",
        cwd,
        background: true,
      });
      const pids = yield* Deferred.await(children);
      for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
      yield* manager.stopAgents("A");
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(Effect.provide(NodePtyAdapter.layer)),
  ),
);

it.effect("foreground timeout returns even when an exited listener never completes", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, manager } = yield* make;
      const started = yield* Deferred.make<void>();
      const never = yield* Deferred.make<void>();
      yield* manager.subscribe((event) =>
        event.type === "started"
          ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
          : event.type === "exited"
            ? Deferred.await(never).pipe(Effect.asVoid)
            : Effect.void,
      );
      const result = yield* manager
        .runAgent({ threadId: "A", command: "sleep 1000", cwd, timeoutMs: 50 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(50);
      // Covers the kill grace cap as well; the call must still return.
      yield* TestClock.adjust(10_000);
      const ended = result.pollUnsafe();
      expect(ended?._tag).toBe("Success");
      if (ended?._tag === "Success") {
        expect(ended.value.timedOut).toBe(true);
        expect(ended.value.status).toBe("exited");
        expect(ended.value.notice).toContain("background=true");
      }
    }),
  ),
);

it.live("foreground timeout kills a SIGTERM-ignoring command and its child", () =>
  provide(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-terminal-term-" });
      const adapter = yield* PtyAdapter.PtyAdapter;
      const manager = yield* Manager.makeWithOptions({
        logsDir: cwd,
        ptyAdapter: adapter,
        processKillGraceMs: 50,
        processTable: Effect.succeed([]),
      });
      const children = yield* Deferred.make<ReadonlyArray<number>>();
      let text = "";
      yield* manager.subscribe((event) =>
        Effect.gen(function* () {
          if (event.type !== "output") return;
          text += event.data;
          const match = /CHILD:(\d+)/u.exec(text);
          if (match) yield* Deferred.succeed(children, [Number(match[1])]);
        }),
      );
      const startedAt = Date.now();
      const result = yield* manager.runAgent({
        threadId: "A",
        command: "trap '' TERM; sleep 1000 & echo CHILD:$!; wait",
        cwd,
        timeoutMs: 300,
      });
      const elapsed = Date.now() - startedAt;
      expect(result.timedOut).toBe(true);
      expect(result.status).toBe("exited");
      expect(result.notice).toContain("background=true");
      expect(elapsed).toBeLessThan(5_000);
      const pids = yield* Deferred.await(children);
      yield* Effect.sleep(200);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(Effect.provide(NodePtyAdapter.layer)),
  ),
);

it.effect("foreground returns exit status and bounded head/tail output", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, process, manager } = yield* make;
      const started = yield* Deferred.make<void>();
      yield* manager.subscribe((event) =>
        event.type === "started"
          ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      const result = yield* manager
        .runAgent({ threadId: "A", command: "produce-output", cwd })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      process.output("H".repeat(8_000) + "X".repeat(100_000) + "T".repeat(24_000));
      process.finish(7);
      const ended = yield* Fiber.join(result);
      expect(ended.exitCode).toBe(7);
      expect(ended.timedOut).toBe(false);
      expect(ended.output.startsWith("H".repeat(8_000))).toBe(true);
      expect(ended.output.endsWith("T".repeat(24_000))).toBe(true);
      expect(ended.output).toContain("100000 characters omitted");
    }),
  ),
);

it.effect("shutdown kills active agent PTYs and completes pending group cleanup", () =>
  provide(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { cwd, process, manager } = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.runAgent({ threadId: "A", command: "sleep 1000", cwd, background: true });
      yield* Scope.close(scope, Exit.void);
      expect(process.signals).toContain("SIGTERM");
      expect(process.signals).toContain("SIGKILL");
    }),
  ),
);

it.effect("stale agent tabs cannot spawn shells on attach or restart after a server restart", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, process, manager } = yield* make;
      const identity = { threadId: "A", terminalId: "agent-stale" };
      expect((yield* manager.open({ ...identity, cwd }).pipe(Effect.flip))._tag).toBe(
        "TerminalSessionLookupError",
      );
      expect(
        (yield* manager.attachStream({ ...identity, cwd }, () => Effect.void).pipe(Effect.flip))
          ._tag,
      ).toBe("TerminalSessionLookupError");
      expect(
        (yield* manager.restart({ ...identity, cwd, cols: 80, rows: 24 }).pipe(Effect.flip))._tag,
      ).toBe("TerminalSessionLookupError");
      expect(yield* manager.listAgents("A")).toEqual([]);
      expect(process.signals).toEqual([]);
    }),
  ),
);

it.effect("an evicted finished run replays its persisted log on attach without spawning", () =>
  provide(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-terminal-test-" });
      let spawns = 0;
      let process = new FakePty();
      const manager = yield* Manager.makeWithOptions({
        logsDir: cwd,
        ptyAdapter: {
          spawn: () =>
            Effect.sync(() => {
              spawns += 1;
              process = new FakePty();
              return process;
            }),
        },
        processKillGraceMs: 0,
        processTable: Effect.succeed([]),
        // Only the newest finished session stays in memory.
        maxRetainedInactiveSessions: 1,
      });
      const exited = yield* Queue.unbounded<string>();
      yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Queue.offer(exited, event.terminalId).pipe(Effect.asVoid)
          : Effect.void,
      );
      const finish = (command: string, output: string) =>
        Effect.gen(function* () {
          const run = yield* manager.runAgent({ threadId: "A", command, cwd, background: true });
          if (output) process.output(output);
          process.finish(0);
          expect(yield* Queue.take(exited)).toBe(run.terminalId);
          return run.terminalId;
        });

      const first = yield* finish("echo done", "done\r\n");
      // Lets the debounced history write land, and makes the next run newer.
      yield* TestClock.adjust(1_000);
      yield* finish("echo next", "");
      // The first run's session was evicted from memory, but a client may still list it.
      expect((yield* manager.listAgents("A")).map((run) => run.terminalId)).not.toContain(first);

      const identity = { threadId: "A", terminalId: first };
      const attached: Array<string> = [];
      yield* manager.attachStream(identity, (event) =>
        Effect.sync(() => {
          if (event.type === "snapshot") {
            attached.push(`${event.snapshot.status}:${event.snapshot.history}`);
          }
        }),
      );
      const observed: Array<string> = [];
      yield* manager.observeStream(identity, (event) =>
        Effect.sync(() => {
          if (event.type === "snapshot") observed.push(event.snapshot.history);
        }),
      );
      expect(attached).toEqual(["exited:done\r\n"]);
      expect(observed).toEqual(["done\r\n"]);
      expect(spawns).toBe(2);

      // A run that left no log has nothing to replay.
      expect(
        (yield* manager
          .attachStream({ threadId: "A", terminalId: "agent-silent" }, () => Effect.void)
          .pipe(Effect.flip))._tag,
      ).toBe("TerminalSessionLookupError");
    }),
  ),
);
