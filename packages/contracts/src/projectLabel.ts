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
    reason: Schema.Literals(["storage", "not_found", "invalid_membership"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_found":
        return "The folder, repository, or thread was not found.";
      case "invalid_membership":
        return "A thread can belong to at most one project folder.";
      case "storage":
        return "Could not access project folders.";
    }
  }
}
