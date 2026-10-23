import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, SharedStateError, type SharedDocumentChange } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SharedState from "./SharedState.ts";

const local = EnvironmentId.make("local");
const peer = EnvironmentId.make("peer");
const layer = SharedState.layer.pipe(
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(local),
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);
const project = {
  name: "Shared",
  color: null,
  description: null,
  instructions: "",
  archivedAt: null,
  repositories: [],
  sourceLinks: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};
const change = (fields: SharedDocumentChange["fields"], wall = 10): SharedDocumentChange => ({
  kind: "project",
  id: "label:peer",
  fields,
  clocks: Object.fromEntries(
    Object.keys(fields).map((key) => [key, { wall, logical: 0, node: peer }]),
  ),
  tombstone: null,
  updatedBy: peer,
});
const batch = (changes: SharedDocumentChange[], after = 0) => ({
  after,
  cursor: after + 1,
  changes,
});
describe("SharedState", () => {
  it.effect(
    "commits projection and outbound log together, stores duplicates and replays idempotently",
    () =>
      Effect.gen(function* () {
        const state = yield* SharedState.SharedState;
        const sql = yield* SqlClient.SqlClient;
        yield* state.write("project", "label:local", project);
        const incoming = batch([change(project)]);
        yield* state.receive(incoming, peer, false);
        yield* state.receive(incoming, peer, false);
        expect(yield* sql`SELECT name FROM project_labels ORDER BY label_id`).toEqual([
          { name: "Shared" },
          { name: "Shared" },
        ]);
        expect((yield* sql`SELECT * FROM shared_changes`).length).toBe(2);
        expect((yield* sql`SELECT * FROM shared_possible_duplicates`).length).toBe(1);
        expect((yield* state.cursors(peer)).received).toBe(1);
        const relay = yield* state.readBatch(0, EnvironmentId.make("third"), false);
        expect(relay.changes.length).toBe(2);
        expect((yield* state.readBatch(0, peer, false)).changes.length).toBe(1);
        expect((yield* state.readBatch(0, EnvironmentId.make("hub"), true)).changes.length).toBe(1);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("rolls back an invalid batch including projection and cursor", () =>
    Effect.gen(function* () {
      const state = yield* SharedState.SharedState;
      const result = yield* Effect.result(
        state.receive(batch([change(project), change({ workspaceRoot: "/etc" })]), peer, false),
      );
      expect(result._tag).toBe("Failure");
      expect(yield* state.get("project", "label:peer")).toBeUndefined();
      expect((yield* state.cursors(peer)).received).toBe(0);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("merges stale deliveries without losing fields and keeps deletes permanent", () =>
    Effect.gen(function* () {
      const state = yield* SharedState.SharedState;
      yield* state.receive(batch([change(project, 20)]), peer, false);
      yield* state.receive(batch([change({ name: "stale" }, 10)], 1), peer, false);
      expect((yield* state.get("project", "label:peer"))?.fields.name).toBe("Shared");
      yield* state.receive(
        batch([{ ...change({}, 30), tombstone: { wall: 30, logical: 0, node: peer } }], 2),
        peer,
        false,
      );
      yield* state.receive(batch([change({ name: "late" }, 40)], 3), peer, false);
      expect((yield* state.get("project", "label:peer"))?.tombstone).not.toBeNull();
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM project_labels`).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("validates authorship, clock bounds, fields, nested paths and cursor gaps", () =>
    Effect.gen(function* () {
      const state = yield* SharedState.SharedState;
      const bad = [
        { ...change(project), updatedBy: local },
        change({ repositories: [{ remote: "/tmp/repo", directoryName: null }] }),
        change({
          repositories: [{ remote: "github.com/org/repo", directoryName: "../../escape" }],
        }),
        change({ sourceLinks: [{ kind: "github-owner", owner: "valid", path: "/tmp" }] }),
        change({ name: "future" }, Number.MAX_SAFE_INTEGER),
        { ...change({ name: "x" }), clocks: {} },
        change({ instructions: "x".repeat(100_000) }),
      ];
      for (const invalid of bad)
        expect((yield* Effect.result(state.receive(batch([invalid]), peer, false)))._tag).toBe(
          "Failure",
        );
      expect(
        (yield* Effect.result(state.receive(batch([change(project)], 5), peer, false)))._tag,
      ).toBe("Failure");
      expect((yield* Effect.result(state.acknowledge(peer, 99)))._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );
  it.effect("bounds replay batches by count and bytes", () =>
    Effect.gen(function* () {
      const state = yield* SharedState.SharedState;
      for (let i = 0; i < 40; i++)
        yield* state.write("project", `label:${i}`, {
          ...project,
          instructions: "x".repeat(32000),
        });
      const first = yield* state.readBatch(0, peer, false);
      expect(first.changes.length).toBeLessThanOrEqual(32);
      expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThanOrEqual(
        256 * 1024,
      );
      expect(first.cursor).toBeGreaterThan(0);
      expect(first.cursor).toBeLessThan(40);
      yield* state.acknowledge(peer, first.cursor);
      expect((yield* state.cursors(peer)).acknowledged).toBe(first.cursor);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("refuses ownership theft even from the trusted relay", () =>
    Effect.gen(function* () {
      const state = yield* SharedState.SharedState;
      yield* state.write("agent", "agent:one", { ownerMachine: local });
      const incoming = {
        ...change({ ownerMachine: peer }),
        kind: "agent" as const,
        id: "agent:one",
      };
      const result = yield* Effect.result(state.receive(batch([incoming]), peer, true));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(SharedStateError);
      expect((yield* state.get("agent", "agent:one"))?.fields.ownerMachine).toBe(local);
    }).pipe(Effect.provide(layer)),
  );
});
