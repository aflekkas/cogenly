import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import type { EnvironmentId, ProjectLabelId, ThreadId, ThreadMoveResult } from "@cogenly/contracts";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { readLocalApi } from "../localApi";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  chunkThreadIds,
  mergeThreadMoveResults,
  summarizeProjectMove,
  summarizeThreadMove,
  type MachineMoveTarget,
  type ThreadMoveSummary,
} from "./machines.logic";

export interface ThreadMachineMoveRequest {
  /** The environment the client reaches the threads through. */
  readonly environmentId: EnvironmentId;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly target: Pick<MachineMoveTarget, "environmentId" | "name">;
  /** The machine they run on now, named where held-back changes stay. */
  readonly fromName: string | null;
  readonly leaveLocalChanges?: boolean;
}

function errorDescription(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Shows a finished move. Threads held back only by unpushed changes get a
 * "Move anyway…" action that confirms first, since those changes stay behind.
 */
function showMoveSummary(
  summary: ThreadMoveSummary,
  request: Omit<ThreadMachineMoveRequest, "threadIds">,
  retry: (request: ThreadMachineMoveRequest) => Promise<unknown>,
) {
  const retryable = request.leaveLocalChanges !== true && summary.localChanges.length > 0;
  const id = toastManager.add({
    type: summary.type,
    title: summary.title,
    ...(summary.description ? { description: summary.description } : {}),
    ...(retryable
      ? {
          timeout: 0,
          actionProps: {
            children: "Move anyway…",
            onClick: () => {
              toastManager.close(id);
              void confirmLeavingChanges(summary.localChanges.length, request).then((confirmed) => {
                if (!confirmed) return;
                void retry({
                  ...request,
                  threadIds: summary.localChanges,
                  leaveLocalChanges: true,
                });
              });
            },
          },
        }
      : {}),
  });
}

async function confirmLeavingChanges(
  count: number,
  request: Pick<ThreadMachineMoveRequest, "target" | "fromName">,
): Promise<boolean> {
  const api = readLocalApi();
  if (!api) return false;
  const from = request.fromName ?? "the machine that runs them now";
  const confirmed = await settlePromise(() =>
    api.dialogs.confirm(
      [
        count === 1
          ? `Move this thread to ${request.target.name} anyway?`
          : `Move ${count} threads to ${request.target.name} anyway?`,
        `Uncommitted and unpushed changes stay on ${from}. ${request.target.name} checks out each branch as pushed.`,
      ].join("\n"),
    ),
  );
  return confirmed._tag === "Success" && confirmed.value;
}

/**
 * Hands threads to another paired machine, which runs them from then on.
 * Large selections go out in request-sized chunks. Shows progress, then what
 * moved and what was skipped. Resolves with the result, or null on failure.
 */
export function useMoveThreadsToMachine() {
  const move = useAtomCommand(serverEnvironment.moveThreadsToMachine, {
    label: "move threads to machine",
    reportFailure: false,
  });

  return useCallback(
    async function run(request: ThreadMachineMoveRequest): Promise<ThreadMoveResult | null> {
      const { environmentId, threadIds, target } = request;
      if (threadIds.length === 0) return null;
      const progress = toastManager.add({
        type: "loading",
        title:
          threadIds.length === 1
            ? `Moving to ${target.name}…`
            : `Moving ${threadIds.length} threads to ${target.name}…`,
        timeout: 0,
      });
      const results: ThreadMoveResult[] = [];
      for (const chunk of chunkThreadIds(threadIds)) {
        const result = await move({
          environmentId,
          input: {
            threadIds: chunk,
            target: target.environmentId,
            ...(request.leaveLocalChanges === true ? { leaveLocalChanges: true } : {}),
          },
        });
        if (result._tag === "Failure") {
          toastManager.close(progress);
          if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: `Could not move to ${target.name}`,
              description: errorDescription(result),
            });
          }
          return null;
        }
        results.push(result.value);
      }
      toastManager.close(progress);
      const merged = mergeThreadMoveResults(results);
      showMoveSummary(summarizeThreadMove(merged, target.name), request, run);
      return merged;
    },
    [move],
  );
}

/**
 * Hands a whole project to another paired machine after a confirm: the target
 * clones its repositories and runs its threads and agents from then on.
 * Resolves true once the move answered.
 */
export function useMoveProjectToMachine() {
  const move = useAtomCommand(serverEnvironment.moveProjectToMachine, {
    label: "move project to machine",
    reportFailure: false,
  });
  const moveThreads = useMoveThreadsToMachine();

  return useCallback(
    async (request: {
      readonly environmentId: EnvironmentId;
      readonly project: { readonly id: ProjectLabelId; readonly name: string };
      readonly target: Pick<MachineMoveTarget, "environmentId" | "name">;
      readonly fromName: string | null;
    }): Promise<boolean> => {
      const { environmentId, project, target } = request;
      const api = readLocalApi();
      if (!api) return false;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Move ${project.name} to ${target.name}?`,
            `${target.name} clones the project's repositories and runs all of its threads and agents from now on.`,
          ].join("\n"),
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return false;
      const progress = toastManager.add({
        type: "loading",
        title: `Moving ${project.name} to ${target.name}…`,
        timeout: 0,
      });
      const result = await move({
        environmentId,
        input: { id: project.id, target: target.environmentId },
      });
      toastManager.close(progress);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: `Could not move ${project.name} to ${target.name}`,
            description: errorDescription(result),
          });
        }
        return false;
      }
      showMoveSummary(
        summarizeProjectMove(result.value, project.name, target.name),
        { environmentId, target, fromName: request.fromName },
        moveThreads,
      );
      return true;
    },
    [move, moveThreads],
  );
}
