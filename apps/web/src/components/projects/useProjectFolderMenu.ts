import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted, settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem } from "@t3tools/contracts";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { useDeleteProjectFolder } from "../../projectLabels/ProjectLabelEditorDialog";
import {
  PROJECT_LABEL_COLORS,
  projectLabelPaletteColor,
  type EnvironmentProjectLabel,
} from "../../projectLabels/projectLabels.logic";
import { reportProjectFolderFailure } from "../../projectLabels/useMoveThreadToFolder";
import { useProjectArchive } from "../../projectLabels/useProjectArchive";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

type FolderMenuId =
  | "open"
  | "rename"
  | "recolor"
  | `color:${string}`
  | "link-github"
  | "archive"
  | "unarchive"
  | "delete";

/**
 * A project folder's context menu (Open, Rename, Color, Link GitHub,
 * Archive or Unarchive, Delete) through the desktop's native menu. `menuOpen`
 * is true while it is up, so the row can read as selected meanwhile. Rename
 * and Link GitHub need a dialog, which the caller hosts.
 */
export function useProjectFolderMenu(
  entry: EnvironmentProjectLabel,
  handlers: {
    readonly onOpen: () => void;
    readonly onRename: () => void;
    readonly onLinkSources: () => void;
    readonly onDeleted: () => void;
  },
) {
  const { environmentId, label } = entry;
  const canUpdate = useAtomValue(
    serverEnvironment.updateProjectLabel.permissionAtom(environmentId),
  );
  const canDelete = useAtomValue(
    serverEnvironment.deleteProjectLabel.permissionAtom(environmentId),
  );
  const updateLabel = useAtomCommand(serverEnvironment.updateProjectLabel, {
    label: "recolor project",
    reportFailure: false,
  });
  const deleteFolder = useDeleteProjectFolder();
  const { archived, canArchive, setArchived } = useProjectArchive(environmentId, label);
  const [menuOpen, setMenuOpen] = useState(false);

  const openMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const current = projectLabelPaletteColor(label.color);
    const items: ReadonlyArray<ContextMenuItem<FolderMenuId>> = [
      { id: "open", label: "Open", icon: "folder" },
      { id: "rename", label: "Rename…", icon: "pencil", disabled: !canUpdate },
      {
        id: "recolor",
        label: "Color",
        disabled: !canUpdate,
        // Each choice shows its swatch, natively too; the current one is checked.
        children: PROJECT_LABEL_COLORS.map((color) => ({
          id: `color:${color.value}` as const,
          label: color.label,
          icon: "swatch",
          iconColor: color.hex,
          checked: current === color.value,
        })),
      },
      { id: "link-github", label: "Link GitHub…", icon: "link", disabled: !canUpdate },
      archived
        ? { id: "unarchive", label: "Unarchive", icon: "archive", disabled: !canArchive }
        : { id: "archive", label: "Archive", icon: "archive", disabled: !canArchive },
      {
        id: "delete",
        label: "Delete…",
        icon: "trash",
        destructive: true,
        disabled: !canDelete,
        separatorBefore: true,
      },
    ];
    setMenuOpen(true);
    const clicked = await settlePromise(() => api.contextMenu.show(items, position));
    setMenuOpen(false);
    if (clicked._tag === "Failure" || clicked.value === null) return;
    const id = clicked.value;
    if (id === "open") handlers.onOpen();
    else if (id === "rename") handlers.onRename();
    else if (id === "link-github") handlers.onLinkSources();
    else if (id === "archive" || id === "unarchive") await setArchived(id === "archive");
    else if (id === "delete") {
      if (await deleteFolder(environmentId, label)) handlers.onDeleted();
    } else if (id.startsWith("color:")) {
      const color = projectLabelPaletteColor(id.slice("color:".length));
      if (color === label.color) return;
      const result = await updateLabel({
        environmentId,
        input: { id: label.id, color },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportProjectFolderFailure(`Could not recolor ${label.name}`, result);
      }
    }
  };

  return {
    menuOpen,
    openMenu,
    openMenuAtElement: (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      void openMenu({ x: rect.left, y: rect.bottom + 4 });
    },
  };
}
