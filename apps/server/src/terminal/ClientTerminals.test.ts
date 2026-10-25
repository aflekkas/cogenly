import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@cogenly/contracts";
import type { PtyExitEvent, PtyProcess } from "@cogenly/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ProcessRunner from "../processRunner.ts";
import * as ClientTerminals from "./ClientTerminals.ts";
import * as Manager from "./Manager.ts";

class FakePty implements PtyProcess {
  readonly pid = 12345;
  readonly input: string[] = [];
  private data = (_data: string) => {};
  private exit = (_event: PtyExitEvent) => {};
  write(data: string) {
    this.input.push(data);
  }
  resize() {}
  kill() {}
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
  finish(exitCode: number) {
    this.exit({ exitCode, signal: null });
  }
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-client-terminals-test-" });
  const process = new FakePty();
  let spawns = 0;
  const manager = yield* Manager.makeWithOptions({
    logsDir: cwd,
    ptyAdapter: {
      spawn: () => {
        spawns += 1;
        return Effect.succeed(process);
      },
    },
    processKillGraceMs: 0,
    processTable: Effect.succeed([]),
    resolveProviderInstanceEnvironment: () => Effect.succeed({}),
  });
  return { cwd, process, manager, spawnCount: () => spawns };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.scoped,
  );

const onboardingOpen = (cwd: string) => ({
  threadId: ClientTerminals.ONBOARDING_THREAD_ID,
  terminalId: "onboarding-codex-0192c5c7-test",
  cwd,
  providerInstanceId: ProviderInstanceId.make("codex_work"),
});

it("sanitizeClientAttachInput drops every spawn and respawn signal", () => {
  expect(
    ClientTerminals.sanitizeClientAttachInput({
      threadId: "t",
      terminalId: "agent-1",
      cwd: "/tmp/project",
      worktreePath: "/tmp/project/.t3/worktrees/a",
      cols: 100,
      rows: 30,
      env: { CUSTOM_FLAG: "1" },
      restartIfNotRunning: true,
    }),
  ).toEqual({ threadId: "t", terminalId: "agent-1", cols: 100, rows: 30 });
});

it.effect("client open rejects a user shell without spawning", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, manager, spawnCount } = yield* make;
      const failure = yield* ClientTerminals.openTerminalForClient(manager.open, {
        threadId: "thread-1",
        terminalId: "term-1",
        cwd,
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("TerminalUserShellsDisabledError");
      expect(failure.message).toBe("User shells are disabled; terminals show agent runs only.");
      expect(spawnCount()).toBe(0);
    }),
  ),
);

it.effect("client open rejects onboarding ids outside the onboarding flow", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, manager, spawnCount } = yield* make;
      const onboarding = onboardingOpen(cwd);
      const failures = yield* Effect.forEach(
        [
          // Right prefix, wrong thread.
          { ...onboarding, threadId: "thread-1" },
          // Right thread, wrong prefix.
          { ...onboarding, terminalId: "term-1" },
          // Right shape but no provider instance binding.
          { ...onboarding, providerInstanceId: undefined },
        ],
        (input) => ClientTerminals.openTerminalForClient(manager.open, input).pipe(Effect.flip),
      );
      for (const failure of failures) {
        expect(failure._tag).toBe("TerminalUserShellsDisabledError");
      }
      expect(spawnCount()).toBe(0);
    }),
  ),
);

it.effect("client open allows the onboarding provider setup terminal", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, manager, spawnCount } = yield* make;
      const snapshot = yield* ClientTerminals.openTerminalForClient(
        manager.open,
        onboardingOpen(cwd),
      );
      expect(snapshot.terminalId).toBe("onboarding-codex-0192c5c7-test");
      expect(snapshot.status).toBe("running");
      expect(spawnCount()).toBe(1);
      yield* ClientTerminals.writeTerminalForClient(manager.write, {
        threadId: snapshot.threadId,
        terminalId: snapshot.terminalId,
        data: "codex login",
      });
    }),
  ),
);

it.effect("client attach never spawns a missing session", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, manager, spawnCount } = yield* make;
      const failure = yield* ClientTerminals.attachTerminalForClient(
        manager.attachStream,
        {
          threadId: "thread-1",
          terminalId: "term-1",
          cwd,
          restartIfNotRunning: true,
        },
        () => Effect.void,
      ).pipe(Effect.flip);
      expect(failure._tag).toBe("TerminalSessionLookupError");
      expect(spawnCount()).toBe(0);
    }),
  ),
);

it.effect("client attach reaches an existing agent session", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, manager, spawnCount } = yield* make;
      const started = yield* manager.runAgent({
        threadId: "thread-1",
        command: "echo hello",
        cwd,
        background: true,
      });
      // The runs view sends cwd alongside the ids; it must be ignored, not rejected.
      const unsubscribe = yield* ClientTerminals.attachTerminalForClient(
        manager.attachStream,
        { threadId: "thread-1", terminalId: started.terminalId, cwd },
        () => Effect.void,
      );
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
      expect(spawnCount()).toBe(1);
    }),
  ),
);

it.effect("client attach never respawns an exited non-agent session", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, process, manager, spawnCount } = yield* make;
      // A setup-script shell opened internally, then exited.
      const opened = yield* manager.open({ threadId: "thread-1", terminalId: "settle-1", cwd });
      expect(opened.status).toBe("running");
      process.finish(0);
      const unsubscribe = yield* ClientTerminals.attachTerminalForClient(
        manager.attachStream,
        {
          threadId: "thread-1",
          terminalId: "settle-1",
          cwd,
          restartIfNotRunning: true,
        },
        () => Effect.void,
      );
      unsubscribe();
      expect(spawnCount()).toBe(1);
    }),
  ),
);

it.effect("client restart is rejected for every session", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, manager, spawnCount } = yield* make;
      const started = yield* manager.runAgent({
        threadId: "thread-1",
        command: "echo hello",
        cwd,
        background: true,
      });
      yield* manager.open({ threadId: "thread-1", terminalId: "settle-1", cwd });
      const failures = yield* Effect.forEach(
        [
          { threadId: "thread-1", terminalId: started.terminalId, cwd, cols: 80, rows: 24 },
          { threadId: "thread-1", terminalId: "settle-1", cwd, cols: 80, rows: 24 },
        ],
        (input) => ClientTerminals.restartTerminalForClient(input).pipe(Effect.flip),
      );
      for (const failure of failures) {
        expect(failure._tag).toBe("TerminalUserShellsDisabledError");
      }
      expect(spawnCount()).toBe(2);
    }),
  ),
);

it.effect("client write stays allowed for agent input, rejected elsewhere", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, process, manager } = yield* make;
      const started = yield* manager.runAgent({
        threadId: "thread-1",
        command: "read answer",
        cwd,
        background: true,
      });
      yield* manager.open({ threadId: "thread-1", terminalId: "settle-1", cwd });
      yield* ClientTerminals.writeTerminalForClient(manager.write, {
        threadId: "thread-1",
        terminalId: started.terminalId,
        data: "yes\r",
      });
      expect(process.input).toEqual(["yes\r"]);
      const failure = yield* ClientTerminals.writeTerminalForClient(manager.write, {
        threadId: "thread-1",
        terminalId: "settle-1",
        data: "rm -rf /tmp/evil\r",
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("TerminalUserShellsDisabledError");
      expect(process.input).toEqual(["yes\r"]);
    }),
  ),
);
