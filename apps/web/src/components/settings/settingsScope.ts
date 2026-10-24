import type { EnvironmentId, ProjectLabelWithRepositories } from "@t3tools/contracts";

import type { EnvironmentProjectLabel } from "../../projectLabels/projectLabels.logic";
import type { EnvironmentPresentation } from "../../state/environments";
import type { Project } from "../../types";

/**
 * `project` is a project folder id: settings pages apply to all projects or
 * to one. `machine` picks the machine whose machine-local settings a page
 * shows and edits (absent = the primary environment). `repository` is the
 * Repository page's repository group, not a settings scope. `checkout` only
 * survives from older links, which resolve as unavailable rather than broader.
 * Device-local preferences are not a scope: they render regardless.
 */
export interface SettingsScopeSearch {
  project?: string | undefined;
  machine?: string | undefined;
  repository?: string | undefined;
  checkout?: string | undefined;
}

/**
 * A project folder and every repository it holds on each environment. Paired
 * machines share a folder id, so one folder spans every machine.
 */
export interface SettingsProjectFolder {
  readonly id: string;
  readonly name: string;
  readonly color: string | undefined;
  readonly members: readonly Project[];
}

type ScopeTargets = {
  label: string;
  /** The repositories a project override is written to, on every environment. */
  members: readonly Project[];
  /** The environments a universal setting is written to, or the one machine of a machine page. */
  environmentIds: readonly EnvironmentId[];
  /** The machine machine-local settings and display values come from. */
  machineId: EnvironmentId | null;
};

export type ResolvedSettingsScope = ScopeTargets &
  (
    | { kind: "all" }
    | { kind: "environment"; environmentId: EnvironmentId }
    | { kind: "project"; folder: SettingsProjectFolder }
    | {
        kind: "unavailable";
        reason: "project-missing" | "environment-missing" | "legacy-link";
        message: string;
      }
  );

/** Stale IDs remain visible to the resolver so a removed target reads as unavailable, not as "all". */
export function validateSettingsScopeSearch(raw: Record<string, unknown>): SettingsScopeSearch {
  const stringValue = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const project = stringValue(raw.project);
  const machine = stringValue(raw.machine);
  const repository = stringValue(raw.repository);
  const checkout = stringValue(raw.checkout);
  return {
    ...(project === undefined ? {} : { project }),
    ...(machine === undefined ? {} : { machine }),
    ...(repository === undefined ? {} : { repository }),
    ...(checkout === undefined ? {} : { checkout }),
  };
}

/**
 * The picker's project folders: active folders deduped by id across
 * environments, each with the repositories it holds on every environment. A
 * folder without a repository cannot hold overrides (they are stored per
 * repository), so it is left out.
 */
export function buildSettingsProjectFolders(
  labels: readonly (Pick<EnvironmentProjectLabel, "environmentId"> & {
    readonly label: Pick<ProjectLabelWithRepositories, "id" | "name" | "color" | "repositoryIds">;
  })[],
  projects: readonly Project[],
): SettingsProjectFolder[] {
  const projectsByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const folders = new Map<
    string,
    { name: string; color: string | undefined; members: Project[] }
  >();
  for (const { environmentId, label } of labels) {
    let folder = folders.get(label.id);
    if (!folder) {
      folder = { name: label.name, color: label.color, members: [] };
      folders.set(label.id, folder);
    }
    for (const repositoryId of label.repositoryIds) {
      const project = projectsByKey.get(`${environmentId}:${repositoryId}`);
      if (project && !folder.members.includes(project)) folder.members.push(project);
    }
  }
  return [...folders]
    .filter(([, folder]) => folder.members.length > 0)
    .map(([id, folder]) => ({ id, ...folder }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type ScopeEnvironment = Pick<EnvironmentPresentation, "environmentId" | "label"> & {
  readonly connection: Pick<EnvironmentPresentation["connection"], "phase">;
};

/**
 * Resolves only existing targets. An unavailable selection never broadens a
 * subsequent write. Machine pages are about one machine's own state and
 * ignore the project; every other page ignores nothing but `repository`.
 */
export function resolveSettingsScope(
  search: SettingsScopeSearch,
  folders: readonly SettingsProjectFolder[],
  environments: readonly ScopeEnvironment[],
  options: {
    readonly machinePage?: boolean;
    readonly primaryEnvironmentId?: EnvironmentId | null;
  } = {},
): ResolvedSettingsScope {
  const unavailable = (
    reason: Extract<ResolvedSettingsScope, { kind: "unavailable" }>["reason"],
    message: string,
  ): ResolvedSettingsScope => ({
    kind: "unavailable",
    reason,
    label: "Unavailable selection",
    message,
    members: [],
    environmentIds: [],
    machineId: null,
  });

  const chosen = environments.find((candidate) => candidate.environmentId === search.machine);
  if (search.machine && !chosen) {
    return unavailable("environment-missing", "This machine is no longer available.");
  }
  const connected = environments.filter((candidate) => candidate.connection.phase === "connected");
  const machine =
    chosen ??
    connected.find((candidate) => candidate.environmentId === options.primaryEnvironmentId) ??
    connected[0] ??
    environments.find((candidate) => candidate.environmentId === options.primaryEnvironmentId) ??
    environments[0];
  const machineId = machine?.environmentId ?? null;

  if (options.machinePage) {
    return machine
      ? {
          kind: "environment",
          environmentId: machine.environmentId,
          label: machine.label,
          members: [],
          environmentIds: [machine.environmentId],
          machineId,
        }
      : { kind: "all", label: "No machines", members: [], environmentIds: [], machineId };
  }

  if (search.checkout) {
    return unavailable(
      "legacy-link",
      "This link pointed at one checkout. Settings now apply to a whole project: choose one above.",
    );
  }
  if (search.project) {
    const folder = folders.find((candidate) => candidate.id === search.project);
    if (!folder) {
      return unavailable(
        "project-missing",
        "This project is no longer available, or has no repositories yet. Choose a project above.",
      );
    }
    return {
      kind: "project",
      folder,
      label: folder.name,
      members: folder.members,
      environmentIds: [...new Set(folder.members.map((member) => member.environmentId))],
      machineId,
    };
  }
  return {
    kind: "all",
    label: "All projects",
    members: [],
    environmentIds: environments.map((candidate) => candidate.environmentId),
    machineId,
  };
}
