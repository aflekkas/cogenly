import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { PtyExitEvent, PtyProcess } from "@cogenly/shared/PtyAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as AgentProcesses from "../process/AgentProcesses.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

const SHELL_PID = 12345;

class FakePty implements PtyProcess {
  readonly pid = SHELL_PID;
  private readonly onKill: () => void;
  constructor(onKill: () => void) {
    this.onKill = onKill;
  }
  write() {}
  resize() {}
  kill() {
    this.onKill();
  }
  onData() {
    return () => {};
  }
  onExit(_callback: (event: PtyExitEvent) => void) {
    return () => {};
  }
}

it.effect("settling a thread kills its agent command, the child and an escaped grandchild", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-cleanup-test-" });
    // The shell, its child in its group, a grandchild that called setsid, and
    // a process nobody tracked.
    const alive = new Map<number, AgentProcesses.ProcessRow>(
      [
        { pid: 10, ppid: 1, pgid: 10, startTime: "server" },
        { pid: SHELL_PID, ppid: 10, pgid: SHELL_PID, startTime: "shell" },
        { pid: 12346, ppid: SHELL_PID, pgid: SHELL_PID, startTime: "dev server" },
        { pid: 12347, ppid: 12346, pgid: 12347, startTime: "watcher" },
        { pid: 500, ppid: 1, pgid: 500, startTime: "untracked" },
      ].map((row) => [row.pid, row]),
    );
    const kill = (target: number) => {
      for (const row of alive.values()) {
        if (target < 0 ? row.pgid === -target : row.pid === target) alive.delete(row.pid);
      }
    };
    const { service: processes } = yield* AgentProcesses.make({
      statePath: path.join(cwd, "agent-processes.json"),
      selfPid: 10,
      graceMs: 0,
      readTable: Effect.sync(() => [...alive.values()]),
      signal: kill,
      killScope: () => Effect.void,
    });
    const terminals = yield* TerminalManager.makeWithOptions({
      logsDir: cwd,
      // The PTY kill reaches the shell's group, as node-pty's does.
      ptyAdapter: { spawn: () => Effect.succeed(new FakePty(() => kill(-SHELL_PID))) },
      processKillGraceMs: 0,
      processTable: Effect.succeed([]),
      processes,
    });
    const started = yield* terminals.runAgent({
      threadId: "T",
      command: "npm run dev",
      cwd,
      background: true,
    });
    // What the subprocess poll records while the command runs.
    yield* processes.observe({
      threadId: "T",
      terminalId: started.terminalId,
      pids: [SHELL_PID, 12346, 12347],
    });

    const cleanup = yield* ResourceCleanupService.ResourceCleanupService.pipe(
      Effect.provide(
        ResourceCleanupService.layer.pipe(
          Layer.provide(Layer.succeed(TerminalManager.TerminalManager, terminals)),
          Layer.provide(Layer.mock(PreviewManager.PreviewManager)({})),
          Layer.provide(ServerConfig.layerTest(cwd, { prefix: "cleanup" })),
        ),
      ),
      Effect.provideService(AgentProcesses.AgentProcesses, processes),
    );
    // The terminal.cleanup effect thread.settle queues, stamped when it committed.
    const settledAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 }));
    yield* cleanup.cleanupTerminals("T", true, settledAt);

    expect([...alive.keys()].toSorted((a, b) => a - b)).toEqual([10, 500]);
    expect((yield* terminals.listAgents("T"))[0]?.status).toBe("exited");
    expect((yield* processes.snapshot).reaped[0]).toMatchObject({
      threadId: "T",
      reason: "stopped",
    });
  }).pipe(
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.scoped,
  ),
);

it.effect("deleting an attachment also removes its extracted text sidecar", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
    const id = "cleanup-00000000-0000-4000-8000-000000000001-docx";
    const path = `${config.attachmentsDir}/${id}.docx`;
    yield* fs.writeFileString(path, "binary document");
    yield* fs.writeFileString(`${path}.txt`, "extracted text");
    yield* fs.writeFileString(`${config.attachmentsDir}/keep.txt`, "other attachment");
    yield* cleanup.cleanupAttachments([id]);
    expect(yield* fs.exists(path)).toBe(false);
    expect(yield* fs.exists(`${path}.txt`)).toBe(false);
    expect(yield* fs.readFileString(`${config.attachmentsDir}/keep.txt`)).toBe("other attachment");
  }).pipe(
    Effect.provide(
      ResourceCleanupService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(TerminalManager.TerminalManager)({}),
            Layer.mock(PreviewManager.PreviewManager)({}),
            Layer.mock(AgentProcesses.AgentProcesses)({}),
          ),
        ),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-sidecar-cleanup-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
