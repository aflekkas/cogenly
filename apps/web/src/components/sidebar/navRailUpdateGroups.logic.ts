import type { EnvironmentId } from "@cogenly/contracts";

import { rowNeedsUpdate, type UpdateRowStatus, type UpdateRowView } from "./navRailUpdates.logic";
import { compareReleaseVersions } from "./releaseNotes.logic";

/** One component (a server or a provider CLI) on one machine. */
export interface MachineUpdateRow<Row extends UpdateRowView = UpdateRowView> {
  /** `${environmentId}:${row.key}`, stable across renders. */
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly row: Row;
  /** This session can start the row's update with one click. */
  readonly canUpdate: boolean;
}

/** One machine's rows, as the popover builds them. */
export interface MachineUpdates<Row extends UpdateRowView = UpdateRowView> {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly rows: ReadonlyArray<{ readonly row: Row; readonly canUpdate: boolean }>;
}

/** Every machine's copy of one component: the popover's one row for it. */
export interface ComponentUpdateGroup<Row extends UpdateRowView = UpdateRowView> {
  readonly key: string;
  readonly name: string;
  readonly machines: ReadonlyArray<MachineUpdateRow<Row>>;
  /** The loudest machine's status: updating, then failed, then available. */
  readonly status: UpdateRowStatus;
}

const STATUS_RANK: Record<UpdateRowStatus, number> = {
  current: 0,
  available: 1,
  failed: 2,
  updating: 3,
};

/**
 * Regroups per-machine rows by component, so five machines still make one
 * Claude row. The server leads, then providers by name; machines keep the
 * order they were given in.
 */
export function groupUpdatesByComponent<Row extends UpdateRowView>(
  machines: ReadonlyArray<MachineUpdates<Row>>,
): ComponentUpdateGroup<Row>[] {
  const byKey = new Map<string, MachineUpdateRow<Row>[]>();
  for (const machine of machines) {
    for (const { row, canUpdate } of machine.rows) {
      const entry: MachineUpdateRow<Row> = {
        id: `${machine.environmentId}:${row.key}`,
        environmentId: machine.environmentId,
        machineLabel: machine.label,
        row,
        canUpdate,
      };
      byKey.set(row.key, [...(byKey.get(row.key) ?? []), entry]);
    }
  }
  return Array.from(byKey, ([key, rows]) => ({
    key,
    name: rows[0]!.row.name,
    machines: rows,
    status: rows.reduce<UpdateRowStatus>(
      (loudest, { row }) => (STATUS_RANK[row.status] > STATUS_RANK[loudest] ? row.status : loudest),
      "current",
    ),
  })).toSorted((left, right) =>
    left.key === "server" ? -1 : right.key === "server" ? 1 : left.name.localeCompare(right.name),
  );
}

/**
 * A component's versions across machines, for its row: the version pair to
 * show and how far it reaches ("on 2 of 5 machines"). One machine shows its
 * own pair and no scope, as before machines were grouped.
 */
export interface ComponentVersionSummary {
  readonly current: string | null;
  readonly next: string | null;
  readonly scope: string | null;
}

function newest(versions: ReadonlyArray<string>): string | null {
  return versions.reduce<string | null>(
    (best, version) =>
      best === null || compareReleaseVersions(version, best) > 0 ? version : best,
    null,
  );
}

const distinct = (values: ReadonlyArray<string | null>) =>
  Array.from(new Set(values.filter((value): value is string => value !== null)));

export function describeComponentVersions(
  machines: ReadonlyArray<Pick<MachineUpdateRow, "row">>,
): ComponentVersionSummary {
  const total = machines.length;
  if (total === 1) {
    const { row } = machines[0]!;
    return {
      current: row.currentVersion,
      next: row.status === "current" ? null : row.latestVersion,
      scope: null,
    };
  }
  const behind = machines.filter(({ row }) => row.status !== "current");
  if (behind.length === 0) {
    const versions = distinct(machines.map(({ row }) => row.currentVersion));
    if (versions.length <= 1) {
      return {
        current: versions[0] ?? null,
        next: null,
        scope: total === 2 ? "on both machines" : `on all ${total} machines`,
      };
    }
    // Every machine is current by its own check, but they disagree.
    const latest = newest(versions);
    const onLatest = machines.filter(({ row }) => row.currentVersion === latest).length;
    return { current: latest, next: null, scope: `on ${onLatest} of ${total} machines` };
  }
  const targets = distinct(behind.map(({ row }) => row.latestVersion));
  const froms = distinct(behind.map(({ row }) => row.currentVersion));
  const reach =
    behind.length === total ? `on ${total} machines` : `on ${behind.length} of ${total} machines`;
  if (targets.length === 1 && froms.length <= 1) {
    return { current: froms[0] ?? null, next: targets[0]!, scope: reach };
  }
  if (targets.length === 1) {
    // Behind from different versions: say how many already run the target.
    const target = targets[0]!;
    const onTarget = machines.filter(
      ({ row }) => row.status === "current" && row.currentVersion === target,
    ).length;
    return { current: target, next: null, scope: `on ${onTarget} of ${total} machines` };
  }
  return { current: null, next: null, scope: `Updates ${reach}` };
}

/** The summary as one line: "1.4.12 → 1.4.13 on 2 machines". */
export function formatComponentVersionSummary(summary: ComponentVersionSummary): string {
  const versions =
    summary.current && summary.next && summary.current !== summary.next
      ? `${summary.current} → ${summary.next}`
      : (summary.current ?? summary.next);
  return [versions, summary.scope].filter((part) => part).join(" ");
}

/** The machines whose update this component's row button (and "Update all") starts. */
export function componentUpdateTargets<Row extends UpdateRowView>(
  group: Pick<ComponentUpdateGroup<Row>, "machines">,
): MachineUpdateRow<Row>[] {
  return group.machines.filter(({ row, canUpdate }) => canUpdate && rowNeedsUpdate(row));
}

/**
 * Everything "Update all" starts: each pending update on each machine that
 * this session may run with one click. Manual installs and machines without
 * the permission are left out; their rows still say they are behind.
 */
export function collectUpdateAllTargets<Row extends UpdateRowView>(
  groups: ReadonlyArray<Pick<ComponentUpdateGroup<Row>, "machines">>,
): MachineUpdateRow<Row>[] {
  return groups.flatMap(componentUpdateTargets);
}

export interface ComponentProgress {
  readonly label: string;
  /** Machines finished out of the batch, 0-100; null for a single update. */
  readonly percent: number | null;
}

/**
 * A component's progress across machines. `batch` holds every row id that has
 * been updating since nothing was, so "Updating 2 of 3" counts on as machines
 * finish rather than shrinking. One machine reports its own detail.
 */
export function describeComponentProgress(
  machines: ReadonlyArray<Pick<MachineUpdateRow, "id" | "row">>,
  batch: ReadonlySet<string>,
): ComponentProgress | null {
  const updating = machines.filter(({ row }) => row.status === "updating");
  if (updating.length === 0) return null;
  const total = Math.max(machines.filter(({ id }) => batch.has(id)).length, updating.length);
  if (total === 1) {
    return {
      label: updating[0]!.row.detail ?? "Updating",
      percent: updating[0]!.row.percent ?? null,
    };
  }
  const done = total - updating.length;
  return { label: `Updating ${done + 1} of ${total}`, percent: (done / total) * 100 };
}

/**
 * Where the component failed: the machine and its reason when one did, else
 * how many. Null when nothing failed. Each machine's reason sits in its own
 * row under the disclosure.
 */
export function describeComponentFailure(
  machines: ReadonlyArray<Pick<MachineUpdateRow, "machineLabel" | "row">>,
): string | null {
  const failed = machines.filter(({ row }) => row.status === "failed");
  if (failed.length === 0) return null;
  if (machines.length === 1) return failed[0]!.row.detail;
  if (failed.length === 1) {
    const { machineLabel, row } = failed[0]!;
    return row.detail ? `Failed on ${machineLabel}: ${row.detail}` : `Failed on ${machineLabel}`;
  }
  return `Failed on ${failed.length} of ${machines.length} machines`;
}
