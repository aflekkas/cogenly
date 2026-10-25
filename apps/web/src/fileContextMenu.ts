/** Context menu actions for workspace files. */
import { type ContextMenuItem, type EnvironmentId, type ScopedThreadRef } from "@cogenly/contracts";
import { useRightPanelStore } from "./rightPanelStore";
import { useCallback, useMemo } from "react";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { readLocalApi } from "./localApi";
import { serverEnvironment } from "./state/server";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { resolvePathLinkTarget } from "@cogenly/shared/fileLinks";
import { toastManager } from "./components/ui/toast";
import { useAtomValue } from "@effect/atom-react";

export type FileContextMenuAction = "reveal-in-folder" | "open";

export interface FileContextMenuTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadRef?: ScopedThreadRef | null;
  /** Repo- or workspace-relative file path, as shown in diffs. */
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
}

/** Absolute path on the environment host, or null when it cannot be resolved. */
/**
 * Absolute path on the environment host for a diff-style target, resolving
 * repo-relative paths through the workspace root like every other diff
 * surface. Returns null when the path cannot be resolved, which callers must
 * treat as "no file actions available".
 */
export function resolveFileContextMenuAbsolutePath(target: FileContextMenuTarget): string | null {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: target.filePath,
    workspaceRoot: target.workspaceRoot,
    repositoryRoot: target.repositoryRoot,
  });
  if (workspaceFilePath === null) return null;
  if (target.workspaceRoot === undefined) {
    return workspaceFilePath.startsWith("/") || /^[a-zA-Z]:/.test(workspaceFilePath)
      ? workspaceFilePath
      : null;
  }
  return resolvePathLinkTarget(workspaceFilePath, target.workspaceRoot);
}

export interface FileContextMenuCapabilities {
  readonly revealLabel: string | undefined;
  readonly canOpenDefault: boolean;
}

/**
 * Menu items for a resolved file, offering only what the environment's config
 * advertises: default-app open, reveal (with server-provided wording), and an
 * "Open with" submenu of detected editors. Empty when nothing can act.
 */
export function buildFileContextMenuItems(input: {
  readonly hasAbsolutePath: boolean;
  readonly capabilities: FileContextMenuCapabilities;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  // Without a resolvable absolute path nothing here can act on the file.
  if (!input.hasAbsolutePath) return [];
  const items: ContextMenuItem<FileContextMenuAction>[] = [];
  if (input.capabilities.canOpenDefault) {
    items.push({ id: "open", label: "Open", icon: "pencil" });
  }
  if (input.capabilities.revealLabel !== undefined) {
    items.push({
      id: "reveal-in-folder",
      label: input.capabilities.revealLabel,
      icon: "folder-tree",
    });
  }
  return items;
}

/**
 * Context-menu actions for files. The environment id is fixed per component
 * (a thread's environment, a file browser's environment), so capabilities
 * resolve once per hook call.
 */
/** Builds and dispatches the file context menu for one environment's files. */
export function useFileContextMenu(environmentId: EnvironmentId | null) {
  const revealInFileManager = useAtomCommand(shellEnvironment.revealInFileManager, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));

  return useMemo(() => {
    const capabilities: FileContextMenuCapabilities = {
      // The reveal wording comes from the server because on WSL the reveal can
      // run through Windows File Explorer even though the host reports Linux.
      revealLabel:
        environmentId !== null && serverConfig?.shellRevealInFileManager === true
          ? serverConfig.shellRevealInFileManagerKind === undefined
            ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
            : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
          : undefined,
      canOpenDefault: true,
    };

    const activate = async (
      action: FileContextMenuAction,
      target: FileContextMenuTarget,
    ): Promise<void> => {
      const absolutePath = resolveFileContextMenuAbsolutePath(target);
      if (absolutePath === null || environmentId === null) return;

      if (action === "open") {
        if (target.threadRef)
          useRightPanelStore.getState().openFile(target.threadRef, absolutePath);
        return;
      }
      const result = await revealInFileManager({ environmentId, input: { path: absolutePath } });
      if (result._tag !== "Failure") return;
      toastManager.add({
        type: "error",
        title: "Unable to reveal file",
        description: absolutePath,
      });
    };

    const show = async (
      target: FileContextMenuTarget,
      position?: { x: number; y: number },
    ): Promise<void> => {
      const api = readLocalApi();
      const items = buildFileContextMenuItems({
        hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
        capabilities: { ...capabilities, canOpenDefault: target.threadRef != null },
      });
      if (items.length === 0 || api === undefined) return;
      const clicked = await api.contextMenu.show(items, position);
      if (clicked === null) return;
      await activate(clicked as FileContextMenuAction, target);
    };

    return {
      buildItems: (target: FileContextMenuTarget) =>
        buildFileContextMenuItems({
          hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
          capabilities: { ...capabilities, canOpenDefault: target.threadRef != null },
        }),
      capabilities,
      activate,
      show,
    };
  }, [environmentId, revealInFileManager, serverConfig]);
}

/** Convenience callback for onContextMenu handlers. */
/** Returns an onContextMenu callback that shows the menu at the pointer. */
export function useFileContextMenuHandler(environmentId: EnvironmentId | null) {
  const contextMenu = useFileContextMenu(environmentId);
  return useCallback(
    (target: FileContextMenuTarget, event?: { clientX: number; clientY: number }) => {
      void contextMenu.show(target, event ? { x: event.clientX, y: event.clientY } : undefined);
    },
    [contextMenu],
  );
}
