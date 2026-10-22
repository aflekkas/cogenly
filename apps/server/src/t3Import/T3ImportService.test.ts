// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { T3_IMPORT_RUNNING_NOTE, type T3ImportStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layerOffline } from "./T3ImportOfflineLayer.ts";
import { T3ImportService } from "./T3ImportService.ts";
import { created, makeT3Fixture, message, run, T3_PROJECT } from "./T3Import.testkit.ts";

const fixture = makeT3Fixture();
fixture.append(created("thread-a"));
fixture.append(message("thread-a", 1));
fixture.append(run("thread-a", "running"));
fixture.close();
NodeFS.writeFileSync(
  NodePath.join(fixture.dir, "settings.json"),
  JSON.stringify({
    providerInstances: {
      "claude-personal": { driver: "claudeAgent", config: { homePath: "~/.claude_personal" } },
    },
  }),
);

const snapshotRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-import-snapshots-"));

const makeLayer = (options: { readonly freeBytes?: (directory: string) => number } = {}) =>
  layerOffline({ sourceDir: fixture.dir, snapshotRoot, ...options }).pipe(
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(Sqlite.layerConfig),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-import-service-test-" })),
    ),
    Layer.provide(NodeServices.layer),
  );
const layer = makeLayer();

/** The first status the UI would render that satisfies `predicate`. */
const waitFor = (
  service: T3ImportService["Service"],
  predicate: (status: T3ImportStatus) => boolean,
) => service.status.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

describe("T3ImportService", () => {
  it.effect("walks the Settings flow: detect, dry run, confirm, import", () =>
    Effect.gen(function* () {
      const service = yield* T3ImportService;
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* ServerSettings.ServerSettingsService;

      const detected = yield* waitFor(service, () => true);
      expect(detected.source.available).toBe(true);
      expect(detected.source.running).toBe(false);
      expect(detected.source.backupDirectory).toBeDefined();
      expect(
        detected.source.projects.map((project) => [
          project.sourceProjectId,
          project.selectedByDefault,
        ]),
      ).toEqual([[T3_PROJECT, true]]);
      expect(detected.job._tag).toBe("Idle");
      expect(yield* service.cancel).toEqual({ cancelled: false });

      // An import needs a dry run first.
      const unconfirmed = yield* service
        .run({ reportId: "nope", includeSettings: false })
        .pipe(Effect.flip);
      expect(unconfirmed.reason).toBe("stale-report");

      yield* service.scan({ scope: { sourceProjectIds: [] } });
      const scanned = yield* waitFor(service, (status) => status.job._tag === "Scanned");
      if (scanned.job._tag !== "Scanned") throw new Error("not scanned");
      const report = scanned.job.report;
      expect(report.totals).toMatchObject({
        threads: 1,
        events: 3,
        skippedEvents: 0,
        normalizedEvents: 1,
      });
      expect(report.projects[0]?.action).toBe("create");
      expect(report.providers.map((binding) => [binding.instanceId, binding.status])).toEqual([
        ["claude-personal", "create"],
      ]);
      // The dry run wrote nothing.
      expect(yield* sql`SELECT 1 FROM t3_import_threads`).toEqual([]);

      yield* service.run({ reportId: report.reportId, includeSettings: false });
      const done = yield* waitFor(
        service,
        (status) => status.job._tag === "Completed" || status.job._tag === "Failed",
      );
      if (done.job._tag !== "Completed") throw new Error(JSON.stringify(done.job));
      expect(done.job.result.writtenEvents).toBe(3);
      expect(done.job.result.backupPath.startsWith(detected.source.backupDirectory ?? "?")).toBe(
        true,
      );
      expect(NodeFS.existsSync(done.job.result.backupPath)).toBe(true);
      expect(Object.keys((yield* settings.getSettings).providerInstances)).toContain(
        "claude-personal",
      );
      expect(
        yield* sql<{ status: string }>`SELECT status FROM orchestration_v2_projection_runs`,
      ).toEqual([{ status: "interrupted" }]);
      // The new project now shows as the merge target.
      expect(done.source.projects[0]?.existingProjectId).not.toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("imports while T3 Code is running, from a snapshot it deletes afterwards", () =>
    Effect.gen(function* () {
      const service = yield* T3ImportService;
      const runtimeFile = NodePath.join(fixture.dir, "server-runtime.json");
      NodeFS.writeFileSync(runtimeFile, JSON.stringify({ pid: process.pid }));
      try {
        const status = yield* waitFor(service, () => true);
        expect(status.source.running).toBe(true);
        yield* service.scan({ scope: { sourceProjectIds: [] } });
        const scanned = yield* waitFor(service, (current) => current.job._tag === "Scanned");
        if (scanned.job._tag !== "Scanned") throw new Error("not scanned");
        expect(scanned.job.report.warnings).toContain(T3_IMPORT_RUNNING_NOTE);
        // The confirmed import replays the scan's snapshot, so it is held until then.
        expect(NodeFS.readdirSync(snapshotRoot)).toHaveLength(1);
        yield* service.run({ reportId: scanned.job.report.reportId, includeSettings: false });
        const done = yield* waitFor(
          service,
          (current) => current.job._tag === "Completed" || current.job._tag === "Failed",
        );
        if (done.job._tag !== "Completed") throw new Error(JSON.stringify(done.job));
        expect(done.job.result.writtenEvents).toBe(3);
        expect(NodeFS.readdirSync(snapshotRoot)).toEqual([]);
      } finally {
        NodeFS.rmSync(runtimeFile);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails clearly when the snapshot would not fit, leaving nothing behind", () =>
    Effect.gen(function* () {
      const service = yield* T3ImportService;
      yield* service.scan({ scope: { sourceProjectIds: [] } });
      const failed = yield* waitFor(service, (current) => current.job._tag === "Failed");
      if (failed.job._tag !== "Failed") throw new Error("not failed");
      expect(failed.job.message).toMatch(/needs .* free in .* but only 0\.0 GB is free/);
      expect(NodeFS.readdirSync(snapshotRoot)).toEqual([]);
    }).pipe(Effect.provide(makeLayer({ freeBytes: () => 0 }))),
  );
});
