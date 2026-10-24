import { CommandId, ThreadId, ThreadRemoteError, type EnvironmentId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback } from "react";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { serverEnvironment } from "../state/server";
import { waitForThreadShell } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import type { MachineMoveTarget } from "./machines.logic";

const isRemoteError = Schema.is(ThreadRemoteError);
const attempts = new Map<string, { commandId: CommandId; targetThreadId: ThreadId }>();

/** A fork always keeps its source. An explicit action chooses the pushed revision when local work cannot travel. */
export function useForkToMachine() {
  const fork = useAtomCommand(serverEnvironment.forkThreadToMachine, { reportFailure: false });
  const navigate = useNavigate();
  return useCallback(
    async (request: {
      readonly environmentId: EnvironmentId;
      readonly sourceThreadId: ThreadId;
      readonly target: Pick<MachineMoveTarget, "environmentId" | "name">;
    }) => {
      const key = `${request.environmentId}:${request.sourceThreadId}:${request.target.environmentId}`;
      const attempt = attempts.get(key) ?? {
        commandId: CommandId.make(randomUUID()),
        targetThreadId: ThreadId.make(randomUUID()),
      };
      attempts.set(key, attempt);
      const run = async (allowLastPushed = false): Promise<void> => {
        const progress = toastManager.add({
          type: "loading",
          title: `Forking to ${request.target.name}…`,
          timeout: 0,
        });
        const result = await fork({
          environmentId: request.environmentId,
          input: {
            ...attempt,
            sourceThreadId: request.sourceThreadId,
            machine: request.target.environmentId,
            ...(allowLastPushed ? { allowLastPushed: true } : {}),
          },
        });
        toastManager.close(progress);
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const error = squashAtomCommandFailure(result);
          const localChanges = isRemoteError(error) && error.reason === "local-changes";
          toastManager.add({
            type: "error",
            title: localChanges
              ? "Local work stays on this machine"
              : `Could not fork to ${request.target.name}`,
            description:
              error instanceof Error ? error.message : "The conversation could not be forked.",
            timeout: 0,
            actionProps: {
              children: localChanges ? "Start from last pushed commit" : "Retry",
              onClick: () => {
                void run(localChanges || allowLastPushed);
              },
            },
          });
          return;
        }
        attempts.delete(key);
        const target = scopeThreadRef(request.environmentId, result.value.targetThreadId);
        if (await waitForThreadShell(target)) {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(target),
          });
        } else {
          toastManager.add({
            type: "info",
            title: `Fork created on ${request.target.name}`,
            description: "Open it from the sidebar once the thread arrives.",
          });
        }
      };
      await run();
    },
    [fork, navigate],
  );
}
