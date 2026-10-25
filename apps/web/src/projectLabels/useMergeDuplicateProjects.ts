import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { requestConfirmDialog } from "../confirmDialog";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { PossibleDuplicateProjects } from "./projectLabels.logic";

function reportFailure(title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/** What the merge confirm says: everything moves, and the merged-away project is gone everywhere. */
export function mergeDuplicateProjectsMessage(pair: PossibleDuplicateProjects): string {
  const name = pair.into.label.name;
  return (
    `Merge the two ${name} projects?\n` +
    `The newer one's repositories, chats, Work, files, agents and instructions move into the older one, ` +
    `then the newer one is removed on every machine. Nothing is deleted, but the merge can't be undone; ` +
    `to split them again, create a project and move things back into it.`
  );
}

/**
 * Merging two possible duplicates (after a confirm that says what happens),
 * or keeping them apart so the question stops. Every entry point (the
 * Projects page, a project's page, the command palette) uses these.
 */
export function useMergeDuplicateProjects() {
  const merge = useAtomCommand(serverEnvironment.mergeProjectLabels, {
    label: "merge projects",
    reportFailure: false,
  });
  const dismiss = useAtomCommand(serverEnvironment.dismissProjectLabelDuplicate, {
    label: "keep projects separate",
    reportFailure: false,
  });
  const mergePair = useCallback(
    async (pair: PossibleDuplicateProjects): Promise<boolean> => {
      if (pair.environmentId === null) return false;
      const message = mergeDuplicateProjectsMessage(pair);
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return false;
      const result = await merge({
        environmentId: pair.environmentId,
        input: { sourceId: pair.from.label.id, targetId: pair.into.label.id },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) reportFailure("Could not merge projects", result);
        return false;
      }
      toastManager.add({ type: "success", title: `Merged into ${pair.into.label.name}` });
      return true;
    },
    [merge],
  );
  const keepSeparate = useCallback(
    async (pair: PossibleDuplicateProjects): Promise<boolean> => {
      if (pair.environmentId === null) return false;
      const result = await dismiss({
        environmentId: pair.environmentId,
        input: { id: pair.into.label.id, otherId: pair.from.label.id },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          reportFailure("Could not keep them separate", result);
        return false;
      }
      return true;
    },
    [dismiss],
  );
  return { mergePair, keepSeparate };
}
