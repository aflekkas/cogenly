import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { requestConfirmDialog } from "../confirmDialog";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { EnvironmentProjectLabel } from "./projectLabels.logic";
import { reportProjectFolderFailure } from "./useMoveThreadToFolder";

/**
 * Takes a repository out of its project after a confirm. Only the filing
 * changes: the checkout stays on disk, and "Add repository" puts it back.
 * Returns whether it was removed. Shared by Settings → Projects and the
 * repository pickers.
 */
export function useRemoveRepositoryFromProject() {
  const unlink = useAtomCommand(serverEnvironment.unlinkProjectLabelRepository, {
    label: "remove repository from project",
    reportFailure: false,
  });
  return useCallback(
    async (input: {
      readonly project: Pick<EnvironmentProjectLabel, "environmentId"> & {
        readonly label: {
          readonly id: EnvironmentProjectLabel["label"]["id"];
          readonly name: string;
        };
      };
      readonly repositoryId: ProjectId;
      readonly title: string;
    }): Promise<boolean> => {
      const message = `Remove ${input.title} from ${input.project.label.name}?\nThe repository stays on disk, and its Work leaves the project with it. Add it back any time with Add repository.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return false;
      const result = await unlink({
        environmentId: input.project.environmentId,
        input: { labelId: input.project.label.id, repositoryId: input.repositoryId },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportProjectFolderFailure(`Could not remove ${input.title}`, result);
        }
        return false;
      }
      return true;
    },
    [unlink],
  );
}

/** Whether repositories can be taken out of projects on this environment. */
export function useCanRemoveRepositoryFromProject(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(serverEnvironment.unlinkProjectLabelRepository.permissionAtom(environmentId));
}
