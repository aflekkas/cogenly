import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectLabelWithRepositories } from "@t3tools/contracts";

import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** A project's standing instructions and the way to save them. */
export interface ProjectInstructions {
  readonly value: string;
  /** Resolves true once the server has the new text. */
  readonly save: (text: string) => Promise<boolean>;
}

/**
 * The label's instructions, saved through `projectLabels.update`. The server
 * injects them into every thread filed in the project.
 */
export function useProjectInstructions(
  environmentId: EnvironmentId,
  label: ProjectLabelWithRepositories | null,
): ProjectInstructions {
  const updateLabel = useAtomCommand(serverEnvironment.updateProjectLabel, {
    label: "update project instructions",
    reportFailure: false,
  });
  const labelId = label?.id ?? null;
  return {
    value: label?.instructions ?? "",
    save: async (instructions) => {
      if (labelId === null) return false;
      const result = await updateLabel({ environmentId, input: { id: labelId, instructions } });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          reportProjectFolderFailure("Could not save the project's instructions", result);
        }
        return false;
      }
      return true;
    },
  };
}
