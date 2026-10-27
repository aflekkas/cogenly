import {
  CommandId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProjectLabelError,
  SourceControlProviderKind,
  SourceControlRepositoryError,
  projectHomeOwner,
  repositoryDirectoryNameFor,
  type ProjectLabelCloneRepositoryInput,
} from "@cogenly/contracts";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";

import { normalizeRepositoryRemote } from "../project/RepositoryRemote.ts";
import {
  projectRepositoryDirectory,
  repositoryDirectoryNameFromRemote,
  resolveProjectsRootDirectory,
  sanitizePathSegment,
} from "../project/ProjectsRoot.ts";
import type * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import type * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as ProjectLabelFolders from "./ProjectLabelFolders.ts";
import type * as ProjectLabelService from "./ProjectLabelService.ts";

export interface ProjectLabelCloneDeps {
  readonly labels: Pick<
    ProjectLabelService.ProjectLabelService["Service"],
    "readActive" | "linkRepository"
  >;
  readonly clones: Pick<ProjectCloneTracker.ProjectCloneTracker["Service"], "start">;
  readonly projects: Pick<ProjectService.ProjectService["Service"], "create" | "update" | "delete">;
  readonly identities: Pick<
    RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
    "resolve"
  >;
  readonly settings: Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">;
  readonly crypto: Crypto.Crypto;
  readonly path: Path.Path;
  readonly home: string;
  readonly cogenlyHome: string;
  /** When present the clone lands in the reconciled folder, not the sanitized name. */
  readonly folders?: Pick<ProjectLabelFolders.ProjectLabelFolders["Service"], "dirForLabel">;
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
}

/**
 * The normalized remote a clone input names, for matching it against a
 * project's links: `owner/repo` on GitHub, or a pasted remote URL. Null when
 * it names no portable remote.
 */
export const cloneInputRemote = (input: ProjectLabelCloneRepositoryInput): string | null => {
  if (input.remoteUrl !== undefined) return normalizeRepositoryRemote(input.remoteUrl);
  if (input.repository !== undefined && (input.provider ?? "github") === "github")
    return normalizeRepositoryRemote(`https://github.com/${input.repository}`);
  return null;
};

/**
 * Clone a repository into a project: the destination resolves under the
 * projects root (`<root>/<Project>/repos/<repo>`, or `repos/<owner>/<repo>`
 * for an owner other than the project's), the clone runs through the
 * tracked clone flow (progress on the project-clone subscription), and the
 * repository is filed in the project: immediately, so the picker shows it
 * while it clones, and again once it lands, which files its GitHub link too.
 */
export const cloneRepositoryIntoLabel = Effect.fn("ProjectLabelCloneRepository.clone")(function* (
  input: ProjectLabelCloneRepositoryInput,
  deps: ProjectLabelCloneDeps,
  options?: { readonly caller?: SourceControlRepositoryService.CloneCaller },
) {
  // Before cloning: the link at the end is best-effort, so an archived
  // project must refuse here rather than leave an unfiled clone.
  const { label } = yield* deps.labels.readActive(input.id);
  const folderName = repositoryDirectoryNameFromRemote(input);
  if (folderName === "") {
    return yield* new SourceControlRepositoryError({
      operation: "cloneRepository",
      provider: input.provider ?? SourceControlProviderKind.make("unknown"),
      detail: "Enter a repository path or clone URL before cloning.",
    });
  }
  const settings = yield* deps.settings.getSettings.pipe(
    Effect.mapError(
      (cause) => new ProjectLabelError({ operation: "cloneRepository", reason: "storage", cause }),
    ),
  );
  const projectsRoot = resolveProjectsRootDirectory(
    settings.projectsRoot,
    deps.home,
    deps.cogenlyHome,
    deps.path,
  );
  const projectDir =
    deps.folders === undefined
      ? deps.path.join(projectsRoot, sanitizePathSegment(label.name, "project"))
      : (yield* deps.folders
          .dirForLabel(label)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProjectLabelError({ operation: "cloneRepository", reason: "storage", cause }),
            ),
          )).dir;
  // Folder naming follows only an explicitly linked owner.
  const remote = cloneInputRemote(input);
  const homeOwner = projectHomeOwner(label.sourceLinks);
  const directoryName =
    (remote === null ? null : repositoryDirectoryNameFor(remote, homeOwner)) ?? folderName;
  const destinationPath = projectRepositoryDirectory(projectDir, directoryName, deps.path);
  const projectId =
    input.projectId ??
    ProjectId.make(
      yield* deps.crypto
        .randomUUIDv4()
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectLabelError({ operation: "cloneRepository", reason: "storage", cause }),
          ),
        ),
    );
  const started = yield* deps.clones.start(
    {
      projectId,
      title: input.title ?? directoryName,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.repository === undefined ? {} : { repository: input.repository }),
      ...(input.remoteUrl === undefined ? {} : { remoteUrl: input.remoteUrl }),
      destinationPath,
      ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
    },
    {
      createProject: (project) =>
        deps.projects
          .create({
            commandId: CommandId.make(`project-clone-create:${project.projectId}`),
            projectId: project.projectId,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            createWorkspaceRootIfMissing: true,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: "Failed to create clone project.",
                  cause,
                }),
            ),
          ),
      onCloned: (project) =>
        deps.identities.resolve(project.workspaceRoot, { refresh: true }).pipe(
          Effect.andThen(
            deps.projects.update({
              commandId: CommandId.make(`project-clone-done:${project.projectId}`),
              projectId: project.projectId,
            }),
          ),
          Effect.andThen(
            deps.labels.linkRepository({ labelId: input.id, repositoryId: project.projectId }),
          ),
          Effect.andThen(deps.refreshGitStatus(project.workspaceRoot)),
          Effect.ignoreCause({ log: true }),
        ),
      // The repository exists only for this clone: a failed or cancelled one
      // must not leave an empty repository filed in the project. Not forced,
      // so a thread that somehow landed in it keeps it.
      removeProject: ({ projectId: removedId }) =>
        deps.projects
          .delete({
            commandId: CommandId.make(`project-clone-abandon:${removedId}`),
            projectId: removedId,
          })
          .pipe(Effect.asVoid, Effect.ignoreCause({ log: true })),
    },
    { cloneCaller: options?.caller ?? "owner" },
  );
  // Record the remote now, while the clone is still running: if it fails or
  // is cancelled and its project record survives, a later launch can clone
  // the checkout in place from this remote instead of starting empty.
  yield* deps.labels
    .linkRepository({
      labelId: input.id,
      repositoryId: started.projectId,
      remote: normalizeRepositoryRemote(started.remoteUrl),
    })
    .pipe(Effect.ignoreCause({ log: true }));
  return started;
});
