import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { SourceControlCloneProtocol, SourceControlProviderKind } from "./sourceControl.ts";

/** Project folders provide context only and never grant access. Legacy names/IDs are stable. */
export const ProjectLabelId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectLabelId"));
export type ProjectLabelId = typeof ProjectLabelId.Type;
/** A stored color: palette names, plus whatever older clients stored (shown as gray). */
const color = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
/**
 * The colors a project can be given: the app's palette names. Hex values and
 * other names are refused, so a project never silently shows as gray.
 */
export const ProjectLabelColor = Schema.Literals([
  "gray",
  "red",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
]).annotate({
  description: "One of gray, red, amber, green, teal, blue, violet, pink (not a hex value).",
});
export type ProjectLabelColor = typeof ProjectLabelColor.Type;
const description = Schema.String.check(Schema.isMaxLength(4000));
/** Standing guidance for every agent working in the project; empty means none. */
export const PROJECT_INSTRUCTIONS_MAX_LENGTH = 20_000;
const instructions = Schema.String.check(Schema.isMaxLength(PROJECT_INSTRUCTIONS_MAX_LENGTH));
const fields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  color: Schema.optional(color),
  description: Schema.optional(description),
};
export const ProjectLabel = Schema.Struct({
  id: ProjectLabelId,
  ...fields,
  /**
   * Injected into the runtime instructions of every thread filed in the
   * project, for every provider. Older servers and caches decode as empty.
   */
  instructions: instructions.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /**
   * Set while the project is archived (`projectLabels.archive`, undone by
   * `projectLabels.unarchive`). Archived projects keep their threads, chat and
   * filing; clients leave them out of pickers and list them under Archived.
   */
  archivedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectLabel = typeof ProjectLabel.Type;
/** A GitHub user or organization login: alphanumerics and hyphens, at most 39 characters. */
export const GitHubOwnerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(39),
  Schema.isPattern(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/),
);
export type GitHubOwnerName = typeof GitHubOwnerName.Type;

/** A GitHub repository name: alphanumerics, dots, hyphens and underscores. */
export const GitHubRepositoryName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-zA-Z0-9._-]+$/),
);
export type GitHubRepositoryName = typeof GitHubRepositoryName.Type;

/** A code source a project links to: a whole GitHub owner, or one repository under it. */
export const ProjectSourceLink = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("github-owner"), owner: GitHubOwnerName }),
  Schema.Struct({
    kind: Schema.Literal("github-repo"),
    owner: GitHubOwnerName,
    repo: GitHubRepositoryName,
  }),
]);
export type ProjectSourceLink = typeof ProjectSourceLink.Type;

/**
 * Where a linked repository stands on the machine serving the list:
 * `ready` has a checkout, `not_cloned` is linked (from another machine) but
 * was never cloned here, `missing` has a record here whose folder is gone or
 * empty, and `cloning` / `failed` follow the tracked clone.
 */
export const ProjectLabelRepositoryCheckout = Schema.Literals([
  "ready",
  "missing",
  "not_cloned",
  "cloning",
  "failed",
]);
export type ProjectLabelRepositoryCheckout = typeof ProjectLabelRepositoryCheckout.Type;
/**
 * Id prefix of a linked repository with no checkout record on this machine:
 * `remote:<host/owner/repo>`. Cloning it here replaces the id with a real one.
 */
export const REMOTE_REPOSITORY_ID_PREFIX = "remote:";
export const isRemoteRepositoryPlaceholder = (repositoryId: string): boolean =>
  repositoryId.startsWith(REMOTE_REPOSITORY_ID_PREFIX);
/** The folder inside a project that holds its repository checkouts. */
export const PROJECT_REPOSITORIES_SEGMENT = "repos";
/**
 * The host, owner and repository name of a normalized remote
 * (`host/owner/repo`; nested groups make the owner `group/sub`). Anything that
 * is not one (a filesystem path to a local bare repository) has no host or
 * owner, only the last path segment as its name.
 */
export const repositoryRemoteParts = (
  remote: string,
): {
  readonly host: string | null;
  readonly owner: string | null;
  readonly name: string;
} | null => {
  const trimmed = remote.trim();
  const segments = trimmed.split(/[/\\]+/).filter((segment) => segment.length > 0);
  const name = segments.at(-1)?.replace(/\.git$/i, "") ?? "";
  if (name.length === 0 || name === "." || name === "..") return null;
  const normalized = /^[a-z0-9][a-z0-9.-]*\.[a-z]+\//.test(trimmed) && segments.length >= 3;
  return normalized
    ? { host: segments[0] ?? null, owner: segments.slice(1, -1).join("/"), name }
    : { host: null, owner: null, name };
};
/**
 * The GitHub owner whose repositories sit directly in a project's `repos/`:
 * the project's linked GitHub owner (the first by name when it links
 * several). Synced with the project, so every machine derives the same
 * folders. Null when the project links no owner.
 */
export const projectHomeOwner = (sourceLinks: ReadonlyArray<ProjectSourceLink>): string | null =>
  sourceLinks
    .flatMap((link) => (link.kind === "github-owner" ? [link.owner] : []))
    .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }))[0] ?? null;
/**
 * A linked repository's folder under `<project>/repos/`, and the name it is
 * shown by: `<repo>` for the project's home owner (`Spawn-Partners/platform`
 * in Spawn Partners is `platform`), `<owner>/<repo>` for any other owner
 * (`aflekkas/athens-racing`), so same-named repositories never collide.
 * Derived, never chosen: no caller can pick another name. Null when the
 * remote names nothing; a repository with no remote keeps its folder name.
 */
export const repositoryDirectoryNameFor = (
  remote: string,
  homeOwner: string | null,
): string | null => {
  const parts = repositoryRemoteParts(remote);
  if (parts === null) return null;
  if (parts.owner === null || parts.owner.length === 0) return parts.name;
  const home =
    homeOwner !== null &&
    parts.host === "github.com" &&
    parts.owner.toLowerCase() === homeOwner.toLowerCase();
  return home ? parts.name : `${parts.owner}/${parts.name}`;
};
/**
 * One repository filed in a project, identified portably by its remote.
 * `remote` is the normalized remote (`host/owner/repo`: lowercase host,
 * ssh/https unified, no `.git` suffix); null marks a local-only repository
 * with no remote. `directoryName` is the repository's path under the
 * project's `repos/` folder (where every machine clones it): derived from the
 * remote by {@link repositoryDirectoryNameFor} (the project schema below
 * enforces it), else the checkout's own folder name; null until known.
 */
export const ProjectLabelRepositoryLink = Schema.Struct({
  repositoryId: ProjectId,
  remote: Schema.NullOr(TrimmedNonEmptyString),
  directoryName: Schema.NullOr(TrimmedNonEmptyString),
  // Older servers (and caches written by them) predate per-machine state.
  checkout: Schema.optionalKey(ProjectLabelRepositoryCheckout),
  /**
   * The repository's icon file, relative to its root, as a machine with a
   * checkout found it. Synced, so a machine without one can show the same
   * icon; absent until some machine has looked.
   */
  iconPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectLabelRepositoryLink = typeof ProjectLabelRepositoryLink.Type;

const projectLabelWithRepositoriesFields = {
  ...ProjectLabel.fields,
  possibleDuplicateIds: Schema.optionalKey(Schema.Array(ProjectLabelId)),
  repositoryIds: Schema.Array(ProjectId),
  // Older servers (and caches written by them) predate portable repo identity.
  repositories: Schema.optionalKey(Schema.Array(ProjectLabelRepositoryLink)),
  // Older servers (and caches written by them) predate source links.
  sourceLinks: Schema.Array(ProjectSourceLink).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /**
   * The project's own chat (project home), created lazily by
   * `projectLabels.ensureProjectChat`. Null until the first visit. Clients
   * leave it out of the normal Chats list; it is a regular chat-surface thread.
   */
  projectChatThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Visible chats and Work: excludes archives, delegated children, agent
   * conversations and the project chat.
   */
  threadCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
};
type DerivableLabel = {
  readonly sourceLinks: ReadonlyArray<ProjectSourceLink>;
  readonly repositories?: ReadonlyArray<ProjectLabelRepositoryLink>;
};
const derivedDirectoryName = (link: ProjectLabelRepositoryLink, homeOwner: string | null) =>
  link.remote === null
    ? link.directoryName
    : (repositoryDirectoryNameFor(link.remote, homeOwner) ?? link.directoryName);
const followsRepositoryNames = Schema.makeFilter(
  (label: DerivableLabel) => {
    const homeOwner = projectHomeOwner(label.sourceLinks);
    return (label.repositories ?? []).every(
      (link) => link.directoryName === derivedDirectoryName(link, homeOwner),
    );
  },
  { expected: "repository directory names derived from their remotes and the project's owner" },
);
/**
 * A project with its repositories. Every repository's `directoryName` follows
 * {@link repositoryDirectoryNameFor}: decoding derives it (so a cache written
 * before the rule reads right), and a project that disagrees cannot be made
 * or encoded.
 */
export const ProjectLabelWithRepositories = Schema.Struct(projectLabelWithRepositoriesFields).pipe(
  Schema.decodeTo(
    Schema.toType(Schema.Struct(projectLabelWithRepositoriesFields)).check(followsRepositoryNames),
    SchemaTransformation.transform({
      decode: (label) => {
        if (label.repositories === undefined) return label;
        const homeOwner = projectHomeOwner(label.sourceLinks);
        return {
          ...label,
          repositories: label.repositories.map((link) => ({
            ...link,
            directoryName: derivedDirectoryName(link, homeOwner),
          })),
        };
      },
      encode: (label) => label,
    }),
  ),
);
export type ProjectLabelWithRepositories = typeof ProjectLabelWithRepositories.Type;
export const ProjectLabelRepository = Schema.Struct({
  labelId: ProjectLabelId,
  repositoryId: ProjectId,
});
export type ProjectLabelRepository = typeof ProjectLabelRepository.Type;
export const ProjectLabelSourceLinkInput = Schema.Struct({
  id: ProjectLabelId,
  link: ProjectSourceLink,
});
export type ProjectLabelSourceLinkInput = typeof ProjectLabelSourceLinkInput.Type;

export const PROJECT_LABEL_OWNER_SEARCH_MAX_LIMIT = 50;
export const PROJECT_LABEL_OWNER_SEARCH_DEFAULT_LIMIT = 20;

export const ProjectLabelOwnerRepositorySearchInput = Schema.Struct({
  id: ProjectLabelId,
  /** Substring matched against repository names; empty lists recent pushes. */
  query: TrimmedString.check(Schema.isMaxLength(100)),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_LABEL_OWNER_SEARCH_MAX_LIMIT)),
  ),
});
export type ProjectLabelOwnerRepositorySearchInput =
  typeof ProjectLabelOwnerRepositorySearchInput.Type;

/** One GitHub repository under a linked owner, as the repository picker shows it. */
export const ProjectLabelOwnerRepository = Schema.Struct({
  owner: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  nameWithOwner: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  private: Schema.Boolean,
  defaultBranch: Schema.NullOr(TrimmedNonEmptyString),
  pushedAt: Schema.NullOr(IsoDateTime),
  /** Whether a repository with this owner and name already exists locally. */
  alreadyLocal: Schema.Boolean,
});
export type ProjectLabelOwnerRepository = typeof ProjectLabelOwnerRepository.Type;

export const ProjectLabelOwnerRepositorySearchResult = Schema.Struct({
  repositories: Schema.Array(ProjectLabelOwnerRepository),
});
export type ProjectLabelOwnerRepositorySearchResult =
  typeof ProjectLabelOwnerRepositorySearchResult.Type;

export class ProjectLabelOwnerSearchError extends Schema.TaggedError<ProjectLabelOwnerSearchError>()(
  "ProjectLabelOwnerSearchError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["github_not_connected", "github_rate_limited", "github_unavailable"]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "github_not_connected":
        return "GitHub is not connected on this environment.";
      case "github_rate_limited":
        return "GitHub API rate limit exceeded. Try again shortly.";
      case "github_unavailable":
        return "GitHub could not be reached.";
    }
  }
}

/**
 * Clone a repository into a project: the server resolves the destination under
 * the projects root, tracks progress on the project-clone subscription, and
 * files the repository in the project once the clone lands.
 */
export const ProjectLabelCloneRepositoryInput = Schema.Struct({
  id: ProjectLabelId,
  /** Generated server-side when omitted. */
  projectId: Schema.optional(ProjectId),
  /** Defaults to the cloned folder name. */
  title: Schema.optional(TrimmedNonEmptyString),
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type ProjectLabelCloneRepositoryInput = typeof ProjectLabelCloneRepositoryInput.Type;

/**
 * Give a repository the project already links (by remote) a checkout on this
 * machine: a `not_cloned` one clones into `<project folder>/<directoryName>`,
 * a `missing` or `failed` one clones again in place, and a `ready` one is left
 * alone. Returns once the clone is running; progress arrives on the
 * project-clone subscription and the link's `checkout` state.
 */
export const ProjectLabelCheckoutRepositoryInput = Schema.Struct({
  labelId: ProjectLabelId,
  /** The link's remote, as `repositories[].remote` reports it. */
  remote: TrimmedNonEmptyString,
});
export type ProjectLabelCheckoutRepositoryInput = typeof ProjectLabelCheckoutRepositoryInput.Type;
export const ProjectLabelCheckoutRepositoryResult = Schema.Struct({
  /** This machine's repository record for the remote. */
  repositoryId: ProjectId,
});
export type ProjectLabelCheckoutRepositoryResult = typeof ProjectLabelCheckoutRepositoryResult.Type;

/**
 * Remove a linked repository's checkout from this machine and keep the link:
 * the folder is deleted, the record and its threads stay, and the link reads
 * `missing` until it is cloned here again. Refused while the checkout holds
 * work that exists nowhere else (uncommitted or stashed changes, commits on
 * no remote, other worktrees) or a turn runs in it.
 */
export const ProjectLabelRemoveCheckoutInput = Schema.Struct({
  labelId: ProjectLabelId,
  repositoryId: ProjectId,
});
export type ProjectLabelRemoveCheckoutInput = typeof ProjectLabelRemoveCheckoutInput.Type;
export const ProjectLabelRemoveCheckoutResult = Schema.Struct({
  /** False when there was no checkout here to remove. */
  removed: Schema.Boolean,
});
export type ProjectLabelRemoveCheckoutResult = typeof ProjectLabelRemoveCheckoutResult.Type;

/**
 * Move a linked repository's checkout into its place in the project folder,
 * `<project>/repos/<directoryName>` (renaming a `spawn-platform` checkout to
 * `platform`), repairing its worktrees and repointing its record. Refused
 * while a turn runs in it or a worktree lives inside it; a no-op when it is
 * already there.
 */
export const ProjectLabelAdoptRepositoryInput = Schema.Struct({
  labelId: ProjectLabelId,
  repositoryId: ProjectId,
});
export type ProjectLabelAdoptRepositoryInput = typeof ProjectLabelAdoptRepositoryInput.Type;
export const ProjectLabelAdoptRepositoryResult = Schema.Struct({
  /** False when the checkout was already in place. */
  moved: Schema.Boolean,
  workspaceRoot: TrimmedNonEmptyString,
});
export type ProjectLabelAdoptRepositoryResult = typeof ProjectLabelAdoptRepositoryResult.Type;

/**
 * A folder directly under the projects root that no project claims: it has
 * no project marker (`no_marker`), or its marker names a project that no
 * longer exists (`deleted_project`). `empty` folders hold only the skeleton
 * Cogenly made and can be removed; anything else can only be adopted.
 */
export const ProjectOrphanFolder = Schema.Struct({
  dirName: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  reason: Schema.Literals(["no_marker", "deleted_project"]),
  empty: Schema.Boolean,
});
export type ProjectOrphanFolder = typeof ProjectOrphanFolder.Type;
export const ProjectOrphanFoldersResult = Schema.Struct({
  folders: Schema.Array(ProjectOrphanFolder),
});
export type ProjectOrphanFoldersResult = typeof ProjectOrphanFoldersResult.Type;
export const ProjectOrphanFolderInput = Schema.Struct({ dirName: TrimmedNonEmptyString });
export type ProjectOrphanFolderInput = typeof ProjectOrphanFolderInput.Type;
export const ProjectOrphanFolderRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type ProjectOrphanFolderRemoveResult = typeof ProjectOrphanFolderRemoveResult.Type;
/** `project_folders_reconcile`: list orphans, or adopt / remove one first. */
export const ProjectFoldersReconcileInput = Schema.Struct({
  action: Schema.Literals(["list", "adopt", "remove"]),
  /** The orphan's folder name, for `adopt` and `remove`. */
  dirName: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectFoldersReconcileInput = typeof ProjectFoldersReconcileInput.Type;
export const ProjectFoldersReconcileResult = Schema.Struct({
  folders: Schema.Array(ProjectOrphanFolder),
  /** The project an `adopt` created for the folder. */
  adopted: Schema.optional(ProjectLabelWithRepositories),
  /** Whether a `remove` deleted the folder (only skeleton folders go). */
  removed: Schema.optional(Schema.Boolean),
});
export type ProjectFoldersReconcileResult = typeof ProjectFoldersReconcileResult.Type;

export class RepositoryCheckoutError extends Schema.TaggedError<RepositoryCheckoutError>()(
  "RepositoryCheckoutError",
  {
    repositoryId: ProjectId,
    repositoryName: Schema.String,
    reason: Schema.Literals([
      "not_found",
      "not_linked",
      "no_remote",
      "destination_taken",
      "clone_failed",
      "has_worktrees",
      "uncommitted_changes",
      "unpushed_commits",
      "thread_active",
      "worktrees_inside",
      "move_failed",
      "protected_folder",
      "storage",
    ]),
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return `Repository ${this.repositoryId} was not found.`;
      case "not_linked":
        return `${this.repositoryName} is not linked to this project.`;
      case "no_remote":
        return `${this.repositoryName} has no checkout and no known remote; clone it with project_label_clone_repository or link an existing checkout.`;
      case "destination_taken":
        return `${this.detail ?? "The destination folder"} already holds other files; move them away, then clone ${this.repositoryName} again.`;
      case "clone_failed":
        return `${this.repositoryName} could not be cloned${this.detail ? `: ${this.detail}` : ""}.`;
      case "has_worktrees":
        return `${this.repositoryName} has worktrees on this machine; remove them first.`;
      case "uncommitted_changes":
        return `${this.repositoryName} has uncommitted, stashed or ignored local files on this machine${this.detail ? ` (${this.detail})` : ""}; commit and push them, or remove them, first.`;
      case "unpushed_commits":
        return `${this.repositoryName} has commits that are on no remote; push them first.`;
      case "thread_active":
        return `A turn is running in ${this.repositoryName}; wait for it to finish.`;
      case "worktrees_inside":
        return `${this.repositoryName} has a worktree inside its folder; remove it before moving the repository.`;
      case "move_failed":
        return `${this.repositoryName} could not be moved${this.detail ? `: ${this.detail}` : ""}.`;
      case "protected_folder":
        return `${this.repositoryName}'s record points at ${this.detail ?? "a folder"}, which holds more than this repository; it is never deleted.`;
      case "storage":
        return `The checkout for ${this.repositoryName} could not be inspected.`;
    }
  }
}
/**
 * Legacy membership envelope. Arrays contain at most one effective folder per
 * thread; confidence/source/confirmation fields are fixed compatibility values.
 * New clients use projectFolderId on shell entries or ThreadProjectFolderResult.
 */
export const ThreadProjectLabel = Schema.Struct({
  threadId: ThreadId,
  labelId: ProjectLabelId,
  confidence: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  confirmedByUser: Schema.Boolean,
  source: Schema.Literals(["user", "suggested"]),
});
export type ThreadProjectLabel = typeof ThreadProjectLabel.Type;
export const ProjectLabelCreateInput = Schema.Struct({
  ...fields,
  color: Schema.optional(ProjectLabelColor),
  instructions: Schema.optional(instructions),
});
export type ProjectLabelCreateInput = typeof ProjectLabelCreateInput.Type;
/** Omitted fields are preserved; null clears color or description; "" clears instructions. */
export const ProjectLabelUpdateInput = Schema.Struct({
  id: ProjectLabelId,
  name: Schema.optional(fields.name),
  color: Schema.optional(Schema.NullOr(ProjectLabelColor)),
  description: Schema.optional(Schema.NullOr(description)),
  instructions: Schema.optional(instructions),
});
export type ProjectLabelUpdateInput = typeof ProjectLabelUpdateInput.Type;
export const ProjectLabelKey = Schema.Struct({ id: ProjectLabelId });
export const ProjectLabelListResult = Schema.Struct({
  labels: Schema.Array(ProjectLabelWithRepositories),
});
export const ProjectLabelMergeInput = Schema.Struct({ sourceId: ProjectLabelId, targetId: ProjectLabelId });
export type ProjectLabelMergeInput = typeof ProjectLabelMergeInput.Type;
export const ProjectLabelDismissDuplicateInput = Schema.Struct({ id: ProjectLabelId, otherId: ProjectLabelId });
export type ProjectLabelDismissDuplicateInput = typeof ProjectLabelDismissDuplicateInput.Type;
export const ProjectLabelMutationResult = Schema.Struct({ label: ProjectLabelWithRepositories });
export const ProjectLabelDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export const ThreadProjectLabelsInput = Schema.Struct({ threadId: ThreadId });
export const SetThreadProjectLabelsInput = Schema.Struct({
  threadId: ThreadId,
  labelIds: Schema.Array(ProjectLabelId).check(Schema.isMaxLength(1)),
});
export type SetThreadProjectLabelsInput = typeof SetThreadProjectLabelsInput.Type;
/** Null removes explicit filing and restores the repository default for work. */
export const MoveThreadProjectFolderInput = Schema.Struct({
  threadId: ThreadId,
  folderId: Schema.NullOr(ProjectLabelId),
});
export type MoveThreadProjectFolderInput = typeof MoveThreadProjectFolderInput.Type;
/**
 * Explicitly fork a chat into a project: the source keeps its history and the
 * new chat, filed in the target project, carries it via a context transfer.
 * Plain filing (moveThread) re-homes the same chat instead; this is only for
 * callers that ask for a copy.
 */
export const ForkThreadToProjectInput = Schema.Struct({
  threadId: ThreadId,
  labelId: ProjectLabelId,
});
export type ForkThreadToProjectInput = typeof ForkThreadToProjectInput.Type;
export const ForkThreadToProjectResult = Schema.Struct({ threadId: ThreadId });
export type ForkThreadToProjectResult = typeof ForkThreadToProjectResult.Type;
/**
 * Filing a thread into a project from MCP: the same thread is re-filed
 * (threadId === sourceThreadId, forked is always false). Its next turn runs
 * in the project folder with a fresh provider session seeded from its
 * history. Kept in this shape for callers written against the fork era.
 */
export const FileThreadIntoProjectResult = Schema.Struct({
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  projectFolderId: ProjectLabelId,
  forked: Schema.Boolean,
  message: Schema.String,
});
export type FileThreadIntoProjectResult = typeof FileThreadIntoProjectResult.Type;
/** How the effective folder was selected; does not grant access. */
export const ProjectFolderSource = Schema.NullOr(Schema.Literals(["explicit", "repository"]));
export const ThreadProjectFolderResult = Schema.Struct({
  threadId: ThreadId,
  projectFolderId: Schema.NullOr(ProjectLabelId),
});
export type ThreadProjectFolderResult = typeof ThreadProjectFolderResult.Type;
export const ThreadProjectLabelsResult = Schema.Struct({
  labels: Schema.Array(ThreadProjectLabel),
});
export class ProjectLabelError extends Schema.TaggedError<ProjectLabelError>()(
  "ProjectLabelError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "storage",
      "not_found",
      "invalid_membership",
      "invalid_path",
      "fork_required",
      "thread_active",
      "worktrees_inside",
      "archived",
      "project_chat",
    ]),
    /** The project's name, so an `archived` or `project_chat` refusal can say which one. */
    projectName: Schema.optional(Schema.String),
    repositoryName: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "archived":
        return `${this.projectName ?? "This project"} is archived. Unarchive it to add to it.`;
      case "not_found":
        return "The folder, repository, thread, or file was not found.";
      case "invalid_membership":
        if (this.repositoryName !== undefined)
          return `${this.repositoryName} is not in the ${this.projectName} project. Add it to the project first, or start without a project.`;
        return "A thread can belong to at most one project folder.";
      case "invalid_path":
        return "That path is not a file in this project folder.";
      case "fork_required":
        return "This chat already has turns; fork it into the project instead of moving it.";
      case "thread_active":
        return "A turn is running in this thread; wait for it to finish before moving it.";
      case "worktrees_inside":
        return `${this.projectName ?? "This project"} cannot be renamed while threads have worktrees inside its folder. Remove those worktrees first, or unarchive and finish their threads.`;
      case "project_chat":
        return `This is ${this.projectName ?? "a project"}'s own conversation; it stays in its project.`;
      case "storage":
        return "Could not access project folders.";
    }
  }
}

/** A project resource: a file or folder in the label's directory, by relative path. */
export const ProjectResourceKind = Schema.Literals(["file", "folder"]);
export type ProjectResourceKind = typeof ProjectResourceKind.Type;
export const ProjectResource = Schema.Struct({
  /** Posix-style path relative to the project directory, e.g. `Resources/brief.pdf`. */
  relativePath: TrimmedNonEmptyString,
  kind: ProjectResourceKind,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  /** Sha256 of the file; absent for folders and for files above the hash cap. */
  sha256: Schema.optional(Schema.String),
  modifiedAt: IsoDateTime,
});
export type ProjectResource = typeof ProjectResource.Type;
export const ProjectLabelListResourcesResult = Schema.Struct({
  resources: Schema.Array(ProjectResource),
  truncated: Schema.Boolean,
});
export type ProjectLabelListResourcesResult = typeof ProjectLabelListResourcesResult.Type;
export const ProjectLabelAddResourceInput = Schema.Struct({
  id: ProjectLabelId,
  resource: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("upload"),
      /** A pending upload id from `attachments.createUploadUrl`. */
      attachmentId: TrimmedNonEmptyString,
      /** Original file name; defaults to the upload's. */
      fileName: Schema.optional(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      kind: Schema.Literal("link"),
      url: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
      name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    }),
    Schema.Struct({
      kind: Schema.Literal("note"),
      title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
      text: Schema.String.check(Schema.isMaxLength(1_000_000)),
    }),
  ]),
});
export type ProjectLabelAddResourceInput = typeof ProjectLabelAddResourceInput.Type;
export const ProjectLabelAddResourceResult = Schema.Struct({ resource: ProjectResource });
export type ProjectLabelAddResourceResult = typeof ProjectLabelAddResourceResult.Type;
export const ProjectLabelRemoveResourceInput = Schema.Struct({
  id: ProjectLabelId,
  relativePath: TrimmedNonEmptyString,
});
export type ProjectLabelRemoveResourceInput = typeof ProjectLabelRemoveResourceInput.Type;
export const ProjectLabelRemoveResourceResult = Schema.Struct({ removed: Schema.Boolean });
export type ProjectLabelRemoveResourceResult = typeof ProjectLabelRemoveResourceResult.Type;
export const PROJECT_RESOURCE_READ_DEFAULT_LIMIT = 200;
export const PROJECT_RESOURCE_READ_MAX_LIMIT = 2000;
export const ProjectLabelReadResourceInput = Schema.Struct({
  id: ProjectLabelId,
  relativePath: TrimmedNonEmptyString,
  /** First line, zero-based. */
  offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  /** Lines to return. Defaults to 200, at most 2000. */
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(2000))),
});
export type ProjectLabelReadResourceInput = typeof ProjectLabelReadResourceInput.Type;
export const ProjectLabelReadResourceResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  sizeBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.optional(Schema.String),
  modifiedAt: IsoDateTime,
  /** True for non-text files; `text` is then absent. */
  binary: Schema.Boolean,
  text: Schema.optional(Schema.String),
  /** True when the file holds more lines or bytes than returned. */
  truncated: Schema.Boolean,
  /** Total lines, for text files only. */
  totalLines: Schema.optional(Schema.Number),
});
export type ProjectLabelReadResourceResult = typeof ProjectLabelReadResourceResult.Type;
export const PROJECT_RECALL_DEFAULT_LIMIT = 20;
export const PROJECT_RECALL_MAX_LIMIT = 50;
/** One recall match: the file plus a short snippet. */
export const ProjectRecallMatch = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  kind: ProjectResourceKind,
  mimeType: TrimmedNonEmptyString,
  snippet: Schema.String,
});
export type ProjectRecallMatch = typeof ProjectRecallMatch.Type;
export const ProjectRecallResult = Schema.Struct({ matches: Schema.Array(ProjectRecallMatch) });
export type ProjectRecallResult = typeof ProjectRecallResult.Type;
/**
 * Which folder the project file tools read: a mentioned folder by id, else the calling
 * thread's own folder.
 */
const projectFolderTarget = {
  projectFolderId: Schema.optional(ProjectLabelId),
};
/** Input for the `project_files_list` agent tool. */
export const ProjectFilesListInput = Schema.Struct({
  ...projectFolderTarget,
  /** Only resources under this path prefix, e.g. `Resources/`. */
  prefix: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
});
export type ProjectFilesListInput = typeof ProjectFilesListInput.Type;
/** `project_files_list` result: the folder's name and directory on disk, then its files. */
export const ProjectFilesListResult = Schema.Struct({
  projectFolderId: ProjectLabelId,
  name: Schema.String,
  directory: Schema.String,
  ...ProjectLabelListResourcesResult.fields,
});
export type ProjectFilesListResult = typeof ProjectFilesListResult.Type;
/** Input for the `project_file_read` agent tool. */
export const ProjectFileReadInput = Schema.Struct({
  ...projectFolderTarget,
  /** Project-relative path, e.g. `Resources/brief.md`. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  /** First line, zero-based. */
  offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  /** Lines to return. Defaults to 200, at most 2000. */
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(2000))),
});
export type ProjectFileReadInput = typeof ProjectFileReadInput.Type;
/** Input for the `project_recall` agent tool. */
export const ProjectRecallInput = Schema.Struct({
  ...projectFolderTarget,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
});
export type ProjectRecallInput = typeof ProjectRecallInput.Type;

/*
 * Project home (chat-first project page)
 *
 * - Project chat: one durable chat-surface thread per project, created lazily
 *   by `projectLabels.ensureProjectChat` (idempotent; returns the same thread
 *   every time, recreating it only if it was deleted). Its id is
 *   `ProjectLabelWithRepositories.projectChatThreadId`; clients find it there
 *   and keep it out of the normal Chats list. It runs with a system prompt
 *   that makes it the project's configurator: the project tools below, work
 *   handed to tasks through `work_task`.
 * - Instructions: `ProjectLabel.instructions`, set with `projectLabels.update`
 *   ({ id, instructions }), injected into every thread filed in the project.
 * - Configuration RPCs (all guarded): projectLabels.update (instructions),
 *   linkRepository / unlinkRepository, linkSource / unlinkSource,
 *   addResource / removeResource, ensureProjectChat, archive / unarchive.
 * - MCP tools for agents in a project's threads (target the caller's own
 *   project unless `projectFolderId` names another): project_overview,
 *   project_instructions_get, project_instructions_set, project_repository_add,
 *   project_repository_remove, project_source_link, project_source_unlink,
 *   project_file_write, project_file_remove, plus project_files_list,
 *   project_file_read and project_recall. Every mutation returns a
 *   `ProjectChangeReceipt` the chat renders as a compact card.
 */

/** Input for `projectLabels.ensureProjectChat`. */
export const ProjectChatEnsureInput = Schema.Struct({
  id: ProjectLabelId,
  /** Used only when the chat is created: the user's default model selection. */
  modelSelection: ModelSelection,
});
export type ProjectChatEnsureInput = typeof ProjectChatEnsureInput.Type;
export const ProjectChatEnsureResult = Schema.Struct({
  threadId: ThreadId,
  /** True only for the call that created the thread. */
  created: Schema.Boolean,
});
export type ProjectChatEnsureResult = typeof ProjectChatEnsureResult.Type;

/** What a project change touched. */
export const ProjectChangeKind = Schema.Literals(["repository", "source", "instructions", "file"]);
export type ProjectChangeKind = typeof ProjectChangeKind.Type;
/** `unchanged`: the project already looked like that (already linked, not present, same text). */
export const ProjectChangeAction = Schema.Literals(["added", "removed", "updated", "unchanged"]);
export type ProjectChangeAction = typeof ProjectChangeAction.Type;
/**
 * Compact record of one project configuration change, returned by every
 * project mutation tool so the chat can render it as a card.
 */
export const ProjectChangeReceipt = Schema.Struct({
  projectFolderId: ProjectLabelId,
  kind: ProjectChangeKind,
  /** Human-readable subject: a repository title, `owner/repo`, `Instructions`, a file path. */
  label: Schema.String,
  action: ProjectChangeAction,
});
export type ProjectChangeReceipt = typeof ProjectChangeReceipt.Type;

/** Targets the calling thread's project unless a folder is named. */
export const ProjectTargetInput = Schema.Struct(projectFolderTarget);
export type ProjectTargetInput = typeof ProjectTargetInput.Type;
/** `project_overview` result: what an agent needs to configure the project. */
export const ProjectOverviewResult = Schema.Struct({
  projectFolderId: ProjectLabelId,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  instructions: Schema.String,
  repositories: Schema.Array(
    Schema.Struct({
      id: ProjectId,
      title: Schema.String,
      /** Normalized remote (`host/owner/repo`); null/absent for local-only repositories. */
      remote: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
      /** Directory name under the project folder; absent until known. */
      directoryName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
      /** Checkout state on this machine; `not_cloned` repositories clone with project_label_clone_repository. */
      checkout: Schema.optional(ProjectLabelRepositoryCheckout),
    }),
  ),
  sourceLinks: Schema.Array(ProjectSourceLink),
  projectChatThreadId: Schema.NullOr(ThreadId),
});
export type ProjectOverviewResult = typeof ProjectOverviewResult.Type;
export const ProjectInstructionsResult = Schema.Struct({
  projectFolderId: ProjectLabelId,
  instructions: Schema.String,
});
export type ProjectInstructionsResult = typeof ProjectInstructionsResult.Type;
export const ProjectInstructionsSetInput = Schema.Struct({
  ...projectFolderTarget,
  /** The whole new text; "" clears. */
  instructions,
});
export type ProjectInstructionsSetInput = typeof ProjectInstructionsSetInput.Type;
export const ProjectRepositoryChangeInput = Schema.Struct({
  ...projectFolderTarget,
  /** An existing repository (see project_overview or project_list). */
  repositoryId: ProjectId,
});
export type ProjectRepositoryChangeInput = typeof ProjectRepositoryChangeInput.Type;
export const ProjectSourceChangeInput = Schema.Struct({
  ...projectFolderTarget,
  link: ProjectSourceLink,
});
export type ProjectSourceChangeInput = typeof ProjectSourceChangeInput.Type;
/** Saves a markdown note under `Resources/`; a taken name gets a numeric suffix. */
export const ProjectFileWriteInput = Schema.Struct({
  ...projectFolderTarget,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  text: Schema.String.check(Schema.isMaxLength(1_000_000)),
});
export type ProjectFileWriteInput = typeof ProjectFileWriteInput.Type;
export const ProjectFileRemoveInput = Schema.Struct({
  ...projectFolderTarget,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
});
export type ProjectFileRemoveInput = typeof ProjectFileRemoveInput.Type;
