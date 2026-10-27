"use client";

import {
  browserExtensionPageUrl,
  type BrowserExtension,
  type ScopedThreadRef,
} from "@cogenly/contracts";
import { PuzzleIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { BrowserExtensionInstallDialog } from "~/browser/BrowserExtensionInstall";
import {
  browserExtensionSidePanelTarget,
  browserExtensionToolbarLayout,
  canOpenBrowserExtensionSidePanel,
  isBrowserExtensionUsable,
} from "~/browser/browserExtensions.logic";
import { useBrowserExtensions } from "~/browser/useBrowserExtensions";
import { useStableCallback } from "~/hooks/useStableCallback";
import { BadgeDot } from "~/components/ui/badge-dot";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { selectExtensionSurfaces, useThreadPreviewState } from "~/previewStateStore";

import { subscribePreviewAction } from "../previewActionBus";
import { ToolbarButton } from "../PreviewChromeRow";
import {
  BrowserExtensionDetailsDialog,
  type BrowserExtensionPageKind,
} from "./BrowserExtensionDetails";
import { BrowserExtensionIcon, BrowserExtensionStatusText } from "./BrowserExtensionIcon";
import { ExtensionPopupPopover } from "./ExtensionPopupPopover";
import { recentSidePanelExtensionId, useExtensionSurfaceActions } from "./useExtensionSurfaces";

interface Props {
  readonly threadRef: ScopedThreadRef;
  /** The server tab the popup and side panel open on. */
  readonly hostTabId: string | null;
  readonly profileId: string;
  readonly profileName: string | undefined;
  readonly incognito: boolean;
  /** Why extensions can't run in this tab (browserExtensionTabGap), or null when they can. */
  readonly gap: string | null;
  /** Reopens the tab in the browser that runs its extensions. */
  readonly move?: { readonly label: string; readonly onMove: () => void } | undefined;
  /** Opens an extension's page, such as its options, as a tab of this profile. */
  readonly openPage: (url: string) => void;
  readonly visible: boolean;
}

/**
 * The browser toolbar's extensions: an icon per extension with a toolbar
 * action, the first few inline and the rest in the extensions menu, which
 * also turns them on and off, shows their details and adds new ones. An icon
 * opens its popup under it; the menu opens side panels. The list follows the
 * environment live, so agents' changes and load failures show as they happen.
 */
export function BrowserExtensionsToolbar(props: Props) {
  const { threadRef, hostTabId, profileId, gap } = props;
  const extensions = useBrowserExtensions(
    props.incognito ? null : threadRef.environmentId,
    profileId,
  );
  const surfaceActions = useExtensionSurfaceActions(threadRef, profileId);
  const sessions = useThreadPreviewState(threadRef).sessions;
  const surfaces = useMemo(
    () => selectExtensionSurfaces(sessions, hostTabId),
    [hostTabId, sessions],
  );
  const popupExtensionId = surfaces.popup?.extensionSurface?.extensionId ?? null;
  const sidePanelExtensionId = surfaces.sidePanel?.extensionSurface?.extensionId ?? null;
  const list = extensions.extensions ?? [];
  const layout = browserExtensionToolbarLayout(list, { promoteId: popupExtensionId });
  const popupExtension = list.find((extension) => extension.id === popupExtensionId) ?? null;
  const anyFailed = list.some((extension) => extension.enabled && extension.state === "failed");

  const iconRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const details = list.find((extension) => extension.id === detailsId) ?? null;
  const [addOpen, setAddOpen] = useState(false);

  const openSurface = (extension: BrowserExtension, kind: "popup" | "sidePanel") => {
    if (gap || !hostTabId) return;
    void surfaceActions.open(extension, kind, hostTabId);
  };
  const toggleSidePanel = (extension: BrowserExtension) => {
    if (surfaces.sidePanel && sidePanelExtensionId === extension.id) {
      void surfaceActions.close(surfaces.sidePanel);
    } else {
      openSurface(extension, "sidePanel");
    }
  };
  const openPage = (extension: BrowserExtension, kind: BrowserExtensionPageKind) => {
    if (kind === "options") {
      if (extension.optionsPage) {
        props.openPage(browserExtensionPageUrl(extension.id, extension.optionsPage));
      }
    } else if (kind === "sidePanel") {
      toggleSidePanel(extension);
    } else {
      openSurface(extension, "popup");
    }
  };

  const clickIcon = (extension: BrowserExtension) => {
    if (extension.state === "failed") {
      setDetailsId(extension.id);
      return;
    }
    if (surfaces.popup && popupExtensionId === extension.id) {
      void surfaceActions.close(surfaces.popup);
      return;
    }
    openSurface(extension, "popup");
  };

  // The keybinding toggles the side panel of the extension that opened one last.
  const toggleRecentSidePanel = useStableCallback(() => {
    if (surfaces.sidePanel) {
      void surfaceActions.close(surfaces.sidePanel);
      return;
    }
    const target = browserExtensionSidePanelTarget(list, recentSidePanelExtensionId(profileId));
    if (gap || !target) {
      toastManager.add({
        type: "info",
        title: gap ? "Extensions can't run in this tab" : "No extension with a side panel",
        description: gap ?? "Add an extension that has a side panel, or turn one on.",
      });
      return;
    }
    openSurface(target, "sidePanel");
  });
  const { visible } = props;
  useEffect(() => {
    if (!visible) return;
    return subscribePreviewAction((action) => {
      if (action === "toggle-extension-side-panel") toggleRecentSidePanel();
    });
  }, [toggleRecentSidePanel, visible]);

  if (props.incognito) {
    return (
      <ToolbarButton label="Extensions" unavailableReason={gap} onClick={() => undefined}>
        <PuzzleIcon />
      </ToolbarButton>
    );
  }
  if (!extensions.canManage) return null;

  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Extensions">
        {layout.inline.map((extension) => (
          <ToolbarButton
            key={extension.id}
            buttonRef={(element) => {
              if (element) iconRefs.current.set(extension.id, element);
              else iconRefs.current.delete(extension.id);
            }}
            label={extension.name}
            tooltip={
              extension.state === "failed" ? `${extension.name} failed to load` : extension.name
            }
            unavailableReason={
              gap ?? (extension.state === "installing" ? `${extension.name} is loading` : null)
            }
            pressed={popupExtensionId === extension.id}
            onClick={() => clickIcon(extension)}
          >
            <BrowserExtensionIcon extension={extension} />
          </ToolbarButton>
        ))}
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      ref={menuButtonRef}
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      aria-label="Extensions"
                    />
                  }
                />
              }
            >
              <span className="relative inline-flex">
                <PuzzleIcon />
                <BadgeDot
                  tone={anyFailed ? "destructive" : null}
                  ring="background"
                  className="absolute -top-0.5 -right-0.5"
                />
              </span>
            </TooltipTrigger>
            <TooltipPopup>
              {anyFailed ? "Extensions: one failed to load" : "Extensions"}
            </TooltipPopup>
          </Tooltip>
          <MenuPopup align="end" sideOffset={6}>
            {gap ? (
              <MenuGroup>
                <MenuGroupLabel className="max-w-72">
                  <span className="block">{gap}</span>
                </MenuGroupLabel>
                {props.move ? (
                  <MenuItem onClick={props.move.onMove}>{props.move.label}</MenuItem>
                ) : null}
              </MenuGroup>
            ) : null}
            {gap ? <MenuSeparator /> : null}
            {extensions.extensions === null ? (
              <MenuItem disabled>{extensions.loadError ?? "Loading extensions…"}</MenuItem>
            ) : extensions.extensions.length === 0 ? (
              <MenuItem disabled>No extensions in this profile</MenuItem>
            ) : (
              extensions.extensions.map((extension) => (
                <ExtensionMenuRow
                  key={extension.id}
                  extension={extension}
                  canOpen={!gap && hostTabId !== null}
                  popupOpen={popupExtensionId === extension.id}
                  sidePanelOpen={sidePanelExtensionId === extension.id}
                  onSetEnabled={(enabled) => void extensions.setEnabled(extension.id, enabled)}
                  onOpenPage={(kind) => openPage(extension, kind)}
                  onDetails={() => setDetailsId(extension.id)}
                  onReload={() => void extensions.reloadFromFolder(extension)}
                  onRemove={() => void extensions.remove(extension)}
                />
              ))
            )}
            <MenuSeparator />
            <MenuItem onClick={() => setAddOpen(true)}>Add extension…</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <ExtensionPopupPopover
        threadRef={threadRef}
        snapshot={surfaces.popup}
        extensionName={popupExtension?.name ?? "Extension"}
        anchor={() =>
          (popupExtensionId ? iconRefs.current.get(popupExtensionId) : undefined) ??
          menuButtonRef.current
        }
        visible={visible}
        onClose={(snapshot) => void surfaceActions.close(snapshot)}
      />
      {/* Outside the menu, which unmounts its items as it closes. */}
      <BrowserExtensionDetailsDialog
        extension={details}
        onClose={() => setDetailsId(null)}
        actions={extensions}
        onOpenPage={(kind) => {
          if (details) openPage(details, kind);
        }}
        pagesUnavailableReason={gap}
      />
      <BrowserExtensionInstallDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        install={extensions.install}
        profileName={props.profileName}
      />
    </>
  );
}

/** One extension in the menu: its icon, name and state; its submenu holds the rest. */
function ExtensionMenuRow(props: {
  readonly extension: BrowserExtension;
  /** False when this tab can't run extensions; their pages stay closed. */
  readonly canOpen: boolean;
  readonly popupOpen: boolean;
  readonly sidePanelOpen: boolean;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onOpenPage: (kind: BrowserExtensionPageKind) => void;
  readonly onDetails: () => void;
  readonly onReload: () => void;
  readonly onRemove: () => void;
}) {
  const { extension } = props;
  const running = isBrowserExtensionUsable(extension);
  return (
    <MenuSub>
      <MenuSubTrigger>
        <BrowserExtensionIcon extension={extension} />
        <span className="flex w-full max-w-64 min-w-0 items-center justify-between gap-6">
          <span className="truncate">{extension.name}</span>
          {running ? (
            <span className="shrink-0 text-xs text-muted-foreground">{extension.version}</span>
          ) : (
            <BrowserExtensionStatusText extension={extension} />
          )}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuCheckboxItem
          variant="switch"
          checked={extension.enabled}
          onCheckedChange={props.onSetEnabled}
        >
          Enabled
        </MenuCheckboxItem>
        {extension.hasAction ? (
          <MenuItem disabled={!props.canOpen || !running} onClick={() => props.onOpenPage("popup")}>
            {props.popupOpen ? "Close popup" : extension.popupPage ? "Open popup" : "Run action"}
          </MenuItem>
        ) : null}
        {extension.sidePanelPage ? (
          <MenuItem
            disabled={!props.canOpen || !canOpenBrowserExtensionSidePanel(extension)}
            onClick={() => props.onOpenPage("sidePanel")}
          >
            {props.sidePanelOpen ? "Close side panel" : "Open side panel"}
          </MenuItem>
        ) : null}
        {extension.optionsPage ? (
          <MenuItem
            disabled={!props.canOpen || !running}
            onClick={() => props.onOpenPage("options")}
          >
            Open options
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={props.onDetails}>Details…</MenuItem>
        {extension.source.type === "folder" ? (
          <MenuItem onClick={props.onReload}>Reload from folder</MenuItem>
        ) : null}
        <MenuItem variant="destructive" onClick={props.onRemove}>
          Remove
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}
