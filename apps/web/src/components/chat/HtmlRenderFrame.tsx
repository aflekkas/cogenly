import { OverlayPresence } from "~/components/ui/overlay-presence";
import type { EnvironmentId, ScopedThreadRef } from "@cogenly/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderOutlineBoxes,
  type HtmlRenderOutlineBox,
  type HtmlRenderReference,
} from "@cogenly/shared/htmlRender";
import { CircleAlertIcon, Maximize2Icon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { HtmlRenderSubmittedBadge } from "./HtmlRenderSubmittedBadge";
import { useHtmlRenderVisualState } from "./useHtmlRenderVisualBridge";
import { observeResize } from "~/lib/observeResize";

// A frame may load its URL a little after mounting.
const MIN_URL_LIFE_MS = 5 * 60_000;

/**
 * The height each page last reported, at the width it reported it. A frame
 * that mounts again (reopening a thread, scrolling a virtualized row back in)
 * starts at that height and without the loading skeleton, so its row does not
 * resize and the page does not fade in a second time.
 */
const reportedPageHeights = new Map<string, { readonly width: number; readonly height: number }>();
const MAX_REPORTED_PAGE_HEIGHTS = 500;

function rememberPageHeight(attachmentId: string, width: number, height: number) {
  reportedPageHeights.delete(attachmentId);
  reportedPageHeights.set(attachmentId, { width, height });
  if (reportedPageHeights.size > MAX_REPORTED_PAGE_HEIGHTS) {
    const oldest = reportedPageHeights.keys().next();
    if (!oldest.done) reportedPageHeights.delete(oldest.value);
  }
}

/**
 * An agent's HTML render inline in the thread: the page itself on the thread's
 * own background, at the server's measured height for this width until the
 * page reports its own. Loading holds that box so nothing below it moves; a
 * page that fails to load collapses to a one-line error.
 */
export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onFullscreenChange?: (fullscreen: boolean) => void;
}) {
  const { attachmentId, title } = props.htmlRender;
  const submitted = useHtmlRenderVisualState(props.threadRef, attachmentId)?.locked === true;
  // The frame takes the page's measured height at its own width, read before
  // first paint so the reserved box is already the right size.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  // Client fonts can wrap a page taller than the server measured it; a frame
  // left short would scroll inside the thread and take the reader's scroll.
  const [contentHeight, setContentHeight] = useState<number>();
  // A page shown before keeps its last height and skips the skeleton.
  const [shownBefore] = useState(() => reportedPageHeights.has(attachmentId));
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    // Read before first paint, at the width the page reported it.
    const reported = reportedPageHeights.get(attachmentId);
    if (reported !== undefined && Math.abs(reported.width - box.clientWidth) < 1) {
      setContentHeight(reported.height);
    }
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The row is keyed by attachment.
  }, []);
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const fileName = htmlRenderFileName(title);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  // A cached URL with life left is reused, so the browser's cache serves the
  // page again; one near expiry is minted afresh, since a frame cannot report a
  // failed load. The page keeps its first URL for its lifetime.
  const [src, setSrc] = useState<string | null>(null);
  // Full screen reuses the inline URL while it has life left, so the page
  // comes from the browser's cache instead of a new mint and download.
  const srcExpiresAt = useRef(0);
  const [expandedSrc, setExpandedSrc] = useState<string | null>(null);
  // The page stays hidden behind a skeleton until it reports its content.
  const [ready, setReady] = useState(shownBefore);
  const showPage = useCallback(() => setReady(true), []);
  const fitPage = useCallback(
    (contentHeight: number) => {
      const width = boxRef.current?.clientWidth;
      if (width !== undefined) rememberPageHeight(attachmentId, width, contentHeight);
      setContentHeight(contentHeight);
      setReady(true);
    },
    [attachmentId],
  );
  const { onFullscreenChange } = props;
  useEffect(() => {
    if (expandedSrc === null) return;
    onFullscreenChange?.(true);
    return () => onFullscreenChange?.(false);
  }, [expandedSrc, onFullscreenChange]);
  const [failed, setFailed] = useState(false);
  const assetUrl = useAssetUrlState(src === null ? props.environmentId : null, resource);
  const cachedUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  const cachedExpiresAt = assetUrl._tag === "Success" ? assetUrl.expiresAt : 0;
  const cacheFailed = assetUrl._tag === "Failure";
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  // At most one mint per mount: expiry is server time and the check uses the
  // client clock, so a skewed clock must not mint again on every update.
  const minting = useRef(false);
  useEffect(() => {
    if (src !== null || minting.current) return;
    if (cacheFailed) {
      // oxlint-disable-next-line react/set-state-in-effect -- Mirrors the cached URL's failure.
      setFailed(true);
      return;
    }
    if (cachedUrl === null) return;
    if (cachedExpiresAt - Date.now() > MIN_URL_LIFE_MS) {
      srcExpiresAt.current = cachedExpiresAt;
      setSrc(cachedUrl);
      return;
    }
    minting.current = true;
    void refresh().then(
      (url) => (url === null ? setFailed(true) : setSrc(url)),
      () => setFailed(true),
    );
  }, [cacheFailed, cachedExpiresAt, cachedUrl, refresh, src]);

  // A page that never loaded gives back its reserved box: an empty frame the
  // page's height would leave a blank gap with its message out of view.
  if (failed && src === null) {
    return (
      <p
        role="status"
        className="flex min-w-0 items-center gap-1.5 py-1 text-xs text-muted-foreground swap-motion"
      >
        <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">Unable to load {title}</span>
      </p>
    );
  }

  return (
    // The frame's chrome sits in a slim row above the page, never over it: a
    // page's own controls often live in its top corner.
    <div className="group/html-render">
      <div className="flex h-7 items-center justify-end gap-1.5">
        {submitted ? <HtmlRenderSubmittedBadge /> : null}
        {src !== null ? (
          <div className="flex opacity-0 transition-opacity duration-(--motion-duration-fast) ease-standard focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open full screen"
                    size="icon-xs"
                    variant="outline"
                    onClick={async () => {
                      const url =
                        srcExpiresAt.current - Date.now() > MIN_URL_LIFE_MS
                          ? src
                          : await refresh().catch(() => null);
                      if (url !== null) setExpandedSrc(url);
                      else
                        toastManager.add({
                          type: "error",
                          title: "Page unavailable",
                          description: "Reconnect to the machine and try again.",
                        });
                    }}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open full screen</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
      </div>
      <div ref={boxRef} className="relative" style={{ height }}>
        {!ready && !failed ? (
          <HtmlRenderSkeleton
            title={title}
            height={height}
            outline={htmlRenderOutlineBoxes(props.htmlRender, width)}
          />
        ) : null}
        {src !== null ? (
          <HtmlRenderDocument
            src={src}
            title={title}
            threadRef={props.threadRef}
            renderId={attachmentId}
            className={cn(
              "block size-full motion-safe:transition-opacity motion-safe:duration-200",
              !ready && "opacity-0",
            )}
            onContentHeight={fitPage}
            onLoad={showPage}
            onFullscreenChange={onFullscreenChange}
          />
        ) : null}
      </div>
      <OverlayPresence when={expandedSrc}>
        {(expandedSrc) => (
          <HtmlRenderDialog
            src={expandedSrc}
            title={title}
            threadRef={props.threadRef}
            renderId={attachmentId}
            submitted={submitted}
            onClose={() => setExpandedSrc(null)}
          />
        )}
      </OverlayPresence>
    </div>
  );
}

// Without an outline: one heading, a line of text, and a chart-sized block,
// the shape most pages take, repeated to fill the frame's reserved height.
const SKELETON_SECTION_HEIGHT = 264;

const OUTLINE_BOX_CLASS = {
  media: "rounded-lg bg-muted-foreground/15",
  text: "",
  table: "",
} as const;

const OUTLINE_BAR = "color-mix(in srgb, var(--color-muted-foreground) 15%, transparent)";

// Text lines and table rows are bars painted by one gradient per box, so a
// long page costs one element per block rather than one per line.
function outlineBoxStyle(box: HtmlRenderOutlineBox): React.CSSProperties {
  const style: React.CSSProperties = {
    left: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
  };
  if (box.kind !== "text" && box.kind !== "table") return style;
  const step = box.height / box.lines;
  const bar = Math.min(box.kind === "table" ? 12 : 10, step * 0.6);
  const start = (step - bar) / 2;
  return {
    ...style,
    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${start}px, ${OUTLINE_BAR} ${start}px ${start + bar}px, transparent ${start + bar}px ${step}px)`,
  };
}

/**
 * Holds the frame's place while the page loads: the page's own blocks when the
 * server measured an outline, else a generic page shape. The outline pulses
 * as one layer.
 */
function HtmlRenderSkeleton(props: {
  readonly title: string;
  readonly height: number;
  readonly outline: ReadonlyArray<HtmlRenderOutlineBox>;
}) {
  if (props.outline.length > 0) {
    return (
      <div
        role="status"
        aria-label={`Loading ${props.title}`}
        className="pointer-events-none absolute inset-0 overflow-hidden motion-safe:animate-skeleton"
      >
        {props.outline.map((box) => (
          <div
            key={`${box.kind}:${box.x}:${box.y}:${box.width}:${box.height}`}
            className={cn("absolute", OUTLINE_BOX_CLASS[box.kind])}
            style={outlineBoxStyle(box)}
          />
        ))}
      </div>
    );
  }
  const sections = Math.ceil(props.height / SKELETON_SECTION_HEIGHT);
  return (
    <div
      role="status"
      aria-label={`Loading ${props.title}`}
      className="pointer-events-none absolute inset-0 flex flex-col gap-6 overflow-hidden pt-1"
    >
      {Array.from({ length: sections }, (_, index) => (
        <div key={index} className="flex shrink-0 flex-col gap-2">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton shape="card" className="mt-2 h-40 w-full" />
        </div>
      ))}
    </div>
  );
}
