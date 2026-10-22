// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { created, makeT3Fixture, message } from "./T3Import.testkit.ts";
import {
  checkT3SnapshotSpace,
  openT3SourceDatabase,
  removeT3SourceSnapshot,
  snapshotT3SourceDatabase,
} from "./T3SourceDatabase.ts";

const tempRoot = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-test-"));

const eventCount = (dbPath: string, live: boolean) => {
  const source = openT3SourceDatabase(dbPath, { live });
  try {
    return source.threadStats(["thread-a"])[0]?.events ?? 0;
  } finally {
    source.close();
  }
};

describe("T3 source snapshots", () => {
  it("includes what a running T3 has only in its WAL", async () => {
    const fixture = makeT3Fixture({ wal: true });
    fixture.append(created("thread-a"));
    fixture.append(message("thread-a", 1));
    try {
      expect(NodeFS.statSync(`${fixture.dbPath}-wal`).size).toBeGreaterThan(0);
      expect(eventCount(fixture.dbPath, true)).toBe(2);

      const root = tempRoot();
      const snapshot = await snapshotT3SourceDatabase({ dbPath: fixture.dbPath, tempRoot: root });
      // T3 keeps writing after the snapshot; the copy stays as it was.
      fixture.append(message("thread-a", 2));
      expect(eventCount(snapshot.path, false)).toBe(2);
      expect(NodeFS.readdirSync(snapshot.directory)).toEqual(["statev2.sqlite"]);

      removeT3SourceSnapshot(snapshot);
      expect(NodeFS.readdirSync(root)).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("copies in steps that let the event loop run, from one moment of a database T3 keeps writing", async () => {
    const fixture = makeT3Fixture({ wal: true });
    fixture.append(created("thread-a"));
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      fixture.append(message("thread-a", sequence, "x".repeat(4000)));
    }
    try {
      // Counts event loop turns: each runs the next immediate.
      let loopTurns = 0;
      let ticking = true;
      const tick = () => {
        loopTurns += 1;
        if (ticking) setImmediate(tick);
      };
      setImmediate(tick);
      const seen: Array<{ copiedBytes: number; totalBytes: number; loopTurns: number }> = [];
      const snapshot = await snapshotT3SourceDatabase({
        dbPath: fixture.dbPath,
        tempRoot: tempRoot(),
        pagesPerStep: 4,
        onProgress: (progress) => {
          seen.push({ ...progress, loopTurns });
          // T3 writes mid-copy; the copy neither restarts nor picks it up.
          if (seen.length === 2) fixture.append(message("thread-a", 41));
        },
      }).finally(() => {
        ticking = false;
      });

      expect(eventCount(snapshot.path, false)).toBe(41);
      expect(seen.length).toBeGreaterThan(3);
      const last = seen.at(-1);
      expect(last?.copiedBytes).toBe(last?.totalBytes);
      // Bytes only grow: a restarted backup would start over from zero.
      expect(
        seen.every(
          (step, index) => index === 0 || step.copiedBytes > (seen[index - 1]?.copiedBytes ?? 0),
        ),
      ).toBe(true);
      // The loop kept turning while the copy was under way, not only after it.
      expect((last?.loopTurns ?? 0) - (seen[0]?.loopTurns ?? 0)).toBeGreaterThan(0);
      removeT3SourceSnapshot(snapshot);
    } finally {
      fixture.close();
    }
  });

  it("leaves a closed T3 install's files untouched", async () => {
    const fixture = makeT3Fixture({ wal: true });
    fixture.append(created("thread-a"));
    fixture.close();
    const before = NodeFS.readdirSync(fixture.dir).toSorted();
    const snapshot = await snapshotT3SourceDatabase({
      dbPath: fixture.dbPath,
      tempRoot: tempRoot(),
    });
    expect(eventCount(snapshot.path, false)).toBe(1);
    removeT3SourceSnapshot(snapshot);
    expect(NodeFS.readdirSync(fixture.dir).toSorted()).toEqual(before);
  });

  it("asks for the database, its WAL and headroom in free space", () => {
    const fixture = makeT3Fixture({ wal: true });
    fixture.append(created("thread-a"));
    try {
      const databaseBytes =
        NodeFS.statSync(fixture.dbPath).size + NodeFS.statSync(`${fixture.dbPath}-wal`).size;
      const seen: Array<string> = [];
      const short = checkT3SnapshotSpace({
        dbPath: fixture.dbPath,
        tempRoot: "/snapshots",
        freeBytes: (directory) => {
          seen.push(directory);
          return databaseBytes;
        },
      });
      expect(seen).toEqual(["/snapshots"]);
      expect(short.enough).toBe(false);
      expect(short.requiredBytes).toBeGreaterThan(databaseBytes);
      expect(
        checkT3SnapshotSpace({
          dbPath: fixture.dbPath,
          tempRoot: "/snapshots",
          freeBytes: () => short.requiredBytes,
        }).enough,
      ).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
