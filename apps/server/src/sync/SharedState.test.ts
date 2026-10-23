import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, SharedStateError, type SharedDocumentChange } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { agentFixture } from "../agents/agent.testkit.ts";
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
  it.effect("rejects non-owner edits to sensitive agent and schedule fields", () =>
    Effect.gen(function* () {
      const state = yield* SharedState.SharedState;
      yield* state.write("agent", "agent:owned", {
        name: "Owned",
        ownerMachine: local,
        permissions: {
          read: true,
          draft: true,
          execute: false,
          send: false,
          create_pr: false,
          merge: false,
          deploy: false,
          delete: false,
        },
      });
      const agentClock = (yield* state.get("agent", "agent:owned"))!.clocks.name!;
      const permissionsEdit: SharedDocumentChange = {
        kind: "agent",
        id: "agent:owned",
        fields: {
          permissions: {
            read: true,
            draft: true,
            execute: true,
            send: false,
            create_pr: false,
            merge: false,
            deploy: false,
            delete: false,
          },
        },
        clocks: {
          permissions: { ...agentClock, logical: agentClock.logical + 1, node: peer },
        },
        tombstone: null,
        updatedBy: peer,
      };
      const rejected = yield* Effect.result(state.receive(batch([permissionsEdit]), peer, false));
      expect(rejected._tag).toBe("Failure");
      expect((yield* state.get("agent", "agent:owned"))?.fields.permissions).toEqual({
        read: true,
        draft: true,
        execute: false,
        send: false,
        create_pr: false,
        merge: false,
        deploy: false,
        delete: false,
      });
      // Display-only edits from another machine still merge.
      const nameEdit: SharedDocumentChange = {
        kind: "agent",
        id: "agent:owned",
        fields: { name: "Renamed elsewhere" },
        clocks: { name: { ...agentClock, logical: agentClock.logical + 1, node: peer } },
        tombstone: null,
        updatedBy: peer,
      };
      yield* state.receive(batch([nameEdit]), peer, false);
      expect((yield* state.get("agent", "agent:owned"))?.fields.name).toBe("Renamed elsewhere");

      yield* state.write("schedule", "task:owned", {
        title: "Owned task",
        prompt: "Do work",
        enabled: true,
        ownerMachine: local,
      });
      const scheduleClock = (yield* state.get("schedule", "task:owned"))!.clocks.title!;
      const promptEdit: SharedDocumentChange = {
        kind: "schedule",
        id: "task:owned",
        fields: { prompt: "Do something else" },
        clocks: { prompt: { ...scheduleClock, logical: scheduleClock.logical + 1, node: peer } },
        tombstone: null,
        updatedBy: peer,
      };
      const promptRejected = yield* Effect.result(
        state.receive(batch([promptEdit], 1), peer, false),
      );
      expect(promptRejected._tag).toBe("Failure");
      expect((yield* state.get("schedule", "task:owned"))?.fields.prompt).toBe("Do work");
      const enabledEdit: SharedDocumentChange = {
        kind: "schedule",
        id: "task:owned",
        fields: { enabled: false },
        clocks: { enabled: { ...scheduleClock, logical: scheduleClock.logical + 1, node: peer } },
        tombstone: null,
        updatedBy: peer,
      };
      yield* state.receive(batch([enabledEdit], 1), peer, false);
      expect((yield* state.get("schedule", "task:owned"))?.fields.enabled).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("accepts sensitive edits from the owner machine, including via the hub relay", () =>
    Effect.gen(function* () {
      const state = yield* SharedState.SharedState;
      const created: SharedDocumentChange = {
        kind: "agent",
        id: "agent:peer-owned",
        fields: {
          name: "Peer owned",
          ownerMachine: peer,
          permissions: {
            read: true,
            draft: true,
            execute: false,
            send: false,
            create_pr: false,
            merge: false,
            deploy: false,
            delete: false,
          },
        },
        clocks: {
          name: { wall: 10, logical: 0, node: peer },
          ownerMachine: { wall: 10, logical: 0, node: peer },
          permissions: { wall: 10, logical: 0, node: peer },
        },
        tombstone: null,
        updatedBy: peer,
      };
      yield* state.receive(batch([created]), peer, false);
      const edit: SharedDocumentChange = {
        kind: "agent",
        id: "agent:peer-owned",
        fields: {
          permissions: {
            read: true,
            draft: true,
            execute: true,
            send: false,
            create_pr: false,
            merge: false,
            deploy: false,
            delete: false,
          },
        },
        clocks: { permissions: { wall: 20, logical: 0, node: peer } },
        tombstone: null,
        updatedBy: peer,
      };
      // Relayed by the local hub: authorship stays with the peer owner.
      yield* state.receive(batch([edit]), local, true);
      expect((yield* state.get("agent", "agent:peer-owned"))?.fields.permissions).toEqual({
        read: true,
        draft: true,
        execute: true,
        send: false,
        create_pr: false,
        merge: false,
        deploy: false,
        delete: false,
      });
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
          instructions: "x".repeat(20000),
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
  it.effect(
    "backfills legacy owners and bootstraps configuration without runtime fallback state",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fixture = {
          ...agentFixture(),
          fallbackIndex: 2,
          fallbackUntil: "2026-02-01T00:00:00.000Z",
        };
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(fixture);
        yield* sql`INSERT INTO agents(agent_id,conversation_thread_id,payload_json,enabled,daily_run_cap) VALUES (${fixture.id},${fixture.conversationThreadId},${encoded},1,${fixture.dailyRunCap})`;
        const restarted = yield* Layer.build(
          Layer.fresh(SharedState.layer).pipe(
            Layer.provide(
              Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(local),
              }),
            ),
          ),
        );
        const state = yield* SharedState.SharedState.pipe(Effect.provideContext(restarted));
        yield* state.bootstrap;
        const doc = yield* state.get("agent", fixture.id);
        expect(doc?.fields.ownerMachine).toBe(local);
        expect(doc?.fields.fallbackChain).toEqual([]);
        for (const key of [
          "projectId",
          "fallbackIndex",
          "fallbackUntil",
          "fallbackReason",
          "consecutiveFailures",
          "backoffUntil",
        ])
          expect(doc?.fields).not.toHaveProperty(key);
        expect(
          (yield* sql<{ owner_machine: string }>`SELECT owner_machine FROM agents`)[0]
            ?.owner_machine,
        ).toBe(local);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("incoming agent edits preserve local fallback state until its chain changes", () =>
    Effect.gen(function* () {
      const state = yield* SharedState.SharedState;
      const sql = yield* SqlClient.SqlClient;
      const f = agentFixture();
      const fields = {
        name: f.name,
        avatar: { seed: "one" },
        instructions: f.instructions,
        responsibility: f.responsibility,
        permissions: f.permissions,
        notifyPolicy: f.notifyPolicy,
        modelSelection: { instanceId: f.modelSelection.instanceId, model: f.modelSelection.model },
        fallbackChain: [],
        runtimeMode: f.runtimeMode,
        dailyRunCap: f.dailyRunCap,
        repositoryRemote: null,
        ownerMachine: local,
        createdAt: f.createdAt,
      };
      yield* state.write("agent", f.id, fields);
      yield* sql`UPDATE agents SET payload_json=json_set(payload_json,'$.fallbackIndex',1,'$.fallbackUntil','2026-02-01T00:00:00.000Z') WHERE agent_id=${f.id}`;
      const incoming = {
        ...change({ name: "From another machine" }, 100),
        kind: "agent" as const,
        id: f.id,
      };
      // The local write's clock is the test epoch, so the peer edit must follow that clock.
      const localClock = (yield* state.get("agent", f.id))!.clocks.name!;
      const edit = {
        ...incoming,
        clocks: { name: { ...localClock, logical: localClock.logical + 1, node: peer } },
      };
      yield* state.receive(batch([edit]), peer, false);
      expect(
        (yield* sql<{
          fallback: number;
        }>`SELECT json_extract(payload_json,'$.fallbackIndex') AS fallback FROM agents`)[0]
          ?.fallback,
      ).toBe(1);
      expect((yield* state.get("agent", f.id))?.fields.name).toBe("From another machine");
      const chain = {
        ...change({ fallbackChain: [{ ...f.modelSelection, model: "other" }] }, localClock.wall),
        kind: "agent" as const,
        id: f.id,
      };
      chain.clocks = {
        fallbackChain: { ...localClock, logical: localClock.logical + 2, node: peer },
      };
      // The fallback chain is owner-only: a peer edit is refused, so the
      // local fallback position survives until the owner changes the chain.
      const refused = yield* Effect.result(state.receive(batch([chain], 1), peer, false));
      expect(refused._tag).toBe("Failure");
      expect(
        (yield* sql<{
          fallback: number;
        }>`SELECT json_extract(payload_json,'$.fallbackIndex') AS fallback FROM agents`)[0]
          ?.fallback,
      ).toBe(1);
      yield* state.write("agent", f.id, {
        fallbackChain: [{ ...f.modelSelection, model: "other" }],
      });
      expect(
        (yield* sql<{
          fallback: number;
        }>`SELECT json_extract(payload_json,'$.fallbackIndex') AS fallback FROM agents`)[0]
          ?.fallback,
      ).toBe(0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "schedule configuration merges preserve local run history and reject absolute worktrees",
    () =>
      Effect.gen(function* () {
        const state = yield* SharedState.SharedState;
        const sql = yield* SqlClient.SqlClient;
        const f = agentFixture();
        const fields = {
          agentId: null,
          title: "Check",
          prompt: "Check work",
          enabled: true,
          schedule: { type: "interval", everyMs: 60000 },
          repositoryRemote: null,
          workspaceStrategy: { type: "root" },
          modelSelection: {
            instanceId: f.modelSelection.instanceId,
            model: f.modelSelection.model,
          },
          runtimeMode: f.runtimeMode,
          interactionMode: "default",
          ownerMachine: local,
          createdAt: f.createdAt,
        };
        yield* state.write("schedule", "task:one", fields);
        const before = yield* sql<{ next_run_at: string }>`SELECT next_run_at FROM scheduled_tasks`;
        expect(before[0]?.next_run_at).not.toBeNull();
        yield* sql`UPDATE scheduled_tasks SET run_count=9,last_run_status='succeeded' WHERE task_id='task:one'`;
        const clock = (yield* state.get("schedule", "task:one"))!.clocks.prompt!;
        const edit = {
          ...change({ prompt: "Edited" }, clock.wall),
          kind: "schedule" as const,
          id: "task:one",
          clocks: { prompt: { ...clock, logical: clock.logical + 1, node: peer } },
        };
        // The prompt is owner-only: a peer edit is refused, an owner edit merges.
        expect((yield* Effect.result(state.receive(batch([edit]), peer, false)))._tag).toBe(
          "Failure",
        );
        yield* state.write("schedule", "task:one", { prompt: "Edited" });
        expect(
          yield* sql`SELECT prompt,run_count,last_run_status,next_run_at FROM scheduled_tasks`,
        ).toEqual([
          {
            prompt: "Edited",
            run_count: 9,
            last_run_status: "succeeded",
            next_run_at: before[0]!.next_run_at,
          },
        ]);
        const invalid = {
          ...change({
            workspaceStrategy: { type: "existing_worktree", worktreePath: "/private/repo" },
          }),
          kind: "schedule" as const,
          id: "task:one",
        };
        expect((yield* Effect.result(state.receive(batch([invalid], 1), peer, false)))._tag).toBe(
          "Failure",
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("accepts overlapping committed ranges but never skips a cursor gap", () =>
    Effect.gen(function* () {
      const state = yield* SharedState.SharedState;
      yield* state.receive(batch([change(project)]), peer, false);
      const second = change({ name: "New" }, 20);
      yield* state.receive(
        { after: 0, cursor: 2, changes: [change(project), second] },
        peer,
        false,
      );
      expect((yield* state.cursors(peer)).received).toBe(2);
      expect((yield* state.get("project", "label:peer"))?.fields.name).toBe("New");
      expect(
        (yield* Effect.result(state.receive({ after: 3, cursor: 4, changes: [] }, peer, false)))
          ._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([false, true])(
    "converges concurrent repository moves (reversed delivery: %s)",
    (reversed) =>
      Effect.gen(function* () {
        const state = yield* SharedState.SharedState;
        const sql = yield* SqlClient.SqlClient;
        const a = {
          ...change(
            {
              ...project,
              name: "A",
              repositories: [{ remote: "github.com/org/repo", directoryName: "repo" }],
            },
            20,
          ),
          id: "label:a",
        };
        const b = {
          ...change(
            {
              ...project,
              name: "B",
              repositories: [{ remote: "github.com/org/repo", directoryName: "repo" }],
            },
            10,
          ),
          id: "label:b",
        };
        yield* state.receive(
          { after: 0, cursor: 2, changes: reversed ? [b, a] : [a, b] },
          peer,
          false,
        );
        expect(yield* sql`SELECT label_id,remote FROM label_repositories`).toEqual([
          { label_id: "label:a", remote: "github.com/org/repo" },
        ]);
        // Bind this machine's clone, then delete the winning project. The other
        // project's still-live intent wins without losing the local clone location.
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('local-repo','Repo','/private/local/checkout','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
        yield* sql`UPDATE label_repositories SET repository_id='local-repo',directory_name='checkout' WHERE label_id='label:a'`;
        yield* state.capture("project", "label:a");
        const deletion = {
          ...change({}, 30),
          id: "label:a",
          tombstone: { wall: 30, logical: 0, node: peer },
        };
        yield* state.receive({ after: 2, cursor: 3, changes: [deletion] }, peer, false);
        expect(
          yield* sql`SELECT label_id,repository_id,directory_name FROM label_repositories`,
        ).toEqual([
          { label_id: "label:b", repository_id: "local-repo", directory_name: "checkout" },
        ]);
        expect((yield* state.get("project", "label:b"))?.fields).not.toHaveProperty(
          "workspaceRoot",
        );
        yield* sql`UPDATE projection_projects SET deleted_at='2026-01-02T00:00:00.000Z' WHERE project_id='local-repo'`;
        expect(yield* sql`SELECT label_id,repository_id,remote FROM label_repositories`).toEqual([
          {
            label_id: "label:b",
            repository_id: "remote:github.com/org/repo",
            remote: "github.com/org/repo",
          },
        ]);
      }).pipe(Effect.provide(layer)),
  );
});
