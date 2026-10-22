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
import {
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
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import {
  surfaceGroupOf,
  type RightPanelSurface,
  type RightPanelSurfaceGroup,
} from "~/rightPanelStore";
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
  MenuItem,
  MenuPopup,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { ScrollArea } from "~/components/ui/scroll-area";
import { PanOnHoverText } from "~/components/sidebar/PanOnHoverText";
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
import { observeResize } from "~/lib/observeResize";

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
  style,
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
      // The drag adds its own translate.
      style={{ ...style, transform: CSS.Translate.toString(transform), transition }}
      className={cn(className, isDragging && "relative z-10")}
    />
  );
}

/** The tab strip's own motion: arrivals and departures, on the base token. */
const TAB_MOTION_MS = 220;
const TAB_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface LeavingTab {
  readonly surface: RightPanelSurface;
  /** The tab it followed, so it folds shut in its old place. */
  readonly afterId: string | null;
  readonly width: number;
}

/**
 * A closed tab's place, folding shut over the strip's motion so the tabs
 * after it slide over rather than jump. Inert: it is only geometry.
 */
function LeavingTabSlot({ width, onDone }: { width: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || reducedMotion()) {
      onDone();
      return;
    }
    const animation = element.animate(
      [
        { width: `${width}px`, opacity: 1 },
        { width: "0px", opacity: 0 },
      ],
      { duration: TAB_MOTION_MS, easing: TAB_MOTION_EASING, fill: "forwards" },
    );
    animation.onfinish = onDone;
    return () => animation.cancel();
    // Plays once, for the width it closed at.
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- a mount-only animation
  }, []);
  return <div ref={ref} aria-hidden className="h-7 shrink-0 overflow-hidden" />;
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
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabIdPrefix = useId();
  const [renamingDevice, setRenamingDevice] = useState<string | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [leavingTabs, setLeavingTabs] = useState<readonly LeavingTab[]>([]);

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

  // Arrivals grow from nothing and departures fold shut in place, so the
  // tabs beside them slide rather than jump. A switch to another group of
  // tabs is a different strip, not an arrival, and plays nothing.
  //
  // This runs only when the strip's set of tabs changes, never per render: a
  // read here would force the panel's whole first style pass early, inside
  // the commit, and again on every re-render. The widths a closing tab folds
  // from come from a resize observer instead (the tab's border box as last
  // laid out), so no commit reads layout to keep them.
  const seenTabsRef = useRef<{ group: RightPanelSurfaceGroup | null; ids: string[] } | null>(null);
  const lastTabWidthsRef = useRef(new Map<string, number>());
  const tabSetKey = `${activeGroup ?? ""}\u0000${groupSurfaces.map((surface) => surface.id).join("\u0000")}`;
  const syncTabSet = useEffectEvent(() => {
    const ids = groupSurfaces.map((surface) => surface.id);
    const seen = seenTabsRef.current;
    seenTabsRef.current = { group: activeGroup, ids };
    const list = tabListRef.current;
    const sameGroup = seen !== null && seen.group === activeGroup;
    if (sameGroup && list && !reducedMotion()) {
      const previous = new Set<string>(seen.ids);
      // Every read, then every write: one layout for all arrivals.
      const arrivals: Array<{ element: HTMLElement; width: number }> = [];
      for (const id of ids) {
        if (previous.has(id)) continue;
        const element = list.querySelector<HTMLElement>(
          `[data-surface-id="${window.CSS.escape(id)}"]`,
        );
        if (element) arrivals.push({ element, width: element.getBoundingClientRect().width });
      }
      // The tab fades in where it will sit: its content is held at its final
      // width while the slot opens, so the title does not reflow or slide as
      // the neighbours ease aside to make room.
      for (const { element, width } of arrivals) {
        const content = element.firstElementChild;
        if (content instanceof HTMLElement) content.style.width = `${width}px`;
        const animation = element.animate(
          [
            { width: "0px", opacity: 0 },
            { width: `${width}px`, opacity: 1 },
          ],
          { duration: TAB_MOTION_MS, easing: TAB_MOTION_EASING },
        );
        const release = () => {
          if (content instanceof HTMLElement) content.style.width = "";
        };
        animation.addEventListener("finish", release, { once: true });
        animation.addEventListener("cancel", release, { once: true });
      }
      const current = new Set<string>(ids);
      const gone = seen.ids
        .map((id, index) => ({ id, afterId: seen.ids[index - 1] ?? null }))
        .filter(({ id }) => !current.has(id));
      if (gone.length > 0) {
        setLeavingTabs((leaving) => [
          ...leaving,
          ...gone.flatMap(({ id, afterId }) => {
            const width = lastTabWidthsRef.current.get(id);
            const surface = props.surfaces.find((entry) => (entry.id as string) === id);
            return width && surface ? [{ surface, afterId, width }] : [];
          }),
        ]);
      }
      for (const { id } of gone) lastTabWidthsRef.current.delete(id);
    }
    if (!list) return;
    const tabs = Array.from(list.querySelectorAll<HTMLElement>("[data-surface-id]"));
    return observeResize(tabs, (entries) => {
      for (const entry of entries) {
        const id = entry.target instanceof HTMLElement ? entry.target.dataset.surfaceId : undefined;
        const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        if (id) lastTabWidthsRef.current.set(id, width);
      }
    });
  });
  // Keyed on the tab set: a title change resizes its tab, and the observed
  // sizes follow it on their own.
  // eslint-disable-next-line react/exhaustive-effect-dependencies -- keyed on the tab set
  useLayoutEffect(() => syncTabSet(), [tabSetKey]);
  const dismissLeaving = useCallback(
    (id: string) => setLeavingTabs((leaving) => leaving.filter((entry) => entry.surface.id !== id)),
    [],
  );
  // The strip in order: current tabs, with each leaving slot after the tab it followed.
  const tabItems = useMemo(() => {
    const items: Array<
      | { kind: "tab"; surface: RightPanelSurface; index: number }
      | { kind: "leaving"; entry: LeavingTab }
    > = [];
    const placed = new Set<LeavingTab>();
    const place = (afterId: string | null) => {
      for (const entry of leavingTabs) {
        if (placed.has(entry) || entry.afterId !== afterId) continue;
        placed.add(entry);
        items.push({ kind: "leaving", entry });
      }
    };
    place(null);
    groupSurfaces.forEach((surface, index) => {
      items.push({ kind: "tab", surface, index });
      place(surface.id);
    });
    for (const entry of leavingTabs) {
      if (!placed.has(entry)) items.push({ kind: "leaving", entry });
    }
    return items;
  }, [groupSurfaces, leavingTabs]);

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

  // A strip with more tabs than room scrolls: the wheel scrolls it sideways
  // and the fade on each edge says there is more.
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

  // "+" lists what the thread can open; the menu is a Base UI menu, so arrows,
  // Home/End, typeahead and Enter work. A browser with several profiles opens
  // as a submenu of them.
  const hasProfileChoice = browserProfiles.length > 1;
  if (!canAdd && addMenuOpen) setAddMenuOpen(false);
  const newTabButton = (
    <Menu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
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
              className="relative flex h-full w-full items-center gap-0.5"
              onKeyDown={handleTabListKeyDown}
            >
              {tabItems.map((item) => {
                if (item.kind === "leaving") {
                  const { entry } = item;
                  return (
                    <LeavingTabSlot
                      key={`leaving:${entry.surface.id}`}
                      width={entry.width}
                      onDone={() => dismissLeaving(entry.surface.id)}
                    />
                  );
                }
                const { surface, index } = item;
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
                    aria-label={title}
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
                      // As wide as its title, up to a cap past which the title
                      // truncates; a strip that runs out of room scrolls. Only
                      // keyboard focus draws a ring; PanelTab draws the rest.
                      "relative h-7 max-w-44 shrink-0 cursor-pointer overflow-hidden rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      ownsDesktopTitleBar && "[-webkit-app-region:no-drag]",
                    )}
                  >
                    <PanelTab.Body active={active}>
                      <PanelTab.Icon>
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
                      ) : surface.kind === "device" ? (
                        // A device's tooltip adds its host and OS version.
                        <Tooltip>
                          <TooltipTrigger render={<PanelTab.Label />}>{title}</TooltipTrigger>
                          <TooltipPopup>
                            <DeviceTabTooltip
                              surface={surface}
                              environmentId={props.environmentId}
                              title={title}
                            />
                          </TooltipPopup>
                        </Tooltip>
                      ) : (
                        // A truncated title pans on hover so it can be read in
                        // place, like a sidebar row; no tooltip repeats it.
                        <PanOnHoverText className="min-w-0 flex-1 text-left">
                          {title}
                        </PanOnHoverText>
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
                          <TooltipPopup>
                            {audio === "muted" ? "Unmute tab" : "Mute tab"}
                          </TooltipPopup>
                        </Tooltip>
                      )}
                      {/* Not a tab stop, since Delete closes the focused tab. */}
                      <PanelTab.Close
                        active={active}
                        tabIndex={-1}
                        aria-label={`Close ${title}`}
                        onClick={() => props.onCloseSurface(surface)}
                      />
                    </PanelTab.Body>
                  </SortableTab>
                );
              })}
              {canAdd && props.open !== false ? newTabButton : null}
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
