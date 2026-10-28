import { squashAtomCommandFailure } from "@cogenly/client-runtime/state/runtime";
import type { DesktopAppRendererRequest } from "@cogenly/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { formatDesktopSshConnectionError } from "../../connection/sshConnectionError";
import { connectSshEnvironment } from "../../connection/onboarding";
import {
  handleDesktopAddEnvironmentRequest,
  handleDesktopAppActivationRequest,
  handleDesktopPairMachinesRequest,
} from "../../desktopAppActivation";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newProjectId } from "../../lib/utils";
import { machinesRpc } from "../../rpc/machines";
import { readProjects, waitForProject } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function DesktopAppActivationCoordinator() {
  const primaryEnvironment = usePrimaryEnvironment();
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  const connectSsh = useAtomCommand(connectSshEnvironment, { reportFailure: false });
  const pairMachines = useAtomCommand(machinesRpc.pairWith, { reportFailure: false });
  const { environments } = useEnvironments();
  const queueRef = useRef(Promise.resolve());
  const activation = window.desktopBridge?.appActivation;
  const shell = useEnvironmentQuery(
    primaryEnvironment === null
      ? null
      : environmentShell.stateAtom(primaryEnvironment.environmentId),
  );
  const ready =
    activation !== undefined &&
    primaryEnvironment?.connection.phase === "connected" &&
    primaryEnvironment.serverConfig !== null &&
    shell.data?.snapshot._tag === "Some";

  // `cogenly environment add`, `environment_add`, and confirmed deep links: one toast
  // that goes from "Connecting…" to "Connected" (or the failure) without blocking anything.
  const addEnvironment = useEffectEvent(
    (request: Extract<DesktopAppRendererRequest, { type: "add-environment" }>) => {
      let toastId: ReturnType<typeof toastManager.add> | null = null;
      const show = (options: Parameters<typeof toastManager.add>[0]) => {
        if (toastId === null) toastId = toastManager.add(options);
        else toastManager.update(toastId, options);
      };
      return handleDesktopAddEnvironmentRequest(request, {
        resolveHost: (alias) => {
          const bridge = window.desktopBridge;
          if (bridge === undefined) {
            return Promise.reject(new Error("SSH machines need the desktop app."));
          }
          return bridge.resolveSshHost(alias);
        },
        connect: async (input) => {
          const result = await connectSsh(input);
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        onStart: (displayName) =>
          show({
            type: "loading",
            title: `Connecting ${displayName}…`,
            description: "Signing in over SSH and pairing this app.",
            timeout: 0,
            data: { hideCopyButton: true },
          }),
        onConnected: (label) =>
          show({
            type: "success",
            title: "Connected",
            description: `${label} is ready in Settings → Connections.`,
            timeout: 6_000,
            data: { hideCopyButton: true },
          }),
        onFailed: (displayName, message) =>
          show(
            stackedThreadToast({
              type: "error",
              title: `Could not connect ${displayName}`,
              description: formatDesktopSshConnectionError(new Error(message)),
              timeout: 0,
            }),
          ),
      });
    },
  );

  // `machine_pair`: the same command as Settings → Machines → Add machine, so
  // the join code stays inside it. The agent hears the outcome; the user gets a toast.
  const pairRequested = useEffectEvent(
    (request: Extract<DesktopAppRendererRequest, { type: "pair-machines" }>) =>
      handleDesktopPairMachinesRequest(request, {
        machines: environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label.trim() || environment.environmentId,
          connected: environment.connection.phase === "connected",
        })),
        pair: async ({ hub, joining }) => {
          const result = await pairMachines({
            environmentId: joining.environmentId,
            input: { hubEnvironmentId: hub.environmentId, hubName: hub.name },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
        onPaired: ({ hub, joining }) =>
          toastManager.add({
            type: "success",
            title: `Paired. ${joining.name} now syncs with ${hub.name}.`,
          }),
      }),
  );

  const processRequest = useEffectEvent(async (request: DesktopAppRendererRequest) =>
    request.type === "add-environment"
      ? addEnvironment(request)
      : request.type === "pair-machines"
        ? pairRequested(request)
        : handleDesktopAppActivationRequest(request, {
            getTarget: () => {
              if (
                primaryEnvironment?.connection.phase !== "connected" ||
                primaryEnvironment.serverConfig === null
              ) {
                return null;
              }
              return {
                environmentId: primaryEnvironment.environmentId,
                platform: primaryEnvironment.serverConfig.environment.platform.os,
              };
            },
            findProject: (environmentId, workspaceRoot) =>
              findProjectByPath(
                readProjects().filter((project) => project.environmentId === environmentId),
                workspaceRoot,
              ) ?? null,
            createProject: async (environmentId, workspaceRoot) => {
              const projectId = newProjectId();
              const result = await createProject({
                environmentId,
                input: {
                  projectId,
                  title: inferProjectTitleFromPath(workspaceRoot),
                  workspaceRoot,
                  createWorkspaceRootIfMissing: false,
                  defaultModelSelection: null,
                },
              });
              if (result._tag === "Failure") {
                const error = squashAtomCommandFailure(result);
                throw error instanceof Error
                  ? error
                  : new Error("Cogenly could not add the repository.");
              }
              return projectId;
            },
            waitForProject: async (projectRef) => {
              await waitForProject(projectRef);
            },
            openThread: (projectRef) => openThread(projectRef),
          }),
  );

  useEffect(() => {
    if (!ready || activation === undefined) return;

    let subscribed = true;
    const unsubscribe = activation.onRequest((request) => {
      queueRef.current = queueRef.current.then(async () => {
        const response = await processRequest(request);
        await activation.complete(response);
      });
      queueRef.current = queueRef.current.catch(() => undefined);
    });
    // Skip readiness if React runs cleanup before this subscription can receive requests.
    queueMicrotask(() => {
      if (subscribed) void activation.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void activation.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [activation, ready]);

  return null;
}
