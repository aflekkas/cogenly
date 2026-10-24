"use client";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamViewport,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  Bot,
  ChevronDown,
  EyeOff,
  Globe2,
  Hand,
  PanelRight,
  PictureInPicture2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useChatCanvas } from "~/components/chat/ChatCanvasContext";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import {
  acquireBrowserSurfaceActivity,
  useBrowserSurfaceStore,
} from "~/browser/browserSurfaceStore";
import { usePreviewAvailable, useRendersServerTabNatively } from "~/browser/previewRuntime";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { refreshPreviewStreamAccess, usePreviewStreamAccess } from "~/state/previewStream";
import { useEnvironmentScope } from "~/state/session";
import { buildThreadRouteParams } from "~/threadRoutes";

import {
  anchorResizedFloatingPreview,
  clampFloatingPreviewToArea,
  type FloatingPreviewArea,
  type FloatingPreviewCorner,
  FLOATING_PREVIEW_ASPECT,
  FLOATING_PREVIEW_CAPTURE_INTERVAL_MS,
  DEFAULT_FLOATING_PREVIEW_CORNER,
  FLOATING_PREVIEW_DRAG_SLOP_PX,
  FLOATING_PREVIEW_MAX_WIDTH,
  FLOATING_PREVIEW_MIN_CARD_SIZE,
  FLOATING_PREVIEW_MIN_WIDTH,
  FLOATING_PREVIEW_RESIZE_STEP_PX,
  FLOATING_PREVIEW_STREAM_FRAME_INTERVAL_MS,
  floatingPreviewCardSize,
  floatingPreviewCornerPosition,
  floatingPreviewPaneFits,
  floatingPreviewResizeHandle,
  floatingPreviewStatus,
  floatingPreviewTitle,
  type FloatingPreviewPoint,
  type FloatingPreviewSize,
  type FloatingPreviewStatus,
  oppositeFloatingPreviewCorner,
  resizeFloatingPreviewWidth,
  resolveFloatingPreviewDriver,
  resolveFloatingPreviewDrop,
  shouldShowFloatingPreview,
} from "./floatingBrowserPreview.logic";
import {
  type FloatingPreviewTarget,
  useFloatingBrowserPreviewStore,
} from "./floatingBrowserPreviewStore";
import { AgentCursorMark, desktopSurfaceFrame } from "./AgentBrowserCursor";
import {
  type AgentSurfaceRect,
  type BrowserController,
  composeFrames,
  coverTopFrame,
  placeAgentTarget,
} from "./agentBrowserCursorLogic";
import { FaviconImage } from "./PreviewFaviconIcon";
import { previewBridge } from "./previewBridge";
import { usePreviewSession } from "./usePreviewSession";

/** A dragged card stays below the window's titlebar row and off its edges. */
const WORKSPACE_TITLEBAR_HEIGHT = 52;
const WINDOW_EDGE_INSET = 8;
const FLOATING_PREVIEW_CORNERS: ReadonlyArray<FloatingPreviewCorner> = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];
const STREAM_JPEG_QUALITY = 60;
const MAX_STREAM_REFUSALS = 2;
/**
 * Thumbnails ask for frames in steps of this many CSS px, so resizing the card
 * reconnects the stream (or resizes captures) only when it crosses a step.
 */
const THUMBNAIL_WIDTH_STEP = 160;

/** The grip's hit area in each corner, and the cursor that says which way it pulls. */
const RESIZE_HANDLE_CLASS: Record<FloatingPreviewCorner, string> = {
  "top-left": "top-0 left-0 cursor-nwse-resize",
  "top-right": "top-0 right-0 cursor-nesw-resize",
  "bottom-left": "bottom-0 left-0 cursor-nesw-resize",
  "bottom-right": "bottom-0 right-0 cursor-nwse-resize",
};
/** The grip's visible mark: a short bracket hugging the card's rounded corner. */
const RESIZE_GRIP_CLASS: Record<FloatingPreviewCorner, string> = {
  "top-left": "top-1 left-1 rounded-tl-md border-t-2 border-l-2",
  "top-right": "top-1 right-1 rounded-tr-md border-t-2 border-r-2",
  "bottom-left": "bottom-1 left-1 rounded-bl-md border-b-2 border-l-2",
  "bottom-right": "bottom-1 right-1 rounded-br-md border-r-2 border-b-2",
};

function thumbnailWidth(width: number): number {
  return Math.ceil(width / THUMBNAIL_WIDTH_STEP) * THUMBNAIL_WIDTH_STEP;
}

/**
 * A card over the chat for this thread's browser tab the panel showed last,
 * once the panel no longer shows it: closed or switched to another surface. It
 * mirrors the page with a throttled thumbnail. Clicking it reopens the panel on
 * that tab; it drags anywhere in the window (docking near pane corners) and
 * resizes from the grip facing open space. While someone else drives, its chip
 * says who and what the page is doing, and offers taking over. The x dismisses
 * it until the tab is looked at again. Mounted once per chat pane.
 */
export function FloatingBrowserPreview(props: {
  readonly activeThreadRef: ScopedThreadRef | null;
  /** The docked composer; bottom corners sit above it. Null when nothing is docked. */
  readonly composerElement: HTMLElement | null;
}) {
  const target = useFloatingBrowserPreviewStore((state) => state.target);
  // Only the thread that owns the tab shows it; another thread's browsing never follows you.
  const onTargetThread =
    target !== null &&
    props.activeThreadRef !== null &&
    props.activeThreadRef.environmentId === target.threadRef.environmentId &&
    props.activeThreadRef.threadId === target.threadRef.threadId;
  if (!target || !onTargetThread) return null;
  return <FloatingBrowserPreviewGate key={target.key} target={target} {...props} />;
}

function FloatingBrowserPreviewGate(props: {
  readonly target: FloatingPreviewTarget;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly composerElement: HTMLElement | null;
}) {
  const environmentId = props.target.threadRef.environmentId;
  const canOperate = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const available = usePreviewAvailable(environmentId);
  if (!canOperate || !available) return null;
  return <FloatingBrowserPreviewCard {...props} />;
}

function FloatingBrowserPreviewCard({
  target,
  activeThreadRef,
  composerElement,
}: {
  readonly target: FloatingPreviewTarget;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly composerElement: HTMLElement | null;
}) {
  const { threadRef, tabId, key } = target;
  // The panel that kept this thread's tabs in sync may be gone with its thread.
  usePreviewSession(threadRef);
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = previewState.sessions[tabId] ?? null;
  const desktopOverlay = previewState.desktopByTabId[tabId] ?? null;
  const nativeServerTab = useRendersServerTabNatively(threadRef.environmentId, snapshot);
  const streamed = snapshot?.runtime === "server" && !nativeServerTab;
  // A desktop tab draws only on the client holding its page.
  const thumbnailSource = streamed
    ? "stream"
    : previewBridge && desktopOverlay?.hasWebContents
      ? "desktop"
      : null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);

  const shownCounts = useFloatingBrowserPreviewStore((state) => state.shownCounts);
  const dismissedKey = useFloatingBrowserPreviewStore((state) => state.dismissedKey);
  const corner =
    useFloatingBrowserPreviewStore((state) => state.corner) ?? DEFAULT_FLOATING_PREVIEW_CORNER;
  const detailsCard = useChatCanvas()?.detailsCard ?? null;
  const freePosition = useFloatingBrowserPreviewStore((state) => state.freePosition);

  // The pane stays in the chat's layout only to be measured; the card itself
  // renders in a body portal on its own layer (see the return below).
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [pane, setPane] = useState<FloatingPreviewSize | null>(null);
  const [paneOrigin, setPaneOrigin] = useState<FloatingPreviewPoint>({ x: 0, y: 0 });
  const [minimapInset, setMinimapInset] = useState(0);
  const [windowSize, setWindowSize] = useState<FloatingPreviewSize>(() => ({
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));
  const [composerHeight, setComposerHeight] = useState(0);
  useLayoutEffect(() => {
    const element = paneRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setPane((current) =>
        current?.width === width && current.height === height ? current : { width, height },
      );
      setPaneOrigin((current) =>
        current.x === rect.left && current.y === rect.top ? current : { x: rect.left, y: rect.top },
      );
      // The timeline minimap rides the pane's right edge; right corners clear it.
      const strip = element.parentElement?.querySelector<HTMLElement>("[data-minimap-strip]");
      const stripRect = strip?.getBoundingClientRect();
      const inset =
        stripRect && stripRect.width > 0 && stripRect.left < rect.right
          ? Math.max(0, Math.round(rect.right - stripRect.left))
          : 0;
      setMinimapInset((current) => (current === inset ? current : inset));
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      setWindowSize((current) =>
        current.width === windowWidth && current.height === windowHeight
          ? current
          : { width: windowWidth, height: windowHeight },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    const stopObserving = observeResize(element, measure);
    return () => {
      window.removeEventListener("resize", measure);
      stopObserving();
    };
  }, []);
  useLayoutEffect(() => {
    if (!composerElement) return;
    const measure = () => setComposerHeight(composerElement.getBoundingClientRect().height);
    measure();
    return observeResize(composerElement, measure);
  }, [composerElement]);
  // A composer that is not docked (the centred draft hero) leaves the bottom free.
  const bottomInset = composerElement ? composerHeight : 0;

  // The width the user chose, live while the grip is held; the pane may shrink it.
  const storedWidth = useFloatingBrowserPreviewStore((state) => state.width);
  const [resize, setResize] = useState<{
    readonly handle: FloatingPreviewCorner;
    readonly width: number;
    /** A free card keeps the corner across from the grip in place; a docked one stays docked. */
    readonly position: FloatingPreviewPoint | null;
  } | null>(null);
  const sizeFor = (width: number | null): FloatingPreviewSize =>
    pane
      ? floatingPreviewCardSize(width, pane, { bottom: bottomInset, right: minimapInset })
      : floatingPreviewCardSize(width, { width: Infinity, height: Infinity }, { bottom: 0 });
  const restingSize = sizeFor(storedWidth);
  const size = resize ? sizeFor(resize.width) : restingSize;

  const shown = shouldShowFloatingPreview({
    targetKey: key,
    shownKeys: new Set(Object.keys(shownCounts)),
    dismissedKey,
    sessionsLoaded: previewState.listLoaded,
    navStatus: snapshot?.navStatus ?? null,
    thumbnailAvailable: thumbnailSource !== null,
    poppedOut: desktopOverlay?.pictureInPicture === true,
    paneFits:
      pane !== null && floatingPreviewPaneFits(pane, FLOATING_PREVIEW_MIN_CARD_SIZE, bottomInset),
  });
  // Mounts transparent and fades in on the next frame, so arriving on a thread
  // with a card to show reads the same as closing the panel in place.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const opaque = shown && entered;

  const [drag, setDrag] = useState<FloatingPreviewPoint | null>(null);
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly origin: FloatingPreviewPoint;
    moved: boolean;
  } | null>(null);
  // Positions are in window coordinates: the card may be dragged anywhere in
  // the window below the titlebar, over the sidebar too. A card left in a
  // corner docks to that corner of the chat pane.
  const cornerPosition = (
    target: FloatingPreviewCorner,
    card: FloatingPreviewSize,
  ): FloatingPreviewPoint | null => {
    if (!pane) return null;
    const inPane = floatingPreviewCornerPosition(target, pane, card, {
      top: 0,
      bottom: bottomInset,
      right: minimapInset,
      detailsCard,
    });
    return { x: paneOrigin.x + inPane.x, y: paneOrigin.y + inPane.y };
  };
  const windowArea: FloatingPreviewArea = {
    left: WINDOW_EDGE_INSET,
    top: WORKSPACE_TITLEBAR_HEIGHT,
    right: windowSize.width - WINDOW_EDGE_INSET,
    bottom: windowSize.height - WINDOW_EDGE_INSET,
  };
  const docked = freePosition
    ? clampFloatingPreviewToArea(freePosition, windowArea, size)
    : cornerPosition(corner, size);
  const position = drag ?? resize?.position ?? docked;
  // Held still while the grip is dragged, so it cannot jump corners under the pointer.
  const resizeHandle =
    resize?.handle ??
    (freePosition && docked
      ? floatingPreviewResizeHandle(docked, size, windowArea)
      : oppositeFloatingPreviewCorner(corner));
  // The close button takes the top corner the grip leaves free.
  const closeOnLeft = resizeHandle === "top-right";

  const navigate = useNavigate();
  const openInPanel = () => {
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
    const onThread =
      activeThreadRef !== null &&
      activeThreadRef.environmentId === threadRef.environmentId &&
      activeThreadRef.threadId === threadRef.threadId;
    if (!onThread) {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    }
  };

  const handlePointer = (event: ReactPointerEvent<HTMLElement>) => {
    if (!pane || !docked) return;
    const current = dragRef.current;
    if (event.type === "pointerdown") {
      if (event.button !== 0 || !event.isPrimary || resize) return;
      // The chip's menu renders in a portal, but its events still bubble here through React.
      const target = event.target as Element;
      if (!event.currentTarget.contains(target)) return;
      if (target.closest("[data-floating-preview-control]")) return;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: docked,
        moved: false,
      };
      return;
    }
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (event.type === "pointermove") {
      if (!current.moved && Math.hypot(dx, dy) < FLOATING_PREVIEW_DRAG_SLOP_PX) return;
      if (!current.moved) {
        current.moved = true;
        // Captured only once it is a drag, so a plain click still reaches the button.
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      setDrag(
        clampFloatingPreviewToArea(
          { x: current.origin.x + dx, y: current.origin.y + dy },
          windowArea,
          size,
        ),
      );
      return;
    }
    dragRef.current = null;
    if (!current.moved) return;
    // A drop near a pane corner docks there; anywhere else the card stays where
    // it was dropped. A cancelled drag returns to where it was.
    if (event.type === "pointerup") {
      const dropped = clampFloatingPreviewToArea(
        { x: current.origin.x + dx, y: current.origin.y + dy },
        windowArea,
        size,
      );
      const corners = Object.fromEntries(
        FLOATING_PREVIEW_CORNERS.map((name) => [name, cornerPosition(name, size) ?? dropped]),
      ) as Record<FloatingPreviewCorner, FloatingPreviewPoint>;
      const resolved = resolveFloatingPreviewDrop(dropped, corners);
      const store = useFloatingBrowserPreviewStore.getState();
      if (resolved.kind === "corner") store.setCorner(resolved.corner);
      else store.setFreePosition(resolved.position);
    }
    setDrag(null);
  };

  // The grip resizes from the corner it sits in; the corner across from it holds still.
  const resizeRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly handle: FloatingPreviewCorner;
    readonly startCard: FloatingPreviewSize;
    /** Set for a free card, which moves to keep its far corner; null when docked. */
    readonly startPosition: FloatingPreviewPoint | null;
  } | null>(null);
  const resizedTo = (
    width: number,
    handle: FloatingPreviewCorner,
    from: { readonly position: FloatingPreviewPoint | null; readonly card: FloatingPreviewSize },
  ) => {
    const card = sizeFor(width);
    const position = from.position
      ? clampFloatingPreviewToArea(
          anchorResizedFloatingPreview({ position: from.position, card: from.card }, handle, card),
          windowArea,
          card,
        )
      : null;
    return { card, position };
  };
  const commitResize = (card: FloatingPreviewSize, position: FloatingPreviewPoint | null) => {
    const store = useFloatingBrowserPreviewStore.getState();
    store.setWidth(card.width);
    if (position) store.setFreePosition(position);
  };
  const handleResizePointer = (event: ReactPointerEvent<HTMLElement>) => {
    // The card's own drag never sees the grip.
    event.stopPropagation();
    if (!pane || !docked) return;
    const current = resizeRef.current;
    if (event.type === "pointerdown") {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        handle: resizeHandle,
        startCard: size,
        startPosition: freePosition ? docked : null,
      };
      setResize({ handle: resizeHandle, width: size.width, position: null });
      return;
    }
    if (!current || current.pointerId !== event.pointerId) return;
    const width = resizeFloatingPreviewWidth(current.startCard.width, current.handle, {
      dx: event.clientX - current.startX,
      dy: event.clientY - current.startY,
    });
    const next = resizedTo(width, current.handle, {
      position: current.startPosition,
      card: current.startCard,
    });
    if (event.type === "pointermove") {
      setResize({ handle: current.handle, width: next.card.width, position: next.position });
      return;
    }
    resizeRef.current = null;
    // A cancelled resize returns to the size it started at.
    if (event.type === "pointerup") commitResize(next.card, next.position);
    setResize(null);
  };
  const handleResizeKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!docked) return;
    const step =
      event.key === "ArrowUp" || event.key === "ArrowRight"
        ? FLOATING_PREVIEW_RESIZE_STEP_PX
        : event.key === "ArrowDown" || event.key === "ArrowLeft"
          ? -FLOATING_PREVIEW_RESIZE_STEP_PX
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = resizedTo(size.width + step, resizeHandle, {
      position: freePosition ? docked : null,
      card: size,
    });
    commitResize(next.card, next.position);
  };

  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  // The card's watch-only stream reports who holds a streamed tab.
  const [streamController, setStreamController] = useState<
    PreviewStreamControl["controller"] | null
  >(null);
  const driver = resolveFloatingPreviewDriver({
    streamController: thumbnailSource === "stream" ? streamController : null,
    agentDriving: snapshot?.agentDriving === true,
    desktopController: desktopOverlay?.controller ?? null,
  });
  const status = floatingPreviewStatus({ driver, navStatus, streamed });
  const cursorController: BrowserController = driver === "agent" ? "agent" : "none";
  const favicon = desktopOverlay?.favicon ?? null;
  const capturedFavicon = favicon && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
  const title = floatingPreviewTitle(navStatus);
  // Frames are requested for the resting size, so a resize in progress never reconnects.
  const frameWidth = thumbnailWidth(restingSize.width);

  const takeControl = () => {
    useFloatingBrowserPreviewStore.getState().requestTakeControl(key);
    openInPanel();
  };
  const popOut =
    previewBridge && thumbnailSource === "desktop"
      ? () => {
          void previewBridge?.pictureInPicture.open(runtimeTabId).catch((error: unknown) => {
            toastManager.add({
              type: "error",
              title: "Couldn't open the preview window",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          });
        }
      : null;
  const dismiss = () => useFloatingBrowserPreviewStore.getState().dismiss(key);

  const card = position ? (
    <section
      aria-label={`Browser preview: ${title}`}
      aria-hidden={shown ? undefined : true}
      inert={!shown}
      data-floating-browser-preview={shown ? "shown" : "hidden"}
      className={cn(
        "group/floating-preview absolute top-0 left-0 touch-none overflow-hidden rounded-xl border border-border/70 bg-muted shadow-xl",
        // Electron hit-tests window drag regions above every layer, so a card
        // over the titlebar would lose its presses, the close button's first.
        "[-webkit-app-region:no-drag]",
        "transition-opacity duration-(--motion-duration-base) ease-out",
        // The card glides to its corner after a drop, and to a size set from the
        // keyboard or forced by the pane; it follows the pointer while dragged or resized.
        drag === null &&
          resize === null &&
          "motion-safe:transition-[opacity,transform,width,height]",
        opaque ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
      style={{
        width: size.width,
        height: size.height,
        transform: `translate3d(${Math.round(position.x)}px, ${Math.round(position.y)}px, 0)`,
      }}
      onPointerDown={handlePointer}
      onPointerMove={handlePointer}
      onPointerUp={handlePointer}
      onPointerCancel={handlePointer}
    >
      {/* The page fills the card; clicking it opens the tab in the browser panel. */}
      <button
        type="button"
        className="absolute inset-0 block cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={openInPanel}
        aria-label={`Open ${title} in the browser panel`}
      >
        {/* Placeholder until the first frame paints over it. */}
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <FaviconImage
            sources={[capturedFavicon, faviconUrlForOrigin(url, 64)]}
            fallback={<Globe2 aria-hidden className="size-6" />}
            className="size-8 rounded object-contain opacity-60"
          />
        </span>
        {thumbnailSource === "stream" ? (
          <StreamThumbnail
            threadRef={threadRef}
            tabId={tabId}
            active={shown}
            frameWidth={frameWidth}
            controller={cursorController}
            onController={setStreamController}
          />
        ) : thumbnailSource === "desktop" ? (
          <DesktopThumbnail
            runtimeTabId={runtimeTabId}
            active={shown}
            frameWidth={frameWidth}
            card={size}
            zoomFactor={desktopOverlay?.zoomFactor ?? 1}
            controller={cursorController}
          />
        ) : null}
      </button>
      {/* The title on a soft scrim along the bottom. Clicks fall through to the page. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-1.5 bg-linear-to-t from-black/70 to-transparent px-3.5 pt-4 pb-1.5 text-white">
        <FaviconImage
          sources={[capturedFavicon, faviconUrlForOrigin(url, 32)]}
          fallback={<Globe2 aria-hidden className="size-3.5 shrink-0 opacity-80" />}
          className="size-3.5 shrink-0 rounded-sm object-contain"
        />
        <span className="min-w-0 flex-1 truncate text-xs leading-5 font-medium">{title}</span>
        {status.chip ? (
          <span data-floating-preview-control="" className="pointer-events-auto flex shrink-0">
            <FloatingPreviewDriverMenu
              status={status}
              onTakeControl={takeControl}
              onOpen={openInPanel}
              onPopOut={popOut}
              onDismiss={dismiss}
            />
          </span>
        ) : null}
      </div>
      {/* Always shown and always hit-testable: a hover-only close faded in as the
          pointer arrived, and its press could start a card drag. Its own
          handlers keep the press away from the card's drag and the page's click. */}
      <span
        data-floating-preview-control=""
        className={cn("absolute top-1.5 flex", closeOnLeft ? "left-1.5" : "right-1.5")}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button
          variant="media-close"
          size="icon-sm"
          aria-label="Close browser preview"
          onClick={(event) => {
            event.stopPropagation();
            dismiss();
          }}
        >
          <X aria-hidden />
        </Button>
      </span>
      {/* The resize grip, in the corner facing open space; arrow keys step the size. */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Browser preview size"
        aria-orientation="horizontal"
        aria-valuemin={FLOATING_PREVIEW_MIN_WIDTH}
        aria-valuemax={FLOATING_PREVIEW_MAX_WIDTH}
        aria-valuenow={size.width}
        aria-valuetext={`${size.width} by ${size.height} pixels`}
        data-floating-preview-control=""
        className={cn(
          "group/resize absolute size-4 touch-none outline-none",
          RESIZE_HANDLE_CLASS[resizeHandle],
        )}
        onPointerDown={handleResizePointer}
        onPointerMove={handleResizePointer}
        onPointerUp={handleResizePointer}
        onPointerCancel={handleResizePointer}
        onKeyDown={handleResizeKey}
      >
        <span
          aria-hidden
          className={cn(
            "absolute size-2.5 border-white/80 transition-opacity duration-(--motion-duration-fast) ease-out group-hover/floating-preview:opacity-100 group-focus-visible/resize:opacity-100",
            resize ? "opacity-100" : "opacity-0",
            RESIZE_GRIP_CLASS[resizeHandle],
          )}
        />
      </div>
    </section>
  ) : null;

  // Above page content (messages, timeline hover cards, the minimap, the docked
  // details card) and below real overlays: dialogs, toasts, menus. A window-wide
  // body portal, so no chat-pane stacking context can bury it and it can be
  // dragged over the sidebar.
  const layer =
    pane && typeof document !== "undefined"
      ? createPortal(
          <div
            data-floating-browser-preview-layer=""
            className="pointer-events-none fixed inset-0 z-(--z-floating-preview) overflow-hidden"
          >
            {card}
          </div>,
          document.body,
        )
      : null;
  return (
    <div ref={paneRef} aria-hidden className="pointer-events-none absolute inset-0">
      {layer}
    </div>
  );
}

/**
 * The chip on the card's title row while someone else drives: who, with what
 * the page is doing on hover, and a menu to take over, open the tab, pop it
 * into its own window (desktop), or hide the card.
 */
function FloatingPreviewDriverMenu(props: {
  readonly status: FloatingPreviewStatus;
  readonly onTakeControl: () => void;
  readonly onOpen: () => void;
  /** Null where the tab cannot get its own window. */
  readonly onPopOut: (() => void) | null;
  readonly onDismiss: () => void;
}) {
  const { status, onTakeControl, onOpen, onPopOut, onDismiss } = props;
  const summary = `${status.headline} · ${status.activity}`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button variant="overlay" size="micro" aria-label={`${summary}. Options`} />}
            />
          }
        >
          <Bot aria-hidden />
          {status.chip}
          <ChevronDown aria-hidden />
        </TooltipTrigger>
        <TooltipPopup>{summary}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="end" sideOffset={6}>
        <MenuGroup>
          <MenuGroupLabel>{status.headline}</MenuGroupLabel>
          <div className="max-w-64 truncate px-2 pb-1.5 text-xs text-muted-foreground">
            {status.takeOver === "page"
              ? `${status.activity} · use the page to take over`
              : status.activity}
          </div>
        </MenuGroup>
        <MenuSeparator />
        {status.takeOver === "stream" ? (
          <MenuItem onClick={onTakeControl}>
            <Hand aria-hidden />
            Take control
          </MenuItem>
        ) : null}
        <MenuItem onClick={onOpen}>
          <PanelRight aria-hidden />
          Open in browser panel
        </MenuItem>
        {onPopOut ? (
          <MenuItem onClick={onPopOut}>
            <PictureInPicture2 aria-hidden />
            Open in separate window
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={onDismiss}>
          <EyeOff aria-hidden />
          Hide preview
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * A streamed server tab, watched passively at a thumbnail's size and paced to
 * one frame a second. Connected only while the card shows; reconnects when the
 * card is resized across a frame-width step.
 */
function StreamThumbnail(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly active: boolean;
  /** CSS px of page width to ask frames for. */
  readonly frameWidth: number;
  readonly controller: BrowserController;
  /** Who holds the tab, as the stream reports it; null while disconnected. */
  readonly onController: (controller: PreviewStreamControl["controller"] | null) => void;
}) {
  const { threadRef, tabId, active, frameWidth, controller, onController } = props;
  const controllerChanged = useEffectEvent((next: PreviewStreamControl["controller"] | null) =>
    onController(next),
  );
  const environmentId = threadRef.environmentId;
  const access = usePreviewStreamAccess(environmentId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [painted, setPainted] = useState(false);
  const refusalsRef = useRef(0);
  const viewportRef = useRef<PreviewStreamViewport | null>(null);
  const [cursor, setCursor] = useState<ThumbnailCursor | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !access || !canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const painter = createPreviewFramePainter(canvas, () => setPainted(true));
    const client = createPreviewStreamClient(
      {
        access,
        threadId: threadRef.threadId,
        tabId,
        maxWidth: frameWidth * ratio,
        maxHeight: frameWidth * FLOATING_PREVIEW_ASPECT * ratio * 2,
        interactive: false,
        minFrameIntervalMs: FLOATING_PREVIEW_STREAM_FRAME_INTERVAL_MS,
        quality: STREAM_JPEG_QUALITY,
      },
      {
        onFrame: (jpeg) => {
          refusalsRef.current = 0;
          painter.paint(jpeg);
        },
        onViewport: (viewport) => {
          viewportRef.current = viewport;
        },
        // The page fills the card top-anchored (object-cover), so the cursor maps the same way.
        onPointer: (pointer) => {
          const viewport = viewportRef.current;
          const element = canvasRef.current;
          if (!viewport || !element) return;
          const frame = coverTopFrame(viewport, {
            width: element.clientWidth,
            height: element.clientHeight,
          });
          if (frame)
            setCursor({
              phase: pointer.phase,
              sequence: pointer.sequence,
              ...placeAgentTarget(pointer, frame),
            });
        },
        onControl: (control) => controllerChanged(control.controller),
        onConnectedChange: (connected) => {
          if (!connected) controllerChanged(null);
        },
        // A fresh ticket re-runs this effect; a viewer refused twice stays on its placeholder.
        onUnauthorized: () => {
          refusalsRef.current += 1;
          if (refusalsRef.current < MAX_STREAM_REFUSALS) refreshPreviewStreamAccess(environmentId);
        },
      },
    );
    return () => {
      painter.stop();
      client.stop();
      controllerChanged(null);
    };
  }, [access, active, environmentId, frameWidth, tabId, threadRef.threadId]);
  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn(
          "absolute inset-0 block size-full object-cover object-top transition-opacity duration-(--motion-duration-base) ease-out",
          painted ? "opacity-100" : "opacity-0",
        )}
      />
      {cursor && painted ? <AgentCursorMark {...cursor} controller={controller} compact /> : null}
    </>
  );
}

interface ThumbnailCursor {
  readonly phase: "move" | "click";
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
  readonly outline: AgentSurfaceRect | null;
}

/**
 * A desktop tab's agent cursor over its thumbnail. The pointer maps onto the
 * panel surface the page draws into, and that surface onto the card the way
 * the captured image covers it.
 */
function DesktopThumbnailCursor(props: {
  readonly runtimeTabId: string;
  readonly zoomFactor: number;
  readonly surface: { readonly width: number; readonly height: number };
  readonly card: { readonly width: number; readonly height: number };
  readonly controller: BrowserController;
}) {
  const { runtimeTabId, zoomFactor, surface, card, controller } = props;
  const event = useBrowserPointerStore((state) => state.byTabId[runtimeTabId] ?? null);
  const content = useBrowserSurfaceStore((state) => state.byTabId[runtimeTabId]?.content ?? null);
  const toCard = coverTopFrame(surface, card);
  if (!event || !toCard) return null;
  const placed = placeAgentTarget(
    event,
    composeFrames(desktopSurfaceFrame(content, zoomFactor), toCard),
  );
  return (
    <AgentCursorMark
      phase={event.phase}
      sequence={event.sequence}
      left={placed.left}
      top={placed.top}
      outline={placed.outline}
      controller={controller}
      compact
    />
  );
}

interface CapturedPageImage {
  readonly isEmpty?: () => boolean;
  readonly resize?: (options: { readonly width: number }) => CapturedPageImage;
  readonly toDataURL?: () => string;
}

interface CapturableWebview extends HTMLElement {
  readonly capturePage?: () => Promise<CapturedPageImage>;
}

/**
 * A desktop tab's page, captured from its hidden `<webview>` every couple of
 * seconds while the card shows. Holding surface activity keeps the guest
 * compositing behind the app, the way recordings do; a guest that cannot be
 * captured leaves the placeholder.
 */
function DesktopThumbnail(props: {
  readonly runtimeTabId: string;
  readonly active: boolean;
  /** CSS px of page width to capture at. */
  readonly frameWidth: number;
  /** The card's current size, which the cursor maps onto. */
  readonly card: FloatingPreviewSize;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { runtimeTabId, active, frameWidth, card, zoomFactor, controller } = props;
  const [source, setSource] = useState<string | null>(null);
  // The webview's own size: what the captured image shows, so the cursor maps through it.
  const [surface, setSurface] = useState<FloatingPreviewSize | null>(null);
  useEffect(() => {
    if (!active) return;
    const releaseActivity = acquireBrowserSurfaceActivity(runtimeTabId);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const width = Math.round(frameWidth * (window.devicePixelRatio || 1));
    const capture = async () => {
      const webview = [...document.querySelectorAll("webview")].find(
        (element) => element.dataset.previewTab === runtimeTabId,
      ) as CapturableWebview | undefined;
      try {
        const image = await webview?.capturePage?.();
        if (disposed || !image || image.isEmpty?.() === true) return;
        const dataUrl = (image.resize?.({ width }) ?? image).toDataURL?.();
        if (dataUrl && dataUrl.length > "data:image/png;base64,".length) {
          setSource(dataUrl);
          if (webview && webview.clientWidth > 0 && webview.clientHeight > 0) {
            const next = { width: webview.clientWidth, height: webview.clientHeight };
            setSurface((current) =>
              current?.width === next.width && current.height === next.height ? current : next,
            );
          }
        }
      } catch {
        // A cold or crashed guest rejects; the next tick tries again.
      }
    };
    const tick = () => {
      void capture().finally(() => {
        if (!disposed) timer = setTimeout(tick, FLOATING_PREVIEW_CAPTURE_INTERVAL_MS);
      });
    };
    tick();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      releaseActivity();
    };
  }, [active, frameWidth, runtimeTabId]);
  const [loaded, setLoaded] = useState(false);
  // Later captures swap in place; only the first one fades over the placeholder.
  return source ? (
    <>
      <img
        src={source}
        alt=""
        aria-hidden
        draggable={false}
        onLoad={() => setLoaded(true)}
        className={cn(
          "absolute inset-0 block size-full object-cover object-top transition-opacity duration-(--motion-duration-base) ease-out",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
      {loaded && surface ? (
        <DesktopThumbnailCursor
          runtimeTabId={runtimeTabId}
          zoomFactor={zoomFactor}
          surface={surface}
          card={card}
          controller={controller}
        />
      ) : null}
    </>
  ) : null;
}

function sameOrigin(left: string, right: string): boolean {
  if (!URL.canParse(left) || !URL.canParse(right)) return false;
  return new URL(left).origin === new URL(right).origin;
}
