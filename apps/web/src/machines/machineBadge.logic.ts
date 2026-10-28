import type { EnvironmentConnectionPhase } from "@cogenly/client-runtime/connection";
import type { EnvironmentId } from "@cogenly/contracts";

/**
 * A machine other than this computer that runs some work, as a cloud badge
 * names it. Work on this computer has no badge at all.
 */
export interface RemoteMachine {
  readonly name: string;
  readonly online: boolean;
}

/** How pickers and details name the machine this client is primarily connected to. */
export const LOCAL_MACHINE_LABEL = "This computer";

const UNKNOWN_REMOTE_MACHINE_NAME = "Another machine";

/** The machine that runs a thread: the paired machine running its replica, else its own environment. */
export function threadRunsOn(thread: {
  readonly environmentId: EnvironmentId;
  readonly source?: { readonly ownerMachine?: EnvironmentId | null | undefined } | undefined;
}): EnvironmentId {
  return thread.source?.ownerMachine ?? thread.environmentId;
}

/**
 * Whether `runsOn` is this computer: the environment the client is primarily
 * connected to (the desktop app's own server, or the server that served this
 * browser). With no primary, as in the hosted app, every machine is remote.
 */
export function isLocalMachine(
  runsOn: EnvironmentId | null,
  localEnvironmentId: EnvironmentId | null,
): boolean {
  return runsOn !== null && localEnvironmentId !== null && runsOn === localEnvironmentId;
}

const UNREACHABLE_PHASES: ReadonlySet<EnvironmentConnectionPhase> = new Set([
  "offline",
  "error",
  "unsupported",
]);

/**
 * The badge for work that runs on `runsOn`: null on this computer, else its
 * name and whether it is reachable. `direct` is this client's own saved
 * connection to that machine, `paired` the pairing report read through the
 * work's environment. A live direct connection answers for itself; otherwise
 * the pairing report does, since a saved connection that is down or still
 * reconnecting says nothing about the machine. Without a report, only an
 * unreachable direct connection reads as offline, so a reconnect does not
 * flash it. A machine neither knows yet still gets a cloud, since it is not here.
 */
export function resolveRemoteMachine(input: {
  readonly runsOn: EnvironmentId | null;
  readonly localEnvironmentId: EnvironmentId | null;
  readonly direct: { readonly name: string; readonly phase: EnvironmentConnectionPhase } | null;
  readonly paired: RemoteMachine | null;
}): RemoteMachine | null {
  if (input.runsOn === null || isLocalMachine(input.runsOn, input.localEnvironmentId)) return null;
  const { direct, paired } = input;
  if (direct?.phase === "connected") return { name: direct.name, online: true };
  if (paired !== null) return { name: direct?.name ?? paired.name, online: paired.online };
  if (direct !== null) return { name: direct.name, online: !UNREACHABLE_PHASES.has(direct.phase) };
  return { name: UNKNOWN_REMOTE_MACHINE_NAME, online: true };
}

/** A paired machine as a picker shows it: null for this computer, else its name and reachability. */
export function pairedMachineChoice(
  machine: {
    readonly environmentId: EnvironmentId;
    readonly name: string;
    readonly online: boolean;
  },
  localEnvironmentId: EnvironmentId | null,
): RemoteMachine | null {
  return isLocalMachine(machine.environmentId, localEnvironmentId)
    ? null
    : { name: machine.name, online: machine.online };
}

/** Machines as a menu lists them: the local one renamed "This computer", the rest by name. */
export function nameLocalMachine<
  T extends { readonly environmentId: EnvironmentId; readonly name: string },
>(machines: ReadonlyArray<T>, localEnvironmentId: EnvironmentId | null): ReadonlyArray<T> {
  return machines.map((machine) =>
    isLocalMachine(machine.environmentId, localEnvironmentId)
      ? { ...machine, name: LOCAL_MACHINE_LABEL }
      : machine,
  );
}

/** A machine's name in a picker: "This computer" for the local one, else its own name. */
export function machineChoiceLabel(
  environmentId: EnvironmentId,
  name: string,
  localEnvironmentId: EnvironmentId | null,
): string {
  return isLocalMachine(environmentId, localEnvironmentId) ? LOCAL_MACHINE_LABEL : name;
}

/** The tooltip and accessible name for a cloud badge. */
export function describeRemoteMachine(machine: RemoteMachine): string {
  return machine.online ? `Runs on ${machine.name}` : `Runs on ${machine.name}, offline`;
}
