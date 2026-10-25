import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@cogenly/client-runtime/state/runtime";
import type { EnvironmentId, ProjectLabelWithRepositories } from "@cogenly/contracts";
import { useCallback } from "react";

import { toastManager } from "../components/ui/toast";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { isProjectLabelArchived } from "./projectLabels.logic";
import { reportProjectFolderFailure } from "./useMoveThreadToFolder";

/**
 * Archive and unarchive for one project. Archiving takes the project out of
 * every picker and lists it under the Projects list's Archived filter; its
 * threads and project chat stay as they are. Each change toasts with an Undo.
 * Resolves true once the change landed.
 */
export function useProjectArchive(
  environmentId: EnvironmentId,
  label: Pick<ProjectLabelWithRepositories, "id" | "name" | "archivedAt"> | null,
) {
  const archived = label !== null && isProjectLabelArchived(label);
  const canArchive = useAtomValue(
    (archived
      ? serverEnvironment.unarchiveProjectLabel
      : serverEnvironment.archiveProjectLabel
    ).permissionAtom(environmentId),
  );
  const archive = useAtomCommand(serverEnvironment.archiveProjectLabel, {
    label: "archive project",
    reportFailure: false,
  });
  const unarchive = useAtomCommand(serverEnvironment.unarchiveProjectLabel, {
    label: "unarchive project",
    reportFailure: false,
  });
  const labelId = label?.id ?? null;
  const name = label?.name ?? "";

  const setArchived = useCallback(
    async function run(
      next: boolean,
      options: { readonly undoable?: boolean } = {},
    ): Promise<boolean> {
      if (labelId === null) return false;
      const command = next ? archive : unarchive;
      const result = await command({ environmentId, input: { id: labelId } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportProjectFolderFailure(
            next ? `Could not archive ${name}` : `Could not unarchive ${name}`,
            result,
          );
        }
        return false;
      }
      const id = toastManager.add({
        type: "success",
        title: next ? `Archived ${name}` : `Unarchived ${name}`,
        ...(next ? { description: "Its threads stay where they are." } : {}),
        ...(options.undoable === false
          ? {}
          : {
              actionProps: {
                children: "Undo",
                onClick: () => {
                  toastManager.close(id);
                  void run(!next, { undoable: false });
                },
              },
            }),
      });
      return true;
    },
    [archive, environmentId, labelId, name, unarchive],
  );

  return { archived, canArchive, setArchived };
}
