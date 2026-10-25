/**
 * The one list every repository surface shows: a project's linked
 * repositories (or, with no project, a machine's), each named by its folder
 * under the project's `repos/` and carrying its state on the selected
 * machine. The composer's picker, Start Work, the project page and the
 * Projects overview all build their rows here, so a repository reads the
 * same everywhere and a count always matches its list.
 */
import {
  isRemoteRepositoryPlaceholder,
  PROJECT_REPOSITORIES_SEGMENT,
  REMOTE_REPOSITORY_ID_PREFIX,
  projectCloneProgressSummary,
  projectHomeOwner,
  repositoryDirectoryNameFor,
  repositoryRemoteParts,
  type ProjectCloneSnapshot,
  type ProjectId,
  type ProjectLabelOwnerRepository,
  type ProjectLabelRepositoryCheckout,
  type ProjectLabelRepositoryLink,
  type ProjectLabelWithRepositories,
  type RepositoryIdentity,
} from "@cogenly/contracts";

import type { EnvironmentProjectLabel } from "./projectLabels.logic";

const GITHUB_PREFIX = "github.com/";

function gitHubPathOf(canonicalKey: string | undefined): string | null {
  if (!canonicalKey?.startsWith(GITHUB_PREFIX)) return null;
  const [owner, name, ...rest] = canonicalKey.slice(GITHUB_PREFIX.length).split("/");
  return owner && name && rest.length === 0 ? `${owner}/${name}` : null;
}

/**
 * Every GitHub `owner/name` a checkout answers to, lowercase: the canonical
 * remote, a fork's own remote, and any other remote on GitHub (a checkout
 * whose origin is another host can still push to GitHub through a second one).
 */
export function gitHubRepositoryKeys(
  identity: RepositoryIdentity | null | undefined,
): ReadonlyArray<string> {
  if (!identity) return [];
  const keys = [
    gitHubPathOf(identity.canonicalKey),
    gitHubPathOf(identity.origin?.canonicalKey),
    ...(identity.remoteKeys ?? []).map(gitHubPathOf),
  ];
  return [...new Set(keys.filter((key) => key !== null))];
}

/**
 * The GitHub repository a checkout's row names, as `owner/name`: its own
 * remote (a fork's), else the canonical one, else any other remote on
 * GitHub. Null when none is on GitHub.
 */
export function gitHubRepositoryOf(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) return null;
  return (
    gitHubPathOf(identity.origin?.canonicalKey) ??
    gitHubPathOf(identity.canonicalKey) ??
    gitHubRepositoryKeys(identity)[0] ??
    null
  );
}

/** The slice of a repository record (a Cogenly project) the list reads. */
export interface RepositoryListLocal {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/** One repository as every surface lists it. */
export interface RepositoryListRow<Local extends RepositoryListLocal = RepositoryListLocal> {
  /** Stable while the repository is cloned here: its remote when known, else its id. */
  readonly key: string;
  /** This machine's record; null for one linked from another machine and not cloned here. */
  readonly repositoryId: ProjectId | null;
  /**
   * The id the project links it by (a `remote:` placeholder when it is not
   * cloned here), which unlinking names; null when no project links it.
   */
  readonly linkId: ProjectId | null;
  readonly remote: string | null;
  /** The project's folder name for it under `repos/`, when the project links it. */
  readonly directoryName: string | null;
  /** The icon file a machine with a checkout recorded on the link, for its icon anywhere. */
  readonly iconPath: string | null;
  /** What the row reads: the folder name, never renamed. */
  readonly name: string;
  /** Secondary text, only where another row in the list would read the same. */
  readonly detail: string | null;
  /** Its state on the selected machine. */
  readonly checkout: ProjectLabelRepositoryCheckout;
  readonly local: Local | null;
  /** The project that links it, if any. */
  readonly project: EnvironmentProjectLabel | null;
}

/**
 * A project's repository links, once each. Servers that predate portable
 * repository identity send ids only; those read as links with no remote.
 */
export function projectRepositoryLinks(
  label: Pick<ProjectLabelWithRepositories, "repositoryIds" | "repositories">,
): ReadonlyArray<ProjectLabelRepositoryLink> {
  const links =
    label.repositories ??
    label.repositoryIds.map((repositoryId): ProjectLabelRepositoryLink => ({
      repositoryId,
      remote: null,
      directoryName: null,
    }));
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = rowKey(link.remote, link.repositoryId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rowKey(remote: string | null, repositoryId: string): string {
  return remote === null ? `id:${repositoryId}` : `remote:${remote.toLowerCase()}`;
}

/** A link's state here; an older server reports none, which reads as cloned for a real record. */
function linkCheckout(link: ProjectLabelRepositoryLink): ProjectLabelRepositoryCheckout {
  return (
    link.checkout ?? (isRemoteRepositoryPlaceholder(link.repositoryId) ? "not_cloned" : "ready")
  );
}

function rowFromLink<Local extends RepositoryListLocal>(
  link: ProjectLabelRepositoryLink,
  project: EnvironmentProjectLabel,
  local: Local | null,
): RepositoryListRow<Local> {
  const placeholder = isRemoteRepositoryPlaceholder(link.repositoryId);
  // A placeholder's id carries its remote, for a server that sent no remote.
  const remote =
    link.remote ??
    (placeholder ? link.repositoryId.slice(REMOTE_REPOSITORY_ID_PREFIX.length) || null : null);
  return {
    key: rowKey(remote, link.repositoryId),
    repositoryId: placeholder ? null : link.repositoryId,
    linkId: link.repositoryId,
    remote,
    directoryName: link.directoryName,
    iconPath: link.iconPath ?? null,
    name:
      link.directoryName ??
      local?.title ??
      (remote === null ? null : repositoryRemoteParts(remote)?.name) ??
      link.repositoryId,
    detail: null,
    checkout: linkCheckout(link),
    local: placeholder ? null : local,
    project,
  };
}

/**
 * What `RepositoryRowIcon` needs beyond the record for a repository listed
 * outside the shared list: the remote and recorded icon of the link `project`
 * holds for it, or nothing when no project links it.
 */
export function linkedRepositoryIcon(
  project: EnvironmentProjectLabel | null,
  repositoryId: ProjectId,
): { readonly remote: string | null; readonly iconPath: string | null } {
  const link =
    project === null
      ? undefined
      : projectRepositoryLinks(project.label).find((each) => each.repositoryId === repositoryId);
  if (project === null || link === undefined) return { remote: null, iconPath: null };
  const row = rowFromLink(link, project, null);
  return { remote: row.remote, iconPath: row.iconPath };
}

const compareNames = (left: string, right: string) =>
  left.localeCompare(right, "en", { sensitivity: "base" });

/**
 * Names that would read the same get secondary text: the project when the
 * rows sit in different ones, else the owner (or "No remote"). Then the list
 * sorts by name, `leadRepositoryId` first; a state change never moves a row.
 */
function finishRows<Local extends RepositoryListLocal>(
  rows: ReadonlyArray<RepositoryListRow<Local>>,
  leadRepositoryId: ProjectId | null | undefined,
): RepositoryListRow<Local>[] {
  const byName = new Map<string, RepositoryListRow<Local>[]>();
  for (const row of rows) {
    const name = row.name.toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  const ownerOf = (row: RepositoryListRow<Local>) =>
    row.remote === null ? null : (repositoryRemoteParts(row.remote)?.owner ?? null);
  const finished = rows.map((row) => {
    const same = byName.get(row.name.toLowerCase()) ?? [];
    if (same.length < 2) return row;
    const projects = new Set(same.map((candidate) => candidate.project?.key ?? null));
    if (projects.size > 1) return { ...row, detail: row.project?.label.name ?? "No project" };
    const owners = new Set(same.map(ownerOf));
    if (owners.size > 1) return { ...row, detail: ownerOf(row) ?? "No remote" };
    return row;
  });
  return finished.toSorted((left, right) => {
    const lead =
      Number(right.repositoryId !== null && right.repositoryId === leadRepositoryId) -
      Number(left.repositoryId !== null && left.repositoryId === leadRepositoryId);
    return (
      lead ||
      compareNames(left.name, right.name) ||
      compareNames(left.detail ?? "", right.detail ?? "")
    );
  });
}

/**
 * Inside a project: every repository it links, whatever its state on this
 * machine. `localById` holds this machine's records (the project's machine).
 */
export function linkedRepositoryRows<Local extends RepositoryListLocal>(input: {
  readonly project: EnvironmentProjectLabel;
  readonly localById: ReadonlyMap<string, Local>;
  readonly leadRepositoryId?: ProjectId | null;
}): RepositoryListRow<Local>[] {
  return finishRows(
    projectRepositoryLinks(input.project.label).map((link) =>
      rowFromLink(link, input.project, input.localById.get(link.repositoryId) ?? null),
    ),
    input.leadRepositoryId,
  );
}

/**
 * With no project: the repositories on one machine (`locals`, already
 * narrowed to real repositories). One a project links is named and stated as
 * that project has it; same names tell their projects apart.
 */
export function machineRepositoryRows<Local extends RepositoryListLocal>(input: {
  readonly locals: ReadonlyArray<Local>;
  /** The projects on the same machine. */
  readonly projects: ReadonlyArray<EnvironmentProjectLabel>;
  readonly leadRepositoryId?: ProjectId | null;
}): RepositoryListRow<Local>[] {
  const linkOf = new Map<
    string,
    { readonly project: EnvironmentProjectLabel; readonly link: ProjectLabelRepositoryLink }
  >();
  for (const project of input.projects) {
    for (const link of projectRepositoryLinks(project.label)) {
      if (!linkOf.has(link.repositoryId)) linkOf.set(link.repositoryId, { project, link });
    }
  }
  return finishRows(
    input.locals.map((local): RepositoryListRow<Local> => {
      const linked = linkOf.get(local.id);
      if (linked) return rowFromLink(linked.link, linked.project, local);
      return {
        key: rowKey(null, local.id),
        repositoryId: local.id,
        linkId: null,
        remote: null,
        directoryName: null,
        iconPath: null,
        name: local.title,
        detail: null,
        checkout: "ready",
        local,
        project: null,
      };
    }),
    input.leadRepositoryId,
  );
}

/**
 * Every repository the given projects link that picking would clone onto
 * its project's machine (not cloned there, gone, or failed), as the
 * pickers list them. Archived projects offer none. For surfaces outside a
 * project, such as the command palette's "Clone to set up" rows.
 */
export function cloneableRepositoryRows(
  projects: ReadonlyArray<EnvironmentProjectLabel>,
): RepositoryListRow[] {
  return projects.flatMap((project) =>
    project.label.archivedAt === undefined
      ? linkedRepositoryRows({ project, localById: new Map() }).filter(
          (row) => repositoryRowAction(row) === "checkout",
        )
      : [],
  );
}

/** What picking a row does: pick it, clone it here first, wait for it, or nothing. */
export function repositoryRowAction(
  row: RepositoryListRow,
): "select" | "checkout" | "wait" | "none" {
  switch (row.checkout) {
    case "ready":
      return row.local === null ? "wait" : "select";
    case "cloning":
      return "wait";
    default:
      // Cloning here needs the link's remote and a project to clone into.
      return row.project !== null && row.remote !== null ? "checkout" : "none";
  }
}

/** Whether "Remove from this machine" applies: a cloned, linked repository another machine can clone again. */
export function canRemoveCheckout(row: RepositoryListRow): boolean {
  return (
    row.checkout === "ready" &&
    row.project !== null &&
    row.repositoryId !== null &&
    row.remote !== null
  );
}

/**
 * Whether "Move into project folder" applies: a cloned, linked repository
 * whose checkout is not at `…/repos/<directoryName>`. The client cannot know
 * the project folder itself, so it only checks the tail; the server answers
 * `moved: false` when the checkout is already in place.
 */
export function canMoveIntoProjectFolder(row: RepositoryListRow): boolean {
  if (row.checkout !== "ready" || row.project === null || row.local === null) return false;
  if (row.directoryName === null) return false;
  const root = row.local.workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return !root.endsWith(`/${PROJECT_REPOSITORIES_SEGMENT}/${row.directoryName}`);
}

/**
 * A clone this client asked for: in flight, accepted (with the record it
 * clones into, and the tracked clone's sequence at that moment so an old
 * failure is not taken for the new one), or refused with the server's words.
 */
export type RepositoryCheckoutRequest =
  | { readonly phase: "starting" }
  | {
      readonly phase: "started";
      readonly repositoryId: ProjectId;
      readonly baselineSequence: number | null;
    }
  | { readonly phase: "error"; readonly message: string };

/** What a row reads from the tracked clone of its record. */
export type RepositoryCloneProgress = Pick<
  ProjectCloneSnapshot,
  "phase" | "stage" | "percent" | "detail" | "error" | "sequence"
>;

/** A row action this client is running: removing it from this machine, moving it, or unlinking it. */
export type RepositoryRowWork = "removing" | "moving" | "unlinking";

/** How a row shows its state on the selected machine. */
export type RepositoryRowView =
  | { readonly kind: "ready" }
  /** Not cloned here; `cloneable` when picking it here would clone it. */
  | { readonly kind: "needs-clone"; readonly cloneable: boolean }
  | { readonly kind: "starting" }
  /** `progress` is git's own stage and percent; null while none is reported. */
  | { readonly kind: "cloning"; readonly progress: string | null }
  | { readonly kind: "failed"; readonly message: string | null; readonly cloneable: boolean }
  | { readonly kind: "working"; readonly work: RepositoryRowWork };

/**
 * Whether a request this client made has been overtaken by what the server
 * says: the link reports the checkout ready or cloning, or the clone it
 * started has ended. From then on the server's state alone speaks, so a
 * later removal reads "Clone to set up" rather than an old "Starting clone…".
 */
export function isRepositoryRequestSettled(
  row: Pick<RepositoryListRow, "checkout">,
  request: RepositoryCheckoutRequest,
  clone: RepositoryCloneProgress | null,
): boolean {
  if (request.phase === "starting") return false;
  if (row.checkout === "ready" || row.checkout === "cloning") return true;
  if (request.phase === "error") return false;
  return clone !== null && clone.sequence !== request.baselineSequence && clone.phase !== "running";
}

/**
 * The row's state from what the server says (the link's checkout and the
 * tracked clone), what this client asked for, and what it is doing to the
 * row now. A clone asked for here reads as starting until the server
 * reports it running, landed or failed, so the row never shows an older
 * failure or a spinner nothing backs. `cloneable` says whether picking the
 * row here can clone it (a remote, a project, and permission).
 */
export function repositoryRowView(
  row: Pick<RepositoryListRow, "checkout">,
  request: RepositoryCheckoutRequest | null,
  clone: RepositoryCloneProgress | null,
  options: { readonly cloneable: boolean; readonly work?: RepositoryRowWork | null } = {
    cloneable: true,
  },
): RepositoryRowView {
  const { cloneable } = options;
  if (options.work) return { kind: "working", work: options.work };
  const live =
    request !== null && !isRepositoryRequestSettled(row, request, clone) ? request : null;
  if (live?.phase === "error") return { kind: "failed", message: live.message, cloneable };
  const running = clone?.phase === "running" ? clone : null;
  if (running !== null || row.checkout === "cloning") {
    return {
      kind: "cloning",
      progress: running === null ? null : projectCloneProgressSummary(running),
    };
  }
  if (live?.phase === "starting") return { kind: "starting" };
  if (row.checkout === "ready") return { kind: "ready" };
  if (live?.phase === "started") return { kind: "starting" };
  if (
    request?.phase === "started" &&
    clone !== null &&
    clone.sequence !== request.baselineSequence
  ) {
    if (clone.phase === "failed" || clone.phase === "cancelled")
      return { kind: "failed", message: clone.error, cloneable };
  }
  if (row.checkout === "failed")
    return { kind: "failed", message: clone?.error ?? null, cloneable };
  return { kind: "needs-clone", cloneable };
}

/** Results the "Add repository" list shows before "Show more"; a search shows them all. */
export const REMOTE_ROWS_PREVIEW_LIMIT = 6;

/**
 * GitHub results the project does not hold yet. The server already leaves
 * out repositories cloned anywhere on the machine; this also drops ones the
 * project's own checkouts answer to (a clone on another machine, or a fork's
 * own remote), and a repository two owners both return.
 */
export function remoteRowsOutsideProject(
  repositories: ReadonlyArray<ProjectLabelOwnerRepository>,
  local: ReadonlyArray<RepositoryIdentity | null | undefined>,
): ProjectLabelOwnerRepository[] {
  const held = new Set(local.flatMap(gitHubRepositoryKeys));
  const rows: ProjectLabelOwnerRepository[] = [];
  for (const repository of repositories) {
    const key = repository.nameWithOwner.toLowerCase();
    if (repository.alreadyLocal || held.has(key)) continue;
    held.add(key);
    rows.push(repository);
  }
  return rows;
}

/** A repository "Add repository" offers: a checkout on this machine to link, or a GitHub one to clone. */
export type AddRepositoryOption<Local extends RepositoryListLocal> =
  | {
      readonly kind: "local";
      readonly key: string;
      readonly name: string;
      /** The project it is in now, which linking takes it out of. */
      readonly from: EnvironmentProjectLabel | null;
      readonly local: Local;
    }
  | {
      readonly kind: "github";
      readonly key: string;
      /** The folder name it gets in this project, so it reads as it will once cloned. */
      readonly name: string;
      readonly repository: ProjectLabelOwnerRepository;
    };

/**
 * What "Add repository" lists for a project: this machine's repositories the
 * project does not link (by record or remote), then GitHub results it does
 * not hold, named as they would be once cloned and cut to a preview unless
 * searching or expanded. `hidden` counts what the preview leaves out.
 */
export function addRepositoryOptions<Local extends RepositoryListLocal>(input: {
  readonly project: EnvironmentProjectLabel;
  readonly locals: ReadonlyArray<Local>;
  readonly folderOf: (local: Local) => EnvironmentProjectLabel | null;
  readonly gitHub: ReadonlyArray<ProjectLabelOwnerRepository>;
  readonly searching: boolean;
  readonly expanded: boolean;
}): { readonly options: AddRepositoryOption<Local>[]; readonly hidden: number } {
  const links = projectRepositoryLinks(input.project.label);
  const linkedIds = new Set<string>(links.map((link) => link.repositoryId));
  const linkedGitHub = new Set(
    links.flatMap((link) =>
      link.remote?.toLowerCase().startsWith(GITHUB_PREFIX)
        ? [link.remote.slice(GITHUB_PREFIX.length).toLowerCase()]
        : [],
    ),
  );
  const local = input.locals
    .filter(
      (candidate) =>
        !linkedIds.has(candidate.id) &&
        !gitHubRepositoryKeys(candidate.repositoryIdentity).some((key) =>
          linkedGitHub.has(key.toLowerCase()),
        ),
    )
    .toSorted((left, right) => compareNames(left.title, right.title))
    .map((candidate): AddRepositoryOption<Local> => ({
      kind: "local",
      key: `local:${candidate.id}`,
      name: candidate.title,
      from: input.folderOf(candidate),
      local: candidate,
    }));
  const homeOwner = projectHomeOwner(input.project.label.sourceLinks);
  const outside = remoteRowsOutsideProject(
    input.gitHub,
    input.locals
      .filter((candidate) => linkedIds.has(candidate.id))
      .map((candidate) => candidate.repositoryIdentity),
  ).filter((repository) => !linkedGitHub.has(repository.nameWithOwner.toLowerCase()));
  const shown =
    input.searching || input.expanded ? outside : outside.slice(0, REMOTE_ROWS_PREVIEW_LIMIT);
  const gitHub = shown.map((repository): AddRepositoryOption<Local> => ({
    kind: "github",
    key: `github:${repository.nameWithOwner.toLowerCase()}`,
    name:
      repositoryDirectoryNameFor(`${GITHUB_PREFIX}${repository.nameWithOwner}`, homeOwner) ??
      repository.nameWithOwner,
    repository,
  }));
  return { options: [...local, ...gitHub], hidden: outside.length - shown.length };
}

const SERVER_ERROR_PREFIX = /^Source control repository operation \S+ failed for \S+:\s*/;

/** A clone failure as the picker shows it: what to do first, then git's own words. */
export interface CloneFailureText {
  readonly summary: string;
  /** The underlying message, when it says more than the summary. */
  readonly detail: string | null;
}

/**
 * Turns a clone error into one readable first sentence. Known git and
 * server failures get advice; anything else leads with its own first line.
 */
export function describeCloneFailure(message: string, repository: string): CloneFailureText {
  const detail = message.replace(SERVER_ERROR_PREFIX, "").trim();
  const summary = (() => {
    if (/already exists and is not (?:empty|a directory)/i.test(detail)) {
      return `A folder named ${repository} is already in this project's folder. Move or rename it, then retry.`;
    }
    // Before "not found": an SSH key failure also says it could not read from the remote.
    if (
      /permission denied|authentication failed|could not read username|publickey|403/i.test(detail)
    ) {
      return `This machine isn't signed in to GitHub with access to ${repository}.`;
    }
    if (/not found|could not read from remote/i.test(detail)) {
      return `GitHub couldn't find ${repository}, or this machine's GitHub account can't access it.`;
    }
    if (/could not resolve host|timed out|network|connection (?:refused|reset)/i.test(detail)) {
      return "Couldn't reach GitHub. Check the connection, then retry.";
    }
    const firstLine = detail
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim();
    return firstLine && firstLine.length > 0 ? firstLine : "The clone failed.";
  })();
  return { summary, detail: detail.length > 0 && detail !== summary ? detail : null };
}
