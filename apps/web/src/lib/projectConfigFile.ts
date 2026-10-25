import {
  PROJECT_CONFIG_FILE_NAMES,
  type EnvironmentId,
  type T3ProjectFile,
} from "@cogenly/contracts";
import { parseT3ProjectFile } from "@cogenly/shared/t3ProjectFile";
import { executeAtomQuery } from "@cogenly/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read and decode the project's checked-in `cogenly.json`, or the legacy
 * `t3.json` when the checkout has no `cogenly.json`.
 *
 * Imperative counterpart to `useProjectConfigFileState` for the new-thread
 * path, which resolves defaults at call time rather than render time. The
 * file query atom caches per (environment, cwd), so repeat calls don't
 * re-fetch. Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files resolve
 * to null.
 */
export async function readProjectConfigFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
  for (const fileName of PROJECT_CONFIG_FILE_NAMES) {
    const result = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, workspaceRoot, fileName),
      { reportDefect: false, reportFailure: false },
    );
    const data = resolveProjectFileQueryData(
      environmentId,
      workspaceRoot,
      fileName,
      result._tag === "Success" ? result.value : null,
    );
    if (data === null) continue;
    return data.truncated ? null : parseT3ProjectFile(data.contents);
  }
  return null;
}
