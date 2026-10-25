import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Labels from "../projectLabels/ProjectLabelService.ts";
import { layerIdentity } from "./testkit.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const layer = Labels.layer.pipe(
  Layer.provide(layerIdentity),
  Layer.provide(
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: (cwd) =>
        Effect.succeed({
          canonicalKey: cwd,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: "git@github.com:org/repo.git",
          },
          rootPath: cwd,
        }),
    }),
  ),
  Layer.provideMerge(Events.layer.pipe(Layer.provideMerge(database))),
  Layer.provide(NodeServices.layer),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of ["clone-one", "clone-two"])
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${id},${id},${`/repos/${id}`},'[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
});

describe("local shared document captures", () => {
  it.effect("a failed lazy capture never makes project reads fail", () =>
    Effect.gen(function* () {
      yield* seed;
      const labels = yield* Labels.ProjectLabelService;
      const id = (yield* labels.create({ name: "Legacy" })).label.id;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${id},'clone-one')`;
      yield* sql`CREATE TRIGGER reject_capture BEFORE INSERT ON shared_changes BEGIN SELECT RAISE(ABORT,'capture unavailable'); END`;
      expect((yield* labels.list()).labels[0]?.repositoryIds).toEqual(["clone-one"]);
      expect((yield* labels.read(id)).label.repositories?.[0]?.remote).toBe("github.com/org/repo");
    }).pipe(Effect.provide(layer)),
  );
  it.effect("keeps two local clones of the same remote linked", () =>
    Effect.gen(function* () {
      yield* seed;
      const labels = yield* Labels.ProjectLabelService;
      const id = (yield* labels.create({ name: "Clones" })).label.id;
      for (const clone of ["clone-one", "clone-two"])
        yield* labels.linkRepository({ labelId: id, repositoryId: ProjectId.make(clone) });
      yield* labels.update({ id, name: "Renamed" });
      expect((yield* labels.read(id)).label.repositoryIds).toEqual(["clone-one", "clone-two"]);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("moving a repository captures both projects without unlinking the destination", () =>
    Effect.gen(function* () {
      yield* seed;
      const labels = yield* Labels.ProjectLabelService;
      const a = (yield* labels.create({ name: "A" })).label.id;
      const b = (yield* labels.create({ name: "B" })).label.id;
      const repositoryId = ProjectId.make("clone-one");
      yield* labels.linkRepository({ labelId: a, repositoryId });
      yield* labels.linkRepository({ labelId: b, repositoryId });
      expect((yield* labels.read(a)).label.repositoryIds).toEqual([]);
      expect((yield* labels.read(b)).label.repositoryIds).toEqual([repositoryId]);
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql`SELECT id,json_extract(fields_json,'$.repositories') AS repositories FROM shared_documents WHERE kind='project' ORDER BY id`,
      ).toEqual(
        [
          { id: a, repositories: "[]" },
          {
            id: b,
            // Synced under the name its remote derives, not the checkout's folder.
            repositories: '[{"remote":"github.com/org/repo","directoryName":"org/repo"}]',
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
    }).pipe(Effect.provide(layer)),
  );
});
