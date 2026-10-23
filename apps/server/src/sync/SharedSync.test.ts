import { describe, expect, it } from "@effect/vitest";
import {
  SharedChangesApply,
  SharedChangesRead,
  type SharedDocumentChange,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { startMachine, pair, startProxy, awaitLinkState } from "../machines/testkit.ts";
import * as SharedState from "./SharedState.ts";
import { compareClock } from "./merge.ts";
import * as SharedSync from "./SharedSync.ts";

const project = {
  name: "Project",
  color: null,
  description: null,
  instructions: "",
  archivedAt: null,
  repositories: [{ remote: "github.com/org/repo", directoryName: "repo" }],
  sourceLinks: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};
const start = Effect.fn("startSyncMachine")(function* (
  name: string,
  role: "computer" | "cloud-server",
) {
  const machine = yield* startMachine(name, role);
  const stateContext = yield* machine.run(Layer.build(SharedState.layer));
  const state = yield* SharedState.SharedState.pipe(Effect.provideContext(stateContext));
  const syncContext = yield* machine.run(
    Layer.build(
      SharedSync.layer.pipe(
        Layer.provide(Layer.succeed(SharedState.SharedState, state)),
        // Explicit passes in tests, with durable milestones instead of scheduler sleeps.
        Layer.provide(Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void })),
      ),
    ),
  );
  const sync = yield* SharedSync.SharedSync.pipe(Effect.provideContext(syncContext));
  return { ...machine, state, sync };
});

describe("shared documents over the authenticated machine link", () => {
  it.live(
    "two machines converge concurrent fields and a lost acknowledgement is replay-safe",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("sync-hub", "cloud-server");
        const spoke = yield* start("sync-spoke", "computer");
        yield* hub.state.write("project", "label:one", project);
        yield* pair(hub, spoke);
        expect(yield* spoke.state.defaultOwner).toBe(hub.environmentId);
        yield* spoke.sync.sync(hub.environmentId);
        yield* hub.sync.sync(spoke.environmentId);
        // Simultaneous independent edits persist before either side exchanges the next batch.
        yield* Effect.all(
          [
            hub.state.write("project", "label:one", { name: "Hub name" }),
            spoke.state.write("project", "label:one", { instructions: "Spoke instructions" }),
          ],
          { concurrency: "unbounded" },
        );
        yield* spoke.sync.sync(hub.environmentId);
        yield* hub.sync.sync(spoke.environmentId);
        yield* spoke.sync.sync(hub.environmentId);
        expect(yield* spoke.state.get("project", "label:one")).toEqual(
          yield* hub.state.get("project", "label:one"),
        );
        expect((yield* hub.state.get("project", "label:one"))?.fields).toMatchObject({
          name: "Hub name",
          instructions: "Spoke instructions",
        });
        yield* Effect.all(
          [
            hub.state.write("project", "label:one", { name: "Hub conflict" }),
            spoke.state.write("project", "label:one", { name: "Spoke conflict" }),
          ],
          { concurrency: "unbounded" },
        );
        const hubEdit = (yield* hub.state.get("project", "label:one"))!;
        const spokeEdit = (yield* spoke.state.get("project", "label:one"))!;
        const expectedName =
          compareClock(hubEdit.clocks.name!, spokeEdit.clocks.name!) > 0
            ? hubEdit.fields.name
            : spokeEdit.fields.name;
        yield* spoke.sync.sync(hub.environmentId);
        yield* hub.sync.sync(spoke.environmentId);
        expect((yield* hub.state.get("project", "label:one"))?.fields.name).toBe(expectedName);
        expect(yield* spoke.state.get("project", "label:one")).toEqual(
          yield* hub.state.get("project", "label:one"),
        );
        const sql = yield* hub.run(SqlClient.SqlClient);
        const before = (yield* sql`SELECT * FROM shared_changes`).length;
        const outgoing = yield* spoke.state.readBatch(0, hub.environmentId, true);
        // Re-send an already committed range, as when the reply was lost on disconnect.
        yield* spoke.machines.call(hub.environmentId, SharedChangesApply, outgoing);
        expect((yield* sql`SELECT * FROM shared_changes`).length).toBe(before);
        expect(
          (yield* spoke.state.readBatch(0, hub.environmentId, true)).changes.every(
            (change) => change.updatedBy === spoke.environmentId,
          ),
        ).toBe(true);
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "hub relays between spokes and reconnect catches up without resetting cursors",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("relay-hub", "cloud-server");
        const a = yield* start("relay-a", "computer");
        const b = yield* start("relay-b", "computer");
        yield* pair(hub, a);
        const proxy = yield* startProxy(hub);
        yield* pair(hub, b, proxy.url);
        yield* a.state.write("project", "label:relay", project);
        yield* a.sync.sync(hub.environmentId);
        yield* b.sync.sync(hub.environmentId);
        expect((yield* b.state.get("project", "label:relay"))?.fields.name).toBe("Project");
        yield* proxy.dropAll;
        yield* awaitLinkState(b, (state) => state.status !== "online");
        yield* awaitLinkState(b, (state) => state.status === "online");
        yield* a.state.write("project", "label:relay", { name: "After disconnect" });
        yield* a.sync.sync(hub.environmentId);
        yield* b.sync.sync(hub.environmentId);
        expect(yield* b.state.get("project", "label:relay")).toEqual(
          yield* hub.state.get("project", "label:relay"),
        );
        const cursors = yield* b.state.cursors(hub.environmentId);
        expect(cursors.received).toBeGreaterThan(0);
        yield* b.sync.sync(hub.environmentId);
        expect((yield* b.state.cursors(hub.environmentId)).received).toBe(cursors.received);
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "rejects a paired peer's spoofed author and absolute-path payload",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("validate-hub", "cloud-server");
        const spoke = yield* start("validate-spoke", "computer");
        yield* pair(hub, spoke);
        const bad: SharedDocumentChange = {
          kind: "project",
          id: "label:bad",
          fields: { repositories: [{ remote: "/tmp/repo", directoryName: "repo" }] },
          clocks: { repositories: { wall: 10, logical: 0, node: spoke.environmentId } },
          tombstone: null,
          updatedBy: spoke.environmentId,
        };
        expect(
          (yield* Effect.result(
            spoke.machines.call(hub.environmentId, SharedChangesApply, {
              after: 0,
              cursor: 1,
              changes: [bad],
            }),
          ))._tag,
        ).toBe("Failure");
        const forged = {
          ...bad,
          fields: { name: "Spoofed" },
          clocks: { name: { wall: 10, logical: 0, node: hub.environmentId } },
          updatedBy: hub.environmentId,
        };
        expect(
          (yield* Effect.result(
            spoke.machines.call(hub.environmentId, SharedChangesApply, {
              after: 0,
              cursor: 1,
              changes: [forged],
            }),
          ))._tag,
        ).toBe("Failure");
        expect(yield* hub.state.get("project", "label:bad")).toBeUndefined();
        const read = yield* spoke.machines.call(hub.environmentId, SharedChangesRead, { after: 0 });
        expect(read.changes).toEqual([]);
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "standalone sync leaves the log and cursor untouched",
    () =>
      Effect.gen(function* () {
        const machine = yield* start("standalone", "computer");
        yield* machine.sync.sync(machine.environmentId);
        expect(yield* machine.state.cursors(machine.environmentId)).toEqual({
          received: 0,
          acknowledged: 0,
        });
      }).pipe(Effect.scoped),
    20000,
  );
});
