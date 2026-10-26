/**
 * Finding this machine's own checkout of a remote before cloning another.
 * A machine often already has a repository a project links, checked out by
 * hand or used by unfiled threads, such as a server where a repository was
 * worked on before it joined a project. Moving that project here files that
 * checkout into it, where it is, instead of cloning a second copy beside it.
 */
import { type ProjectLabelId, ThreadRemoteError } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { findLocalCheckout } from "../project/findLocalCheckout.ts";
import * as RepositoryCheckout from "../project/RepositoryCheckout.ts";
import * as ProjectLabelFolders from "../projectLabels/ProjectLabelFolders.ts";
import {
  projectRepositoryDirectory,
  repositoryDirectoryNameFromRemote,
} from "../project/ProjectsRoot.ts";
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
  const labels = yield* ProjectLabelService.ProjectLabelService;
  const found = yield* findLocalCheckout(labelId, remote);
  if (Option.isSome(found))
    yield* labels
      .bindRepositoryCheckout({ labelId, remote, repositoryId: found.value.repositoryId })
      .pipe(Effect.orDie);
  return found;
});

/** The checkout adoptLocalCheckout would file, without filing it: for a dry run. */
export { findLocalCheckout };

/**
 * This machine's record for `remote`, which the project links: its own
 * checkout filed in place, or a clone started into the project. Turns wait
 * for a clone; a clone that cannot start fails with `needs-repository`.
 */
export const ensureLocalCheckout = Effect.fn("localCheckout.ensure")(function* (
  labelId: ProjectLabelId,
  remote: string,
) {
  const adopted = yield* adoptLocalCheckout(labelId, remote);
  if (Option.isSome(adopted)) return adopted.value.repositoryId;
  const checkout = yield* RepositoryCheckout.RepositoryCheckout;
  const { repositoryId } = yield* checkout
    .checkoutRepository({ labelId, remote })
    .pipe(
      Effect.mapError(
        (error) => new ThreadRemoteError({ reason: "needs-repository", detail: error.message }),
      ),
    );
  return repositoryId;
});

/** The exact destination checkoutRepository would use, without reserving or creating it. */
export const previewClonePath = Effect.fn("localCheckout.previewClonePath")(function* (
  labelId: ProjectLabelId,
  remote: string,
) {
  const labels = yield* ProjectLabelService.ProjectLabelService;
  const folders = yield* ProjectLabelFolders.ProjectLabelFolders;
  const path = yield* Path.Path;
  const { label } = yield* labels.readActive(labelId);
  const link = label.repositories?.find((item) => item.remote === remote);
  const { dir } = yield* folders.dirForLabel(label);
  return projectRepositoryDirectory(
    dir,
    link?.directoryName ?? repositoryDirectoryNameFromRemote({ remoteUrl: remote }),
    path,
  );
});
