import {
  LEGACY_PROJECT_CONFIG_FILE_NAME,
  PROJECT_CONFIG_FILE_NAME,
  type T3ProjectFile,
} from "@cogenly/contracts";
import { parseT3ProjectFile } from "@cogenly/shared/t3ProjectFile";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type ReactNode, useContext, useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { getProjectFileQueryAtom, optimisticFileAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectFolders, useSettingsProjectGroups } from "./useSettingsProjectGroups";
import {
  resolveScopedSettingsTargets,
  scopedProjectFileKey,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";

/**
 * Each repository's decoded cogenly.json (or legacy t3.json), so file-backed
 * settings show the file as a layer in the inheritance chain. A repository is
 * only present once its read has settled; the query atom caches per
 * (environment, cwd).
 */
const NO_MEMBERS: ReturnType<typeof resolveSettingsScope>["members"] = [];

function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" ? scope.members : NO_MEMBERS;
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          const files = new Map<string, T3ProjectFile | null>();
          for (const member of members) {
            // Undefined while the read is pending, null when the file is missing.
            const read = (fileName: string) => {
              const result = get(
                getProjectFileQueryAtom(member.environmentId, member.workspaceRoot, fileName),
              );
              if (result.waiting) return undefined;
              // A pending in-app save overlays the query, like useProjectFileQuery.
              return (
                get(optimisticFileAtom(member.environmentId, member.workspaceRoot, fileName))
                  ?.data ?? Option.getOrNull(AsyncResult.value(result))
              );
            };
            const primary = read(PROJECT_CONFIG_FILE_NAME);
            const data = primary === null ? read(LEGACY_PROJECT_CONFIG_FILE_NAME) : primary;
            if (data === undefined) continue;
            files.set(
              scopedProjectFileKey(member),
              data === null || data.truncated ? null : parseT3ProjectFile(data.contents),
            );
          }
          return files;
        }),
      [members],
    ),
  );
}

function useResolvedSettingsScope(search: SettingsScopeSearch, machinePage: boolean) {
  const folders = useSettingsProjectFolders();
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scope = useMemo(
    () =>
      resolveSettingsScope(search, folders, availableEnvironments, {
        machinePage,
        primaryEnvironmentId,
      }),
    [availableEnvironments, folders, machinePage, primaryEnvironmentId, search],
  );
  const projectFiles = useMemberProjectFiles(scope);
  return useMemo(() => {
    const selected = selectScopedSettingsEnvironments(
      scope,
      availableEnvironments,
      primaryEnvironmentId,
    );
    const targets = resolveScopedSettingsTargets(
      scope,
      selected.connectedEnvironments,
      projectFiles,
    );
    // The representative target supplies display values; project scopes
    // prefer the repository on the scope's machine.
    const target =
      targets.find(
        (candidate) => candidate.environmentId === selected.environment?.environmentId,
      ) ??
      targets[0] ??
      null;
    // The machine machine-local settings belong to, as the machine picker names it.
    const machine =
      availableEnvironments.find((environment) => environment.environmentId === scope.machineId) ??
      null;
    return { scope, folders, groups, search, ...selected, targets, target, machine };
  }, [availableEnvironments, folders, groups, primaryEnvironmentId, projectFiles, scope, search]);
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      /** The page is about one machine's own state: it picks a machine, not a project. */
      machinePage: boolean;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  machinePage = false,
}: {
  machinePage?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, machinePage);
  const value = useMemo(
    () => ({ ...resolved, machinePage, selectScope: onChange }),
    [machinePage, onChange, resolved],
  );
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
