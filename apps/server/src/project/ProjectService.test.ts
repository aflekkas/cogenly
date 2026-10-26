// @effect-diagnostics nodeBuiltinImport:off - the folders under test are real ones on disk.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectService from "./ProjectService.ts";

const noEnrichment: ProjectEnrichmentService.ProjectEnrichment = {
  repositoryIdentity: null,
  faviconPath: null,
  repositoryIdentityResolved: true,
};

// The real service over a memory database; repository enrichment and thread
// commands are beyond what a lookup touches.
const layer = RuntimeLayer.layerProjectService.pipe(
  Layer.provide(
    Layer.mergeAll(
      WorkspacePaths.layer,
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        getAvailable: () => Effect.succeed(noEnrichment),
        peek: () => Effect.succeed(noEnrichment),
        invalidate: () => Effect.void,
      }),
      Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
    ),
  ),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-project-service-" })),
  Layer.provide(NodeServices.layer),
);

describe("ProjectService.getByWorkspaceRoot", () => {
  it.effect("looks up a folder that does not exist instead of failing", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "project-service-"));
      // A clone's destination before the clone makes it: `<project>/repos/platform`.
      const destination = NodePath.join(root, "Spawn Partners", "repos", "platform");
      expect(yield* projects.getByWorkspaceRoot(destination)).toEqual(Option.none());

      // A record whose checkout was removed from this machine is still found.
      const projectId = ProjectId.make("project:platform");
      yield* projects.create({
        commandId: CommandId.make("create:platform"),
        projectId,
        title: "platform",
        workspaceRoot: destination,
        createWorkspaceRootIfMissing: true,
      });
      NodeFS.rmSync(destination, { recursive: true });
      const found = yield* projects.getByWorkspaceRoot(destination);
      expect(Option.map(found, (project) => project.id)).toEqual(Option.some(projectId));
    }).pipe(Effect.provide(layer)),
  );
});
