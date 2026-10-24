import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type FactCreateInput,
  FactId,
  type SharedDocumentChange,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "../agents/AgentStore.ts";
import { agentFixture } from "../agents/agent.testkit.ts";
import * as Facts from "../context/FactService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { factDocumentId, splitChange } from "./documentSchemas.ts";
import * as SharedState from "./SharedState.ts";

const machineLayer = (name: string) =>
  Layer.mergeAll(SharedState.layer, Facts.layer, Store.layer).pipe(
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(name)),
      }),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(NodeServices.layer),
  );

/** One isolated machine: its own database, identity and change log. */
const machine = Effect.fn("machine")(function* (name: string) {
  const context = yield* Layer.build(machineLayer(name));
  return {
    environmentId: EnvironmentId.make(name),
    state: Context.get(context, SharedState.SharedState),
    facts: Context.get(context, Facts.FactService),
    store: Context.get(context, Store.AgentStore),
    sql: Context.get(context, SqlClient.SqlClient),
  };
});
type Machine = Effect.Success<ReturnType<typeof machine>>;

/** Delivers what `from` authored that `to` has not acknowledged, as SharedSync does. */
const send = Effect.fn("send")(function* (from: Machine, to: Machine) {
  for (;;) {
    const { acknowledged } = yield* from.state.cursors(to.environmentId);
    const batch = yield* from.state.readBatch(acknowledged, to.environmentId, true);
    if (batch.cursor === batch.after) return;
    const result = yield* to.state.receive(batch, from.environmentId, false);
    yield* from.state.acknowledge(to.environmentId, result.acknowledged);
  }
});
const exchange = (a: Machine, b: Machine) => Effect.andThen(send(a, b), send(b, a));

const agent = agentFixture();
const principal = `agent:${agent.id}` as const;
const note = (text: string): FactCreateInput => ({
  subject: "Preference",
  text,
  labelIds: [],
  visibility: "user",
  agentId: agent.id,
  sourceRefs: [],
});
/** Status of every fact, in a form two machines can compare. */
const placements = (m: Machine) =>
  m.facts.list({}).pipe(
    Effect.map(({ facts }) =>
      facts
        .map((fact) => ({
          id: fact.id,
          text: fact.text,
          status: fact.status,
          supersededBy: fact.supersededBy ?? null,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    ),
  );
const statusOf = (m: Machine, id: FactId) =>
  placements(m).pipe(Effect.map((all) => all.find((fact) => fact.id === id)?.status));

const paired = Effect.gen(function* () {
  const a = yield* machine("machine-a");
  const b = yield* machine("machine-b");
  yield* a.store.save(agent);
  yield* exchange(a, b);
  return { a, b };
});

describe("memory facts across paired machines", () => {
  it.effect("a supersede and a concurrent confirm converge, and a retraction always wins", () =>
    Effect.gen(function* () {
      const { a, b } = yield* paired;
      const proposal = (yield* a.facts.create(note("Prefers tea"), principal)).fact;
      const doomed = (yield* a.facts.create(note("Works nights"), principal)).fact;
      yield* exchange(a, b);
      expect(yield* statusOf(b, proposal.id)).toBe("proposed");

      // Neither machine has seen the other's edit when it makes its own.
      const replacement = (yield* a.facts.supersede({
        id: proposal.id,
        replacement: note("Prefers green tea"),
      })).fact;
      yield* b.facts.update({ id: proposal.id, status: "confirmed" });
      yield* a.facts.update({ id: doomed.id, status: "confirmed" });
      yield* b.facts.retract(doomed.id);
      yield* exchange(a, b);
      yield* exchange(a, b);

      expect(yield* placements(a)).toEqual(yield* placements(b));
      expect(yield* statusOf(a, proposal.id)).toBe("superseded");
      expect(yield* statusOf(a, replacement.id)).toBe("confirmed");
      expect(yield* statusOf(a, doomed.id)).toBe("retracted");
    }).pipe(Effect.scoped),
  );

  it.effect("the same fact proposed on two machines converges to one active copy", () =>
    Effect.gen(function* () {
      const { a, b } = yield* paired;
      const fromA = (yield* a.facts.create(note("Ships on Fridays"), principal)).fact;
      const fromB = (yield* b.facts.create(note("ships  on FRIDAYS"), principal)).fact;
      yield* exchange(a, b);
      const sent = yield* b.state.readBatch(0, a.environmentId, true);
      yield* exchange(a, b);
      // Placing the copies writes no documents, so nothing echoes back.
      expect((yield* b.state.readBatch(0, a.environmentId, true)).changes).toHaveLength(
        sent.changes.length,
      );

      const [winner, loser] = [fromA.id, fromB.id].sort();
      expect(yield* placements(a)).toEqual(yield* placements(b));
      expect((yield* placements(a)).filter((fact) => fact.status === "proposed")).toEqual([
        expect.objectContaining({ id: winner }),
      ]);
      expect((yield* placements(a)).find((fact) => fact.id === loser)).toMatchObject({
        status: "superseded",
        supersededBy: winner,
      });
      // The agent's own view sees one copy too.
      expect((yield* b.facts.list({ status: "proposed" }, principal)).facts).toHaveLength(1);

      // Retracting the visible copy takes the hidden one with it on both machines.
      yield* b.facts.retract(winner as FactId);
      yield* exchange(a, b);
      expect(yield* placements(a)).toEqual(yield* placements(b));
      expect((yield* placements(a)).map((fact) => fact.status)).toEqual(["retracted", "retracted"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "superseding a normalized duplicate keeps its replacement active on both machines",
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* paired;
        const id = FactId.make("fact:0");
        const at = "2026-01-01T00:00:00.000Z";
        // This portable id sorts before every newly generated fact UUID, so the
        // replacement deterministically starts hidden behind the original.
        yield* a.state.write("fact", id, {
          factId: id,
          ...note("Ships on Fridays"),
          agentId: agent.id,
          predicate: null,
          validFrom: null,
          supersedes: null,
          createdBy: "user",
          createdAt: at,
          legacyNoteId: null,
          legacySource: null,
          confirmedAt: at,
          supersededBy: null,
          retractedAt: null,
        });
        // A pre-existing hidden copy must retire with the original.
        const twin = (yield* a.facts.create(note("ships on fridays"))).fact;
        const replacement = (yield* a.facts.supersede({
          id,
          replacement: note("SHIPS  on Fridays"),
        })).fact;
        expect(replacement).toMatchObject({ status: "confirmed", supersedes: id });
        expect(replacement.supersededBy).toBeUndefined();
        yield* exchange(a, b);
        for (const m of [a, b]) {
          expect((yield* m.facts.list({ status: "confirmed" })).facts.map((f) => f.id)).toEqual([
            replacement.id,
          ]);
          const all = yield* placements(m);
          for (const retired of [id, twin.id])
            expect(all.find((f) => f.id === retired)).toMatchObject({
              status: "superseded",
              supersededBy: replacement.id,
            });
        }
      }).pipe(Effect.scoped),
  );

  it.effect("a fact that arrives before its agent is placed when the agent arrives", () =>
    Effect.gen(function* () {
      const a = yield* machine("machine-a");
      const b = yield* machine("machine-b");
      yield* a.store.save(agent);
      const fact = (yield* a.facts.create(note("Likes short updates"), principal)).fact;
      const outgoing = (yield* a.state.readBatch(0, b.environmentId, true)).changes;
      const agentChange = outgoing.find((change) => change.kind === "agent")!;
      const factChange = outgoing.find((change) => change.kind === "fact")!;
      yield* b.state.receive(
        { after: 0, cursor: 1, changes: [factChange] },
        a.environmentId,
        false,
      );
      expect(yield* b.sql`SELECT id FROM facts`).toEqual([]);
      yield* b.state.receive(
        { after: 1, cursor: 2, changes: [agentChange] },
        a.environmentId,
        false,
      );
      expect((yield* b.facts.list({}, principal)).facts.map((f) => f.id)).toEqual([fact.id]);
      // A replicated fact is local history here, never another replicated change.
      expect(
        (yield* b.facts.history(fact.id)).history.map((entry) => entry.id.startsWith("sync:")),
      ).toEqual([true]);
    }).pipe(Effect.scoped),
  );

  it.effect("legacy memory notes keep their ids on the other machine", () =>
    Effect.gen(function* () {
      const a = yield* machine("machine-a");
      const b = yield* machine("machine-b");
      yield* a.store.save(agent);
      const legacyId = `legacy-memory:${JSON.stringify([agent.id, "note-1"])}`;
      const at = "2026-01-01T00:00:00.000Z";
      const payload = {
        id: legacyId,
        subject: "Agent memory",
        text: "Owner prefers mornings",
        labelIds: [],
        visibility: "user",
        agentId: agent.id,
        status: "confirmed",
        sourceRefs: [],
        createdBy: "user",
        createdAt: at,
        updatedAt: at,
      };
      // As migration 069 left it, before this build captured any fact.
      yield* a.sql`INSERT INTO facts(id,agent_id,legacy_note_id,legacy_source,status,payload_json,updated_at) VALUES (${legacyId},${agent.id},'note-1','owner','confirmed',${JSON.stringify(payload)},${at})`;
      yield* a.state.bootstrap();
      expect((yield* a.state.get("fact", factDocumentId(legacyId)))?.fields.factId).toBe(legacyId);
      yield* exchange(a, b);
      expect(yield* b.store.memory(agent.id)).toEqual([
        expect.objectContaining({ id: "note-1", text: "Owner prefers mornings", source: "owner" }),
      ]);

      yield* b.store.remember({ agentId: agent.id, id: "note-1", text: "Owner prefers evenings" });
      yield* exchange(a, b);
      expect(yield* a.store.memory(agent.id)).toEqual([
        expect.objectContaining({ id: "note-1", text: "Owner prefers evenings" }),
      ]);
      expect(yield* statusOf(a, legacyId as FactId)).toBe("superseded");
      yield* a.store.forget(agent.id, "note-1");
      yield* exchange(a, b);
      expect(yield* b.store.memory(agent.id)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps a newer build's fact field through a local edit and defers what it cannot read",
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* paired;
        const fact = (yield* a.facts.create(note("Reviews on Mondays"), principal)).fact;
        yield* exchange(a, b);
        const id = factDocumentId(fact.id);
        const stored = (yield* a.state.get("fact", id))!;
        const newer = (fields: SharedDocumentChange["fields"]): SharedDocumentChange => ({
          kind: "fact",
          id,
          fields,
          clocks: Object.fromEntries(
            Object.keys(fields).map((key) => [
              key,
              {
                ...stored.clocks.text!,
                logical: stored.clocks.text!.logical + 1,
                node: "machine-a",
              },
            ]),
          ),
          tombstone: null,
          updatedBy: EnvironmentId.make("machine-a"),
        });
        const received = (yield* b.state.cursors(a.environmentId)).received;
        yield* b.state.receive(
          {
            after: received,
            cursor: received + 2,
            changes: [newer({ confidence: 0.9 }), newer({ visibility: "team" })],
          },
          a.environmentId,
          false,
        );
        expect(yield* b.sql`SELECT COUNT(*) AS count FROM shared_deferred_changes`).toEqual([
          { count: 1 },
        ]);
        yield* b.facts.update({ id: fact.id, status: "confirmed" });
        const edited = (yield* b.state.get("fact", id))!;
        expect(edited.fields).toMatchObject({ confidence: 0.9, visibility: "user" });
        expect(edited.fields.confirmedAt).not.toBeNull();
        // An older build without fact documents keeps them for later instead of refusing.
        expect(splitChange({ ...edited, kind: "memory-fact" })).toEqual({
          accepted: null,
          deferred: true,
        });
      }).pipe(Effect.scoped),
  );
});
