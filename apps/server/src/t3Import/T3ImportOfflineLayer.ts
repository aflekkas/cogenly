import * as Layer from "effect/Layer";

import * as Keybindings from "../keybindings.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectConfigFileLoader from "../project/ProjectConfigFileLoader.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as T3Import from "./T3ImportService.ts";

/**
 * The import service without a running server, for the CLI and tests. The
 * caller provides the database, `ServerConfig` and the settings service.
 */
export const layerOffline = (options: T3Import.T3ImportServiceOptions) =>
  T3Import.layerWithOptions(options).pipe(
    Layer.provide(Layer.mergeAll(RuntimeLayer.layerProjectService, RuntimeLayer.layerEventSink)),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(ProjectConfigFileLoader.layer),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(Keybindings.layer),
    Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  );
