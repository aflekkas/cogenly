import type { ProjectId, ProjectLabelId } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { normalizeRepositoryRemote } from "./RepositoryRemote.ts";

/**
 * This machine's own checkout of `remote` that no project other than
 * `labelId` claims: a live record whose folder is a Git checkout with that
 * remote, oldest first. A machine often already has a repository a project
 * links, cloned by hand or used by unfiled threads before it joined the
 * project; filing that one beats cloning a second copy beside it.
 */
export const findLocalCheckout = Effect.fn("findLocalCheckout")(function* (
  labelId: ProjectLabelId,
  remote: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const candidates = yield* sql<{
    readonly project_id: string;
    readonly workspace_root: string;
  }>`SELECT p.project_id, p.workspace_root FROM projection_projects p
    WHERE p.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM label_repositories r
        WHERE r.repository_id = p.project_id AND r.label_id <> ${labelId})
    ORDER BY p.created_at`.pipe(Effect.orDie);
  for (const candidate of candidates) {
    if (
      !(yield* fileSystem.exists(candidate.workspace_root).pipe(Effect.orElseSucceed(() => false)))
    )
      continue;
    const identity = yield* identities.resolve(candidate.workspace_root);
    if (normalizeRepositoryRemote(identity?.locator.remoteUrl) !== remote) continue;
    return Option.some({
      repositoryId: candidate.project_id as ProjectId,
      workspaceRoot: candidate.workspace_root,
    });
  }
  return Option.none<{ readonly repositoryId: ProjectId; readonly workspaceRoot: string }>();
});
