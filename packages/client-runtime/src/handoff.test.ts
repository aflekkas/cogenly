import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type OrchestrationV2Run,
} from "@cogenly/contracts";
import * as DateTime from "effect/DateTime";

import { type PendingHandoffProjection, resolvePendingHandoff } from "./handoff.ts";

const sol = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
const codexThread = ProviderThreadId.make("provider-thread:codex");
const claudeThread = ProviderThreadId.make("provider-thread:claude");
const providers = [
  { instanceId: sol.instanceId, driver: ProviderDriverKind.make("codex") },
  { instanceId: opus.instanceId, driver: ProviderDriverKind.make("claudeAgent") },
];

type Run = PendingHandoffProjection["runs"][number];
const run = (
  modelSelection: typeof sol,
  providerThreadId: ProviderThreadId,
  status: OrchestrationV2Run["status"],
  started = status === "completed",
): Run => ({
  modelSelection,
  providerThreadId,
  status,
  startedAt: started ? DateTime.makeUnsafe("2026-10-23T00:00:00.000Z") : null,
});
const thread = (
  activeProviderThreadId: ProviderThreadId | null,
  runs: ReadonlyArray<Run>,
): PendingHandoffProjection => ({
  thread: { activeProviderThreadId },
  runs,
  visibleTurnItems: [{}],
});
const pending = (projection: PendingHandoffProjection, selection: typeof sol) =>
  resolvePendingHandoff(projection, selection, providers);

const onSol = thread(codexThread, [run(sol, codexThread, "completed")]);

describe("resolvePendingHandoff", () => {
  it("previews a switch before sending and drops it when the selection switches back", () => {
    expect(pending(onSol, opus)).toEqual({ from: [sol], to: opus });
    expect(pending(onSol, sol)).toBeNull();
  });

  it("stops previewing once the send dispatches, before its provider turn starts", () => {
    const starting = thread(claudeThread, [
      run(sol, codexThread, "completed"),
      run(opus, claudeThread, "starting"),
    ]);
    expect(pending(starting, opus)).toBeNull();
  });

  it("keeps the conversation on the switched provider after a stop before start", () => {
    const stopped = thread(claudeThread, [
      run(sol, codexThread, "completed"),
      run(opus, claudeThread, "interrupted"),
    ]);
    // The prepared handoff already reached that run; the next Opus send reuses it.
    expect(pending(stopped, opus)).toBeNull();
    // Going back to Sol hands the stopped turn back.
    expect(pending(stopped, sol)).toEqual({ from: [opus], to: sol });
  });

  it("shows the handoff as still pending when a restart cancelled the run before start", () => {
    const cancelled = thread(claudeThread, [
      run(sol, codexThread, "completed"),
      run(opus, claudeThread, "cancelled"),
    ]);
    expect(pending(cancelled, opus)).toEqual({ from: [sol], to: opus });
    expect(pending(cancelled, sol)).toBeNull();
  });

  it("ignores queued and rolled-back runs", () => {
    const queued = thread(codexThread, [
      run(sol, codexThread, "completed"),
      run(opus, claudeThread, "queued"),
    ]);
    expect(pending(queued, opus)).toEqual({ from: [sol], to: opus });
    const rolledBack = thread(codexThread, [
      run(sol, codexThread, "completed"),
      run(opus, codexThread, "rolled_back", true),
    ]);
    expect(pending(rolledBack, sol)).toBeNull();
  });

  it("previews nothing after the switched turn completes", () => {
    const completed = thread(claudeThread, [
      run(sol, codexThread, "completed"),
      run(opus, claudeThread, "completed"),
    ]);
    expect(pending(completed, opus)).toBeNull();
  });

  it("previews nothing between accounts that resume the same native thread", () => {
    const personal = { instanceId: ProviderInstanceId.make("codex_personal"), model: sol.model };
    const grouped = [
      { ...providers[0]!, continuation: { groupKey: "codex:home" } },
      {
        instanceId: personal.instanceId,
        driver: ProviderDriverKind.make("codex"),
        continuation: { groupKey: "codex:home" },
      },
    ];
    expect(resolvePendingHandoff(onSol, personal, grouped)).toBeNull();
  });
});
