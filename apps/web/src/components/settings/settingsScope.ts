import type { EnvironmentId } from "@cogenly/contracts";

import type { EnvironmentPresentation } from "../../state/environments";

/**
 * `machine` picks the machine whose machine-local settings a page shows and
 * edits (absent = the primary environment). `repository` is the Repository
 * page's repository group, not a settings scope. Settings have no project
 * scope: links from older builds that still carry `project` or `checkout`
 * drop them and land on the global page. Device-local preferences are not a
 * scope: they render regardless.
 */
export interface SettingsScopeSearch {
  machine?: string | undefined;
  repository?: string | undefined;
}

type ScopeTargets = {
  label: string;
  /** The environments a universal setting is written to, or the one machine of a machine page. */
  environmentIds: readonly EnvironmentId[];
  /** The machine machine-local settings and display values come from. */
  machineId: EnvironmentId | null;
};

export type ResolvedSettingsScope = ScopeTargets &
  (
    | { kind: "all" }
    | { kind: "environment"; environmentId: EnvironmentId }
    | { kind: "unavailable"; reason: "environment-missing"; message: string }
  );

/** A stale machine id stays visible to the resolver so a removed machine reads as unavailable. */
export function validateSettingsScopeSearch(raw: Record<string, unknown>): SettingsScopeSearch {
  const stringValue = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const machine = stringValue(raw.machine);
  const repository = stringValue(raw.repository);
  return {
    ...(machine === undefined ? {} : { machine }),
    ...(repository === undefined ? {} : { repository }),
  };
}

type ScopeEnvironment = Pick<EnvironmentPresentation, "environmentId" | "label"> & {
  readonly connection: Pick<EnvironmentPresentation["connection"], "phase">;
};

/**
 * Resolves only existing targets. An unavailable machine never broadens a
 * subsequent write. Machine pages are about one machine's own state; every
 * other page writes universal settings to every machine and machine-local
 * ones to the chosen machine.
 */
export function resolveSettingsScope(
  search: SettingsScopeSearch,
  environments: readonly ScopeEnvironment[],
  options: {
    readonly machinePage?: boolean;
    readonly primaryEnvironmentId?: EnvironmentId | null;
  } = {},
): ResolvedSettingsScope {
  const chosen = environments.find((candidate) => candidate.environmentId === search.machine);
  if (search.machine && !chosen) {
    return {
      kind: "unavailable",
      reason: "environment-missing",
      label: "Unavailable selection",
      message: "This machine is no longer available.",
      environmentIds: [],
      machineId: null,
    };
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
          environmentIds: [machine.environmentId],
          machineId,
        }
      : { kind: "all", label: "No machines", environmentIds: [], machineId };
  }
  return {
    kind: "all",
    label: "All machines",
    environmentIds: environments.map((candidate) => candidate.environmentId),
    machineId,
  };
}
