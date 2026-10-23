import { layerIdentity as layerSharedIdentity } from "../sync/testkit.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectLabelId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Folders from "./ProjectLabelFolders.ts";
import * as Labels from "./ProjectLabelService.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const persistence = Events.layer.pipe(Layer.provideMerge(database));

const foldersLayer = (prefix: string) =>
  Folders.layer.pipe(
    Layer.provideMerge(database),
    Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix })),
    Layer.provideMerge(ServerSettings.layerTest({})),
    Layer.provideMerge(NodeServices.layer),
  );

const labelsLayer = (prefix: string) =>
  Labels.layer
    .pipe(Layer.provide(layerSharedIdentity))
    .pipe(
      Layer.provideMerge(persistence),
      Layer.provideMerge(foldersLayer(prefix)),
      Layer.provideMerge(NodeServices.layer),
    );

const seedLabel = (id: string, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_labels(label_id, name, created_at, updated_at) VALUES (${id}, ${name}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  });

const idFileOf = (dir: string) => `${dir}/.cogenly-project.json`;

describe("project label folders", () => {
  it.effect("creates the folder, id file and Resources on ensure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folders = yield* Folders.ProjectLabelFolders;
      const label = { id: ProjectLabelId.make("label:spawn"), name: "Spawn Partners" };
      const { dir } = yield* folders.ensureForLabel(label);
      expect(dir.endsWith("/projects/Spawn Partners")).toBe(true);
      expect((yield* fs.readFileString(idFileOf(dir))).trim()).toBe(`{"id":"${label.id}"}`);
      expect((yield* fs.stat(`${dir}/Resources`)).type).toBe("Directory");
      // Idempotent: a second ensure keeps the same folder.
      expect((yield* folders.ensureForLabel(label)).dir).toBe(dir);
    }).pipe(Effect.provide(foldersLayer("label-folders-ensure"))),
  );

  it.effect("creates the folder when the label is created and renames it on rename", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const labels = yield* Labels.ProjectLabelService;
      const folders = yield* Folders.ProjectLabelFolders;
      const created = yield* labels.create({ name: "Spawn Partners" });
      const first = (yield* folders.dirForLabel(created.label)).dir;
      expect((yield* fs.stat(first)).type).toBe("Directory");
      expect(yield* fs.readFileString(idFileOf(first))).toContain(created.label.id);
      const renamed = yield* labels.update({ id: created.label.id, name: "Spawned" });
      expect(renamed.label.name).toBe("Spawned");
      const second = (yield* folders.dirForLabel(renamed.label)).dir;
      expect(second).toBe(path.join(path.dirname(first), "Spawned"));
      expect((yield* fs.stat(second)).type).toBe("Directory");
      expect(yield* fs.exists(first)).toBe(false);
      expect(yield* fs.readFileString(idFileOf(second))).toContain(created.label.id);
    }).pipe(Effect.provide(labelsLayer("label-folders-hooks"))),
  );

  it.effect("reconcile adopts a Finder-renamed folder by its id file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folders = yield* Folders.ProjectLabelFolders;
      const id = ProjectLabelId.make("label:renamed");
      yield* seedLabel(id, "Spawn Partners");
      const root = yield* folders.projectsRoot;
      // The user renamed the folder in Finder; the id file still matches.
      const renamed = path.join(root, "Totally Different Name");
      yield* fs.makeDirectory(renamed, { recursive: true });
      yield* fs.writeFileString(idFileOf(renamed), `{"id":"${id}"}\n`);
      const summary = yield* folders.reconcile;
      expect(summary).toEqual({ labels: 1, folders: 1 });
      expect((yield* folders.dirForLabel({ id, name: "Spawn Partners" })).dir).toBe(renamed);
      // No second folder is created for the sanitized name.
      expect(yield* fs.exists(path.join(root, "Spawn Partners"))).toBe(false);
    }).pipe(Effect.provide(foldersLayer("label-folders-reconcile"))),
  );

  it.effect("reconcile creates folders for labels that predate them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const folders = yield* Folders.ProjectLabelFolders;
      yield* seedLabel("label:legacy", "Legacy Label");
      const summary = yield* folders.reconcile;
      expect(summary).toEqual({ labels: 1, folders: 1 });
      const { dir } = yield* folders.dirForLabel({
        id: ProjectLabelId.make("label:legacy"),
        name: "Legacy Label",
      });
      expect((yield* fs.stat(dir)).type).toBe("Directory");
      expect(yield* fs.readFileString(idFileOf(dir))).toContain("label:legacy");
    }).pipe(Effect.provide(foldersLayer("label-folders-legacy"))),
  );

  it.effect("suffices when a foreign folder holds the sanitized name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folders = yield* Folders.ProjectLabelFolders;
      const root = yield* folders.projectsRoot;
      const taken = path.join(root, "Spawn Partners");
      yield* fs.makeDirectory(taken, { recursive: true });
      yield* fs.writeFileString(path.join(taken, "someone-else.txt"), "not ours");
      const { dir } = yield* folders.ensureForLabel({
        id: ProjectLabelId.make("label:new"),
        name: "Spawn Partners",
      });
      expect(dir).toBe(path.join(root, "Spawn Partners (2)"));
      expect(yield* fs.readFileString(path.join(taken, "someone-else.txt"))).toBe("not ours");
    }).pipe(Effect.provide(foldersLayer("label-folders-collision"))),
  );
});
