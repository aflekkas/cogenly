import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@cogenly/contracts";
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
  it.live("late source overrides follow a merged project and an explicit target reset wins", () =>
    Effect.gen(function* () {
      const repository = ProjectId.make("merge-settings-repo");
      const machine = yield* start("merge-settings", "cloud-server", repository);
      yield* machine.state.write(
        "project",
        "label:source",
        { mergedInto: LABEL, mergeSourceName: "Source" },
        true,
      );
      yield* machine.state.write("project-settings", "label:source", {
        enableAgentBrowserAccess: { value: false },
      });
      yield* machine.reconcile;
      expect(
        (yield* machine.settings.getSettings).projectSettingsOverrides[repository]
          ?.enableAgentBrowserAccess,
      ).toBe(false);
      yield* machine.state.write("project-settings", LABEL, { enableAgentBrowserAccess: null });
      yield* machine.reconcile;
      expect(
        (yield* machine.settings.getSettings).projectSettingsOverrides[repository]
          ?.enableAgentBrowserAccess,
      ).toBeUndefined();
    }),
  );

  it.live(
    "lifecycle scripts stay local in universal settings and project overrides",
    () =>
      Effect.gen(function* () {
        const hubRepository = ProjectId.make("scripts-hub-repo");
        const spokeRepository = ProjectId.make("scripts-spoke-repo");
        const hub = yield* start("scripts-hub", "cloud-server", hubRepository);
        const spoke = yield* start("scripts-spoke", "computer", spokeRepository);
        yield* pair(hub, spoke);
        const scripts = [
          {
            id: "setup",
            name: "Setup",
            command: "echo peer-script",
            icon: "play" as const,
            runOnWorktreeCreate: true,
            runOnSettle: true,
          },
        ];
        yield* hub.settings.updateSettings({
          defaultProjectScripts: scripts,
          projectSettingsOverrides: { [hubRepository]: { defaultProjectScripts: scripts } },
        });
        yield* hub.reconcile;
        yield* spoke.reconcile;
        yield* spoke.sync.sync(hub.environmentId);
        yield* hub.reconcile;
        yield* spoke.reconcile;
        const local = yield* hub.settings.getSettings;
        const remote = yield* spoke.settings.getSettings;
        expect(local.defaultProjectScripts).toEqual(scripts);
        expect(local.projectSettingsOverrides[hubRepository]?.defaultProjectScripts).toEqual(
          scripts,
        );
        expect(remote.defaultProjectScripts).toEqual([]);
        expect(
          remote.projectSettingsOverrides[spokeRepository]?.defaultProjectScripts,
        ).toBeUndefined();
        expect((yield* hub.state.get("settings", "universal"))?.fields ?? {}).not.toHaveProperty(
          "defaultProjectScripts",
        );
        expect((yield* hub.state.get("project-settings", LABEL))?.fields ?? {}).not.toHaveProperty(
          "defaultProjectScripts",
        );
      }).pipe(Effect.scoped),
    20000,
  );

  it.live(
    "universal settings and project overrides follow the user; machine-local ones stay",
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
          projectSettingsOverrides: { [hubRepository]: { defaultAutoPull: true } },
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
        expect(onSpoke.projectSettingsOverrides[spokeRepository]).toEqual({
          defaultAutoPull: true,
        });

        // The way back: an edit and a reset on the spoke reach the hub.
        yield* spoke.settings.updateSettings({
          branchNamePrefix: "fix",
          aiGreetings: true,
          clientAppearanceAccent: "orange",
          sharedKeybindings: [],
          projectSettingsOverrides: { [spokeRepository]: null },
        });
        yield* exchange;
        const onHub = yield* hub.settings.getSettings;
        expect(onHub.branchNamePrefix).toBe("fix");
        expect(onHub.aiGreetings).toBe(true);
        expect(onHub.clientAppearanceAccent).toBe("orange");
        expect(onHub.clientFollowUpBehavior).toBe("queue");
        expect(onHub.sharedKeybindings).toEqual([]);
        expect(onHub.projectsRoot).toBe("/srv/projects");
        expect(onHub.projectSettingsOverrides[hubRepository]).toBeUndefined();

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
    "Use only Cogenly integrations follows the user between the Mac and the VPS",
    () =>
      Effect.gen(function* () {
        const vps = yield* start("connectors-vps", "cloud-server", ProjectId.make("vps-repo"));
        const mac = yield* start("connectors-mac", "computer", ProjectId.make("mac-repo"));
        yield* pair(vps, mac);
        const exchange = Effect.gen(function* () {
          yield* vps.reconcile;
          yield* mac.reconcile;
          yield* mac.sync.sync(vps.environmentId);
          yield* vps.reconcile;
          yield* mac.reconcile;
        });
        // On by default on both: native servers stay off everywhere.
        expect((yield* mac.settings.getSettings).useProviderConnectors).toBe(false);

        // Turning it off on the Mac restores native servers on the VPS too.
        yield* mac.settings.updateSettings({ useProviderConnectors: true });
        yield* exchange;
        expect((yield* vps.settings.getSettings).useProviderConnectors).toBe(true);
        expect((yield* vps.state.get("settings", "universal"))?.fields).toMatchObject({
          useProviderConnectors: true,
        });
        // The import prompt is per machine: what it reviewed is that machine's config.
        yield* mac.settings.updateSettings({ nativeMcpImportReviewed: true });
        yield* exchange;
        expect((yield* vps.settings.getSettings).nativeMcpImportReviewed).toBe(false);

        // And back on from the VPS.
        yield* vps.settings.updateSettings({ useProviderConnectors: false });
        yield* exchange;
        expect((yield* mac.settings.getSettings).useProviderConnectors).toBe(false);
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
        // What a newer hub sends: a key this build lacks (as useProviderConnectors
        // is to builds before it), a value it cannot read for a key it knows, and
        // values it can.
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
        expect(settings.useProviderConnectors).toBe(true);
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
});
