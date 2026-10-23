import { describe, expect, it } from "@effect/vitest";

import {
  EXTEND_TIMEOUT_USEC,
  LauncherNotifier,
  launcherNotifyEnabled,
  launcherNotifyMessages,
  WATCHDOG_PING_INTERVAL_MS,
} from "./serviceLauncher.ts";

describe("launcher sd_notify decisions", () => {
  it("extends the start timeout while a child starts, before READY", () => {
    expect(launcherNotifyMessages("starting", false)).toEqual([
      `EXTEND_TIMEOUT_USEC=${EXTEND_TIMEOUT_USEC}`,
    ]);
  });

  it("pings the watchdog while a child starts after READY was already sent", () => {
    expect(launcherNotifyMessages("starting", true)).toEqual(["WATCHDOG=1"]);
  });

  it("pings the watchdog while running", () => {
    expect(launcherNotifyMessages("running", true)).toEqual(["WATCHDOG=1"]);
    expect(launcherNotifyMessages("running", false)).toEqual(["WATCHDOG=1"]);
  });

  it("sends READY when idling with no child that could send it", () => {
    expect(launcherNotifyMessages("idle", false)).toEqual(["READY=1", "WATCHDOG=1"]);
    expect(launcherNotifyMessages("idle", true)).toEqual(["WATCHDOG=1"]);
  });

  it("extends timeouts and pings during long operations (backup, migration, handoff)", () => {
    expect(launcherNotifyMessages("long-operation", true)).toEqual([
      `EXTEND_TIMEOUT_USEC=${EXTEND_TIMEOUT_USEC}`,
      "WATCHDOG=1",
    ]);
    expect(launcherNotifyMessages("long-operation", false)).toEqual([
      `EXTEND_TIMEOUT_USEC=${EXTEND_TIMEOUT_USEC}`,
      "WATCHDOG=1",
    ]);
  });

  it("pings well within the 60 second watchdog window", () => {
    expect(WATCHDOG_PING_INTERVAL_MS).toBeLessThan(60_000);
    expect(EXTEND_TIMEOUT_USEC).toBeGreaterThan(60_000_000);
  });

  it("only notifies on Linux with a notify socket", () => {
    expect(launcherNotifyEnabled("linux", "/run/user/1000/systemd/notify")).toBe(true);
    expect(launcherNotifyEnabled("linux", undefined)).toBe(false);
    expect(launcherNotifyEnabled("linux", "")).toBe(false);
    expect(launcherNotifyEnabled("darwin", "/tmp/notify")).toBe(false);
  });
});

describe("LauncherNotifier", () => {
  it("sends READY once when the child reports ready, then only watchdog pings", () => {
    const sent: string[][] = [];
    const notifier = new LauncherNotifier({
      enabled: true,
      send: (messages) => sent.push([...messages]),
    });
    notifier.setPhase("starting");
    notifier.tick();
    notifier.markChildReady();
    notifier.markChildReady();
    notifier.tick();
    expect(sent).toEqual([
      [`EXTEND_TIMEOUT_USEC=${EXTEND_TIMEOUT_USEC}`],
      ["READY=1", "WATCHDOG=1"],
      ["WATCHDOG=1"],
    ]);
  });

  it("keeps an idle launcher alive: READY on the first idle tick, then pings", () => {
    const sent: string[][] = [];
    const notifier = new LauncherNotifier({
      enabled: true,
      send: (messages) => sent.push([...messages]),
    });
    notifier.setPhase("idle");
    notifier.tick();
    notifier.tick();
    expect(sent).toEqual([["READY=1", "WATCHDOG=1"], ["WATCHDOG=1"]]);
  });
});
