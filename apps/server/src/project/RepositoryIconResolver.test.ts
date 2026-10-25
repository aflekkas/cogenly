// @effect-diagnostics nodeBuiltinImport:off - tests lay out checkouts on disk.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as GitHubRest from "@cogenly/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectConfigFileLoader from "./ProjectConfigFileLoader.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as RepositoryIconResolver from "./RepositoryIconResolver.ts";

const REMOTE = "github.com/spawn-partners/platform";

/** GitHub's contents API answering for one file, counting its calls. */
const gitHub = (calls: { count: number }, files: Record<string, string>) =>
  Layer.mock(GitHubRest.GitHubRest)({
    rest: (input) =>
      Effect.sync(() => {
        calls.count += 1;
        const file = files[input.path];
        return {
          status: file === undefined ? 404 : 200,
          headers: {},
          body:
            file === undefined
              ? "{}"
              : JSON.stringify({
                  encoding: "base64",
                  content: Buffer.from(file).toString("base64"),
                }),
          truncated: false,
          invalidUtf8: false,
        };
      }),
  });

const harness = (calls: { count: number }, files: Record<string, string>) =>
  RepositoryIconResolver.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Sqlite.layerMemory,
        ServerConfig.layerTest(process.cwd(), { prefix: "repository-icon-test-" }),
        // The real resolver: a checkout's favicon is found exactly as a project's.
        ProjectFaviconResolver.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provide(ProjectConfigFileLoader.layer),
        ),
        gitHub(calls, files),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const link = (input: {
  readonly repositoryId: string;
  readonly workspaceRoot?: string;
  readonly iconPath?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_labels(label_id, name, instructions, created_at, updated_at) VALUES ('label:spawn', 'Spawn', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z') ON CONFLICT DO NOTHING`;
    if (input.workspaceRoot !== undefined)
      yield* sql`INSERT INTO projection_projects(project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${input.repositoryId}, 'platform', ${input.workspaceRoot}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO label_repositories(label_id, repository_id, remote, directory_name, icon_path) VALUES ('label:spawn', ${input.repositoryId}, ${REMOTE}, 'platform', ${input.iconPath ?? null})`;
  });

describe("RepositoryIconResolver", () => {
  it.effect("serves a checkout's own favicon when the repository is cloned here", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "repository-icon-"));
    NodeFS.mkdirSync(NodePath.join(root, ".git"));
    NodeFS.writeFileSync(NodePath.join(root, "favicon.svg"), "<svg/>");
    const calls = { count: 0 };
    return Effect.gen(function* () {
      yield* link({ repositoryId: "repo:platform", workspaceRoot: root });
      const icons = yield* RepositoryIconResolver.RepositoryIconResolver;
      expect(yield* icons.resolve(REMOTE)).toEqual({
        kind: "file",
        path: NodePath.join(root, "favicon.svg"),
      });
      expect(calls.count).toBe(0);
    }).pipe(Effect.provide(harness(calls, {})));
  });

  it.effect("fetches the icon another machine recorded once, then serves it from disk", () => {
    const calls = { count: 0 };
    const files = { "repos/spawn-partners/platform/contents/apps/web/public/icon.svg": "<svg/>" };
    return Effect.gen(function* () {
      yield* link({ repositoryId: `remote:${REMOTE}`, iconPath: "apps/web/public/icon.svg" });
      const icons = yield* RepositoryIconResolver.RepositoryIconResolver;
      const first = yield* icons.resolve(REMOTE);
      expect(first?.kind).toBe("file");
      if (first?.kind !== "file") return;
      expect(NodeFS.readFileSync(first.path, "utf8")).toBe("<svg/>");
      expect(yield* icons.resolve(REMOTE)).toEqual(first);
      expect(calls.count).toBe(1);
    }).pipe(Effect.provide(harness(calls, files)));
  });

  it.effect(
    "falls back to the owner's avatar, and never fetches a path outside the repository",
    () => {
      const calls = { count: 0 };
      return Effect.gen(function* () {
        yield* link({ repositoryId: `remote:${REMOTE}`, iconPath: "../../etc/icon.svg" });
        const icons = yield* RepositoryIconResolver.RepositoryIconResolver;
        expect(yield* icons.resolve(REMOTE)).toEqual({
          kind: "avatar",
          url: "https://github.com/spawn-partners.png?size=96",
        });
        expect(calls.count).toBe(0);
        // A remote not on GitHub has no avatar to fall back to.
        expect(yield* icons.resolve("gitlab.com/acme/site")).toBeNull();
      }).pipe(Effect.provide(harness(calls, {})));
    },
  );

  it.effect("serves an owner's avatar for a project linked to that owner", () => {
    const calls = { count: 0 };
    return Effect.gen(function* () {
      const icons = yield* RepositoryIconResolver.RepositoryIconResolver;
      expect(yield* icons.resolve("github.com/Spawn-Partners")).toEqual({
        kind: "avatar",
        url: "https://github.com/Spawn-Partners.png?size=96",
      });
      expect(calls.count).toBe(0);
      expect(yield* icons.resolve("gitlab.com/acme")).toBeNull();
    }).pipe(Effect.provide(harness(calls, {})));
  });
});
