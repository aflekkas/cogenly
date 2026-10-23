"use client";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
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

import { acquireBrowserSurfaceActivity } from "~/browser/browserSurfaceStore";
import { usePreviewAvailable, useRendersServerTabNatively } from "~/browser/previewRuntime";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { faviconUrlForOrigin } from "~/lib/favicon";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { refreshPreviewStreamAccess, usePreviewStreamAccess } from "~/state/previewStream";
import { useEnvironmentScope } from "~/state/session";
import { buildThreadRouteParams } from "~/threadRoutes";

import {
  clampFloatingPreviewPosition,
  FLOATING_PREVIEW_CAPTURE_INTERVAL_MS,
  FLOATING_PREVIEW_CARD_HEIGHT,
  FLOATING_PREVIEW_CARD_WIDTH,
  FLOATING_PREVIEW_DRAG_SLOP_PX,
  FLOATING_PREVIEW_MIN_PANE_WIDTH,
  FLOATING_PREVIEW_STREAM_FRAME_INTERVAL_MS,
  FLOATING_PREVIEW_THUMBNAIL_HEIGHT,
  floatingPreviewCornerPosition,
  floatingPreviewSubtitle,
  floatingPreviewTitle,
  type FloatingPreviewPoint,
  type FloatingPreviewSize,
  nearestFloatingPreviewCorner,
  shouldShowFloatingPreview,
} from "./floatingBrowserPreview.logic";
import {
  type FloatingPreviewTarget,
  useFloatingBrowserPreviewStore,
} from "./floatingBrowserPreviewStore";
import { FaviconImage } from "./PreviewFaviconIcon";
import { previewBridge } from "./previewBridge";
import { usePreviewSession } from "./usePreviewSession";

const CARD_SIZE: FloatingPreviewSize = {
  width: FLOATING_PREVIEW_CARD_WIDTH,
  height: FLOATING_PREVIEW_CARD_HEIGHT,
};
/** The chat header overlays the pane's top edge. */
const PANE_TOP_INSET = 48;
const STREAM_JPEG_QUALITY = 60;
const MAX_STREAM_REFUSALS = 2;

/**
 * A small card over the chat for the browser tab the panel showed last, once
 * the panel no longer shows it: closed, switched to another surface, or left
 * behind on another thread. It mirrors the page with a throttled thumbnail;
 * clicking it reopens the panel on that tab, and the x dismisses it until the
 * tab is looked at again. Mounted once per chat pane.
 */
export function FloatingBrowserPreview(props: {
  readonly activeThreadRef: ScopedThreadRef | null;
  /** The docked composer; bottom corners sit above it. Null when nothing is docked. */
  readonly composerElement: HTMLElement | null;
}) {
  const target = useFloatingBrowserPreviewStore((state) => state.target);
  if (!target) return null;
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

  const paneRef = useRef<HTMLDivElement | null>(null);
  const [pane, setPane] = useState<FloatingPreviewSize | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  useLayoutEffect(() => {
    const element = paneRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setPane((current) =>
        current?.width === width && current.height === height ? current : { width, height },
      );
    };
    measure();
    return observeResize(element, measure);
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
  const docked = pane
    ? floatingPreviewCornerPosition(corner, pane, CARD_SIZE, {
        top: PANE_TOP_INSET,
        bottom: bottomInset,
      })
    : null;
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
        clampFloatingPreviewPosition(
          { x: current.origin.x + dx, y: current.origin.y + dy },
          pane,
          CARD_SIZE,
        ),
      );
      return;
    }
    dragRef.current = null;
    if (!current.moved) return;
    // A drop snaps to the nearest corner; a cancelled drag returns to where it was.
    if (event.type === "pointerup") {
      const dropped = clampFloatingPreviewPosition(
        { x: current.origin.x + dx, y: current.origin.y + dy },
        pane,
        CARD_SIZE,
      );
      useFloatingBrowserPreviewStore
        .getState()
        .setCorner(nearestFloatingPreviewCorner(dropped, pane, CARD_SIZE));
    }
    setDrag(null);
  };

  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const agentDriving = snapshot?.agentDriving === true || desktopOverlay?.controller === "agent";
  const favicon = desktopOverlay?.favicon ?? null;
  const capturedFavicon = favicon && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
  const title = floatingPreviewTitle(navStatus);

  return (
    <div ref={paneRef} className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {position ? (
        <section
          aria-label={`Browser preview: ${title}`}
          aria-hidden={shown ? undefined : true}
          inert={!shown}
          data-floating-browser-preview={shown ? "shown" : "hidden"}
          className={cn(
            "absolute top-0 left-0 flex touch-none flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg",
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
          <button
            type="button"
            className="flex min-h-0 flex-1 cursor-pointer flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={openInPanel}
            aria-label={`Open ${title} in the browser panel`}
          >
            <span
              className="relative block shrink-0 overflow-hidden border-b border-border bg-muted"
              style={{ height: FLOATING_PREVIEW_THUMBNAIL_HEIGHT }}
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
                <StreamThumbnail threadRef={threadRef} tabId={tabId} active={shown} />
              ) : thumbnailSource === "desktop" ? (
                <DesktopThumbnail runtimeTabId={runtimeTabId} active={shown} />
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2 pr-9 pl-2.5">
              <FaviconImage
                sources={[capturedFavicon, faviconUrlForOrigin(url, 32)]}
                fallback={
                  <Globe2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                }
                className="size-3.5 shrink-0 rounded-sm object-contain"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs font-medium text-foreground">{title}</span>
                <span className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
                  {agentDriving ? <Bot aria-hidden className="size-3 shrink-0" /> : null}
                  <span className="truncate">{floatingPreviewSubtitle({ url, agentDriving })}</span>
                </span>
              </span>
            </span>
          </button>
          <div data-floating-preview-close="" className="absolute right-1.5 bottom-2">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close browser preview"
              onClick={() => useFloatingBrowserPreviewStore.getState().dismiss(key)}
            >
              <X />
            </Button>
          </div>
        </section>
      ) : null}
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
}) {
  const { threadRef, tabId, active } = props;
  const environmentId = threadRef.environmentId;
  const access = usePreviewStreamAccess(environmentId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [painted, setPainted] = useState(false);
  const refusalsRef = useRef(0);
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
        maxHeight: FLOATING_PREVIEW_THUMBNAIL_HEIGHT * ratio * 2,
        interactive: false,
        minFrameIntervalMs: FLOATING_PREVIEW_STREAM_FRAME_INTERVAL_MS,
        quality: STREAM_JPEG_QUALITY,
      },
      {
        onFrame: (jpeg) => {
          refusalsRef.current = 0;
          painter.paint(jpeg);
        },
        onViewport: () => {},
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
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn(
        "absolute inset-0 block size-full object-cover object-top transition-opacity duration-(--motion-duration-base) ease-out",
        painted ? "opacity-100" : "opacity-0",
      )}
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
function DesktopThumbnail(props: { readonly runtimeTabId: string; readonly active: boolean }) {
  const { runtimeTabId, active } = props;
  const [source, setSource] = useState<string | null>(null);
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
        if (dataUrl && dataUrl.length > "data:image/png;base64,".length) setSource(dataUrl);
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
  ) : null;
}

function sameOrigin(left: string, right: string): boolean {
  if (!URL.canParse(left) || !URL.canParse(right)) return false;
  return new URL(left).origin === new URL(right).origin;
}
