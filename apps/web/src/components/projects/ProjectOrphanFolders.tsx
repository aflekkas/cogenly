import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@cogenly/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectOrphanFolder,
  ProjectOrphanFoldersResult,
} from "@cogenly/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { useServerConfigs } from "../../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../preview/fileExplorerLabel";
import { FoldedSettingsSection } from "../settings/FoldedSettingsSection";
import { SettingsNote, SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { DisclosurePanel } from "../ui/disclosure";

const NO_PERMISSION = "You don't have permission to change projects here.";

// The fold already says no project uses these; only a deleted project adds anything.
const REASON_LABEL: Record<ProjectOrphanFolder["reason"], string | null> = {
  deleted_project: "From a project you deleted",
  no_marker: null,
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
 * Settings → Projects, at the bottom: each connected machine's leftover
 * folders, the ones in its projects folder that no project uses. The server
 * tidies away empty ones, so a machine shows a fold only when a leftover
 * holds something; each can become a project or go to the Trash. The page's
 * selected machine comes first.
 */
export function ProjectOrphanFolders(props: {
  readonly environmentId?: EnvironmentId | undefined;
}) {
  const connected = useConnectedEnvironmentIds();
  const identities = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const selected = props.environmentId ?? primaryEnvironmentId;
  const ordered =
    selected !== null && connected.includes(selected)
      ? [selected, ...connected.filter((id) => id !== selected)]
      : connected;
  // "on this Mac" for the desktop app's own machine; other machines by name
  // once there is more than one.
  const whereOf = (environmentId: EnvironmentId) => {
    if (isElectron && environmentId === primaryEnvironmentId) {
      return serverConfigs.get(environmentId)?.environment.platform.os === "darwin"
        ? "on this Mac"
        : "on this computer";
    }
    const label = identities.find((identity) => identity.environmentId === environmentId)?.label;
    return connected.length > 1 && label !== undefined ? `on ${label}` : null;
  };
  return (
    <>
      {ordered.map((environmentId) => (
        <EnvironmentOrphanFolders
          key={environmentId}
          environmentId={environmentId}
          where={whereOf(environmentId)}
        />
      ))}
    </>
  );
}

type RowAction = "adopt" | "trash";

/** A settled row: fading out, then hidden until `list` is replaced by a refresh. */
type LeavingRow =
  | { readonly phase: "closing" }
  | { readonly phase: "closed"; readonly list: ProjectOrphanFoldersResult | null };

/**
 * One machine's leftover folders, folded closed. A settled row collapses and
 * fades out first, then the list refreshes, so nothing below it jumps.
 */
function EnvironmentOrphanFolders(props: {
  readonly environmentId: EnvironmentId;
  readonly where: string | null;
}) {
  const { environmentId } = props;
  const { data, refresh } = useEnvironmentQuery(
    serverEnvironment.projectOrphanFolders({ environmentId, input: {} }),
  );
  const serverConfig = useServerConfigs().get(environmentId);
  const canAdopt = useAtomValue(
    serverEnvironment.adoptProjectOrphanFolder.permissionAtom(environmentId),
  );
  const canTrash = useAtomValue(
    serverEnvironment.trashProjectOrphanFolder.permissionAtom(environmentId),
  );
  const adopt = useAtomCommand(serverEnvironment.adoptProjectOrphanFolder, {
    label: "turn leftover folder into a project",
    reportFailure: false,
  });
  const trash = useAtomCommand(serverEnvironment.trashProjectOrphanFolder, {
    label: "move leftover folder to the Trash",
    reportFailure: false,
  });
  const revealInFileManager = useAtomCommand(shellEnvironment.revealInFileManager, {
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
  // Only a machine whose file manager the server can open gets the button.
  const revealLabel =
    serverConfig?.shellRevealInFileManager === true
      ? serverConfig.shellRevealInFileManagerKind === undefined
        ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
        : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
      : null;

  const settle = (dirNames: ReadonlyArray<string>) => {
    if (dirNames.length === 0) return;
    setLeaving((current) => {
      const next = new Map(current);
      for (const dirName of dirNames) next.set(dirName, { phase: "closed", list: data });
      return next;
    });
    refresh();
  };

  const reveal = async (folder: ProjectOrphanFolder) => {
    const result = await revealInFileManager({ environmentId, input: { path: folder.path } });
    const failed = failureMessage(result) !== null;
    setErrors((current) =>
      withEntry(current, folder.dirName, failed ? "Could not open the folder." : null),
    );
  };

  const run = async (folder: ProjectOrphanFolder, action: RowAction) => {
    const { dirName } = folder;
    if (action === "trash") {
      const message = `Move “${dirName}” to the Trash?\nYou can put it back from the Trash.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setErrors((current) => withEntry(current, dirName, null));
    setPending((current) => withEntry(current, dirName, action));
    const input = { environmentId, input: { dirName } };
    // Either way the folder stops being a leftover on success: trashed:false
    // means something else already claimed or moved it.
    const result = action === "adopt" ? await adopt(input) : await trash(input);
    const error = failureMessage(result);
    setPending((current) => withEntry(current, dirName, null));
    if (error !== null) {
      setErrors((current) => withEntry(current, dirName, error));
    }
    if (result._tag === "Success") {
      setLeaving((current) => withEntry<LeavingRow>(current, dirName, { phase: "closing" }));
    }
  };

  return (
    <DisclosurePanel
      open={shown.length > 0}
      // The last row leaves with the whole fold; its own close never reports.
      onExitComplete={() =>
        settle(folders.flatMap((folder) => (isLeaving(folder.dirName) ? [folder.dirName] : [])))
      }
    >
      <FoldedSettingsSection
        id={`leftover-folders-${environmentId}`}
        title={`Leftover folders (${shown.length})`}
        summary={props.where}
      >
        <SettingsNote>
          These folders are in your projects folder but no project uses them. Turn one into a
          project to keep working with it, or move it to the Trash.
        </SettingsNote>
        {folders.map((folder) => {
          const action = pending.get(folder.dirName) ?? null;
          const error = errors.get(folder.dirName) ?? null;
          const reason = REASON_LABEL[folder.reason];
          return (
            <DisclosurePanel
              key={folder.dirName}
              open={!isLeaving(folder.dirName)}
              onExitComplete={() => settle([folder.dirName])}
            >
              <SettingsRow
                title={folder.dirName}
                // Without a file manager to open, the path is how to find it.
                description={
                  revealLabel === null ? (
                    <span className="break-all">
                      {reason === null ? folder.path : `${reason} · ${folder.path}`}
                    </span>
                  ) : (
                    (reason ?? undefined)
                  )
                }
                status={
                  error === null ? undefined : (
                    <span
                      key={error}
                      role="alert"
                      className="reveal-motion block text-destructive-foreground"
                    >
                      {error}
                    </span>
                  )
                }
                control={
                  <>
                    {revealLabel !== null ? (
                      <Button size="sm" variant="ghost" onClick={() => void reveal(folder)}>
                        {revealLabel}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      disabled={!canTrash || action !== null}
                      title={canTrash ? undefined : NO_PERMISSION}
                      onClick={() => void run(folder, "trash")}
                    >
                      {action === "trash" ? "Moving to Trash…" : "Move to Trash"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canAdopt || action !== null}
                      busy={action === "adopt"}
                      title={canAdopt ? undefined : NO_PERMISSION}
                      onClick={() => void run(folder, "adopt")}
                    >
                      {action === "adopt" ? "Turning into project…" : "Turn into project"}
                    </Button>
                  </>
                }
              />
            </DisclosurePanel>
          );
        })}
      </FoldedSettingsSection>
    </DisclosurePanel>
  );
}
