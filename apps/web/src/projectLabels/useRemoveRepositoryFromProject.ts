import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@cogenly/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@cogenly/contracts";
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
      /** False for a repository not cloned on this machine: nothing here is on disk. */
      readonly onDisk?: boolean;
      /** Wraps the request once confirmed, so a row can show it running. */
      readonly during?: <A>(run: () => Promise<A>) => Promise<A>;
    }): Promise<boolean> => {
      const message =
        input.onDisk === false
          ? `Remove ${input.title} from ${input.project.label.name}?\nIt is not cloned on this machine, and any checkout on another machine stays on its disk. Add it back any time with Add repository.`
          : `Remove ${input.title} from ${input.project.label.name}?\nThe repository stays on disk, and its Work leaves the project with it. Add it back any time with Add repository.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return false;
      const request = () =>
        unlink({
          environmentId: input.project.environmentId,
          input: { labelId: input.project.label.id, repositoryId: input.repositoryId },
        });
      const result = await (input.during ? input.during(request) : request());
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
