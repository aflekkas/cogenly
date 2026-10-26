import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ProjectId } from "@cogenly/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Machines from "../machines/Machines.ts";
import { pair, startMachine } from "../machines/testkit.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SettingsSync from "./SettingsSync.ts";
import * as SharedState from "./SharedState.ts";
import * as SharedSync from "./SharedSync.ts";

const LABEL = "label:shared";
const at = "2026-01-01T00:00:00.000Z";

/** A paired machine with settings sync driven by explicit passes, no watchers. */
const start = Effect.fn("startSettingsMachine")(function* (
  name: string,
  role: "computer" | "cloud-server",
  repository: ProjectId,
) {
  const machine = yield* startMachine(name, role);
  const sql = yield* machine.run(SqlClient.SqlClient);
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${repository},${repository},${`/repos/${repository}`},'[]',${at},${at})`;
  yield* sql`INSERT INTO project_labels(label_id,name,created_at,updated_at) VALUES (${LABEL},'Shared',${at},${at})`;
  yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${LABEL},${repository})`;
  const stateContext = yield* machine.run(Layer.build(SharedState.layer));
  const state = yield* SharedState.SharedState.pipe(Effect.provideContext(stateContext));
  const quietState = Layer.succeed(SharedState.SharedState, { ...state, changes: Stream.never });
  const syncContext = yield* machine.run(
    Layer.build(
      Layer.mergeAll(
        SharedSync.layer.pipe(
          Layer.provide(
            Layer.succeed(Machines.Machines, { ...machine.machines, subscribe: Stream.never }),
          ),
          Layer.provide(Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void })),
        ),
        SettingsSync.layerWithoutWatch,
      ).pipe(Layer.provideMerge(ServerSettings.layerTest()), Layer.provide(quietState)),
    ),
  );
  const services = Effect.provideContext(syncContext);
  return {
    ...machine,
    state,
    sync: yield* SharedSync.SharedSync.pipe(services),
    settings: yield* ServerSettings.ServerSettingsService.pipe(services),
    reconcile: (yield* SettingsSync.SettingsSync.pipe(services)).reconcile,
  };
});

describe("settings sync between paired machines", () => {
  it.live(
    "universal settings follow the user; machine-local ones stay",
    () =>
      Effect.gen(function* () {
        const hubRepository = ProjectId.make("hub-checkout");
        const spokeRepository = ProjectId.make("spoke-checkout");
        const hub = yield* start("settings-hub", "cloud-server", hubRepository);
        const spoke = yield* start("settings-spoke", "computer", spokeRepository);
        yield* pair(hub, spoke);
        const exchange = Effect.gen(function* () {
          yield* hub.reconcile;
          yield* spoke.reconcile;
          yield* spoke.sync.sync(hub.environmentId);
          yield* hub.reconcile;
          yield* spoke.reconcile;
        });

        yield* hub.settings.updateSettings({
          branchNamePrefix: "feat",
          aiGreetings: false,
          clientAppearanceAccent: "blue",
          clientFollowUpBehavior: "queue",
          sharedKeybindings: [{ key: "mod+shift+k", command: "settings.open" }],
          projectsRoot: "/srv/projects",
        });
        yield* exchange;
        const onSpoke = yield* spoke.settings.getSettings;
        expect(onSpoke.branchNamePrefix).toBe("feat");
        expect(onSpoke.aiGreetings).toBe(false);
        expect(onSpoke.clientAppearanceAccent).toBe("blue");
        expect(onSpoke.clientFollowUpBehavior).toBe("queue");
        expect(onSpoke.sharedKeybindings).toEqual([
          { key: "mod+shift+k", command: "settings.open" },
        ]);
        expect(onSpoke.projectsRoot).toBe("");

        // The way back: an edit and a reset on the spoke reach the hub.
        yield* spoke.settings.updateSettings({
          branchNamePrefix: "fix",
          aiGreetings: true,
          clientAppearanceAccent: "orange",
          sharedKeybindings: [],
        });
        yield* exchange;
        const onHub = yield* hub.settings.getSettings;
        expect(onHub.branchNamePrefix).toBe("fix");
        expect(onHub.aiGreetings).toBe(true);
        expect(onHub.clientAppearanceAccent).toBe("orange");
        expect(onHub.clientFollowUpBehavior).toBe("queue");
        expect(onHub.sharedKeybindings).toEqual([]);
        expect(onHub.projectsRoot).toBe("/srv/projects");

        // Settled: another pass changes nothing on either side.
        const before = yield* hub.run(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`SELECT COUNT(*) AS count FROM shared_changes`,
          ),
        );
        yield* exchange;
        expect(
          yield* hub.run(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) => sql`SELECT COUNT(*) AS count FROM shared_changes`,
            ),
          ),
        ).toEqual(before);
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "a machine that never customized a setting adopts its peer's value",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("adopt-hub", "cloud-server", ProjectId.make("adopt-hub-repo"));
        const spoke = yield* start("adopt-spoke", "computer", ProjectId.make("adopt-spoke-repo"));
        yield* hub.settings.updateSettings({ branchNamingMode: "semantic" });
        // Both machines ran their first pass before they were paired.
        yield* hub.reconcile;
        yield* spoke.reconcile;
        yield* pair(hub, spoke);
        yield* spoke.sync.sync(hub.environmentId);
        yield* spoke.reconcile;
        expect((yield* spoke.settings.getSettings).branchNamingMode).toBe("semantic");
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "an older build keeps syncing past a newer build's settings and keeps what it cannot read",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("newer-hub", "cloud-server", ProjectId.make("newer-hub-repo"));
        const spoke = yield* start("older-spoke", "computer", ProjectId.make("older-spoke-repo"));
        yield* pair(hub, spoke);
        // What another build sends: a key this build lacks (as useProviderConnectors
        // is to builds after its removal), a value it cannot read for a key it
        // knows, and values it can.
        const fields = {
          branchNamePrefix: "feat",
          branchNamingMode: "lunar",
          accentTheme: "dark",
          useProviderConnectors: true,
        };
        const wall = yield* Clock.currentTimeMillis;
        const after = (yield* spoke.state.cursors(hub.environmentId)).received;
        yield* spoke.state.receive(
          {
            after,
            cursor: after + 1,
            changes: [
              {
                kind: "settings",
                id: "universal",
                fields,
                clocks: Object.fromEntries(
                  Object.keys(fields).map((key) => [
                    key,
                    { wall, logical: 0, node: hub.environmentId },
                  ]),
                ),
                tombstone: null,
                updatedBy: hub.environmentId,
              },
            ],
          },
          hub.environmentId,
          false,
        );
        expect((yield* spoke.state.cursors(hub.environmentId)).received).toBe(after + 1);
        yield* spoke.reconcile;
        const settings = yield* spoke.settings.getSettings;
        expect(settings.branchNamePrefix).toBe("feat");
        expect(settings.branchNamingMode).toBe("static");
        // The unknown key stays in the document; the unreadable value waits for an update.
        expect((yield* spoke.state.get("settings", "universal"))?.fields).toEqual({
          branchNamePrefix: "feat",
          accentTheme: "dark",
          useProviderConnectors: true,
        });
        const sql = yield* spoke.run(SqlClient.SqlClient);
        expect(
          (yield* sql<{ count: number }>`SELECT count(*) AS count FROM shared_deferred_changes`)[0]
            ?.count,
        ).toBe(1);

        // A later local edit publishes without dropping the newer key.
        yield* spoke.settings.updateSettings({ branchNamePrefix: "fix" });
        yield* spoke.reconcile;
        expect((yield* spoke.state.get("settings", "universal"))?.fields).toMatchObject({
          branchNamePrefix: "fix",
          accentTheme: "dark",
        });
      }).pipe(Effect.scoped),
    20000,
  );
  it.live(
    "provider IDs, metadata and models converge without secrets entering shared events",
    () =>
      Effect.gen(function* () {
        const hub = yield* start("provider-hub", "cloud-server", ProjectId.make("hub"));
        const mac = yield* start("provider-mac", "computer", ProjectId.make("mac"));
        yield* pair(hub, mac);
        const id = ProviderInstanceId.make("claude-personal");
        const driver = ProviderDriverKind.make("claudeAgent");
        yield* mac.settings.updateSettings({
          providerInstances: {
            [id]: {
              driver,
              displayName: "Personal",
              accentColor: "blue",
              enabled: true,
              config: {
                homePath: "/mac-only",
                customModels: ["private-model"],
                password: "NEVER_IN_EVENTS",
              },
              environment: [
                { name: "LANG", value: "C", sensitive: false },
                { name: "TOKEN", value: "NEVER_IN_EVENTS", sensitive: true },
              ],
            },
          },
        });
        yield* mac.reconcile;
        yield* hub.reconcile;
        yield* mac.sync.sync(hub.environmentId);
        yield* hub.reconcile;
        const copied = (yield* hub.settings.getSettings).providerInstances[id];
        expect(copied).toMatchObject({
          driver,
          displayName: "Personal",
          accentColor: "blue",
          enabled: true,
          environment: [{ name: "LANG", value: "C", sensitive: false }],
          config: {
            customModels: ["private-model"],
            homePath: "~/.cogenly/provider-homes/claude-personal",
          },
        });
        const sql = yield* hub.run(SqlClient.SqlClient);
        expect(
          (yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM shared_changes WHERE change_json LIKE '%NEVER_IN_EVENTS%'`)[0]
            ?.count,
        ).toBe(0);
        yield* hub.settings.updateSettings({ providerInstances: {} });
        yield* hub.reconcile;
        yield* mac.sync.sync(hub.environmentId);
        yield* mac.reconcile;
        expect((yield* mac.settings.getSettings).providerInstances[id]).toBeUndefined();
      }).pipe(Effect.scoped),
    20000,
  );
});
