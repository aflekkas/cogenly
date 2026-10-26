import {
  ThreadId,
  type ServerAgentProcessesResult,
  type ServerKillAgentProcessResult,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as AgentProcesses from "./AgentProcesses.ts";

/**
 * What Diagnostics, machine health and the reaper do with agent processes:
 * list them with their thread, and kill one command's whole tree.
 */
export class AgentProcessControl extends Context.Service<
  AgentProcessControl,
  {
    readonly list: Effect.Effect<ServerAgentProcessesResult>;
    readonly kill: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly reason?: AgentProcesses.AgentProcessReapReason;
    }) => Effect.Effect<ServerKillAgentProcessResult>;
    readonly killOrphans: Effect.Effect<ServerKillAgentProcessResult>;
  }
>()("cogenly-server/process/AgentProcessControl") {}

export const make = Effect.gen(function* () {
  const processes = yield* AgentProcesses.AgentProcesses;
  const terminals = yield* TerminalManager.TerminalManager;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const list: AgentProcessControl["Service"]["list"] = Effect.gen(function* () {
    const snapshot = yield* processes.snapshot;
    const titles = new Map<string, string | null>();
    for (const record of snapshot.processes) {
      if (titles.has(record.threadId)) continue;
      const shell = yield* projections
        .getThreadShell(ThreadId.make(record.threadId))
        .pipe(Effect.orElseSucceed(() => null));
      titles.set(record.threadId, shell?.title ?? null);
    }
    return {
      processes: snapshot.processes.map((record) => ({
        threadId: record.threadId,
        threadTitle: titles.get(record.threadId) ?? null,
        terminalId: record.terminalId,
        kind: record.kind,
        command: record.command,
        startedAt: record.startedAt,
        keepRunning: record.keepRunning,
        orphaned: record.orphaned,
        pids: record.pids,
      })),
      killed: snapshot.reaped,
    };
  });

  const kill: AgentProcessControl["Service"]["kill"] = Effect.fn("AgentProcessControl.kill")(
    function* (input) {
      const before = yield* processes.snapshot;
      const target = before.processes.find(
        (record) => record.threadId === input.threadId && record.terminalId === input.terminalId,
      );
      // Through the terminal first, so its session shows it exited; the ledger
      // alone covers a terminal that is already gone, or an orphan.
      yield* terminals.killAgent(input).pipe(Effect.ignore);
      const rest = yield* processes.terminate(input);
      return { pids: [...new Set([...(target?.pids ?? []), ...rest])] };
    },
  );

  const killOrphans = processes.killOrphans.pipe(Effect.map((pids) => ({ pids })));

  return AgentProcessControl.of({ list, kill, killOrphans });
});

export const layer = Layer.effect(AgentProcessControl, make);
