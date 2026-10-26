import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { IDLE_REAP_AFTER_MS, reapReason } from "./AgentProcessReaper.ts";

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-25T12:00:00.000Z"));
const at = (ms: number) => DateTime.makeUnsafe(ms);
const iso = (ms: number) => DateTime.formatIso(at(ms));

const record = {
  kind: "terminal" as const,
  keepRunning: false,
  orphaned: false,
  startedAt: iso(NOW - IDLE_REAP_AFTER_MS - 60_000),
};

const idleShell = {
  archivedAt: null,
  settledOverride: null,
  activeRunId: null,
  latestRunCompletedAt: at(NOW - IDLE_REAP_AFTER_MS - 1),
  latestUserMessageAt: null,
  lastVisitedAt: null,
} as const;

describe("reapReason", () => {
  it("reaps a dev server left by a thread idle past the threshold", () => {
    expect(reapReason(record, idleShell, NOW)).toBe("idle");
  });

  it("respects keep running however idle, settled or archived the thread is", () => {
    const kept = { ...record, keepRunning: true };
    expect(reapReason(kept, idleShell, NOW)).toBeNull();
    expect(reapReason(kept, { ...idleShell, settledOverride: "settled" }, NOW)).toBeNull();
    expect(reapReason(kept, { ...idleShell, archivedAt: at(NOW) }, NOW)).toBeNull();
    expect(reapReason(kept, null, NOW)).toBeNull();
  });

  it("keeps a live turn's processes even when its thread is settled or archived", () => {
    const active = { ...idleShell, activeRunId: "run-live" as never };
    expect(reapReason(record, { ...active, settledOverride: "settled" }, NOW)).toBeNull();
    expect(reapReason(record, { ...active, archivedAt: at(NOW) }, NOW)).toBeNull();
  });

  it("reaps commands of settled, archived and deleted threads at once", () => {
    const fresh = { ...record, startedAt: iso(NOW) };
    expect(reapReason(fresh, { ...idleShell, settledOverride: "settled" }, NOW)).toBe("stopped");
    expect(reapReason(fresh, { ...idleShell, archivedAt: at(NOW) }, NOW)).toBe("stopped");
    expect(reapReason(fresh, null, NOW)).toBe("stopped");
  });

  it("keeps commands while the thread works or someone recently looked at it", () => {
    expect(reapReason(record, { ...idleShell, activeRunId: "run-1" as never }, NOW)).toBeNull();
    expect(reapReason(record, { ...idleShell, lastVisitedAt: at(NOW - 60_000) }, NOW)).toBeNull();
    expect(
      reapReason(record, { ...idleShell, latestUserMessageAt: at(NOW - 60_000) }, NOW),
    ).toBeNull();
  });

  it("leaves orphans to machine health and provider CLIs to their session manager", () => {
    expect(reapReason({ ...record, orphaned: true }, null, NOW)).toBeNull();
    expect(reapReason({ ...record, kind: "provider" }, null, NOW)).toBeNull();
  });
});
