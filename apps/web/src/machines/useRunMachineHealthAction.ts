import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { machinesRpc } from "../rpc/machines";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { MachineHealthAction } from "./machineHealthLinks.logic";
import { useOpenMachineHealthLink } from "./useOpenMachineHealthLink";

const ALWAYS_PERMITTED = Atom.make(true).pipe(Atom.withLabel("machine-health:open-permitted"));

/** Whether this connection may run an action; opening a screen always is. */
export function machineHealthActionPermissionAtom(action: MachineHealthAction): Atom.Atom<boolean> {
  switch (action.kind) {
    case "open":
      return ALWAYS_PERMITTED;
    case "runTask":
      return serverEnvironment.runScheduledTaskNow.permissionAtom(action.environmentId);
    case "setupSandbox":
      return machinesRpc.sandboxSetup.permissionAtom(action.environmentId);
    case "retrySync":
      return machinesRpc.healthRetrySync.permissionAtom(action.environmentId);
  }
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "Try again in a moment.";
}

/**
 * Runs a health item's fix or opens its target. Commands report their
 * outcome in a toast; resolves true when the action went through.
 */
export function useRunMachineHealthAction(): (action: MachineHealthAction) => Promise<boolean> {
  const open = useOpenMachineHealthLink();
  const runTask = useAtomCommand(serverEnvironment.runScheduledTaskNow, { reportFailure: false });
  const setupSandbox = useAtomCommand(machinesRpc.sandboxSetup, { reportFailure: false });
  const retrySync = useAtomCommand(machinesRpc.healthRetrySync, { reportFailure: false });
  return useCallback(
    async (action: MachineHealthAction) => {
      if (action.kind === "open") {
        open(action.link);
        return true;
      }
      if (action.kind === "setupSandbox") {
        const outcome = await setupSandbox({ environmentId: action.environmentId, input: {} });
        if (outcome._tag === "Success") {
          toastManager.add({
            type: outcome.value.available ? "success" : "info",
            title: outcome.value.available
              ? "Chat commands enabled"
              : "Chat sandbox needs attention",
            description: outcome.value.message,
            timeout: outcome.value.available ? 5000 : 0,
          });
          return outcome.value.available;
        }
        if (!isAtomCommandInterrupted(outcome))
          toastManager.add({
            type: "error",
            title: "Couldn't set up the sandbox",
            description: failureMessage(squashAtomCommandFailure(outcome)),
          });
        return false;
      }
      const result =
        action.kind === "runTask"
          ? await runTask({ environmentId: action.environmentId, input: { id: action.taskId } })
          : await retrySync({
              environmentId: action.environmentId,
              input: { environmentId: action.peerEnvironmentId },
            });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: action.kind === "runTask" ? "Task started" : "Retrying sync",
        });
        return true;
      }
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: action.kind === "runTask" ? "Couldn't run the task" : "Couldn't retry sync",
          description: failureMessage(squashAtomCommandFailure(result)),
        });
      }
      return false;
    },
    [open, retrySync, runTask, setupSandbox],
  );
}
