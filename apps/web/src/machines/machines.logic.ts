import {
  THREAD_MOVE_MAX_THREADS,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type MachineInfo,
  type MachineListResult,
  type ProjectMoveResult,
  type ThreadId,
  type ThreadMoveResult,
  type ThreadMoveSkip,
} from "@cogenly/contracts";

/** A machine a thread or project can be handed to, as menus offer it. */
export interface MachineMoveTarget {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly online: boolean;
  readonly icon: EnvironmentMachineKind;
}

/**
 * The machines an environment can hand work to: its hub, its spokes, or the
 * hub's other spokes (moves go through the hub), and itself when `includeThis` (work another machine runs can move here), minus
 * `exclude` (where the work already runs). Empty for a standalone machine.
 */
export function machineMoveTargets(
  list: MachineListResult | null,
  exclude: ReadonlySet<EnvironmentId> = new Set(),
  includeThis = false,
): ReadonlyArray<MachineMoveTarget> {
  if (list === null) return [];
  const paired = list.machines.filter(
    (machine) =>
      (machine.relation === "hub" || machine.relation === "spoke" || machine.relation === "peer") &&
      machine.pairing === "paired",
  );
  if (paired.length === 0) return [];
  const here = includeThis ? list.machines.filter((machine) => machine.relation === "this") : [];
  return [...paired, ...here]
    .filter((machine) => !exclude.has(machine.environmentId))
    .map((machine) => ({
      environmentId: machine.environmentId,
      name: machine.name,
      online: machine.online,
      icon: machineIconKind(machine),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Targets for a set of threads on one environment. A target is left out only
 * when it already runs every one of them; moving a thread to the machine that
 * runs it is a no-op the server reports as moved. This machine is offered
 * when another machine runs every one of them.
 */
export function machineMoveTargetsForThreads(
  list: MachineListResult | null,
  owners: ReadonlyArray<EnvironmentId | null | undefined>,
): ReadonlyArray<MachineMoveTarget> {
  const first = owners[0];
  const sharedOwner =
    first != null && owners.every((owner) => owner === first) ? new Set([first]) : undefined;
  const allElsewhere = owners.length > 0 && owners.every((owner) => owner != null);
  return machineMoveTargets(list, sharedOwner, allElsewhere);
}

/** The paired machine that runs a replica; null for this machine's own threads. */
export function threadOwnerMachine(
  list: MachineListResult | null,
  ownerMachine: EnvironmentId | null | undefined,
): MachineInfo | null {
  if (ownerMachine == null || list === null) return null;
  const machine = list.machines.find((candidate) => candidate.environmentId === ownerMachine);
  return machine === undefined || machine.relation === "this" ? null : machine;
}

/**
 * The one machine every given thread runs on now, by name, for "changes stay
 * on <machine>" copy; null when they run on different machines or it is unknown.
 */
export function threadsRunOnName(
  list: MachineListResult | null,
  owners: ReadonlyArray<EnvironmentId | null | undefined>,
): string | null {
  if (list === null || owners.length === 0) return null;
  const first = owners[0] ?? null;
  if (!owners.every((owner) => (owner ?? null) === first)) return null;
  const runner =
    first === null
      ? list.machines.find((machine) => machine.relation === "this")
      : list.machines.find((machine) => machine.environmentId === first);
  return runner?.name ?? null;
}

/** The machine icon for a paired machine's report. */
export function machineIconKind(
  machine: Pick<MachineInfo, "kind" | "hardware">,
): EnvironmentMachineKind {
  return machine.kind === "cloud-server" ? "cloud" : machine.hardware;
}

/** One move request names at most THREAD_MOVE_MAX_THREADS threads. */
export function chunkThreadIds(
  threadIds: ReadonlyArray<ThreadId>,
  size: number = THREAD_MOVE_MAX_THREADS,
): ReadonlyArray<ReadonlyArray<ThreadId>> {
  const chunks: ThreadId[][] = [];
  for (let index = 0; index < threadIds.length; index += size) {
    chunks.push(threadIds.slice(index, index + size));
  }
  return chunks;
}

export function mergeThreadMoveResults(results: ReadonlyArray<ThreadMoveResult>): ThreadMoveResult {
  return {
    moved: results.flatMap((result) => result.moved),
    skipped: results.flatMap((result) => result.skipped),
  };
}

const SKIP_PHRASES: Partial<Record<ThreadMoveSkip["reason"], string>> = {
  busy: "busy",
  "local-changes": "with unpushed changes",
  "needs-repository": "missing a repository",
  offline: "on an offline machine",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "2 busy, 12 with unpushed changes": skips counted by reason, in reason order of first appearance. */
export function describeThreadMoveSkips(skipped: ReadonlyArray<ThreadMoveSkip>): string {
  const first = skipped[0];
  if (first === undefined) return "";
  if (skipped.length === 1) return first.detail;
  const counts = new Map<string, number>();
  for (const skip of skipped) {
    const phrase = SKIP_PHRASES[skip.reason] ?? "refused";
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return `Skipped ${[...counts].map(([phrase, count]) => `${count} ${phrase}`).join(", ")}.`;
}

export interface ThreadMoveSummary {
  readonly type: "success" | "warning" | "error";
  readonly title: string;
  readonly description: string | null;
  /** Threads held back only by unpushed changes, which a confirmed retry can move. */
  readonly localChanges: ReadonlyArray<ThreadId>;
}

/** The toast a finished thread move shows. */
export function summarizeThreadMove(
  result: ThreadMoveResult,
  targetName: string,
): ThreadMoveSummary {
  const total = result.moved.length + result.skipped.length;
  const localChanges = result.skipped
    .filter((skip) => skip.reason === "local-changes")
    .map((skip) => skip.threadId);
  const description = result.skipped.length > 0 ? describeThreadMoveSkips(result.skipped) : null;
  if (result.skipped.length === 0) {
    return {
      type: "success",
      title:
        total === 1
          ? `Moved to ${targetName}`
          : `Moved ${plural(total, "thread")} to ${targetName}`,
      description: `${targetName} runs ${total === 1 ? "it" : "them"} from now on.`,
      localChanges,
    };
  }
  if (result.moved.length === 0) {
    return {
      type: "error",
      title:
        total === 1
          ? `Could not move to ${targetName}`
          : `Could not move ${plural(total, "thread")} to ${targetName}`,
      description,
      localChanges,
    };
  }
  return {
    type: "warning",
    title: `Moved ${result.moved.length} of ${plural(total, "thread")} to ${targetName}`,
    description,
    localChanges,
  };
}

/** The toast a finished project move shows: its repositories, then its threads. */
export function summarizeProjectMove(
  result: ProjectMoveResult,
  projectName: string,
  targetName: string,
): ThreadMoveSummary {
  const { moved, skipped } = result.threads;
  const failedRepositories = result.repositories.filter((repo) => repo.status === "failed");
  const cloning = result.repositories.filter((repo) => repo.status === "cloning").length;
  const parts: string[] = [];
  if (cloning > 0) parts.push(`${targetName} is cloning ${plural(cloning, "repository")}.`);
  if (failedRepositories.length === 1) {
    const failed = failedRepositories[0]!;
    parts.push(`Could not clone ${failed.remote}${failed.detail ? `: ${failed.detail}` : "."}`);
  } else if (failedRepositories.length > 1) {
    parts.push(`Could not clone ${failedRepositories.length} repositories.`);
  }
  if (moved.length > 0 || skipped.length === 0) {
    parts.push(`Moved ${plural(moved.length, "thread")}.`);
  }
  if (skipped.length > 0) parts.push(describeThreadMoveSkips(skipped));
  const troubled = skipped.length > 0 || failedRepositories.length > 0;
  return {
    type: !troubled ? "success" : moved.length === 0 && skipped.length > 0 ? "error" : "warning",
    title:
      moved.length === 0 && skipped.length > 0
        ? `Could not move ${projectName} to ${targetName}`
        : `Moved ${projectName} to ${targetName}`,
    description: parts.join(" "),
    localChanges: skipped
      .filter((skip) => skip.reason === "local-changes")
      .map((skip) => skip.threadId),
  };
}
