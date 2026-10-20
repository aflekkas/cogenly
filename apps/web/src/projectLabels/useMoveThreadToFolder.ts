import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectLabelId, ThreadId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { undoFolderId, type PriorFiling } from "./projectLabels.logic";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

export function reportProjectFolderFailure(
  title: string,
  result: { readonly cause: Cause.Cause<unknown> },
) {
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

export interface FolderRef {
  readonly id: ProjectLabelId;
  readonly name: string;
}

/**
 * Files one thread in a folder, or takes it out with `folder: null` (Work then
 * falls back to its repository's folder). Confirms with a toast that can undo
 * the move, so a misclick is one click to reverse. Resolves true on success.
 */
export function useMoveThreadToFolder() {
  const move = useAtomCommand(serverEnvironment.moveThreadProjectFolder, {
    label: "move thread to folder",
    reportFailure: false,
  });
  const run = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly folder: FolderRef | null;
      /** Where the thread was and how, so Undo restores that exact filing. */
      readonly previous: PriorFiling | null;
      readonly undoable?: boolean;
    }): Promise<boolean> => {
      const { environmentId, threadId, folder, previous } = input;
      const result = await move({
        environmentId,
        input: { threadId, folderId: folder?.id ?? null },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportProjectFolderFailure(
            folder ? `Could not move to ${folder.name}` : "Could not remove from folder",
            result,
          );
        }
        return false;
      }
      const landed = result.value.projectFolderId;
      // Work taken out of a folder can land back in its repository's.
      const title = folder
        ? `Moved to ${folder.name}`
        : landed !== null && landed === previous?.id
          ? `Still in ${previous.name} through its repository`
          : previous
            ? `Removed from ${previous.name}`
            : "Removed from folder";
      const id = toastManager.add({
        type: "success",
        title,
        ...(input.undoable !== false
          ? {
              actionProps: {
                children: "Undo",
                onClick: () => {
                  toastManager.close(id);
                  void move({
                    environmentId,
                    input: { threadId, folderId: undoFolderId(previous) },
                  }).then((undo) => {
                    if (undo._tag === "Failure" && !isAtomCommandInterrupted(undo)) {
                      reportProjectFolderFailure("Could not undo the move", undo);
                    }
                  });
                },
              },
            }
          : {}),
      });
      return true;
    },
    [move],
  );
  return run;
}
