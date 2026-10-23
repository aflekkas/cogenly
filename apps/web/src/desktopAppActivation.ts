import type {
  DesktopAppActivationFailure,
  DesktopAppAddEnvironmentRequest,
  DesktopAppOpenWorkspaceRequest,
  DesktopAppActivationResponse,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";
import { parseAddEnvironmentRequest } from "@t3tools/shared/environmentLinks";

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
 * and saves the environment, the same as Settings → Connections → Add environment → SSH.
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
