/**
 * Finding this machine's own checkout of a remote before cloning another.
 * A machine often already has a repository a project links, checked out by
 * hand or used by unfiled threads, such as a server where a repository was
 * worked on before it joined a project. Moving that project here files that
 * checkout into it, where it is, instead of cloning a second copy beside it.
 */
import type { ProjectId, ProjectLabelId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { normalizeRepositoryRemote } from "../project/RepositoryRemote.ts";
import * as ProjectLabelService from "../projectLabels/ProjectLabelService.ts";

/**
 * Files this machine's checkout of `remote` into the project, if it has one
 * that no other project claims: a live record whose folder is a Git checkout
 * with that remote. Returns the record and its folder; none when there is no
 * such checkout, and the caller clones.
 */
export const adoptLocalCheckout = Effect.fn("localCheckout.adopt")(function* (
  labelId: ProjectLabelId,
  remote: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const labels = yield* ProjectLabelService.ProjectLabelService;
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
    const repositoryId = candidate.project_id as ProjectId;
    yield* labels.bindRepositoryCheckout({ labelId, remote, repositoryId }).pipe(Effect.orDie);
    return Option.some({ repositoryId, workspaceRoot: candidate.workspace_root });
  }
  return Option.none<{ readonly repositoryId: ProjectId; readonly workspaceRoot: string }>();
});
