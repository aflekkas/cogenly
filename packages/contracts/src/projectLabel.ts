import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { SourceControlCloneProtocol, SourceControlProviderKind } from "./sourceControl.ts";

/** Project folders provide context only and never grant access. Legacy names/IDs are stable. */
export const ProjectLabelId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectLabelId"));
export type ProjectLabelId = typeof ProjectLabelId.Type;
const color = TrimmedNonEmptyString.check(Schema.isMaxLength(100));
const description = Schema.String.check(Schema.isMaxLength(4000));
const fields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  color: Schema.optional(color),
  description: Schema.optional(description),
};
export const ProjectLabel = Schema.Struct({
  id: ProjectLabelId,
  ...fields,
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

export const ProjectLabelWithRepositories = Schema.Struct({
  ...ProjectLabel.fields,
  repositoryIds: Schema.Array(ProjectId),
  // Older servers (and caches written by them) predate source links.
  sourceLinks: Schema.Array(ProjectSourceLink).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Visible chats and Work: excludes archives, delegated children and agent conversations. */
  threadCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
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
export const ProjectLabelCreateInput = Schema.Struct(fields);
export type ProjectLabelCreateInput = typeof ProjectLabelCreateInput.Type;
/** Omitted fields are preserved; null clears color or description. */
export const ProjectLabelUpdateInput = Schema.Struct({
  id: ProjectLabelId,
  name: Schema.optional(fields.name),
  color: Schema.optional(Schema.NullOr(color)),
  description: Schema.optional(Schema.NullOr(description)),
});
export type ProjectLabelUpdateInput = typeof ProjectLabelUpdateInput.Type;
export const ProjectLabelKey = Schema.Struct({ id: ProjectLabelId });
export const ProjectLabelListResult = Schema.Struct({
  labels: Schema.Array(ProjectLabelWithRepositories),
});
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
 * Moving a chat with turns into a project is a fork: the source keeps its
 * history and the new chat, filed in the target project, carries it via a
 * context transfer. Turnless chats keep using moveThread.
 */
export const ForkThreadToProjectInput = Schema.Struct({
  threadId: ThreadId,
  labelId: ProjectLabelId,
});
export type ForkThreadToProjectInput = typeof ForkThreadToProjectInput.Type;
export const ForkThreadToProjectResult = Schema.Struct({ threadId: ThreadId });
export type ForkThreadToProjectResult = typeof ForkThreadToProjectResult.Type;
/**
 * Filing a thread into a project from MCP: a chat with turns forks (threadId
 * is the new chat, sourceThreadId stays where it was); turnless chats and Work
 * threads file in place (threadId === sourceThreadId).
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
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return "The folder, repository, thread, or file was not found.";
      case "invalid_membership":
        return "A thread can belong to at most one project folder.";
      case "invalid_path":
        return "That path is not a file in this project folder.";
      case "fork_required":
        return "This chat already has turns; fork it into the project instead of moving it.";
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
