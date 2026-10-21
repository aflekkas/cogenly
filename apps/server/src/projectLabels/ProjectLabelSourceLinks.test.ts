import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProjectLabelId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Labels from "./ProjectLabelService.ts";

const database = Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer));
const persistence = Events.layer.pipe(Layer.provideMerge(database));
const layer = Labels.layer.pipe(Layer.provideMerge(persistence), Layer.provide(NodeServices.layer));
const identities = Layer.succeed(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  RepositoryIdentityResolver.RepositoryIdentityResolver.of({
    resolve: (cwd) =>
      Effect.succeed(
        cwd === "/repos/repo-a"
          ? {
              canonicalKey: "github.com/spawn-partners/acme",
              locator: {
                source: "git-remote" as const,
                remoteName: "origin",
                remoteUrl: "https://github.com/spawn-partners/acme.git",
              },
              provider: "github",
              owner: "spawn-partners",
              name: "acme",
            }
          : null,
      ),
  }),
);
const layerWithIdentities = layer.pipe(Layer.provideMerge(identities));

const repoA = ProjectId.make("repo-a");
const repoB = ProjectId.make("repo-b");
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const repo of [repoA, repoB]) {
    yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${repo}, ${repo}, ${`/repos/${repo}`}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  }
});

describe("project source links", () => {
  it.effect("links and unlinks an owner", () =>
    Effect.gen(function* () {
      yield* seed;
      const folders = yield* Labels.ProjectLabelService;
      const { label } = yield* folders.create({ name: "Spawn Partners" });

      const linked = yield* folders.linkSource({
        id: label.id,
        link: { kind: "github-owner", owner: "spawn-partners" },
      });
      expect(linked.label.sourceLinks).toEqual([{ kind: "github-owner", owner: "spawn-partners" }]);

      const relinked = yield* folders.linkSource({
        id: label.id,
        link: { kind: "github-owner", owner: "spawn-partners" },
      });
      expect(relinked.label.sourceLinks).toHaveLength(1);

      const unlinked = yield* folders.unlinkSource({
        id: label.id,
        link: { kind: "github-owner", owner: "spawn-partners" },
      });
      expect(unlinked.label.sourceLinks).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("links a repository alongside an owner", () =>
    Effect.gen(function* () {
      yield* seed;
      const folders = yield* Labels.ProjectLabelService;
      const { label } = yield* folders.create({ name: "Spawn Partners" });

      yield* folders.linkSource({
        id: label.id,
        link: { kind: "github-owner", owner: "spawn-partners" },
      });
      const linked = yield* folders.linkSource({
        id: label.id,
        link: { kind: "github-repo", owner: "someone-else", repo: "solo" },
      });
      expect(linked.label.sourceLinks).toEqual([
        { kind: "github-owner", owner: "spawn-partners" },
        { kind: "github-repo", owner: "someone-else", repo: "solo" },
      ]);

      const listed = yield* folders.list();
      expect(listed.labels.find((entry) => entry.id === label.id)?.sourceLinks).toEqual(
        linked.label.sourceLinks,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads fresh labels with no source links", () =>
    Effect.gen(function* () {
      yield* seed;
      const folders = yield* Labels.ProjectLabelService;
      const { label } = yield* folders.create({ name: "Fresh" });
      expect(label.sourceLinks).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects links on unknown projects", () =>
    Effect.gen(function* () {
      yield* seed;
      const folders = yield* Labels.ProjectLabelService;
      const failure = yield* folders
        .linkSource({
          id: ProjectLabelId.make("label:missing"),
          link: { kind: "github-owner", owner: "spawn-partners" },
        })
        .pipe(Effect.flip);
      expect(failure.reason).toBe("not_found");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("files a linked repository's own GitHub link", () =>
    Effect.gen(function* () {
      yield* seed;
      const folders = yield* Labels.ProjectLabelService;
      const { label } = yield* folders.create({ name: "Spawn Partners" });

      const linked = yield* folders.linkRepository({
        labelId: label.id,
        repositoryId: repoA,
      });
      expect(linked.label.sourceLinks).toEqual([
        { kind: "github-repo", owner: "spawn-partners", repo: "acme" },
      ]);
    }).pipe(Effect.provide(layerWithIdentities)),
  );

  it.effect("adds nothing when the repository has no GitHub remote", () =>
    Effect.gen(function* () {
      yield* seed;
      const folders = yield* Labels.ProjectLabelService;
      const { label } = yield* folders.create({ name: "Spawn Partners" });

      const linked = yield* folders.linkRepository({
        labelId: label.id,
        repositoryId: repoB,
      });
      expect(linked.label.sourceLinks).toEqual([]);
    }).pipe(Effect.provide(layerWithIdentities)),
  );

  it.effect("keeps source links when the repository is unlinked", () =>
    Effect.gen(function* () {
      yield* seed;
      const folders = yield* Labels.ProjectLabelService;
      const { label } = yield* folders.create({ name: "Spawn Partners" });

      yield* folders.linkRepository({ labelId: label.id, repositoryId: repoA });
      const unlinked = yield* folders.unlinkRepository({
        labelId: label.id,
        repositoryId: repoA,
      });
      expect(unlinked.label.repositoryIds).toEqual([]);
      expect(unlinked.label.sourceLinks).toEqual([
        { kind: "github-repo", owner: "spawn-partners", repo: "acme" },
      ]);
    }).pipe(Effect.provide(layerWithIdentities)),
  );
});
