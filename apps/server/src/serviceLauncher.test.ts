import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  EXTEND_TIMEOUT_USEC,
  LauncherNotifier,
  launcherNotifyEnabled,
  launcherNotifyMessages,
  resolveRuntimePaths,
  WATCHDOG_PING_INTERVAL_MS,
} from "./serviceLauncher.ts";

describe("launcher runtime entry", () => {
  it.effect("runs cogenly, falls back to the t3 of a pre-rename runtime, and prefers cogenly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "cogenly-launcher-" });
      const install = Effect.fn(function* (version: string, names: ReadonlyArray<string>) {
        const dir = path.join(home, "runtime/versions", version);
        yield* fs.makeDirectory(dir, { recursive: true });
        for (const name of names) yield* fs.writeFileString(path.join(dir, name), "");
      });
      yield* install("0.3.0", ["cogenly"]);
      yield* install("0.2.2", ["t3"]);
      yield* install("0.3.1", ["cogenly", "t3"]);
      const entry = (version: string) =>
        Effect.promise(() => resolveRuntimePaths(home, version)).pipe(
          Effect.map((paths) => path.basename(paths.entryPath)),
        );
      expect(yield* entry("0.3.0")).toBe("cogenly");
      expect(yield* entry("0.2.2")).toBe("t3");
      expect(yield* entry("0.3.1")).toBe("cogenly");
      // Nothing installed: report the current name as the missing one.
      expect(yield* entry("0.4.0")).toBe("cogenly");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("launcher sd_notify decisions", () => {
  it("extends the start timeout and pings the watchdog while a child starts, before READY", () => {
    expect(launcherNotifyMessages("starting", false)).toEqual([
      `EXTEND_TIMEOUT_USEC=${EXTEND_TIMEOUT_USEC}`,
      "WATCHDOG=1",
    ]);
  });

  it("extends and pings while a child starts after READY was already sent", () => {
    // A normal child sends READY itself, so the launcher may never learn
    // readiness happened; the watchdog must be fed either way or a long
    // first-update migration outlives WatchdogSec and gets killed.
    expect(launcherNotifyMessages("starting", true)).toEqual([
      `EXTEND_TIMEOUT_USEC=${EXTEND_TIMEOUT_USEC}`,
      "WATCHDOG=1",
    ]);
  });

  it("pings the watchdog in every phase, ready or not", () => {
    for (const phase of ["starting", "running", "idle", "long-operation"] as const) {
      for (const readySent of [false, true]) {
        expect(launcherNotifyMessages(phase, readySent)).toContain("WATCHDOG=1");
      }
    }
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
      [`EXTEND_TIMEOUT_USEC=${EXTEND_TIMEOUT_USEC}`, "WATCHDOG=1"],
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
