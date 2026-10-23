/**
 * Code sources a project links to (GitHub owners and repositories), and how
 * the repository picker folds a linked owner's GitHub repositories in under
 * the project's own.
 */
import type {
  ProjectLabelOwnerRepository,
  ProjectLabelOwnerSearchError,
  ProjectSourceLink,
} from "@t3tools/contracts";

import type { EnvironmentProjectLabel, ProjectLabelKey } from "./projectLabels.logic";
import type { RepositoryProjectGroup } from "./projectMeta.logic";

const OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const REPOSITORY_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * What the user typed into "Link GitHub…" as a link: `owner`, `owner/repo`,
 * or any GitHub URL or SSH remote for either. Null when it names neither.
 */
export function parseProjectSourceLink(text: string): ProjectSourceLink | null {
  let path = text.trim();
  if (path.length === 0) return null;
  path = path
    .replace(/^git@github\.com:/i, "")
    .replace(/^(?:https?:\/\/|ssh:\/\/git@)?(?:www\.)?github\.com\//i, "")
    .replace(/^@/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const [owner, repo] = path.split("/");
  if (!owner || !OWNER_PATTERN.test(owner)) return null;
  if (repo === undefined) return { kind: "github-owner", owner };
  // A deeper URL (…/tree/main) still names its repository.
  if (repo.length > 100 || !REPOSITORY_PATTERN.test(repo) || repo === "." || repo === "..") {
    return null;
  }
  return { kind: "github-repo", owner, repo };
}

export function projectSourceLinkLabel(link: ProjectSourceLink): string {
  return link.kind === "github-owner" ? link.owner : `${link.owner}/${link.repo}`;
}

/** GitHub names are case-insensitive, so `Spawn-Partners` and `spawn-partners` are one link. */
export function projectSourceLinkKey(link: ProjectSourceLink): string {
  return `${link.kind}:${projectSourceLinkLabel(link).toLowerCase()}`;
}

export function hasProjectSourceLink(
  links: ReadonlyArray<ProjectSourceLink>,
  link: ProjectSourceLink,
): boolean {
  const key = projectSourceLinkKey(link);
  return links.some((candidate) => projectSourceLinkKey(candidate) === key);
}

/** Owners: listed first, then repositories, each alphabetical. */
export function sortProjectSourceLinks(
  links: ReadonlyArray<ProjectSourceLink>,
): ProjectSourceLink[] {
  return links.toSorted((left, right) => {
    if (left.kind !== right.kind) return left.kind === "github-owner" ? -1 : 1;
    return projectSourceLinkLabel(left).localeCompare(projectSourceLinkLabel(right), undefined, {
      sensitivity: "base",
    });
  });
}

/** The owners a project's GitHub search covers, in link order. */
export function linkedGitHubOwners(project: EnvironmentProjectLabel): string[] {
  return project.label.sourceLinks.flatMap((link) =>
    link.kind === "github-owner" ? [link.owner] : [],
  );
}

/**
 * Projects the picker asks GitHub about while it is open. Each searches its
 * linked owners, or the signed-in account when it links none; an empty query
 * lists recent pushes.
 */
export function ownerSearchProjects(
  projects: ReadonlyArray<EnvironmentProjectLabel>,
  active: boolean,
): EnvironmentProjectLabel[] {
  return active ? [...projects] : [];
}

/** One project's GitHub search, as the picker shows it under the project. */
export type OwnerSearchState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "done"; readonly repositories: ReadonlyArray<ProjectLabelOwnerRepository> };

/**
 * The GitHub results worth a row: ones already on this machine are left out
 * (the local rows above stand for them), and a repository two linked owners
 * both return shows once.
 */
export function remoteRepositoryRows(
  repositories: ReadonlyArray<ProjectLabelOwnerRepository>,
): ProjectLabelOwnerRepository[] {
  const seen = new Set<string>();
  const rows: ProjectLabelOwnerRepository[] = [];
  for (const repository of repositories) {
    if (repository.alreadyLocal) continue;
    const key = repository.nameWithOwner.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(repository);
  }
  return rows;
}

/** The single muted line an owner search failure reads as; never a toast. */
export function ownerSearchErrorMessage(
  reason: ProjectLabelOwnerSearchError["reason"] | null,
  owners: ReadonlyArray<string>,
): string {
  const named =
    owners.length === 0 ? "your repositories" : owners.length === 1 ? owners[0] : "linked owners";
  switch (reason) {
    case "github_not_connected":
      return `Connect GitHub to search ${named}`;
    case "github_rate_limited":
      return "GitHub is rate limiting searches. Try again shortly.";
    default:
      return `Couldn't reach GitHub to search ${named}`;
  }
}

/** The repository picker's sections: a project's own repositories, or its GitHub results. */
export type RepositoryPickerSection<Item> =
  | { readonly kind: "local"; readonly group: RepositoryProjectGroup<Item> }
  | {
      readonly kind: "remote";
      readonly project: EnvironmentProjectLabel;
      /** Loading only once the spinner delay passed; before that the section is not shown. */
      readonly state: OwnerSearchState;
      readonly repositories: ReadonlyArray<ProjectLabelOwnerRepository>;
    };

/**
 * Folds GitHub results into the grouped local repositories: each searched
 * project's "On GitHub" section follows its own group, and a project with no
 * local match still gets its header when GitHub has something to show. A
 * search that finished empty adds nothing. Project order is kept; "Other
 * repositories" stays last.
 */
export function mergeRemoteRepositorySections<Item>(input: {
  readonly groups: ReadonlyArray<RepositoryProjectGroup<Item>>;
  /** Folders, alphabetical (as the directory holds them). */
  readonly projects: ReadonlyArray<EnvironmentProjectLabel>;
  /** The searched project's state, or undefined when it is not searched (or still within the spinner delay). */
  readonly remoteOf: (key: ProjectLabelKey) => OwnerSearchState | undefined;
}): RepositoryPickerSection<Item>[] {
  const localByKey = new Map(input.groups.map((group) => [group.key, group] as const));
  const sections: RepositoryPickerSection<Item>[] = [];
  for (const project of input.projects) {
    const local = localByKey.get(project.key);
    const state = input.remoteOf(project.key);
    const repositories =
      state?.status === "done" ? remoteRepositoryRows(state.repositories) : ([] as const);
    const showsRemote = state !== undefined && (state.status !== "done" || repositories.length > 0);
    if (!local && !showsRemote) continue;
    sections.push({ kind: "local", group: local ?? { key: project.key, project, items: [] } });
    if (showsRemote) sections.push({ kind: "remote", project, state, repositories });
  }
  for (const group of input.groups) {
    if (group.project === null) sections.push({ kind: "local", group });
  }
  return sections;
}
