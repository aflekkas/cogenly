import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { useOpenAgentChat } from "../hooks/useOpenAgentChat";
import { machinesRpc } from "../rpc/machines";
import { useAtomCommand } from "../state/use-atom-command";
import {
  machineHealthAgentPrompt,
  problemsLeftForAgent,
  type MachineHealthAction,
} from "./machineHealthLinks.logic";
import { useOpenMachineHealthLink } from "./useOpenMachineHealthLink";

const ALWAYS_PERMITTED = Atom.make(true).pipe(Atom.withLabel("machine-health:open-permitted"));

/** Whether this connection may run an action; opening a screen always is. */
export function machineHealthActionPermissionAtom(action: MachineHealthAction): Atom.Atom<boolean> {
  switch (action.kind) {
    case "open":
      return ALWAYS_PERMITTED;
    case "fix":
      return machinesRpc.healthFix.permissionAtom(action.environmentId);
    // Starting a chat is an operate grant on the server it opens on, as Fix is.
    case "agent":
      return machinesRpc.healthFix.permissionAtom(action.request.environmentId);
  }
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "Try again in a moment.";
}

/**
 * Runs a health Fix or opens its target. A direct fix reports its outcome in
 * a toast and hands what it couldn't fix to an agent chat, which opens with
 * the problem filled in. Resolves true when the action went through.
 */
export function useRunMachineHealthAction(): (action: MachineHealthAction) => Promise<boolean> {
  const open = useOpenMachineHealthLink();
  const openAgentChat = useOpenAgentChat();
  const healthFix = useAtomCommand(machinesRpc.healthFix, { reportFailure: false });
  return useCallback(
    async (action: MachineHealthAction) => {
      switch (action.kind) {
        case "open":
          open(action.link);
          return true;
        case "agent":
          return openAgentChat(action.request.environmentId, action.request.prompt);
        case "fix": {
          const outcome = await healthFix({
            environmentId: action.environmentId,
            input: {
              ...(action.environmentId === action.originEnvironmentId
                ? {}
                : { environmentId: action.originEnvironmentId }),
              itemKeys: action.itemKeys,
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
          const failed = result.outcomes.some((entry) => entry.status === "failed");
          toastManager.add({
            type: failed ? "warning" : "success",
            title: failed
              ? `Fix needs attention on ${result.machineName}`
              : `Fixed on ${result.machineName}`,
            description: result.summary,
            // A failure explains what to do next; leave it until read.
            ...(failed ? { timeout: 0 } : {}),
          });
          const left = problemsLeftForAgent(
            action,
            result.outcomes
              .filter((entry) => entry.status === "manual")
              .map((entry) => entry.itemKey),
          );
          if (left.length > 0) {
            await openAgentChat(
              action.environmentId,
              machineHealthAgentPrompt(left, {
                environmentId: action.originEnvironmentId,
                name: action.originMachineName,
                local: action.environmentId === action.originEnvironmentId,
              }),
            );
          }
          return !failed;
        }
      }
    },
    [healthFix, open, openAgentChat],
  );
}
