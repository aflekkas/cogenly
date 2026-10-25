import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProjectLabelId, ProjectRepositoryMismatchError } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Folders from "./ProjectLabelFolders.ts";
import * as Membership from "./ProjectRepositoryMembership.ts";

const encodeMismatch = Schema.encodeEffect(ProjectRepositoryMismatchError);
const decodeMismatch = Schema.decodeEffect(ProjectRepositoryMismatchError);

const projectId = ProjectId.make("repo:cogenly");
const projectFolderId = ProjectLabelId.make("label:spawn");
const database = Sqlite.layerMemory;
const layer = Membership.layer.pipe(
  Layer.provideMerge(database),
  Layer.provide(Config.layerTest(process.cwd(), "/tmp/cogenly-membership-test")),
  Layer.provide(
    Layer.mock(Folders.ProjectLabelFolders)({
      dirForLabel: () =>
        Effect.succeed({ dir: "/projects/Spawn Partners", dirName: "Spawn Partners" }),
    }),
  ),
  Layer.provide(NodeServices.layer),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO project_labels(label_id,name,created_at,updated_at)
    VALUES (${projectFolderId},'Spawn Partners','2026-01-01','2026-01-01')`;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'cogenly','/repos/cogenly','[]','2026-01-01','2026-01-01')`;
});

describe("project repository membership", () => {
  it.effect("rejects an unlinked repository with a serializable typed error", () =>
    Effect.gen(function* () {
      yield* seed;
      const membership = yield* Membership.ProjectRepositoryMembership;
      const error = yield* Effect.flip(membership.validate({ projectId, projectFolderId }));
      expect(error._tag).toBe("ProjectRepositoryMismatchError");
      expect(error.message).toBe(
        "cogenly is not in the Spawn Partners project. Add it to the project first, or start without a project.",
      );
      if (error._tag === "ProjectRepositoryMismatchError") {
        const encoded = yield* encodeMismatch(error);
        expect((yield* decodeMismatch(encoded)).message).toBe(error.message);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("accepts a linked repository and a start without a project", () =>
    Effect.gen(function* () {
      yield* seed;
      const membership = yield* Membership.ProjectRepositoryMembership;
      yield* membership.validate({ projectId });
      yield* membership.validate({ projectId, projectFolderId: null });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO label_repositories(label_id,repository_id) VALUES (${projectFolderId},${projectId})`;
      yield* membership.validate({ projectId, projectFolderId });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("exempts scratch and the project's own folder, but not another project's folder", () =>
    Effect.gen(function* () {
      yield* seed;
      const membership = yield* Membership.ProjectRepositoryMembership;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET workspace_root='/tmp/cogenly-membership-test/scratch' WHERE project_id=${projectId}`;
      yield* membership.validate({ projectId, projectFolderId });
      yield* sql`UPDATE projection_projects SET workspace_root='/projects/Spawn Partners' WHERE project_id=${projectId}`;
      yield* membership.validate({ projectId, projectFolderId });
      yield* sql`UPDATE projection_projects SET workspace_root='/projects/Other' WHERE project_id=${projectId}`;
      expect((yield* Effect.flip(membership.validate({ projectId, projectFolderId })))._tag).toBe(
        "ProjectRepositoryMismatchError",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("checks portable launches against the selected label's remotes", () =>
    Effect.gen(function* () {
      yield* seed;
      const membership = yield* Membership.ProjectRepositoryMembership;
      const remote = "github.com/acme/cogenly";
      expect(
        (yield* Effect.flip(
          membership.validate({ projectId, projectFolderId, repositoryRemote: remote }),
        ))._tag,
      ).toBe("ProjectRepositoryMismatchError");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO label_repositories(label_id,repository_id,remote) VALUES (${projectFolderId},'remote:github.com/acme/cogenly',${remote})`;
      yield* membership.validate({ projectId, projectFolderId, repositoryRemote: remote });
      yield* membership.validate({
        projectId: ProjectId.make(`remote:${remote}`),
        projectFolderId,
      });
    }).pipe(Effect.provide(layer)),
  );
});
