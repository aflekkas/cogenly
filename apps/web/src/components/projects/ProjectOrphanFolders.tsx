import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectOrphanFolder,
  ProjectOrphanFoldersResult,
} from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { DisclosurePanel } from "../ui/disclosure";
import { WorkspacePageContainer } from "../WorkspacePageContainer";

const NO_PERMISSION = "You don't have permission to change projects here.";

const REASON_LABEL: Record<ProjectOrphanFolder["reason"], string> = {
  deleted_project: "Left by a deleted project",
  no_marker: "Not part of any project",
};

/** `map` with `key` set to `value`, or without it for `null`. */
function withEntry<V>(
  map: ReadonlyMap<string, V>,
  key: string,
  value: V | null,
): ReadonlyMap<string, V> {
  const next = new Map(map);
  if (value === null) next.delete(key);
  else next.set(key, value);
  return next;
}

/** The server's message for a failed command, or null when it was only interrupted. */
function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * Settings → Projects: folders under each connected machine's projects root
 * that no project claims, each adoptable as a project or, when only an empty
 * skeleton, removable. The page's selected machine comes first; a machine
 * with no such folders shows nothing.
 */
export function ProjectOrphanFolders(props: {
  readonly environmentId?: EnvironmentId | undefined;
}) {
  const connected = useConnectedEnvironmentIds();
  const identities = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const selected = props.environmentId ?? primaryEnvironmentId;
  const ordered =
    selected !== null && connected.includes(selected)
      ? [selected, ...connected.filter((id) => id !== selected)]
      : connected;
  // The machine only says something when there is more than one.
  const labelOf = (environmentId: EnvironmentId) =>
    connected.length > 1
      ? (identities.find((identity) => identity.environmentId === environmentId)?.label ?? null)
      : null;
  return (
    <>
      {ordered.map((environmentId) => (
        <EnvironmentOrphanFolders
          key={environmentId}
          environmentId={environmentId}
          environmentLabel={labelOf(environmentId)}
        />
      ))}
    </>
  );
}

type RowAction = "adopt" | "remove";

/** A settled row: fading out, then hidden until `list` is replaced by a refresh. */
type LeavingRow =
  | { readonly phase: "closing" }
  | { readonly phase: "closed"; readonly list: ProjectOrphanFoldersResult | null };

/**
 * One machine's orphan folders. A settled row collapses and fades out first,
 * then the list refreshes, so nothing below it jumps.
 */
function EnvironmentOrphanFolders(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
}) {
  const { environmentId } = props;
  const { data, refresh } = useEnvironmentQuery(
    serverEnvironment.projectOrphanFolders({ environmentId, input: {} }),
  );
  const canAdopt = useAtomValue(
    serverEnvironment.adoptProjectOrphanFolder.permissionAtom(environmentId),
  );
  const canRemove = useAtomValue(
    serverEnvironment.removeProjectOrphanFolder.permissionAtom(environmentId),
  );
  const adopt = useAtomCommand(serverEnvironment.adoptProjectOrphanFolder, {
    label: "adopt project folder",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.removeProjectOrphanFolder, {
    label: "remove project folder",
    reportFailure: false,
  });
  const [pending, setPending] = useState<ReadonlyMap<string, RowAction>>(() => new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [leaving, setLeaving] = useState<ReadonlyMap<string, LeavingRow>>(() => new Map());
  // A closed row stays hidden only until the list it closed on is replaced, so
  // a refreshed list that still has the folder shows it again.
  const isLeaving = (dirName: string) => {
    const row = leaving.get(dirName);
    return row !== undefined && (row.phase === "closing" || row.list === data);
  };

  const folders = data?.folders ?? [];
  const shown = folders.filter((folder) => !isLeaving(folder.dirName));

  const settle = (dirNames: ReadonlyArray<string>) => {
    if (dirNames.length === 0) return;
    setLeaving((current) => {
      const next = new Map(current);
      for (const dirName of dirNames) next.set(dirName, { phase: "closed", list: data });
      return next;
    });
    refresh();
  };

  const run = async (folder: ProjectOrphanFolder, action: RowAction) => {
    const { dirName } = folder;
    if (action === "remove") {
      const message = `Delete ${dirName}?\nIt holds only the empty folders Cogenly made.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setErrors((current) => withEntry(current, dirName, null));
    setPending((current) => withEntry(current, dirName, action));
    const input = { environmentId, input: { dirName } };
    let error: string | null;
    let settled: boolean;
    if (action === "adopt") {
      const result = await adopt(input);
      error = failureMessage(result);
      settled = result._tag === "Success";
    } else {
      const result = await remove(input);
      error = failureMessage(result);
      settled = result._tag === "Success" && result.value.removed;
      // Something landed in it since the list loaded; the refresh shows it kept.
      if (result._tag === "Success" && !result.value.removed) {
        error = "It is no longer empty, so it was kept.";
        refresh();
      }
    }
    setPending((current) => withEntry(current, dirName, null));
    if (error !== null) {
      const message = error;
      setErrors((current) => withEntry(current, dirName, message));
    }
    if (settled) {
      setLeaving((current) => withEntry<LeavingRow>(current, dirName, { phase: "closing" }));
    }
  };

  const title = props.environmentLabel
    ? `Folders outside any project on ${props.environmentLabel}`
    : "Folders outside any project";
  return (
    <DisclosurePanel
      open={shown.length > 0}
      // The last row leaves with the whole section; its own close never reports.
      onExitComplete={() =>
        settle(folders.flatMap((folder) => (isLeaving(folder.dirName) ? [folder.dirName] : [])))
      }
    >
      <WorkspacePageContainer width="expanded" className="pt-0 pb-6">
        <SettingsSection title={title}>
          {folders.map((folder) => {
            const action = pending.get(folder.dirName) ?? null;
            const error = errors.get(folder.dirName) ?? null;
            return (
              <DisclosurePanel
                key={folder.dirName}
                open={!isLeaving(folder.dirName)}
                onExitComplete={() => settle([folder.dirName])}
              >
                <SettingsRow
                  title={folder.dirName}
                  description={<span className="break-all">{folder.path}</span>}
                  status={
                    <>
                      {REASON_LABEL[folder.reason]}
                      {error !== null ? (
                        <span role="alert" className="block text-destructive">
                          {error}
                        </span>
                      ) : null}
                    </>
                  }
                  control={
                    <>
                      {folder.empty ? (
                        <Button
                          size="sm"
                          variant="ghost-destructive"
                          disabled={!canRemove || action !== null}
                          title={canRemove ? undefined : NO_PERMISSION}
                          onClick={() => void run(folder, "remove")}
                        >
                          {action === "remove" ? "Removing…" : "Remove"}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canAdopt || action !== null}
                        title={canAdopt ? undefined : NO_PERMISSION}
                        onClick={() => void run(folder, "adopt")}
                      >
                        {action === "adopt" ? "Adopting…" : "Adopt as project"}
                      </Button>
                    </>
                  }
                />
              </DisclosurePanel>
            );
          })}
        </SettingsSection>
      </WorkspacePageContainer>
    </DisclosurePanel>
  );
}
