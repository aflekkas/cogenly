import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useStartAgentChat } from "../hooks/useStartAgentChat";
import { machinesRpc } from "../rpc/machines";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  healthFixFollowUp,
  machineHealthAgentPrompt,
  type MachineHealthAction,
  type MachineHealthLegacyCommand,
} from "./machineHealthLinks.logic";
import { useOpenMachineHealthLink } from "./useOpenMachineHealthLink";

const ALWAYS_PERMITTED = Atom.make(true).pipe(Atom.withLabel("machine-health:open-permitted"));

/** Whether this connection may run an action; opening a screen always is. */
export function machineHealthActionPermissionAtom(action: MachineHealthAction): Atom.Atom<boolean> {
  switch (action.kind) {
    case "open":
      return ALWAYS_PERMITTED;
    case "fix":
      switch (action.direct?.kind) {
        case undefined:
          return ALWAYS_PERMITTED;
        case "healthFix":
          return machinesRpc.healthFix.permissionAtom(action.direct.environmentId);
        case "legacy":
          // A group's items share a check, so its commands share a grant.
          return legacyCommandPermissionAtom(action.direct.commands[0]);
      }
    // Starting a chat is an operate grant on the server it opens on, as Fix is.
    case "agent":
      return machinesRpc.healthFix.permissionAtom(action.request.environmentId);
    case "disableProvider":
      return serverEnvironment.mutateProviderInstance.permissionAtom(action.environmentId);
  }
}

/**
 * Turns a provider off in one machine's own settings. The instance comes from
 * that machine's settings, or its provider list for a default instance nobody
 * edited; `enabled` stays on the machine (see providerSettingsDocument.ts).
 */
function useTurnOffProvider(): (
  action: Extract<MachineHealthAction, { readonly kind: "disableProvider" }>,
) => Promise<boolean> {
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });
  return useCallback(
    async (action) => {
      const { environmentId, instanceId, machineName } = action;
      const settings = appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId));
      const provider = appAtomRegistry
        .get(serverEnvironment.configValueAtom(environmentId))
        ?.providers.find((entry) => entry.instanceId === instanceId);
      const instance =
        settings?.providerInstances[instanceId] ??
        (provider === undefined ? undefined : { driver: provider.driver });
      const name = provider?.displayName ?? instanceId;
      if (instance === undefined) {
        toastManager.add({
          type: "error",
          title: `Couldn't turn off ${name}`,
          description: `${machineName} no longer lists it.`,
        });
        return false;
      }
      const outcome = await mutate({
        environmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId,
            instance: { ...instance, enabled: false },
          },
        },
      });
      if (outcome._tag !== "Success") {
        if (!isAtomCommandInterrupted(outcome))
          toastManager.add({
            type: "error",
            title: `Couldn't turn off ${name}`,
            description: failureMessage(squashAtomCommandFailure(outcome)),
          });
        return false;
      }
      toastManager.add({
        type: "success",
        title: `Turned off ${name} on ${machineName}`,
        description:
          "It stays on for your other machines. Turn it back on in Settings → Providers.",
      });
      return true;
    },
    [mutate],
  );
}

function legacyCommandPermissionAtom(command: MachineHealthLegacyCommand): Atom.Atom<boolean> {
  switch (command.kind) {
    case "runTask":
      return serverEnvironment.runScheduledTaskNow.permissionAtom(command.environmentId);
    case "retrySync":
      return machinesRpc.healthRetrySync.permissionAtom(command.environmentId);
    case "setupSandbox":
      return machinesRpc.sandboxSetup.permissionAtom(command.environmentId);
  }
}

const LEGACY_COMMAND_COPY = {
  runTask: { done: "Task started", failed: "Couldn't run the task" },
  retrySync: { done: "Retrying sync", failed: "Couldn't retry sync" },
  setupSandbox: { done: "Chat commands enabled", failed: "Couldn't set up the sandbox" },
} as const satisfies Record<MachineHealthLegacyCommand["kind"], { done: string; failed: string }>;

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "Try again in a moment.";
}

/** Runs one older server's fix command and toasts its outcome; resolves whether it worked. */
function useRunLegacyHealthCommand(): (command: MachineHealthLegacyCommand) => Promise<boolean> {
  const runTask = useAtomCommand(serverEnvironment.runScheduledTaskNow, { reportFailure: false });
  const retrySync = useAtomCommand(machinesRpc.healthRetrySync, { reportFailure: false });
  const setupSandbox = useAtomCommand(machinesRpc.sandboxSetup, { reportFailure: false });
  return useCallback(
    async (command: MachineHealthLegacyCommand) => {
      const copy = LEGACY_COMMAND_COPY[command.kind];
      const { environmentId } = command;
      const sandbox =
        command.kind === "setupSandbox" ? await setupSandbox({ environmentId, input: {} }) : null;
      const outcome =
        sandbox ??
        (command.kind === "runTask"
          ? await runTask({ environmentId, input: { id: command.taskId } })
          : command.kind === "retrySync"
            ? await retrySync({
                environmentId,
                input: { environmentId: command.peerEnvironmentId },
              })
            : null);
      if (outcome === null) return false;
      if (outcome._tag !== "Success") {
        if (!isAtomCommandInterrupted(outcome))
          toastManager.add({
            type: "error",
            title: copy.failed,
            description: failureMessage(squashAtomCommandFailure(outcome)),
          });
        return false;
      }
      if (sandbox?._tag === "Success" && !sandbox.value.available) {
        toastManager.add({
          type: "info",
          title: "Chat sandbox needs attention",
          description: sandbox.value.message,
          timeout: 0,
        });
        return false;
      }
      toastManager.add({ type: "success", title: copy.done });
      return true;
    },
    [retrySync, runTask, setupSandbox],
  );
}

/**
 * Runs a health Fix or opens its target. A direct fix reports its outcome in
 * a toast, then Fix opens the first sign-in or hands what it couldn't fix to
 * a new agent chat, which opens already working on the problem. Resolves true
 * when the action went through.
 */
export function useRunMachineHealthAction(): (action: MachineHealthAction) => Promise<boolean> {
  const open = useOpenMachineHealthLink();
  const startAgentChat = useStartAgentChat();
  const healthFix = useAtomCommand(machinesRpc.healthFix, { reportFailure: false });
  const runLegacy = useRunLegacyHealthCommand();
  const turnOffProvider = useTurnOffProvider();
  return useCallback(
    async (action: MachineHealthAction) => {
      switch (action.kind) {
        case "open":
          open(action.link);
          return true;
        case "disableProvider":
          return turnOffProvider(action);
        case "agent":
          return startAgentChat(action.request.environmentId, { prompt: action.request.prompt });
        case "fix": {
          let failed = false;
          let manual: ReadonlyArray<string> = [];
          const { direct } = action;
          if (direct?.kind === "legacy") {
            for (const command of direct.commands) {
              if (!(await runLegacy(command))) failed = true;
            }
          }
          if (direct?.kind === "healthFix") {
            const outcome = await healthFix({
              environmentId: direct.environmentId,
              input: {
                ...(direct.environmentId === action.originEnvironmentId
                  ? {}
                  : { environmentId: action.originEnvironmentId }),
                itemKeys: direct.itemKeys,
              },
            });
            if (outcome._tag !== "Success") {
              if (!isAtomCommandInterrupted(outcome))
                toastManager.add({
                  type: "error",
                  title: `Couldn't fix it on ${action.originMachineName}`,
                  description: failureMessage(squashAtomCommandFailure(outcome)),
                });
              return false;
            }
            const result = outcome.value;
            failed = result.outcomes.some((entry) => entry.status === "failed");
            toastManager.add({
              type: failed ? "warning" : "success",
              title: failed
                ? `Fix needs attention on ${result.machineName}`
                : `Fixed on ${result.machineName}`,
              description: result.summary,
              // A failure explains what to do next; leave it until read.
              ...(failed ? { timeout: 0 } : {}),
            });
            manual = result.outcomes
              .filter((entry) => entry.status === "manual")
              .map((entry) => entry.itemKey);
          }
          const next = healthFixFollowUp(action, manual);
          if (next.signIn !== null) open(next.signIn);
          if (next.agent.length > 0 && action.agentEnvironmentId !== null) {
            await startAgentChat(action.agentEnvironmentId, {
              prompt: machineHealthAgentPrompt(next.agent, {
                environmentId: action.originEnvironmentId,
                name: action.originMachineName,
                local: action.agentEnvironmentId === action.originEnvironmentId,
              }),
            });
          }
          if (next.remaining > 0) {
            toastManager.add({
              type: "info",
              title:
                next.remaining === 1
                  ? `1 more problem on ${action.originMachineName}`
                  : `${next.remaining} more problems on ${action.originMachineName}`,
              description: "Each has its own action in the machine's health.",
              actionProps: { children: "Details", onClick: () => open(action.details) },
            });
          }
          return !failed;
        }
      }
    },
    [healthFix, open, runLegacy, startAgentChat, turnOffProvider],
  );
}
