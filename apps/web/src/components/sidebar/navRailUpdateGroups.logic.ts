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
 * A component's one row across every machine: one version (or "old → new"),
 * one progress value and one failure line. `split` is true when the machines
 * disagree (different versions, or one failed or behind while another is
 * not) or several failed, and only then does the row open on each machine,
 * so every failure's reason and retry stays reachable. Machines updating
 * together still agree, so a batch does not split the row while it runs.
 */
export interface ComponentSummary {
  readonly current: string | null;
  readonly next: string | null;
  readonly split: boolean;
  /** 0-100 while updating, null when the updater gives no figure. */
  readonly percent: number | null;
  readonly failure: string | null;
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

/**
 * `batch` holds every row id that has been updating since nothing was, so a
 * component updating on three machines fills its one bar as each finishes.
 */
export function summarizeComponent(
  machines: ReadonlyArray<Pick<MachineUpdateRow, "id" | "machineLabel" | "row">>,
  batch: ReadonlySet<string>,
): ComponentSummary {
  const updating = machines.filter(({ row }) => row.status === "updating");
  const inBatch = machines.filter(({ id }) => batch.has(id)).length;
  const total = Math.max(inBatch, updating.length);
  const percent =
    updating.length === 0
      ? null
      : total === 1
        ? (updating[0]!.row.percent ?? null)
        : ((total - updating.length) / total) * 100;

  const failed = machines.filter(({ row }) => row.status === "failed");
  const failure =
    failed.length === 0
      ? null
      : machines.length === 1
        ? failed[0]!.row.detail
        : failed.length === 1
          ? `Failed on ${failed[0]!.machineLabel}`
          : `Failed on ${failed.length} machines`;

  if (machines.length === 1) {
    const { row } = machines[0]!;
    return {
      current: row.currentVersion,
      next: row.status === "current" ? null : row.latestVersion,
      split: false,
      percent,
      failure,
    };
  }

  const behind = machines.filter(({ row }) => row.status !== "current");
  const froms = distinct(behind.map(({ row }) => row.currentVersion));
  const targets = distinct(behind.map(({ row }) => row.latestVersion));
  const currents = distinct(machines.map(({ row }) => row.currentVersion));
  // A machine in the batch moves with it until the batch ends, finished or not.
  const phases = new Set(
    machines.map(({ id, row }) =>
      row.status === "updating" || (batch.has(id) && row.status === "current")
        ? "batch"
        : row.status,
    ),
  );
  if (behind.length === 0) {
    return {
      current: newest(currents),
      next: null,
      split: currents.length > 1,
      percent,
      failure,
    };
  }
  return {
    // Behind from one version: "old → new". Otherwise just where they head.
    current: froms.length === 1 ? froms[0]! : null,
    next: newest(targets),
    // Failures on several machines each carry their own reason and retry.
    split: phases.size > 1 || froms.length > 1 || targets.length > 1 || failed.length > 1,
    percent,
    failure,
  };
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
