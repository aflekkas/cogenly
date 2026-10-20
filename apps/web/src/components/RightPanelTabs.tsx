import type {
  ContextMenuItem,
  EnvironmentId,
  PreviewSessionSnapshot,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Files, Globe2, PanelRight, Plus, Smartphone, TerminalSquare } from "lucide-react";
import { Volume2, VolumeOff } from "lucide";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import { surfaceGroupOf, type RightPanelSurface } from "~/rightPanelStore";
import { cn } from "~/lib/utils";
import { resolveShortcutCommand, type ShortcutMatchContext } from "~/keybindings";
import { readLocalApi } from "~/localApi";
import { Button } from "~/components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { AndroidIcon, AppleIcon } from "~/components/Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Menu, MenuItem, MenuPopup } from "~/components/ui/menu";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { ScrollArea } from "~/components/ui/scroll-area";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { useTheme } from "~/hooks/useTheme";
import { useDeviceState } from "~/state/device";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { previewBridge } from "./preview/previewBridge";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { observeResize } from "~/lib/observeResize";

/**
 * The right panel's frame: one row of tabs for the surfaces in the active
 * group (browser tabs, device streams, open files), then the surface itself.
 * Switching between groups is the Work header's job, so the row never offers
 * other kinds; its only "new" action is another browser tab.
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
  onAddBrowser: () => void;
  /**
   * Separate from `onAddBrowser` on purpose: that one is passed directly as a
   * DOM click handler, and a `(profileId?: string)` signature would silently
   * accept the MouseEvent as a profile id.
   */
  onAddBrowserInProfile: (profileId: string) => void;
  browserAvailable: boolean;
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

const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

function tabScrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

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
    case "terminal":
      return "Terminal";
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
      fallback={<Globe2 className="size-3 shrink-0" />}
      className="size-3 shrink-0 rounded-sm object-contain"
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
      return <Files className="size-3 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3 shrink-0" />;
    case "device":
      return surface.target?.platform === "ios" ? (
        <AppleIcon className="size-3 shrink-0" />
      ) : surface.target?.platform === "android" ? (
        <AndroidIcon className="size-3 shrink-0" />
      ) : (
        <Smartphone className="size-3 shrink-0" />
      );
  }
}

/**
 * Lets its tabs be dragged into a new order. Neighbours slide aside while dragging,
 * and the order commits on drop.
 */
function SortableTabList(props: {
  surfaces: readonly RightPanelSurface[];
  /** The full strip, so a drop lands at the surface's index in the owner's order. */
  allSurfaces: readonly RightPanelSurface[];
  onMove: ((surfaceId: string, toIndex: number) => void) | undefined;
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const surfaceIds = useMemo(() => props.surfaces.map((surface) => surface.id), [props.surfaces]);
  const { onMove, allSurfaces } = props;
  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const toIndex = allSurfaces.findIndex((surface) => surface.id === over.id);
      if (toIndex >= 0) onMove?.(String(active.id), toIndex);
    },
    [onMove, allSurfaces],
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={TAB_DRAG_MODIFIERS}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={surfaceIds} strategy={horizontalListSortingStrategy}>
        {props.children}
      </SortableContext>
    </DndContext>
  );
}

function SortableTab({
  surfaceId,
  disabled,
  className,
  ...props
}: ComponentProps<"div"> & { surfaceId: string; disabled: boolean }) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surfaceId,
    disabled,
  });
  return (
    <div
      {...props}
      {...listeners}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(className, isDragging && "relative z-10")}
    />
  );
}

/** Shown only when an open panel has nothing in it; the header is the way in. */
function RightPanelEmptyState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 pb-(--workspace-topbar-height) text-center">
      <PanelRight className="size-4 text-muted-foreground" />
      <p className="text-sm text-foreground">Nothing open</p>
      <p className="text-xs text-muted-foreground">
        Open Browser, Terminal or Device from the header.
      </p>
    </div>
  );
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const ownsDesktopTitleBar = isElectron && props.mode === "inline";
  const browserProfiles = useBrowserDefaults().profiles;
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabIdPrefix = useId();
  const [renamingDevice, setRenamingDevice] = useState<string | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

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
  const canAddBrowser = activeGroup === "browser" && props.browserAvailable;

  const onNewTabKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !canAddBrowser) return;
    if (
      resolveShortcutCommand(event, props.keybindings, {
        context: { ...props.getShortcutContext(), rightPanelOpen: true },
      }) !== "rightPanel.new"
    )
      return;
    if (document.querySelector(SHORTCUT_BLOCKING_LAYERS)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) props.onAddBrowser();
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
  const handleTabMouseDown = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
  }, []);
  const handleTabAuxClick = useCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      props.onCloseSurface(surface);
    },
    [props],
  );

  const tabElements = () =>
    Array.from(tabListRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
  // Set when the keyboard closed a tab, so focus lands on the tab that takes its
  // place once the close renders (a browser tab may first ask for confirmation).
  const focusActiveTabAfterCloseRef = useRef<string | null>(null);
  useEffect(() => {
    const closedId = focusActiveTabAfterCloseRef.current;
    if (closedId === null || props.surfaces.some((surface) => surface.id === closedId)) return;
    focusActiveTabAfterCloseRef.current = null;
    tabListRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });

  // Manual activation: arrows only move focus, so walking past a terminal or
  // browser tab never hands keyboard focus to the surface it would mount.
  const handleTabListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const tab = event.target;
    if (!(tab instanceof HTMLElement) || tab.getAttribute("role") !== "tab") return;
    const tabs = tabElements();
    const index = tabs.indexOf(tab);
    const surface = groupSurfaces.find((entry) => entry.id === tab.dataset.surfaceId);
    if (index < 0 || !surface) return;
    const focusTab = (next: number) => {
      event.preventDefault();
      tabs[(next + tabs.length) % tabs.length]?.focus();
    };
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case "ArrowRight":
        focusTab(index + 1);
        return;
      case "ArrowLeft":
        focusTab(index - 1);
        return;
      case "Home":
        focusTab(0);
        return;
      case "End":
        focusTab(tabs.length - 1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        props.onActivate(surface);
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        focusActiveTabAfterCloseRef.current = surface.id;
        props.onCloseSurface(surface);
        return;
      case "F2":
        if (surface.kind !== "device" || !props.onRenameDevice) return;
        event.preventDefault();
        setRenamingDevice(surface.id);
        return;
      case "ContextMenu": {
        event.preventDefault();
        const rect = tab.getBoundingClientRect();
        void openTabContextMenu({ x: rect.left, y: rect.bottom }, surface);
        return;
      }
    }
  };

  useEffect(() => {
    if (!props.activeSurfaceId || !hasOverflow) return;
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId, hasOverflow]);

  // Tabs shrink to an icon before the row scrolls; past that, the wheel scrolls
  // it sideways and the fade on each edge says there is more.
  useEffect(() => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;
    const update = () => setHasOverflow(viewport.scrollWidth - viewport.clientWidth > 1);
    const content = viewport.firstElementChild;
    const stopObserving = observeResize(content ? [viewport, content] : viewport, update);
    update();

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      let delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;
      if (delta === 0) return;
      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === previousScrollLeft) return;
      event.preventDefault();
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      stopObserving();
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // "+" opens a tab in the default profile in one click; with more profiles
  // to choose from, a right-click (or the ContextMenu key) offers them.
  const newTabRef = useRef<HTMLButtonElement>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const hasProfileChoice = browserProfiles.length > 1;
  if (!canAddBrowser && profileMenuOpen) setProfileMenuOpen(false);
  const newTabButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={newTabRef}
            aria-label="New browser tab"
            className={cn("shrink-0", ownsDesktopTitleBar && "[-webkit-app-region:no-drag]")}
            size="icon-xs"
            variant="ghost-muted"
            onClick={props.onAddBrowser}
            onContextMenu={(event) => {
              if (!hasProfileChoice) return;
              event.preventDefault();
              setProfileMenuOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ContextMenu" || !hasProfileChoice) return;
              event.preventDefault();
              setProfileMenuOpen(true);
            }}
          />
        }
      >
        <Plus className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>
        {hasProfileChoice ? "New tab · right-click for a profile" : "New tab"}
      </TooltipPopup>
    </Tooltip>
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
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
          // The sheet overlays from the viewport top, so its tab bar keeps
          // the titlebar's height: a compact row re-centers the layout
          // controls a few pixels higher and the cluster jumps on open.
          // Inline, the maximize and panel toggles are fixed at the window's
          // top-right; the row leaves them their room.
          props.mode === "inline" && !props.layoutControls ? "pr-20" : "pr-3",
          ownsDesktopTitleBar && "drag-region",
          ownsDesktopTitleBar && "wco:pr-(--workspace-native-controls-inset)",
          props.mode === "inline" && props.maximized && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          radius="none"
          ref={tabListRef}
          hideScrollbars
          scrollFade
          scrollFadePadding={false}
          className="min-w-0 flex-1"
          data-right-panel-tab-list
          // Maximized, the tabs lead the pane like a chat title and ride its
          // edge when the sidebar toggles.
          data-panel-flip={props.maximized ? "start" : undefined}
        >
          <SortableTabList
            surfaces={groupSurfaces}
            allSurfaces={props.surfaces}
            onMove={props.onMoveSurface}
          >
            <div
              role="tablist"
              aria-label="Panel tabs"
              aria-orientation="horizontal"
              className="flex h-full w-full items-center gap-1"
              onKeyDown={handleTabListKeyDown}
            >
              {groupSurfaces.map((surface, index) => {
                const active = surface.id === props.activeSurfaceId;
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
                // One tab stop for the whole strip: the selected tab, or the
                // first one while nothing is selected.
                const tabStop = active || (props.activeSurfaceId === null && index === 0);
                return (
                  <SortableTab
                    key={surface.id}
                    surfaceId={surface.id}
                    disabled={!props.onMoveSurface || renamingDevice === surface.id}
                    role="tab"
                    id={`${tabIdPrefix}-tab-${index}`}
                    aria-selected={active}
                    aria-controls={active ? `${tabIdPrefix}-panel` : undefined}
                    tabIndex={tabStop ? 0 : -1}
                    data-surface-id={surface.id}
                    data-active-tab={active}
                    onClick={(event) => {
                      // The close and mute buttons inside the tab act on their own.
                      if (event.target instanceof Element && event.target.closest("button")) return;
                      props.onActivate(surface);
                    }}
                    onDoubleClick={() => {
                      if (surface.kind === "device" && props.onRenameDevice)
                        setRenamingDevice(surface.id);
                    }}
                    onMouseDown={handleTabMouseDown}
                    onAuxClick={(event) => handleTabAuxClick(event, surface)}
                    onContextMenu={(event) => handleTabContextMenu(event, surface)}
                    className={cn(
                      // Equal shares of the row up to a comfortable width; the
                      // label folds away before a tab gets narrower than its
                      // icon. The selected tab keeps its name.
                      "group/tab @container/tab h-6 shrink basis-40 cursor-pointer rounded-md text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      active
                        ? "min-w-28 state-selected"
                        : "min-w-9 state-hover text-muted-foreground",
                      ownsDesktopTitleBar && "[-webkit-app-region:no-drag]",
                    )}
                  >
                    <div className="flex h-full items-center gap-1.5 pr-2 pl-1.5 @max-[4.5rem]/tab:justify-center @max-[4.5rem]/tab:px-0">
                      <PanelTabCloseButton
                        label={`Close ${title}`}
                        focusable={false}
                        onClick={() => props.onCloseSurface(surface)}
                      >
                        <SurfaceIcon
                          surface={surface}
                          sessions={props.previewSessions}
                          desktopByTabId={props.desktopByTabId}
                          theme={resolvedTheme}
                        />
                        {pending ? (
                          <span
                            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
                            aria-hidden
                          />
                        ) : null}
                      </PanelTabCloseButton>
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
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span className="min-w-0 flex-1 truncate text-left @max-[4.5rem]/tab:hidden" />
                            }
                          >
                            {title}
                          </TooltipTrigger>
                          <TooltipPopup>
                            {surface.kind === "device" ? (
                              <DeviceTabTooltip
                                surface={surface}
                                environmentId={props.environmentId}
                                title={title}
                              />
                            ) : (
                              title
                            )}
                          </TooltipPopup>
                        </Tooltip>
                      )}
                      {audio === "none" || !audioRuntimeTabId ? null : (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                tabIndex={-1}
                                className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-muted @max-[4.5rem]/tab:hidden"
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
                              </button>
                            }
                          />
                          <TooltipPopup>
                            {audio === "muted" ? "Unmute tab" : "Mute tab"}
                          </TooltipPopup>
                        </Tooltip>
                      )}
                    </div>
                  </SortableTab>
                );
              })}
              {canAddBrowser && props.open !== false ? (
                <>
                  {newTabButton}
                  {hasProfileChoice ? (
                    <Menu open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
                      <MenuPopup
                        anchor={newTabRef}
                        align="start"
                        side="bottom"
                        sideOffset={6}
                        className="max-w-56"
                      >
                        {browserProfiles.map((profile) => (
                          <MenuItem
                            key={profile.id}
                            onClick={() => props.onAddBrowserInProfile(profile.id)}
                          >
                            <span className="min-w-0 truncate">{profile.name}</span>
                          </MenuItem>
                        ))}
                      </MenuPopup>
                    </Menu>
                  ) : null}
                </>
              ) : null}
            </div>
          </SortableTabList>
        </ScrollArea>
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
              id: `${tabIdPrefix}-panel`,
              "aria-labelledby": activeTabDomId(tabIdPrefix, groupSurfaces, props.activeSurfaceId),
            }
          : {})}
      >
        {props.surfaces.length === 0 ? <RightPanelEmptyState /> : props.children}
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
  return index < 0 ? undefined : `${prefix}-tab-${index}`;
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
