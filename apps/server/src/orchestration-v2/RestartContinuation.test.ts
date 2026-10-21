import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import {
  isUnstartedRestartContinuation,
  restartContinuationRun,
  runReachedProvider,
} from "./RestartContinuation.ts";

const NOW = DateTime.makeUnsafe("2026-10-20T10:00:00.000Z");
const EARLIER = DateTime.makeUnsafe("2026-10-20T09:50:00.000Z");

const thread = () => ({
  id: "thread:test",
  providerInstanceId: "instance:a",
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  snoozedUntil: null,
});

const providerThread = (overrides: Record<string, unknown> = {}) => ({
  id: "provider-thread:a",
  appThreadId: "thread:test",
  providerInstanceId: "instance:a",
  providerSessionId: "session:a",
  ownerNodeId: null,
  driver: "codex",
  status: "active",
  nativeThreadRef: { nativeId: "native-1", strength: "strong", driver: "codex" },
  pendingBackgroundTasks: [],
  ...overrides,
});

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "session:a",
  providerInstanceId: "instance:a",
  driver: "codex",
  status: "ready",
  ...overrides,
});

const run = (overrides: Record<string, unknown> = {}) => ({
  id: "run:source",
  ordinal: 1,
  providerInstanceId: "instance:a",
  providerThreadId: "provider-thread:a",
  activeAttemptId: "attempt:1",
  status: "running",
  startedAt: EARLIER,
  completedAt: null,
  ...overrides,
});

const turn = (overrides: Record<string, unknown> = {}) => ({
  id: "turn:1",
  providerThreadId: "provider-thread:a",
  runAttemptId: "attempt:1",
  ordinal: 1,
  status: "running",
  ...overrides,
});

const projection = (overrides: Record<string, unknown> = {}) => ({
  thread: thread(),
  runs: [],
  attempts: [],
  providerThreads: [providerThread()],
  providerSessions: [session()],
  providerTurns: [],
  runtimeRequests: [],
  turnItems: [],
  ...overrides,
});

const selected = (overrides: Record<string, unknown> = {}) =>
  restartContinuationRun(projection(overrides) as never, NOW)?.id;

describe("restartContinuationRun", () => {
  it("continues a running turn that was cut mid-flight", () => {
    expect(selected({ runs: [run()], providerTurns: [turn()] })).toBe("run:source");
  });

  it("skips a running run whose provider turn already completed", () => {
    expect(
      selected({ runs: [run()], providerTurns: [turn({ status: "completed" })] }),
    ).toBeUndefined();
  });

  it("skips an unstarted continuation instead of chaining another marker", () => {
    // The second restart reads the first restart's continuation still
    // starting, its turn never begun. Recovery revives it; selecting it here
    // would stack a "resumed" marker per restart for a turn that never ran.
    const continuation = run({
      id: "run:c1",
      ordinal: 2,
      status: "starting",
      startedAt: null,
      restartContinuationOfRunId: "run:source",
    });
    expect(
      selected({
        runs: [run({ status: "cancelled", completedAt: EARLIER }), continuation],
        providerTurns: [turn({ status: "cancelled" })],
      }),
    ).toBeUndefined();
  });

  it("still continues a starting run with a genuinely live turn", () => {
    const continuation = run({
      id: "run:c1",
      ordinal: 2,
      status: "starting",
      startedAt: null,
      activeAttemptId: "attempt:c1",
      restartContinuationOfRunId: "run:source",
    });
    const live = turn({ id: "turn:c1", runAttemptId: "attempt:c1", status: "running" });
    expect(
      selected({
        runs: [run({ status: "cancelled", completedAt: EARLIER }), continuation],
        providerTurns: [live],
      }),
    ).toBe("run:c1");
  });

  it("never picks up a run that already has a continuation", () => {
    // A stuck-incomplete source sorts latest again once its continuation
    // settles. It was resumed already; a later restart must not repeat it.
    const continuation = run({
      id: "run:c1",
      ordinal: 2,
      status: "completed",
      startedAt: EARLIER,
      completedAt: EARLIER,
      restartContinuationOfRunId: "run:source",
    });
    expect(selected({ runs: [run(), continuation], providerTurns: [turn()] })).toBeUndefined();
  });

  it("skips settled runs with no awaited work", () => {
    expect(
      selected({
        runs: [run({ status: "completed", completedAt: EARLIER })],
        providerTurns: [turn({ status: "completed" })],
      }),
    ).toBeUndefined();
  });

  it("still wakes a settled run that lost awaited work", () => {
    const settled = run({ status: "completed", completedAt: EARLIER });
    const monitor = {
      id: "item:monitor",
      type: "dynamic_tool",
      status: "running",
      runId: settled.id,
      providerThreadId: "provider-thread:a",
      title: "watch",
      toolName: "Monitor",
      input: { persistent: true },
    };
    expect(
      selected({
        runs: [settled],
        providerTurns: [turn({ status: "completed" })],
        turnItems: [monitor],
      }),
    ).toBe("run:source");
  });

  it("skips terminal, queued and pre-start runs", () => {
    for (const status of [
      "queued",
      "preparing",
      "cancelled",
      "failed",
      "interrupted",
      "rolled_back",
    ]) {
      expect(
        selected({
          runs: [run({ status, completedAt: null })],
          providerTurns: [turn()],
        }),
        status,
      ).toBeUndefined();
    }
  });

  it("needs a live session and an active thread for a live turn", () => {
    expect(
      selected({
        runs: [run()],
        providerTurns: [turn()],
        providerSessions: [session({ status: "stopped" })],
      }),
    ).toBeUndefined();
    expect(
      selected({
        runs: [run()],
        providerTurns: [turn()],
        providerThreads: [providerThread({ status: "idle" })],
      }),
    ).toBeUndefined();
  });
});

describe("runReachedProvider", () => {
  const source = (overrides: Record<string, unknown> = {}) =>
    ({ id: "run:s", activeAttemptId: "attempt:1", startedAt: null, ...overrides }) as never;
  const attempts = [{ id: "attempt:1", runId: "run:s" }] as never;
  const turns = (entries: ReadonlyArray<Record<string, unknown>>) => entries as never;

  it("is true once the run started", () => {
    expect(runReachedProvider(source({ startedAt: EARLIER }), attempts, turns([]))).toBe(true);
  });

  it("is true when an attempt's turn ran or ended", () => {
    for (const status of ["running", "completed", "failed", "interrupted"]) {
      expect(
        runReachedProvider(source(), attempts, turns([{ runAttemptId: "attempt:1", status }])),
        status,
      ).toBe(true);
    }
  });

  it("is false for a run whose turn never began", () => {
    expect(runReachedProvider(source(), attempts, turns([]))).toBe(false);
    expect(
      runReachedProvider(
        source(),
        attempts,
        turns([{ runAttemptId: "attempt:1", status: "pending" }]),
      ),
    ).toBe(false);
    // Recovery also cancels rows that never went live, so `cancelled` alone
    // proves nothing.
    expect(
      runReachedProvider(
        source(),
        attempts,
        turns([{ runAttemptId: "attempt:1", status: "cancelled" }]),
      ),
    ).toBe(false);
    expect(
      runReachedProvider(
        source(),
        attempts,
        turns([{ runAttemptId: "attempt:other", status: "running" }]),
      ),
    ).toBe(false);
  });
});

describe("isUnstartedRestartContinuation", () => {
  const attempts = [{ id: "attempt:c1", runId: "run:c1" }] as never;
  const base = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "run:c1",
      status: "starting",
      activeAttemptId: "attempt:c1",
      startedAt: null,
      restartContinuationOfRunId: "run:s",
      ...overrides,
    }) as never;

  it("matches only starting continuations that never went live", () => {
    expect(isUnstartedRestartContinuation(base(), attempts, [])).toBe(true);
    expect(isUnstartedRestartContinuation(base({ status: "running" }), attempts, [])).toBe(false);
    expect(
      isUnstartedRestartContinuation(base({ restartContinuationOfRunId: undefined }), attempts, []),
    ).toBe(false);
    expect(isUnstartedRestartContinuation(base({ startedAt: EARLIER }), attempts, [])).toBe(false);
    expect(
      isUnstartedRestartContinuation(base(), attempts, [
        { runAttemptId: "attempt:c1", status: "completed" },
      ] as never),
    ).toBe(false);
  });
});
