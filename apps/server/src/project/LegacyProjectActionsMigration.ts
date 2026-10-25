/**
 * Moves repository actions saved as pre-0.3.2 per-project settings onto each
 * repository record, once, at boot. The settings loader leaves them in a
 * sidecar beside settings.json (see `legacyProjectActions`); this reads it,
 * updates every live repository whose actions differ, and deletes it. A
 * failure keeps the sidecar, so the next boot tries again.
 *
 * @module project/LegacyProjectActionsMigration
 */
import { CommandId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  LEGACY_PROJECT_ACTIONS_FILE_NAME,
  LegacyProjectActionsJson,
  legacyProjectActionsTarget,
} from "./legacyProjectActions.ts";
import * as ProjectService from "./ProjectService.ts";

const decodeSidecar = Schema.decodeUnknownEffect(LegacyProjectActionsJson);

export const migrate = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const sidecarPath = path.join(path.dirname(settingsPath), LEGACY_PROJECT_ACTIONS_FILE_NAME);
  if (!(yield* fs.exists(sidecarPath))) return;
  const legacy = yield* fs.readFileString(sidecarPath).pipe(Effect.flatMap(decodeSidecar));
  const snapshot = yield* projects.snapshot;
  for (const project of snapshot.projects) {
    if (project.deletedAt !== null) continue;
    const scripts = legacyProjectActionsTarget(legacy, project);
    if (scripts === null) continue;
    yield* projects.update({
      commandId: CommandId.make(`legacy-project-actions:${project.id}`),
      projectId: project.id,
      scripts,
    });
  }
  yield* fs.remove(sidecarPath);
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("Could not move saved repository actions; retrying next start.", cause),
  ),
);
