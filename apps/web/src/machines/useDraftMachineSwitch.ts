import type { EnvironmentProject } from "@cogenly/client-runtime/state/models";
import {
  repositoryGroupingKeyOf,
  type EnvironmentId,
  type ProjectId,
  type ProjectLabelId,
  type ThreadId,
} from "@cogenly/contracts";
import { useCallback, useMemo } from "react";

import {
  setPendingProjectFolder,
  usePendingProjectFolderStore,
} from "../projectLabels/pendingProjectFolders";
import {
  projectLabelKey,
  projectLabelOn,
  scopedRepositoryKey,
} from "../projectLabels/projectLabels.logic";
import { projectRepositoryLinks } from "../projectLabels/repositoryPicker.logic";
import { useProjectLabelDirectory } from "../projectLabels/useProjectLabels";
import { useEnvironments } from "../state/environments";
import { planMachineSwitch, type MachineSwitchPlan } from "./machineSwitch.logic";

/**
 * The composer's "Run on" switch for a draft, beyond moving the draft itself:
 * `plan` reads the draft's project and repository on the machine it leaves
 * and decides where it lands (planMachineSwitch); `carryProject` files the
 * draft's project on the machine it moved to. A project the target lacks is
 * left filed where it was, so switching back finds it again.
 */
export function useDraftMachineSwitch() {
  const { environments } = useEnvironments();
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const directory = useProjectLabelDirectory(environmentIds);

  const plan = useCallback(
    (input: {
      readonly threadId: ThreadId;
      readonly here: EnvironmentId;
      /** The draft's repository; null when it runs in its machine's no-project home. */
      readonly repository: EnvironmentProject | null;
      readonly target: EnvironmentId;
      readonly targetRecordId: ProjectId | null;
      readonly canLaunchThere: boolean;
    }): { readonly plan: MachineSwitchPlan; readonly projectId: ProjectLabelId | null } => {
      const pending = usePendingProjectFolderStore.getState().byThreadId[input.threadId];
      const repository = input.repository;
      const projectId =
        (pending?.environmentId === input.here ? pending.folderId : null) ??
        (repository === null
          ? null
          : (directory.folderByRepository.get(scopedRepositoryKey(input.here, repository.id))?.label
              .id ?? null));
      const entry =
        projectId === null
          ? undefined
          : directory.byKey.get(projectLabelKey(input.here, projectId));
      const projectHere = entry ? projectLabelOn(entry, input.here) : null;
      const projectThere = entry ? projectLabelOn(entry, input.target) : null;
      // The project's link names the repository by its remote; a checkout in
      // no project answers to its own.
      const remote =
        repository === null
          ? null
          : ((projectHere === null
              ? undefined
              : projectRepositoryLinks(projectHere.label).find(
                  (link) => link.repositoryId === repository.id,
                )?.remote) ??
            (repository.repositoryIdentity
              ? repositoryGroupingKeyOf(repository.repositoryIdentity)
              : null));
      return {
        projectId,
        plan: planMachineSwitch(
          {
            repository: repository === null ? null : { id: repository.id, remote },
            projectId,
          },
          {
            environmentId: input.target,
            recordId: input.targetRecordId,
            project: projectThere?.label ?? null,
            canLaunchThere: input.canLaunchThere,
          },
        ),
      };
    },
    [directory],
  );

  /**
   * Files the moved draft in `projectId` on `target`; Work also records the
   * repository it landed on (null: the project's folder).
   */
  const carryProject = useCallback(
    (
      threadId: ThreadId,
      projectId: ProjectLabelId,
      target: EnvironmentId,
      repositoryId?: ProjectId | null,
    ) => {
      setPendingProjectFolder(threadId, {
        environmentId: target,
        folderId: projectId,
        ...(repositoryId === undefined ? {} : { repositoryId }),
      });
    },
    [],
  );

  return { plan, carryProject };
}
