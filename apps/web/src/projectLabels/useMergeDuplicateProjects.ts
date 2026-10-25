import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cogenly/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

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
  const into = pair.into.label.name;
  const from = pair.from.label.name;
  const tail =
    ` Nothing is deleted, but the merge can't be undone; ` +
    `to split them again, create a project and move things back into it.`;
  if (into === from) {
    return (
      `Merge the two ${into} projects?\n` +
      `The newer one's repositories, chats, Work, files, agents and instructions move into the older one, ` +
      `then the newer one is removed on every machine.` +
      tail
    );
  }
  return (
    `Merge ${from} into ${into}?\n` +
    `${from}'s repositories, chats, Work, files, agents and instructions move into ${into}, ` +
    `then ${from} is removed on every machine.` +
    tail
  );
}

/**
 * Merging two projects (after a confirm that says what happens), or keeping
 * possible duplicates apart so the question stops, with an Undo that asks it
 * again. Every entry point (the Projects page, a project's page and menus,
 * the command palette) uses these.
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
  const undismiss = useAtomCommand(serverEnvironment.undismissProjectLabelDuplicate, {
    label: "ask again about duplicate projects",
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
      const { environmentId } = pair;
      const input = { id: pair.into.label.id, otherId: pair.from.label.id };
      const result = await dismiss({ environmentId, input });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result))
          reportFailure("Could not keep them separate", result);
        return false;
      }
      const id = toastManager.add({
        type: "success",
        title: `Kept the ${pair.into.label.name} projects separate`,
        description: "You can still merge them from either project's menu.",
        actionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(id);
            void undismiss({ environmentId, input }).then((undone) => {
              if (undone._tag === "Failure" && !isAtomCommandInterrupted(undone)) {
                reportFailure("Could not undo", undone);
              }
            });
          },
        },
      });
      return true;
    },
    [dismiss, undismiss],
  );
  return { mergePair, keepSeparate };
}

/** Read menu availability against the machine that will execute each merge. */
export function useProjectMergePermissions(candidates: ReadonlyArray<PossibleDuplicateProjects>) {
  const permissions = useMemo(
    () =>
      Atom.make(
        (get) =>
          new Set(
            candidates.flatMap((pair) =>
              pair.environmentId !== null &&
              get(serverEnvironment.mergeProjectLabels.permissionAtom(pair.environmentId))
                ? [pair.key]
                : [],
            ),
          ),
      ),
    [candidates],
  );
  return useAtomValue(permissions);
}
