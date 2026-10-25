import type {
  ContextMenuItem,
  EnvironmentId,
  PreviewSessionSnapshot,
  ResolvedKeybindingsConfig,
} from "@cogenly/contracts";
import {
  Check,
  CircleUser,
  Files,
  Globe2,
  PanelRight,
  Plus,
  Smartphone,
  VenetianMask,
} from "lucide-react";
import { Volume2, VolumeOff } from "lucide";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import { surfaceGroupOf, type RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { resolveShortcutCommand, type ShortcutMatchContext } from "~/keybindings";
import { readLocalApi } from "~/localApi";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { MorphIcon } from "~/components/MorphIcon";
import { AndroidIcon, AppleIcon } from "~/components/Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { useDeviceState } from "~/state/device";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { previewBridge } from "./preview/previewBridge";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { PanelTab } from "./PanelTab";
import type { DeviceAddMenu } from "./device/useDeviceTabActions";
import { BadgeDot } from "./ui/badge-dot";
import { TabStrip } from "./TabStrip";
import { tabStripPanelId, tabStripTabId } from "./TabStrip.logic";

export type RightPanelAddKind = "browser" | "device" | "files";

/** One thing the strip's "+" can open as a new tab. */
export interface RightPanelAddOption {
  readonly kind: RightPanelAddKind;
  readonly shortcutLabel: string | null;
  readonly available: boolean;
  /** Why it is greyed out, for the menu entry. */
  readonly unavailableLabel: string;
  readonly onSelect: () => void;
  /** Browser only: open the tab in one of the configured profiles. */
  readonly onSelectInProfile?: (profileId: string) => void;
  /** Device only: the devices "+" lists, each opening as its own tab. */
  readonly deviceMenu?: DeviceAddMenu & { readonly onSetup: () => void };
}

const ADD_OPTION_PRESENTATION = {
  browser: { label: "Browser", Icon: Globe2 },
  device: { label: "Device", Icon: Smartphone },
  files: { label: "Files", Icon: Files },
} as const;

/**
 * The right panel's frame: one row of tabs for the surfaces in the active
 * group (browser tabs, device streams, open files), then the surface itself.
 * The strip's "+" is the one place to add: it lists every kind of tab the
 * thread offers, and the open tabs say their kind by their icon.
 */
interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  keybindings: ResolvedKeybindingsConfig;
  getShortcutContext: () => ShortcutMatchContext;
  /** Forwarded to PreviewPanelShell so this surface persists its own width. */
  widthStorageKey?: string;
  /** Forwarded to PreviewPanelShell as the initial width before a user resize. */
  defaultWidth?: number;
  inlineSize?: PreviewPanelInlineSize;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  /** Fallback environment for surfaces that do not carry their own. */
  environmentId: EnvironmentId | null;
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  /**
   * Maps a server session tab id to the desktop runtime tab id the Electron
   * preview manager is keyed by. Session ids are only unique within one server
   * process, so desktop operations must not be addressed with them.
   */
  previewRuntimeTabId?: ((tabId: string) => string) | undefined;
  onActivate: (surface: RightPanelSurface) => void;
  onRenameDevice?: (surfaceId: string, title: string) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  /** Tabs are draggable only when the owner can persist the new order. */
  onMoveSurface?: (surfaceId: string, toIndex: number) => void;
  onCopyFilePath: (relativePath: string) => void;
  /** What "+" offers, in menu order. */
  addOptions: readonly RightPanelAddOption[];
  children: ReactNode;
}

/** Overlays that must win over the panel's own shortcuts. */
const SHORTCUT_BLOCKING_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

type TabContextMenuAction =
  | "rename"
  | "copy-path"
  | "toggle-mute"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

/**
 * Desktop preview tab backing a surface, or null for non-preview surfaces, the
 * "new browser tab" placeholder, and the web build where no desktop tab exists.
 */
function previewTabIdOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string | null {
  if (surface.kind !== "preview" || !surface.resourceId) return null;
  return sessions[surface.resourceId]?.tabId ?? null;
}

/**
 * Label and enabled state for a preview tab's mute menu entry.
 * Stays disabled until desktop overlay state arrives: a server session id can
 * resolve while the preview manager's createTab is still in flight, and muting
 * then fails with a PreviewTabNotFoundError nothing surfaces to the user.
 */
export function tabMuteMenuItem(input: {
  overlay: DesktopPreviewOverlay | null;
  canResolveRuntimeTabId: boolean;
}): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? "Unmute tab" : "Mute tab",
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

type TabAudioState = "none" | "audible" | "muted";

/**
 * A muted tab that is not making sound shows nothing: mute is armed silently,
 * and the indicator only appears once there is audio to speak of.
 */
function tabAudioState(overlay: DesktopPreviewOverlay | null): TabAudioState {
  if (!overlay?.audible) return "none";
  return overlay.audioMuted ? "muted" : "audible";
}

/**
 * A browser tab is named by its page, then its host, and "New tab" before it
 * has gone anywhere, so a strip of fresh tabs never reads as a row of clones.
 */
export function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string {
  switch (surface.kind) {
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(
        Math.max(surface.relativePath.lastIndexOf("/"), surface.relativePath.lastIndexOf("\\")) + 1,
      );
    case "device":
      return surface.title ?? surface.target?.name ?? "Device";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "New tab";
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || "New tab";
      } catch {
        return "New tab";
      }
    }
  }
}

function PreviewFavicon({ capturedUrl, url }: { capturedUrl: string | null; url: string | null }) {
  const publicProviderUrl = faviconUrlForOrigin(url, 32);
  return (
    <FaviconImage
      sources={[capturedUrl, publicProviderUrl]}
      fallback={<Globe2 className="size-3.5 shrink-0" />}
      className="size-3.5 shrink-0 rounded-sm object-contain"
    />
  );
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function SurfaceIcon({
  surface,
  sessions,
  desktopByTabId,
  theme,
}: {
  surface: RightPanelSurface;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  theme: "light" | "dark";
}) {
  switch (surface.kind) {
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
      const favicon = snapshot ? (desktopByTabId[snapshot.tabId]?.favicon ?? null) : null;
      const capturedUrl =
        favicon && url && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
      return <PreviewFavicon capturedUrl={capturedUrl} url={url} />;
    }
    case "files":
      return <Files className="size-3.5 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3.5"
        />
      );
    case "device":
      return surface.target?.platform === "ios" ? (
        <AppleIcon className="size-3.5 shrink-0" />
      ) : surface.target?.platform === "android" ? (
        <AndroidIcon className="size-3.5 shrink-0" />
      ) : (
        <Smartphone className="size-3.5 shrink-0" />
      );
  }
}

/** Shown only when an open panel has nothing in it: the same choices as "+", as buttons. */
function RightPanelEmptyState({ options }: { options: readonly RightPanelAddOption[] }) {
  const offered = options.filter((option) => option.available);
  return (
    <Empty size="sm" className="min-h-0">
      <EmptyHeader>
        <EmptyMedia>
          <PanelRight />
        </EmptyMedia>
        <EmptyTitle>Nothing open</EmptyTitle>
        <EmptyDescription>
          {offered.length > 0
            ? "Open something in this panel."
            : "This thread has nothing to open."}
        </EmptyDescription>
      </EmptyHeader>
      {offered.length > 0 ? (
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-1.5">
            {offered.map((option) => {
              const { label, Icon } = ADD_OPTION_PRESENTATION[option.kind];
              return (
                <Button
                  key={option.kind}
                  size="xs"
                  variant="outline"
                  onClick={option.onSelect}
                  data-right-panel-add={option.kind}
                >
                  <Icon />
                  {label}
                </Button>
              );
            })}
          </div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

/**
 * "+ → Device": the simulators and emulators the environment can open, by host,
 * like Browser's profile submenu. A device that already has a tab is checked and
 * selecting it focuses that tab. With nothing to list it points at setup.
 */
function DeviceAddSubmenu(props: {
  label: string;
  icon: ReactNode;
  menu: NonNullable<RightPanelAddOption["deviceMenu"]>;
}) {
  const { menu } = props;
  const showHostLabels = menu.groups.length > 1;
  return (
    <MenuSub>
      <MenuSubTrigger data-right-panel-add="device">
        {props.icon}
        {props.label}
      </MenuSubTrigger>
      <MenuSubPopup className="max-w-64 min-w-48">
        {menu.groups.length === 0 && menu.busy ? (
          <MenuItem disabled>Looking for devices…</MenuItem>
        ) : null}
        {menu.groups.map((group) => (
          <MenuGroup key={group.hostId}>
            {showHostLabels ? <MenuGroupLabel>{group.hostLabel}</MenuGroupLabel> : null}
            {group.entries.map((entry) => (
              <MenuItem
                key={entry.key}
                onClick={() => menu.onSelectDevice(entry)}
                data-right-panel-device={entry.device.id}
              >
                {entry.device.platform === "ios" ? <AppleIcon /> : <AndroidIcon />}
                <span className="min-w-0 truncate">{entry.device.name}</span>
                {entry.open ? (
                  <Check className="ms-auto" aria-label="Open" />
                ) : entry.device.booted ? (
                  <MenuShortcut>Running</MenuShortcut>
                ) : null}
              </MenuItem>
            ))}
          </MenuGroup>
        ))}
        {menu.groups.length > 0 ? <MenuSeparator /> : null}
        {menu.groups.length > 0 || !menu.busy ? (
          <MenuItem onClick={menu.onSetup} data-right-panel-device-setup>
            {menu.groups.length > 0 ? "Device setup…" : "Set up devices…"}
          </MenuItem>
        ) : null}
      </MenuSubPopup>
    </MenuSub>
  );
}

/**
 * The window pins two controls over the inline strip's right end (maximize
 * and the panel toggle): 1.75rem each with 0.25rem between, inset by the
 * window's control offset. The strip keeps that much clear.
 */
const TRAILING_CONTROLS_INSET =
  "calc(var(--workspace-controls-right) + 1px + 2 * var(--workspace-titlebar-control-size) + 0.25rem + 0.5rem)";

export function RightPanelTabs(props: RightPanelTabsProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const browserProfiles = useBrowserDefaults().profiles;
  const { resolvedTheme } = useTheme();
  const tabIdPrefix = useId();
  const [renamingDevice, setRenamingDevice] = useState<string | null>(null);

  // The row only lists the active group's surfaces: the header switches groups.
  const activeSurface =
    props.surfaces.find((surface) => surface.id === props.activeSurfaceId) ??
    props.surfaces[0] ??
    null;
  const activeGroup = activeSurface ? surfaceGroupOf(activeSurface) : null;
  const groupSurfaces = useMemo(
    () =>
      activeGroup === null
        ? []
        : props.surfaces.filter((surface) => surfaceGroupOf(surface) === activeGroup),
    [activeGroup, props.surfaces],
  );
  const offeredOptions = props.addOptions.filter((option) => option.available);
  const browserOption = offeredOptions.find((option) => option.kind === "browser") ?? null;
  const canAdd = offeredOptions.length > 0;
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  // rightPanel.new opens a browser tab, the common case; a thread without a
  // browser gets the "+" menu instead so the shortcut still adds something.
  const onNewTabKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !canAdd) return;
    if (
      resolveShortcutCommand(event, props.keybindings, {
        context: { ...props.getShortcutContext(), rightPanelOpen: true },
      }) !== "rightPanel.new"
    )
      return;
    if (document.querySelector(SHORTCUT_BLOCKING_LAYERS)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (browserOption) browserOption.onSelect();
    else setAddMenuOpen(true);
  });
  useEffect(() => {
    if (props.open === false) return;
    document.addEventListener("keydown", onNewTabKeyDown, true);
    return () => document.removeEventListener("keydown", onNewTabKeyDown, true);
  }, [props.open]);

  const openTabContextMenu = useCallback(
    async (position: { x: number; y: number }, surface: RightPanelSurface) => {
      const api = readLocalApi();
      if (!api) return;

      const surfaceIndex = groupSurfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;

      const items: ContextMenuItem<TabContextMenuAction>[] = [];
      if (surface.kind === "device" && props.onRenameDevice)
        items.push({ id: "rename", label: "Rename" });
      if (surface.kind === "file" && surface.attachment === undefined) {
        items.push({ id: "copy-path", label: "Copy path" });
      }
      const menuPreviewTabId = previewTabIdOf(surface, props.previewSessions);
      // Desktop overlay state only arrives once the preview manager has created
      // the tab. A server session id alone can still be ahead of that, and
      // muting then fails with PreviewTabNotFoundError that nobody surfaces.
      const menuOverlay = menuPreviewTabId
        ? (props.desktopByTabId[menuPreviewTabId] ?? null)
        : null;
      const menuMuted = menuOverlay?.audioMuted ?? false;
      if (surface.kind === "preview") {
        // Not gated on audibility: silencing a quiet tab ahead of time is the
        // point, so the item is offered whenever the tab is mutable at all.
        items.push({
          id: "toggle-mute",
          ...tabMuteMenuItem({
            overlay: menuOverlay,
            canResolveRuntimeTabId: props.previewRuntimeTabId !== undefined,
          }),
        });
      }
      items.push(
        { id: "close", label: "Close" },
        {
          id: "close-others",
          label: "Close others",
          disabled: groupSurfaces.length <= 1,
        },
        {
          id: "close-to-right",
          label: "Close to the right",
          disabled: surfaceIndex >= groupSurfaces.length - 1,
        },
        {
          id: "close-all",
          label: "Close all",
          disabled: props.surfaces.length === 0,
        },
      );

      const action = await api.contextMenu.show(items, position);
      switch (action) {
        case "rename":
          setRenamingDevice(surface.id);
          break;
        case "copy-path":
          if (surface.kind === "file" && surface.attachment === undefined) {
            props.onCopyFilePath(surface.relativePath);
          }
          break;
        case "toggle-mute": {
          // menuOverlay repeats the disabled gate above: the desktop tab must
          // exist before it can be addressed, however the menu was dismissed.
          const runtimeTabId =
            menuPreviewTabId && menuOverlay
              ? (props.previewRuntimeTabId?.(menuPreviewTabId) ?? null)
              : null;
          if (runtimeTabId) {
            void previewBridge?.setAudioMuted(runtimeTabId, !menuMuted).catch(() => undefined);
          }
          break;
        }
        case "close":
          props.onCloseSurface(surface);
          break;
        case "close-others":
          props.onCloseOtherSurfaces(surface);
          break;
        case "close-to-right":
          props.onCloseSurfacesToRight(surface);
          break;
        case "close-all":
          props.onCloseAllSurfaces();
          break;
        case null:
          break;
      }
    },
    [groupSurfaces, props],
  );
  const handleTabContextMenu = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      event.preventDefault();
      event.stopPropagation();
      void openTabContextMenu({ x: event.clientX, y: event.clientY }, surface);
    },
    [openTabContextMenu],
  );
  // The strip owns arrows, Enter and Delete; F2 renames a device, and the
  // context-menu key opens the tab's menu under it.
  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
    surface: RightPanelSurface,
    tab: HTMLElement,
  ) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "F2" && surface.kind === "device" && props.onRenameDevice) {
      event.preventDefault();
      setRenamingDevice(surface.id);
    } else if (event.key === "ContextMenu") {
      event.preventDefault();
      const rect = tab.getBoundingClientRect();
      void openTabContextMenu({ x: rect.left, y: rect.bottom }, surface);
    }
  };
  const { onMoveSurface } = props;
  const handleMoveTab = useMemo(
    () =>
      onMoveSurface
        ? (surface: RightPanelSurface, over: RightPanelSurface) => {
            // A drop lands at the target's index in the owner's full order.
            const toIndex = props.surfaces.findIndex((entry) => entry.id === over.id);
            if (toIndex >= 0) onMoveSurface(surface.id, toIndex);
          }
        : undefined,
    [onMoveSurface, props.surfaces],
  );
  // "+" lists what the thread can open; the menu is a Base UI menu, so arrows,
  // Home/End, typeahead and Enter work. A browser with several profiles opens
  // as a submenu of them.
  const hasProfileChoice = browserProfiles.length > 1;
  if (!canAdd && addMenuOpen) setAddMenuOpen(false);
  const newTabButton = (
    <Menu
      open={addMenuOpen}
      onOpenChange={(open) => {
        setAddMenuOpen(open);
        // Discovery is lazy: opening "+" is what finds devices (and installs
        // device support the first time), so the submenu has them when it opens.
        if (open) props.addOptions.find((option) => option.kind === "device")?.deviceMenu?.onOpen();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  aria-label="New tab"
                  // Sits in the tab lane, after the last tab, like a browser's "+".
                  className={cn(
                    "ml-0.5 shrink-0",
                    ownsDesktopTitleBar && "[-webkit-app-region:no-drag]",
                  )}
                  size="icon-xs"
                  variant="ghost-muted"
                  data-right-panel-add-trigger
                />
              }
            />
          }
        >
          <Plus className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>New tab</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="bottom" sideOffset={6} className="min-w-48">
        {props.addOptions.map((option) => {
          const { label, Icon } = ADD_OPTION_PRESENTATION[option.kind];
          const shortcut = option.shortcutLabel ? (
            <MenuShortcut>{option.shortcutLabel}</MenuShortcut>
          ) : null;
          if (option.kind === "device" && option.available && option.deviceMenu) {
            return (
              <DeviceAddSubmenu
                key={option.kind}
                label={label}
                icon={<Icon />}
                menu={option.deviceMenu}
              />
            );
          }
          if (option.kind === "browser" && option.available && hasProfileChoice) {
            return (
              <MenuSub key={option.kind}>
                <MenuSubTrigger data-right-panel-add={option.kind}>
                  <Icon />
                  {label}
                </MenuSubTrigger>
                <MenuSubPopup className="max-w-56">
                  {browserProfiles.map((profile) => (
                    <MenuItem
                      key={profile.id}
                      onClick={() =>
                        option.onSelectInProfile
                          ? option.onSelectInProfile(profile.id)
                          : option.onSelect()
                      }
                    >
                      {/* Same icon column as the parent menu: the mask marks
                          the throwaway session, a person any persistent profile. */}
                      {profile.kind === "incognito" ? <VenetianMask /> : <CircleUser />}
                      <span className="min-w-0 truncate">{profile.name}</span>
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            );
          }
          return (
            <MenuItem
              key={option.kind}
              disabled={!option.available}
              onClick={option.onSelect}
              aria-description={option.available ? undefined : option.unavailableLabel}
              data-right-panel-add={option.kind}
            >
              <Icon />
              {label}
              {shortcut}
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );

  return (
    <PreviewPanelShell
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
      {...(props.inlineSize ? { inlineSize: props.inlineSize } : {})}
    >
      <div
        className={cn(
          // A tab strip in the titlebar's row, on the panel's own surface.
          // The tabs sit centered on the row, at the same height as the
          // controls the window pins at its right. Browser and file tabs
          // open on a toolbar row with its own hairline, so the strip and
          // that row read as one header with one line under it; a device
          // has no toolbar, so the strip draws the line itself.
          "relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-stretch gap-1 border-b bg-background pl-2 transition-[border-color] duration-(--motion-duration-fast) ease-out",
          activeGroup === "browser" || activeGroup === "files"
            ? "border-transparent"
            : "border-border/60",
          // The sheet overlays from the viewport top, so its tab bar keeps
          // the titlebar's height: a compact row re-centers the layout
          // controls a few pixels higher and the cluster jumps on open.
          // Inline, the window pins the layout controls at its top-right;
          // the strip leaves them their room (see trailingControlsInset).
          (props.mode !== "inline" || props.layoutControls) && "pr-3",
          ownsDesktopTitleBar && "drag-region",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        style={
          props.mode === "inline" && !props.layoutControls
            ? { paddingRight: TRAILING_CONTROLS_INSET }
            : undefined
        }
        data-right-panel-tabbar
      >
        <TabStrip
          aria-label="Panel tabs"
          items={groupSurfaces}
          activeId={props.activeSurfaceId}
          idPrefix={tabIdPrefix}
          setKey={activeGroup ?? undefined}
          getLabel={(surface) => surfaceTitle(surface, props.previewSessions)}
          renderTooltip={(surface) => (
            <SurfaceTabTooltip
              surface={surface}
              title={surfaceTitle(surface, props.previewSessions)}
              sessions={props.previewSessions}
              environmentId={props.environmentId}
            />
          )}
          onActivate={props.onActivate}
          onClose={props.onCloseSurface}
          onMove={handleMoveTab}
          isDragDisabled={(surface) => renamingDevice === surface.id}
          onTabKeyDown={handleTabKeyDown}
          onTabContextMenu={handleTabContextMenu}
          onTabDoubleClick={(surface) => {
            if (surface.kind === "device" && props.onRenameDevice) setRenamingDevice(surface.id);
          }}
          tabClassName={ownsDesktopTitleBar ? "[-webkit-app-region:no-drag]" : undefined}
          rootAttributes={{
            "data-right-panel-tab-list": "",
            // Maximized, the tabs lead the pane like a chat title and ride its
            // edge when the sidebar toggles.
            "data-panel-flip": props.maximized ? "start" : undefined,
          }}
          trailing={canAdd && props.open !== false ? newTabButton : null}
          renderTab={(surface) => {
            const pending = props.pendingSurfaceIds.has(surface.id);
            const title = surfaceTitle(surface, props.previewSessions);
            const previewTabId = previewTabIdOf(surface, props.previewSessions);
            // Desktop state is keyed by the session id, but desktop actions
            // must be addressed with the runtime id.
            const audio = tabAudioState(
              previewTabId ? (props.desktopByTabId[previewTabId] ?? null) : null,
            );
            const audioRuntimeTabId = previewTabId
              ? (props.previewRuntimeTabId?.(previewTabId) ?? null)
              : null;
            return (
              <>
                <PanelTab.Icon>
                  <SurfaceIcon
                    surface={surface}
                    sessions={props.previewSessions}
                    desktopByTabId={props.desktopByTabId}
                    theme={resolvedTheme}
                  />
                  {/* An agent driving the tab marks it, so the user sees which tab it uses. */}
                  <BadgeDot
                    tone={
                      pending
                        ? "current"
                        : previewTabId !== null &&
                          props.previewSessions[previewTabId]?.agentDriving === true &&
                          "info"
                    }
                    className="absolute -right-0.5 -bottom-0.5"
                  />
                </PanelTab.Icon>
                {renamingDevice === surface.id ? (
                  <input
                    aria-label="Device tab name"
                    className="w-24 min-w-0 flex-1 rounded-sm bg-background px-1 outline-none ring-1 ring-inset ring-ring"
                    defaultValue={title}
                    ref={(element) => {
                      element?.focus();
                      element?.select();
                    }}
                    onBlur={(event) => {
                      props.onRenameDevice?.(surface.id, event.currentTarget.value);
                      setRenamingDevice(null);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        event.currentTarget.value = title;
                        event.currentTarget.blur();
                      }
                    }}
                  />
                ) : (
                  <PanelTab.Label>{title}</PanelTab.Label>
                )}
                {audio === "none" || !audioRuntimeTabId ? null : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <PanelTab.Action
                          tabIndex={-1}
                          aria-label={audio === "muted" ? `Unmute ${title}` : `Mute ${title}`}
                          onClick={() => {
                            void previewBridge
                              ?.setAudioMuted(audioRuntimeTabId, audio !== "muted")
                              .catch(() => undefined);
                          }}
                        >
                          <MorphIcon
                            className="size-3"
                            icon={audio === "muted" ? VolumeOff : Volume2}
                          />
                        </PanelTab.Action>
                      }
                    />
                    <TooltipPopup>{audio === "muted" ? "Unmute tab" : "Mute tab"}</TooltipPopup>
                  </Tooltip>
                )}
              </>
            );
          }}
        />
        {props.layoutControls}
        {ownsDesktopTitleBar && !props.layoutControls ? (
          // Keeps the tabs clear of the window controls when the layout toggles live elsewhere.
          <span aria-hidden className="hidden w-24 shrink-0 wco:block" />
        ) : null}
        {ownsDesktopTitleBar ? (
          <span
            aria-hidden
            className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
          />
        ) : null}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-right-panel-surface-content
        {...(groupSurfaces.length > 0
          ? {
              role: "tabpanel",
              id: tabStripPanelId(tabIdPrefix),
              "aria-labelledby": activeTabDomId(tabIdPrefix, groupSurfaces, props.activeSurfaceId),
            }
          : {})}
      >
        {props.surfaces.length === 0 ? (
          <RightPanelEmptyState options={props.addOptions} />
        ) : (
          props.children
        )}
      </div>
    </PreviewPanelShell>
  );
}

function activeTabDomId(
  prefix: string,
  surfaces: readonly RightPanelSurface[],
  activeSurfaceId: string | null,
): string | undefined {
  const index = surfaces.findIndex((surface) => surface.id === activeSurfaceId);
  return index < 0 ? undefined : tabStripTabId(prefix, index);
}

/**
 * A tab's tooltip: its full title, and under it what the title leaves out:
 * a page's URL, a file's path, a device's host and OS version.
 */
function SurfaceTabTooltip(props: {
  surface: RightPanelSurface;
  title: string;
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  environmentId: EnvironmentId | null;
}) {
  const { surface, title } = props;
  if (surface.kind === "device") {
    return <DeviceTabTooltip surface={surface} environmentId={props.environmentId} title={title} />;
  }
  let detail: string | null = null;
  if (surface.kind === "file") detail = surface.relativePath;
  if (surface.kind === "preview") {
    const snapshot = surface.resourceId ? props.sessions[surface.resourceId] : null;
    if (snapshot && snapshot.navStatus._tag !== "Idle") detail = snapshot.navStatus.url;
  }
  if (!detail || detail === title) return title;
  return (
    <div className="flex flex-col gap-0.5">
      <span>{title}</span>
      <span className="text-muted-foreground">{detail}</span>
    </div>
  );
}

function DeviceTabTooltip(props: {
  surface: Extract<RightPanelSurface, { kind: "device" }>;
  environmentId: EnvironmentId | null;
  title: string;
}) {
  const target = props.surface.target;
  const { state } = useDeviceState(target ? props.environmentId : null);
  const device = target
    ? state.devices.find((entry) => entry.hostId === target.hostId && entry.id === target.deviceId)
    : undefined;
  const host = target ? state.hosts.find((entry) => entry.id === target.hostId) : undefined;
  return (
    <div className="flex flex-col gap-0.5">
      <span>{props.title}</span>
      {target ? (
        <span className="text-muted-foreground">
          {host?.label ?? "Device host"} ·{" "}
          {device?.version ?? (target.platform === "ios" ? "iOS" : "Android")}
        </span>
      ) : null}
    </div>
  );
}
