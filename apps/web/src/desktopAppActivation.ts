import type {
  DesktopAppActivationFailure,
  DesktopAppAddEnvironmentRequest,
  DesktopAppOpenWorkspaceRequest,
  DesktopAppPairMachinesRequest,
  DesktopAppPairedMachine,
  DesktopAppActivationResponse,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ThreadId,
} from "@cogenly/contracts";
import { parseAddEnvironmentRequest } from "@cogenly/shared/environmentLinks";

export interface DesktopAppActivationProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface DesktopAppActivationTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: ExecutionEnvironmentPlatformOs;
}

export interface DesktopAppActivationDependencies {
  readonly getTarget: () => DesktopAppActivationTarget | null;
  readonly findProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => DesktopAppActivationProject | null;
  readonly createProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => Promise<ProjectId>;
  readonly waitForProject: (projectRef: ScopedProjectRef) => Promise<void>;
  readonly openThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
}

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return { version: 1, requestId, ok: false, code, message };
}

function desktopPlatformToEnvironmentOs(
  platform: DesktopAppOpenWorkspaceRequest["platform"],
): ExecutionEnvironmentPlatformOs {
  return platform === "win32" ? "windows" : platform;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppOpenWorkspaceRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  const target = dependencies.getTarget();
  if (target === null) {
    return failure(
      request.requestId,
      "environment-unavailable",
      "The desktop app's primary local environment is not connected.",
    );
  }

  const requestPlatform = desktopPlatformToEnvironmentOs(request.platform);
  if (requestPlatform !== target.platform) {
    return failure(
      request.requestId,
      "platform-mismatch",
      `The command path is for ${requestPlatform}, but the desktop app's primary environment uses ${target.platform}. Cross-platform path mapping is not supported.`,
    );
  }

  let projectId = dependencies.findProject(target.environmentId, request.workspaceRoot)?.id ?? null;
  if (projectId === null) {
    try {
      projectId = await dependencies.createProject(target.environmentId, request.workspaceRoot);
      await dependencies.waitForProject({ environmentId: target.environmentId, projectId });
    } catch (error) {
      return failure(
        request.requestId,
        "project-create-failed",
        errorMessage(error, "Cogenly could not add the repository."),
      );
    }
  }

  try {
    const opened = await dependencies.openThread({
      environmentId: target.environmentId,
      projectId,
    });
    if (opened === null) {
      return failure(
        request.requestId,
        "thread-open-failed",
        "Cogenly could not open a new thread for the repository.",
      );
    }
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId,
      threadId: opened.threadId,
    };
  } catch (error) {
    return failure(
      request.requestId,
      "thread-open-failed",
      errorMessage(error, "Cogenly could not open a new thread for the repository."),
    );
  }
}

export interface DesktopAddEnvironmentDependencies {
  readonly resolveHost: (alias: string) => Promise<DesktopSshEnvironmentTarget>;
  /** Runs the SSH flow Settings uses: provision, pair, and save. A blank label picks a name. */
  readonly connect: (input: {
    readonly target: DesktopSshEnvironmentTarget;
    readonly label: string;
  }) => Promise<{ readonly environmentId: EnvironmentId; readonly label: string }>;
  /** Progress the user sees while it runs. */
  readonly onStart: (displayName: string) => void;
  readonly onConnected: (label: string) => void;
  readonly onFailed: (displayName: string, message: string) => void;
}

/**
 * Adds an SSH environment for `cogenly environment add`, `environment_add`, or a deep link
 * the user confirmed. It reuses the host's Cogenly, starts its service when stopped, pairs,
 * and saves the environment, the same as Settings → Connections → Connect a machine → SSH.
 */
export async function handleDesktopAddEnvironmentRequest(
  request: DesktopAppAddEnvironmentRequest,
  dependencies: DesktopAddEnvironmentDependencies,
): Promise<DesktopAppActivationResponse> {
  const parsed = parseAddEnvironmentRequest({ ssh: request.ssh, name: request.name });
  if (!parsed.ok) return failure(request.requestId, "invalid-request", parsed.error);
  const { ssh, name } = parsed.value;
  const displayName = name ?? "your server";
  dependencies.onStart(displayName);
  try {
    const target = await dependencies.resolveHost(ssh);
    const added = await dependencies.connect({ target, label: name ?? "" });
    dependencies.onConnected(added.label);
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      environmentId: added.environmentId,
      label: added.label,
    };
  } catch (error) {
    const message = errorMessage(error, `Cogenly could not connect to ${ssh}.`);
    dependencies.onFailed(displayName, message);
    return failure(request.requestId, "environment-add-failed", message);
  }
}

/** A machine this app has a connection to. */
export interface DesktopPairingCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
}

export interface DesktopPairMachinesDependencies {
  readonly machines: ReadonlyArray<DesktopPairingCandidate>;
  /** Runs Settings → Machines → Add machine's pairing command; throws its failure. */
  readonly pair: (input: {
    readonly hub: DesktopAppPairedMachine;
    readonly joining: DesktopAppPairedMachine;
  }) => Promise<void>;
  readonly onPaired: (input: {
    readonly hub: DesktopAppPairedMachine;
    readonly joining: DesktopAppPairedMachine;
  }) => void;
}

/** The connection a request names, by environment id or by its name. */
export function findPairingCandidate(
  machines: ReadonlyArray<DesktopPairingCandidate>,
  query: string,
):
  | { readonly ok: true; readonly machine: DesktopPairingCandidate }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  const byId = machines.find((machine) => machine.environmentId === query);
  if (byId !== undefined) return { ok: true, machine: byId };
  const wanted = query.trim().toLowerCase();
  const named = machines.filter((machine) => machine.label.trim().toLowerCase() === wanted);
  if (named.length === 1) return { ok: true, machine: named[0]! };
  const known = machines.map((machine) => `"${machine.label}" (${machine.environmentId})`);
  return {
    ok: false,
    message:
      named.length > 1
        ? `More than one connection is named "${query}". Use its environment id: ${named.map((machine) => machine.environmentId).join(", ")}.`
        : `This app has no connection named "${query}". Its connections: ${known.join(", ")}. Add a missing machine with environment_add or in Settings → Connections.`,
  };
}

/**
 * Pairs two machines for `machine_pair`, with the command Settings → Machines →
 * Add machine uses. The join code passes between the two connections inside
 * that command and never reaches the request, the response, or the agent.
 */
export async function handleDesktopPairMachinesRequest(
  request: DesktopAppPairMachinesRequest,
  dependencies: DesktopPairMachinesDependencies,
): Promise<DesktopAppActivationResponse> {
  const hub = findPairingCandidate(dependencies.machines, request.hub);
  if (!hub.ok) return failure(request.requestId, "invalid-request", hub.message);
  const joining = findPairingCandidate(dependencies.machines, request.joining);
  if (!joining.ok) return failure(request.requestId, "invalid-request", joining.message);
  if (hub.machine.environmentId === joining.machine.environmentId) {
    return failure(
      request.requestId,
      "invalid-request",
      "A machine can't pair with itself. Name two different machines.",
    );
  }
  const offline = [hub.machine, joining.machine].find((machine) => !machine.connected);
  if (offline !== undefined) {
    return failure(
      request.requestId,
      "environment-unavailable",
      `This app isn't connected to ${offline.label} right now. Wake it up and make sure Cogenly is running there.`,
    );
  }
  const pair = {
    hub: { environmentId: hub.machine.environmentId, name: hub.machine.label },
    joining: { environmentId: joining.machine.environmentId, name: joining.machine.label },
  };
  try {
    await dependencies.pair(pair);
  } catch (error) {
    return failure(
      request.requestId,
      "machines-pair-failed",
      errorMessage(error, `Cogenly couldn't pair ${pair.joining.name} with ${pair.hub.name}.`),
    );
  }
  dependencies.onPaired(pair);
  return { version: 1, requestId: request.requestId, ok: true, ...pair };
}
