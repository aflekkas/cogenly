import {
  LEGACY_PROJECT_CONFIG_FILE_NAME,
  PROJECT_CONFIG_FILE_NAME,
  type EnvironmentId,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@cogenly/contracts";
import { parseT3ProjectFile } from "@cogenly/shared/t3ProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];

export interface ProjectConfigFileState {
  /**
   * - `valid`: the config file exists and decoded.
   * - `invalid`: it exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable config file at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The file that was read: `cogenly.json`, or the legacy `t3.json` when only that exists. */
  fileName: string;
  /** The decoded file when status is `valid`, null otherwise. */
  file: T3ProjectFile | null;
  scripts: ReadonlyArray<T3ProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `cogenly.json` (or legacy
 * `t3.json`), including whether the file exists but is broken, which the
 * runtime otherwise swallows silently.
 */
export function useProjectConfigFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): ProjectConfigFileState {
  const primary = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    PROJECT_CONFIG_FILE_NAME,
    cwd !== null,
  );
  const primaryMissing = cwd !== null && !primary.isPending && primary.data === null;
  const legacy = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    LEGACY_PROJECT_CONFIG_FILE_NAME,
    primaryMissing,
  );
  const data = primary.data ?? (primaryMissing ? legacy.data : null);
  const fileName =
    primary.data === null && legacy.data !== null
      ? LEGACY_PROJECT_CONFIG_FILE_NAME
      : PROJECT_CONFIG_FILE_NAME;
  const contents = data && !data.truncated ? data.contents : null;
  const isPending = primary.isPending || (primaryMissing && legacy.isPending);
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        fileName,
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseT3ProjectFile(contents);
    if (file === null) {
      return { status: "invalid", fileName, file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", fileName, file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, fileName, isPending]);
}
