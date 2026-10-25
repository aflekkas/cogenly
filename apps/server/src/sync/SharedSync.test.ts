import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  SharedChangesApply,
  SharedChangesRead,
  type SharedDocumentChange,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { agentFixture } from "../agents/agent.testkit.ts";
import * as Facts from "../context/FactService.ts";
import * as Machines from "../machines/Machines.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { startMachine, pair, startProxy, awaitLinkState } from "../machines/testkit.ts";
import * as SharedState from "./SharedState.ts";
import { compareClock } from "./merge.ts";
import * as SharedSync from "./SharedSync.ts";
import * as SharedSyncStatus from "./SharedSyncStatus.ts";

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
  const jobs = new Map<string, Effect.Effect<void>>();
  const syncContext = yield* machine.run(
    Layer.build(
      SharedSync.layer.pipe(
        Layer.provide(Layer.succeed(SharedState.SharedState, { ...state, changes: Stream.never })),
        Layer.provide(
          Layer.succeed(Machines.Machines, { ...machine.machines, subscribe: Stream.never }),
        ),
        // Explicit passes in tests, with durable milestones instead of scheduler sleeps.
        Layer.provide(
          Layer.succeed(Scheduler.Scheduler, {
            register: (name, job) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<Effect.Services<typeof job>>();
                jobs.set(name, job.pipe(Effect.provideContext(context), Effect.orDie));
              }),
          }),
        ),
      ),
    ),
  );
  const sync = yield* SharedSync.SharedSync.pipe(Effect.provideContext(syncContext));
  return { ...machine, state, sync, catchUp: jobs.get("shared-documents")! };
});

describe("shared documents over the authenticated machine link", () => {
  it.live(
    "re-pairing uploads jobs owned by an unknown former hub",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("repair-hub", "cloud-server");
        const spoke = yield* start("repair-spoke", "computer");
        const formerHub = EnvironmentId.make("former-hub");
        yield* spoke.state.write("schedule", "task:former-hub", {
          agentId: null,
          title: "Old job",
          prompt: "Check",
          enabled: true,
          schedule: { type: "interval", everyMs: 60000 },
          repositoryRemote: null,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          ownerMachine: formerHub,
          createdAt: project.createdAt,
        });
        yield* pair(hub, spoke);
        yield* spoke.sync.sync(hub.environmentId);
        expect((yield* hub.state.get("schedule", "task:former-hub"))?.fields.ownerMachine).toBe(
          formerHub,
        );
        const sql = yield* hub.run(SqlClient.SqlClient);
        expect(yield* sql`SELECT owner_machine FROM scheduled_tasks`).toEqual([
          { owner_machine: formerHub },
        ]);
        expect((yield* spoke.state.cursors(hub.environmentId)).acknowledged).toBeGreaterThan(0);
      }).pipe(Effect.scoped),
    20000,
  );
  it.live(
    "a peer with a broken sync channel cannot block the later healthy peer",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("isolated-hub", "cloud-server");
        const broken = yield* startMachine("isolated-broken", "computer");
        const healthy = yield* start("isolated-healthy", "computer");
        yield* pair(hub, broken);
        yield* pair(hub, healthy);
        yield* hub.state.write("project", "label:isolation", project);
        yield* hub.catchUp;
        expect((yield* healthy.state.get("project", "label:isolation"))?.fields.name).toBe(
          "Project",
        );
      }).pipe(Effect.scoped),
    20000,
  );
  it.live(
    "two machines converge concurrent fields and a lost acknowledgement is replay-safe",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("sync-hub", "cloud-server");
        const spoke = yield* start("sync-spoke", "computer");
        yield* hub.state.write("project", "label:one", project);
        yield* pair(hub, spoke);
        expect(yield* spoke.state.defaultOwner).toBe(spoke.environmentId);
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
    "refuses a paired peer's spoofed author, and never applies or relays an absolute path",
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
        // An unreadable value is held back rather than stalling the link.
        expect(
          (yield* Effect.result(
            spoke.machines.call(hub.environmentId, SharedChangesApply, {
              after: 0,
              cursor: 1,
              changes: [bad],
            }),
          ))._tag,
        ).toBe("Success");
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
    "a spoke's proposed fact reaches the hub, the hub's confirmation reaches the spoke",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("facts-hub", "cloud-server");
        const spoke = yield* start("facts-spoke", "computer");
        yield* pair(hub, spoke);
        const agent = agentFixture();
        yield* spoke.state.write("agent", agent.id, {
          name: agent.name,
          avatar: { seed: agent.avatar.seed },
          instructions: agent.instructions,
          responsibility: agent.responsibility,
          permissions: agent.permissions,
          notifyPolicy: agent.notifyPolicy,
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          fallbackChain: [],
          runtimeMode: agent.runtimeMode,
          dailyRunCap: agent.dailyRunCap,
          repositoryRemote: null,
          ownerMachine: spoke.environmentId,
          createdAt: agent.createdAt,
        });
        const factsOn = (machine: typeof hub) =>
          machine
            .run(Layer.build(Facts.layer))
            .pipe(
              Effect.flatMap((context) => Facts.FactService.pipe(Effect.provideContext(context))),
            );
        const statusOn = (machine: typeof hub) =>
          machine
            .run(Layer.build(SharedSyncStatus.layer))
            .pipe(
              Effect.flatMap((context) =>
                SharedSyncStatus.SharedSyncStatus.pipe(Effect.provideContext(context)),
              ),
            );
        const spokeFacts = yield* factsOn(spoke);
        const hubFacts = yield* factsOn(hub);
        const spokeStatus = yield* statusOn(spoke);
        const principal = `agent:${agent.id}` as const;
        const proposal = (yield* spokeFacts.create(
          {
            subject: "Preference",
            text: "Deploys after standup",
            labelIds: [],
            visibility: "user",
            agentId: agent.id,
            sourceRefs: [],
          },
          principal,
        )).fact;
        const pending = (yield* spokeStatus.status({ kinds: ["fact"] })).peers;
        expect(pending).toEqual([
          expect.objectContaining({
            environmentId: hub.environmentId,
            relation: "hub",
            kinds: [{ kind: "fact", pendingOutgoing: 1 }],
          }),
        ]);
        yield* spoke.sync.sync(hub.environmentId);
        expect((yield* spokeStatus.status({ kinds: ["fact"] })).peers[0]?.kinds).toEqual([
          { kind: "fact", pendingOutgoing: 0 },
        ]);
        // What fact_search returns for the agent on the hub.
        expect((yield* hubFacts.list({}, principal)).facts).toEqual([
          expect.objectContaining({ id: proposal.id, status: "proposed" }),
        ]);
        yield* hubFacts.update({ id: proposal.id, status: "confirmed" });
        yield* hub.sync.sync(spoke.environmentId);
        expect((yield* spokeFacts.list({}, principal)).facts).toEqual([
          expect.objectContaining({ id: proposal.id, status: "confirmed" }),
        ]);
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
