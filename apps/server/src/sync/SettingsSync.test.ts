import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
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
    sync: yield* SharedSync.SharedSync.pipe(services),
    settings: yield* ServerSettings.ServerSettingsService.pipe(services),
    reconcile: (yield* SettingsSync.SettingsSync.pipe(services)).reconcile,
  };
});

describe("settings sync between paired machines", () => {
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
          projectsRoot: "/srv/projects",
          projectSettingsOverrides: { [hubRepository]: { defaultAutoPull: true } },
        });
        yield* exchange;
        const onSpoke = yield* spoke.settings.getSettings;
        expect(onSpoke.branchNamePrefix).toBe("feat");
        expect(onSpoke.projectsRoot).toBe("");
        expect(onSpoke.projectSettingsOverrides[spokeRepository]).toEqual({
          defaultAutoPull: true,
        });

        // The way back: an edit and a reset on the spoke reach the hub.
        yield* spoke.settings.updateSettings({
          branchNamePrefix: "fix",
          projectSettingsOverrides: { [spokeRepository]: null },
        });
        yield* exchange;
        const onHub = yield* hub.settings.getSettings;
        expect(onHub.branchNamePrefix).toBe("fix");
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
});
