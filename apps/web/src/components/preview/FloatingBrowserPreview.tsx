"use client";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamViewport,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Bot, Globe2, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

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
  clampFloatingPreviewToArea,
  type FloatingPreviewArea,
  type FloatingPreviewCorner,
  FLOATING_PREVIEW_CAPTURE_INTERVAL_MS,
  FLOATING_PREVIEW_CARD_HEIGHT,
  FLOATING_PREVIEW_CARD_WIDTH,
  FLOATING_PREVIEW_DRAG_SLOP_PX,
  FLOATING_PREVIEW_MIN_PANE_WIDTH,
  FLOATING_PREVIEW_STREAM_FRAME_INTERVAL_MS,
  floatingPreviewCornerPosition,
  floatingPreviewTitle,
  type FloatingPreviewPoint,
  type FloatingPreviewSize,
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

const CARD_SIZE: FloatingPreviewSize = {
  width: FLOATING_PREVIEW_CARD_WIDTH,
  height: FLOATING_PREVIEW_CARD_HEIGHT,
};
/** The chat header overlays the pane's top edge. */
const PANE_TOP_INSET = 48;
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
 * A small card over the chat for this thread's browser tab the panel showed
 * last, once the panel no longer shows it: closed or switched to another
 * surface. It mirrors the page with a throttled thumbnail;
 * clicking it reopens the panel on that tab, and the x dismisses it until the
 * tab is looked at again. Mounted once per chat pane.
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
  const corner = useFloatingBrowserPreviewStore((state) => state.corner);
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

  const shown = shouldShowFloatingPreview({
    targetKey: key,
    shownKeys: new Set(Object.keys(shownCounts)),
    dismissedKey,
    sessionsLoaded: previewState.listLoaded,
    navStatus: snapshot?.navStatus ?? null,
    thumbnailAvailable: thumbnailSource !== null,
    poppedOut: desktopOverlay?.pictureInPicture === true,
    paneFits: (pane?.width ?? 0) >= FLOATING_PREVIEW_MIN_PANE_WIDTH,
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
  const cornerPosition = (target: FloatingPreviewCorner): FloatingPreviewPoint | null => {
    if (!pane) return null;
    const inPane = floatingPreviewCornerPosition(target, pane, CARD_SIZE, {
      top: PANE_TOP_INSET,
      bottom: bottomInset,
      right: minimapInset,
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
    ? clampFloatingPreviewToArea(freePosition, windowArea, CARD_SIZE)
    : cornerPosition(corner);
  const position = drag ?? docked;

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
      if (event.button !== 0 || !event.isPrimary) return;
      if ((event.target as Element).closest("[data-floating-preview-close]")) return;
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
          CARD_SIZE,
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
        CARD_SIZE,
      );
      const corners = Object.fromEntries(
        FLOATING_PREVIEW_CORNERS.map((name) => [name, cornerPosition(name) ?? dropped]),
      ) as Record<FloatingPreviewCorner, FloatingPreviewPoint>;
      const resolved = resolveFloatingPreviewDrop(dropped, corners);
      const store = useFloatingBrowserPreviewStore.getState();
      if (resolved.kind === "corner") store.setCorner(resolved.corner);
      else store.setFreePosition(resolved.position);
    }
    setDrag(null);
  };

  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const agentDriving = snapshot?.agentDriving === true || desktopOverlay?.controller === "agent";
  const favicon = desktopOverlay?.favicon ?? null;
  const capturedFavicon = favicon && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
  const title = floatingPreviewTitle(navStatus);

  const card = position ? (
    <section
      aria-label={`Browser preview: ${title}`}
      aria-hidden={shown ? undefined : true}
      inert={!shown}
      data-floating-browser-preview={shown ? "shown" : "hidden"}
      className={cn(
        "group/floating-preview absolute top-0 left-0 touch-none overflow-hidden rounded-xl border border-border/70 bg-muted shadow-xl",
        "transition-opacity duration-(--motion-duration-base) ease-out",
        // The card glides to its corner after a drop; it follows the pointer while dragged.
        drag === null && "motion-safe:transition-[opacity,transform]",
        opaque ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
      style={{
        width: CARD_SIZE.width,
        height: CARD_SIZE.height,
        transform: `translate3d(${Math.round(position.x)}px, ${Math.round(position.y)}px, 0)`,
      }}
      onPointerDown={handlePointer}
      onPointerMove={handlePointer}
      onPointerUp={handlePointer}
      onPointerCancel={handlePointer}
    >
      {/* The page fills the card; its title sits on a soft scrim along the bottom. */}
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
            controller={agentDriving ? "agent" : "none"}
          />
        ) : thumbnailSource === "desktop" ? (
          <DesktopThumbnail
            runtimeTabId={runtimeTabId}
            active={shown}
            zoomFactor={desktopOverlay?.zoomFactor ?? 1}
            controller={agentDriving ? "agent" : "none"}
          />
        ) : null}
        <span className="absolute inset-x-0 bottom-0 flex h-9 min-w-0 items-end gap-1.5 bg-linear-to-t from-black/70 to-transparent px-2.5 pb-2 text-white">
          <FaviconImage
            sources={[capturedFavicon, faviconUrlForOrigin(url, 32)]}
            fallback={<Globe2 aria-hidden className="size-3.5 shrink-0 opacity-80" />}
            className="size-3.5 shrink-0 rounded-sm object-contain"
          />
          <span className="min-w-0 flex-1 truncate text-xs leading-3.5 font-medium">{title}</span>
          {agentDriving ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/15 px-1.5 text-2xs leading-3.5 backdrop-blur-sm">
              <Bot aria-hidden className="size-2.5" />
              Agent
            </span>
          ) : null}
        </span>
      </button>
      {/* Shown on hover or keyboard focus, so the page reads clean at rest. */}
      <button
        type="button"
        data-floating-preview-close=""
        aria-label="Close browser preview"
        onClick={() => useFloatingBrowserPreviewStore.getState().dismiss(key)}
        className="absolute top-1.5 right-1.5 flex size-6 cursor-pointer items-center justify-center rounded-md bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity duration-(--motion-duration-fast) ease-out outline-none group-hover/floating-preview:opacity-100 hover:bg-black/75 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <X aria-hidden className="size-3.5" />
      </button>
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
 * A streamed server tab, watched passively at a thumbnail's size and paced to
 * one frame a second. Connected only while the card shows.
 */
function StreamThumbnail(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly active: boolean;
  readonly controller: BrowserController;
}) {
  const { threadRef, tabId, active, controller } = props;
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
        maxWidth: FLOATING_PREVIEW_CARD_WIDTH * ratio,
        maxHeight: FLOATING_PREVIEW_CARD_HEIGHT * ratio * 2,
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
        onConnectedChange: () => {},
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
    };
  }, [access, active, environmentId, tabId, threadRef.threadId]);
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
  readonly zoomFactor: number;
  readonly controller: BrowserController;
}) {
  const { runtimeTabId, active, zoomFactor, controller } = props;
  const [source, setSource] = useState<string | null>(null);
  // The webview's own size: what the captured image shows, so the cursor maps through it.
  const [surface, setSurface] = useState<FloatingPreviewSize | null>(null);
  useEffect(() => {
    if (!active) return;
    const releaseActivity = acquireBrowserSurfaceActivity(runtimeTabId);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const width = Math.round(FLOATING_PREVIEW_CARD_WIDTH * (window.devicePixelRatio || 1));
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
  }, [active, runtimeTabId]);
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
          card={CARD_SIZE}
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
