"use client";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamControl,
} from "@cogenly/client-runtime/preview/server-browser-stream";
import { AuthPreviewOperateScope, type ScopedThreadRef } from "@cogenly/contracts";
import { Globe2, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useChatCanvas } from "~/components/chat/ChatCanvasContext";
import { Button } from "~/components/ui/button";
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

import {
  anchorResizedFloatingPreview,
  clampFloatingPreviewToArea,
  type FloatingPreviewCorner,
  FLOATING_PREVIEW_CAPTURE_INTERVAL_MS,
  DEFAULT_FLOATING_PREVIEW_CORNER,
  FLOATING_PREVIEW_DRAG_SLOP_PX,
  FLOATING_PREVIEW_MAX_WIDTH,
  FLOATING_PREVIEW_MIN_PAGE_ASPECT,
  FLOATING_PREVIEW_MIN_WIDTH,
  FLOATING_PREVIEW_RESIZE_STEP_PX,
  FLOATING_PREVIEW_STREAM_FRAME_INTERVAL_MS,
  FLOATING_PREVIEW_TITLE_HEIGHT,
  floatingPreviewCardSize,
  floatingPreviewCornerPosition,
  floatingPreviewMinCardSize,
  floatingPreviewPageAspect,
  floatingPreviewPageFrame,
  floatingPreviewPaneArea,
  floatingPreviewPaneFits,
  floatingPreviewResizeHandle,
  floatingPreviewTitle,
  type FloatingPreviewPageFrame,
  type FloatingPreviewPoint,
  type FloatingPreviewSize,
  oppositeFloatingPreviewCorner,
  resizeFloatingPreviewWidth,
  resolveFloatingPreviewDriver,
  resolveFloatingPreviewDrop,
  shouldShowFloatingPreview,
} from "./floatingBrowserPreview.logic";
import {
  type FloatingPreviewTarget,
  selectFloatingPreviewDismissed,
  selectFloatingPreviewTarget,
  useFloatingBrowserPreviewStore,
} from "./floatingBrowserPreviewStore";
import { AgentCursorMark, desktopSurfaceFrame } from "./AgentBrowserCursor";
import {
  type AgentPointerTarget,
  type AgentSurfaceFrame,
  type BrowserController,
  composeFrames,
  placeAgentTarget,
} from "./agentBrowserCursorLogic";
import { FaviconImage } from "./PreviewFaviconIcon";
import { previewBridge } from "./previewBridge";
import { usePreviewSession } from "./usePreviewSession";

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

function sameSize(left: FloatingPreviewSize | null, right: FloatingPreviewSize): boolean {
  return left !== null && left.width === right.width && left.height === right.height;
}

/** Page pixels onto the page area, for the agent cursor drawn over the thumbnail. */
function cursorFrame(frame: FloatingPreviewPageFrame): AgentSurfaceFrame {
  return { offsetX: frame.left, offsetY: frame.top, scaleX: frame.scale, scaleY: frame.scale };
}

/**
 * A card over the chat for the browser tab this thread's panel showed last,
 * once the panel no longer shows it: closed or switched to another surface. It
 * mirrors the page's whole viewport with a throttled thumbnail. Clicking it
 * reopens the panel on that tab; it drags within the chat pane (docking near
 * its corners) and resizes from the grip facing open space. The x hides it for
 * this thread until "Show mini preview" in the browser panel's menu.
 *
 * Mounted once per chat pane, and drawn inside it rather than in a body
 * portal: a thread view kept alive in a hidden `<Activity>` hides only its own
 * DOM, so a portal would keep painting that thread's card over another one.
 */
export function FloatingBrowserPreview(props: {
  readonly activeThreadRef: ScopedThreadRef | null;
  /** The docked composer; bottom corners sit above it. Null when nothing is docked. */
  readonly composerElement: HTMLElement | null;
}) {
  const target = useFloatingBrowserPreviewStore((state) =>
    selectFloatingPreviewTarget(state, props.activeThreadRef),
  );
  if (!target) return null;
  return (
    <FloatingBrowserPreviewGate
      key={target.key}
      target={target}
      composerElement={props.composerElement}
    />
  );
}

function FloatingBrowserPreviewGate(props: {
  readonly target: FloatingPreviewTarget;
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
  composerElement,
}: {
  readonly target: FloatingPreviewTarget;
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
  const dismissed = useFloatingBrowserPreviewStore((state) =>
    selectFloatingPreviewDismissed(state, threadRef),
  );
  const corner =
    useFloatingBrowserPreviewStore((state) => state.corner) ?? DEFAULT_FLOATING_PREVIEW_CORNER;
  const detailsCard = useChatCanvas()?.detailsCard ?? null;
  const freePosition = useFloatingBrowserPreviewStore((state) => state.freePosition);

  // The pane is the chat column the card lives in; every position is in its coordinates.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [pane, setPane] = useState<FloatingPreviewSize | null>(null);
  const [minimapInset, setMinimapInset] = useState(0);
  const [composerHeight, setComposerHeight] = useState(0);
  useLayoutEffect(() => {
    const element = paneRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setPane((current) => (sameSize(current, next) ? current : next));
      // The timeline minimap rides the pane's right edge; right corners clear it.
      const strip = element.parentElement?.querySelector<HTMLElement>("[data-minimap-strip]");
      const stripRect = strip?.getBoundingClientRect();
      const inset =
        stripRect && stripRect.width > 0 && stripRect.left < rect.right
          ? Math.max(0, Math.round(rect.right - stripRect.left))
          : 0;
      setMinimapInset((current) => (current === inset ? current : inset));
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

  // The tab's viewport, as its thumbnail reports it, shapes the page area. Until
  // then a fixed viewport or the desktop page's last laid-out size stands in.
  const [reportedPage, setReportedPage] = useState<FloatingPreviewSize | null>(null);
  const desktopContent = useBrowserSurfaceStore(
    (state) => state.byTabId[runtimeTabId]?.content ?? null,
  );
  const fixedViewport =
    snapshot?.viewport && snapshot.viewport._tag !== "fill"
      ? { width: snapshot.viewport.width, height: snapshot.viewport.height }
      : null;
  const pageSize =
    reportedPage ??
    fixedViewport ??
    (thumbnailSource === "desktop" && desktopContent && desktopContent.scale > 0
      ? {
          width: desktopContent.width / desktopContent.scale,
          height: desktopContent.height / desktopContent.scale,
        }
      : null);
  const pageAspect = floatingPreviewPageAspect(pageSize);
  const reportPageSize = (size: FloatingPreviewSize) =>
    setReportedPage((current) => (sameSize(current, size) ? current : size));

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
      ? floatingPreviewCardSize(
          width,
          pane,
          { bottom: bottomInset, right: minimapInset },
          pageAspect,
        )
      : floatingPreviewCardSize(
          width,
          { width: Infinity, height: Infinity },
          { bottom: 0 },
          pageAspect,
        );
  const restingSize = sizeFor(storedWidth);
  const size = resize ? sizeFor(resize.width) : restingSize;
  // The page area above the title strip; the thumbnail fits the whole viewport into it.
  const pageBox = { width: size.width, height: size.height - FLOATING_PREVIEW_TITLE_HEIGHT };

  const shown = shouldShowFloatingPreview({
    targetKey: key,
    shownKeys: new Set(Object.keys(shownCounts)),
    dismissed,
    sessionsLoaded: previewState.listLoaded,
    navStatus: snapshot?.navStatus ?? null,
    thumbnailAvailable: thumbnailSource !== null,
    poppedOut: desktopOverlay?.pictureInPicture === true,
    paneFits:
      pane !== null &&
      floatingPreviewPaneFits(pane, floatingPreviewMinCardSize(pageAspect), bottomInset),
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
  const cornerPosition = (
    target: FloatingPreviewCorner,
    card: FloatingPreviewSize,
  ): FloatingPreviewPoint | null =>
    pane
      ? floatingPreviewCornerPosition(target, pane, card, {
          top: 0,
          bottom: bottomInset,
          right: minimapInset,
          detailsCard,
        })
      : null;
  // A free card stays inside the pane, above the composer; a pane that shrinks
  // or a sidebar that opens moves it back in.
  const area = pane
    ? floatingPreviewPaneArea(pane, { bottom: bottomInset, right: minimapInset })
    : null;
  const docked =
    freePosition && area
      ? clampFloatingPreviewToArea(freePosition, area, size)
      : cornerPosition(corner, size);
  const position = drag ?? resize?.position ?? docked;
  // Held still while the grip is dragged, so it cannot jump corners under the pointer.
  const resizeHandle =
    resize?.handle ??
    (freePosition && docked && area
      ? floatingPreviewResizeHandle(docked, size, area)
      : oppositeFloatingPreviewCorner(corner));
  // The close button takes the top corner the grip leaves free.
  const closeOnLeft = resizeHandle === "top-right";

  const openInPanel = () => useRightPanelStore.getState().openBrowser(threadRef, tabId);

  const handlePointer = (event: ReactPointerEvent<HTMLElement>) => {
    if (!area || !docked) return;
    const current = dragRef.current;
    if (event.type === "pointerdown") {
      if (event.button !== 0 || !event.isPrimary || resize) return;
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
          area,
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
        area,
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
    const position =
      from.position && area
        ? clampFloatingPreviewToArea(
            anchorResizedFloatingPreview(
              { position: from.position, card: from.card },
              handle,
              card,
            ),
            area,
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
    const width = resizeFloatingPreviewWidth(
      current.startCard.width,
      current.handle,
      { dx: event.clientX - current.startX, dy: event.clientY - current.startY },
      pageAspect,
    );
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
  // The card's watch-only stream reports who holds a streamed tab; the agent's
  // cursor over the thumbnail reads it.
  const [streamController, setStreamController] = useState<
    PreviewStreamControl["controller"] | null
  >(null);
  const driver = resolveFloatingPreviewDriver({
    streamController: thumbnailSource === "stream" ? streamController : null,
    agentDriving: snapshot?.agentDriving === true,
    desktopController: desktopOverlay?.controller ?? null,
  });
  const cursorController: BrowserController = driver === "agent" ? "agent" : "none";
  const favicon = desktopOverlay?.favicon ?? null;
  const capturedFavicon = favicon && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
  const title = floatingPreviewTitle(navStatus);
  // Frames are requested for the resting size, so a resize in progress never reconnects.
  const frameWidth = thumbnailWidth(restingSize.width);

  const dismiss = () => useFloatingBrowserPreviewStore.getState().dismiss(threadRef);

  const card = position ? (
    <section
      aria-label={`Browser preview: ${title}`}
      aria-hidden={shown ? undefined : true}
      inert={!shown}
      data-floating-browser-preview={shown ? "shown" : "hidden"}
      className={cn(
        "group/floating-preview absolute top-0 left-0 touch-none overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-xl ring-1 ring-border",
        // Electron hit-tests window drag regions above every layer, so a card
        // under the titlebar's drag strip would lose its presses.
        "[-webkit-app-region:no-drag]",
        "transition-opacity duration-(--motion-duration-base) ease-out",
        // The card glides to its corner after a drop, back inside a pane that
        // shrank, and to a size set from the keyboard, forced by the pane or
        // reshaped by the page; it follows the pointer while dragged or resized.
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
      {/* The page over its title strip; clicking either opens the tab in the browser panel. */}
      <button
        type="button"
        className="absolute inset-0 flex cursor-pointer flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={openInPanel}
        aria-label={`Open ${title} in the browser panel`}
      >
        <span className="relative block min-h-0 w-full flex-1 overflow-hidden bg-background">
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
              box={pageBox}
              controller={cursorController}
              onController={setStreamController}
              onPageSize={reportPageSize}
            />
          ) : thumbnailSource === "desktop" ? (
            <DesktopThumbnail
              runtimeTabId={runtimeTabId}
              active={shown}
              frameWidth={frameWidth}
              box={pageBox}
              zoomFactor={desktopOverlay?.zoomFactor ?? 1}
              controller={cursorController}
              onPageSize={reportPageSize}
            />
          ) : null}
        </span>
        {/* Kept in step with FLOATING_PREVIEW_TITLE_HEIGHT (h-7, 28px). */}
        <span className="flex h-7 w-full min-w-0 shrink-0 items-center gap-1.5 border-t border-border px-2.5">
          <FaviconImage
            sources={[capturedFavicon, faviconUrlForOrigin(url, 32)]}
            fallback={<Globe2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
            className="size-3.5 shrink-0 rounded-sm object-contain"
          />
          <span className="min-w-0 flex-1 truncate text-xs leading-5 font-medium">{title}</span>
        </span>
      </button>
      {/* Fades in while the card is hovered or anything in it has focus; a
          touch screen, with no hover, always shows it. It stays hit-testable
          throughout, and its own handlers keep the press away from the card's
          drag and the page's click. */}
      <span
        data-floating-preview-control=""
        className={cn(
          "absolute top-1.5 flex opacity-0 transition-opacity duration-(--motion-duration-fast) ease-out group-focus-within/floating-preview:opacity-100 group-hover/floating-preview:opacity-100 pointer-coarse:opacity-100",
          closeOnLeft ? "left-1.5" : "right-1.5",
        )}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button
          variant="media-solid"
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
            "absolute size-2.5 border-muted-foreground transition-opacity duration-(--motion-duration-fast) ease-out group-hover/floating-preview:opacity-100 group-focus-visible/resize:opacity-100",
            resize ? "opacity-100" : "opacity-0",
            RESIZE_GRIP_CLASS[resizeHandle],
          )}
        />
      </div>
    </section>
  ) : null;

  // Above the pane's own content (messages, the minimap, the composer, the
  // docked details card) and clipped to it, so the card never covers the
  // sidebar or the header. Dialogs, toasts and menus portal above it.
  return (
    <div
      ref={paneRef}
      data-floating-browser-preview-layer=""
      className="pointer-events-none absolute inset-0 z-(--z-floating-preview) overflow-hidden"
    >
      {card}
    </div>
  );
}

interface ThumbnailCursor extends AgentPointerTarget {
  readonly sequence: number;
}

/**
 * A streamed server tab, watched passively at a thumbnail's size and paced to
 * one frame a second. Connected only while the card shows; reconnects when the
 * card is resized across a frame-width step. The whole viewport fits the page
 * area, rescaled whenever the card or the tab's viewport changes.
 */
function StreamThumbnail(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly active: boolean;
  /** CSS px of page width to ask frames for. */
  readonly frameWidth: number;
  /** The page area the frame fits into. */
  readonly box: FloatingPreviewSize;
  readonly controller: BrowserController;
  /** Who holds the tab, as the stream reports it; null while disconnected. */
  readonly onController: (controller: PreviewStreamControl["controller"] | null) => void;
  /** The tab's viewport in CSS px, whenever the stream reports it. */
  readonly onPageSize: (size: FloatingPreviewSize) => void;
}) {
  const { threadRef, tabId, active, frameWidth, box, controller, onController, onPageSize } = props;
  const controllerChanged = useEffectEvent((next: PreviewStreamControl["controller"] | null) =>
    onController(next),
  );
  const viewportChanged = useEffectEvent((next: FloatingPreviewSize) => onPageSize(next));
  const environmentId = threadRef.environmentId;
  const access = usePreviewStreamAccess(environmentId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The painted frame's own pixel size; the canvas is drawn at its shape.
  const [frameSize, setFrameSize] = useState<FloatingPreviewSize | null>(null);
  const refusalsRef = useRef(0);
  const [viewport, setViewport] = useState<FloatingPreviewSize | null>(null);
  const [cursor, setCursor] = useState<ThumbnailCursor | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !access || !canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const painter = createPreviewFramePainter(canvas, () => {
      const next = { width: canvas.width, height: canvas.height };
      setFrameSize((current) => (sameSize(current, next) ? current : next));
    });
    const client = createPreviewStreamClient(
      {
        access,
        threadId: threadRef.threadId,
        tabId,
        maxWidth: frameWidth * ratio,
        // Width-bound for every page shape the card takes; a taller page is height-bound.
        maxHeight: (frameWidth / FLOATING_PREVIEW_MIN_PAGE_ASPECT) * ratio,
        interactive: false,
        minFrameIntervalMs: FLOATING_PREVIEW_STREAM_FRAME_INTERVAL_MS,
        quality: STREAM_JPEG_QUALITY,
      },
      {
        onFrame: (jpeg) => {
          refusalsRef.current = 0;
          painter.paint(jpeg);
        },
        onViewport: (next) => {
          const size = { width: next.width, height: next.height };
          setViewport((current) => (sameSize(current, size) ? current : size));
          viewportChanged(size);
        },
        onPointer: (pointer) => setCursor({ ...pointer }),
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
  const drawn = floatingPreviewPageFrame(frameSize, box);
  // The pointer arrives in viewport CSS px; the frame has the viewport's shape.
  const pointerFrame = floatingPreviewPageFrame(viewport, box);
  const placed =
    cursor && pointerFrame ? placeAgentTarget(cursor, cursorFrame(pointerFrame)) : null;
  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn(
          "absolute block transition-opacity duration-(--motion-duration-base) ease-out",
          drawn ? "opacity-100" : "opacity-0",
        )}
        style={
          drawn
            ? { left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height }
            : { left: 0, top: 0, width: box.width, height: box.height }
        }
      />
      {cursor && placed && drawn ? (
        <AgentCursorMark
          phase={cursor.phase}
          sequence={cursor.sequence}
          left={placed.left}
          top={placed.top}
          outline={placed.outline}
          controller={controller}
          compact
        />
      ) : null}
    </>
  );
}

/**
 * A desktop tab's agent cursor over its thumbnail. The pointer maps onto the
 * panel surface the page draws into, and that surface onto the page area the
 * way the captured image fits it.
 */
function DesktopThumbnailCursor(props: {
  readonly runtimeTabId: string;
  readonly zoomFactor: number;
  readonly surface: FloatingPreviewSize;
  readonly box: FloatingPreviewSize;
  readonly controller: BrowserController;
}) {
  const { runtimeTabId, zoomFactor, surface, box, controller } = props;
  const event = useBrowserPointerStore((state) => state.byTabId[runtimeTabId] ?? null);
  const content = useBrowserSurfaceStore((state) => state.byTabId[runtimeTabId]?.content ?? null);
  const toBox = floatingPreviewPageFrame(surface, box);
  if (!event || !toBox) return null;
  const placed = placeAgentTarget(
    event,
    composeFrames(desktopSurfaceFrame(content, zoomFactor), cursorFrame(toBox)),
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
 * captured leaves the placeholder. Each capture is drawn at its own shape,
 * fitted whole into the page area.
 */
function DesktopThumbnail(props: {
  readonly runtimeTabId: string;
  readonly active: boolean;
  /** CSS px of page width to capture at. */
  readonly frameWidth: number;
  /** The page area the capture fits into. */
  readonly box: FloatingPreviewSize;
  readonly zoomFactor: number;
  readonly controller: BrowserController;
  /** The webview's laid-out size, whenever a capture lands. */
  readonly onPageSize: (size: FloatingPreviewSize) => void;
}) {
  const { runtimeTabId, active, frameWidth, box, zoomFactor, controller, onPageSize } = props;
  const surfaceChanged = useEffectEvent((next: FloatingPreviewSize) => onPageSize(next));
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
            setSurface((current) => (sameSize(current, next) ? current : next));
            surfaceChanged(next);
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
  // The capture's own pixel size, read as each one loads, so it is never drawn
  // at the shape of an earlier one.
  const [imageSize, setImageSize] = useState<FloatingPreviewSize | null>(null);
  const drawn = floatingPreviewPageFrame(imageSize, box);
  // Later captures swap in place; only the first one fades over the placeholder.
  return source ? (
    <>
      <img
        src={source}
        alt=""
        aria-hidden
        draggable={false}
        onLoad={(event) => {
          const next = {
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          };
          setImageSize((current) => (sameSize(current, next) ? current : next));
        }}
        className={cn(
          "absolute block max-w-none transition-opacity duration-(--motion-duration-base) ease-out",
          drawn ? "opacity-100" : "opacity-0",
        )}
        style={
          drawn
            ? { left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height }
            : { left: 0, top: 0, width: box.width, height: box.height }
        }
      />
      {drawn && surface ? (
        <DesktopThumbnailCursor
          runtimeTabId={runtimeTabId}
          zoomFactor={zoomFactor}
          surface={surface}
          box={box}
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
