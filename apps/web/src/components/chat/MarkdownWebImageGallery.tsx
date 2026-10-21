import {
  createContext,
  use,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import { cn } from "../../lib/utils";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";
import { inlineImageAspectRatio, resolveInlineImageSource } from "./markdownInlineImages";

const IMAGE_PROXY_PATH = "/api/image-proxy";

/**
 * Whether the server's image proxy has answered this session. Unknown until a
 * proxied image loads or fails; once a direct retry succeeds where the proxy
 * failed, later images skip it.
 */
let imageProxyState: "unknown" | "available" | "missing" = "unknown";

function imageProxyBase(): { readonly proxyUrl: string | null; readonly origins: string[] } {
  const origins = typeof window === "undefined" ? [] : [window.location.origin];
  try {
    const proxyUrl = resolvePrimaryEnvironmentHttpUrl(IMAGE_PROXY_PATH);
    origins.push(new URL(proxyUrl).origin);
    return { proxyUrl: imageProxyState === "missing" ? null : proxyUrl, origins };
  } catch {
    return { proxyUrl: null, origins };
  }
}

function recordImageProxyResult(input: { proxied: boolean; retried: boolean }) {
  if (input.proxied) imageProxyState = "available";
  else if (input.retried && imageProxyState === "unknown") imageProxyState = "missing";
}

function inlineImageCandidates(src: string) {
  const { proxyUrl, origins } = imageProxyBase();
  return resolveInlineImageSource(src, {
    firstPartyOrigins: origins,
    proxyUrl: proxyUrl
      ? (url) => {
          const proxied = new URL(proxyUrl);
          proxied.searchParams.set("url", url);
          return proxied.toString();
        }
      : undefined,
  });
}

const GalleryCountContext = createContext(0);

// Even columns that wrap on narrow widths: a pair stays a pair, larger sets drop to two.
function galleryColumnsClassName(count: number): string {
  if (count === 2) return "grid-cols-2";
  if (count === 3) return "grid-cols-2 @md:grid-cols-3";
  if (count === 4) return "grid-cols-2 @xl:grid-cols-4";
  return "grid-cols-2 @md:grid-cols-3 @2xl:grid-cols-4";
}

/** A row of web images from one run of image-only markdown paragraphs. */
export function MarkdownImageGalleryRow(props: { count: number; children: ReactNode }) {
  const count = Math.max(1, props.count);
  return (
    <div data-markdown-gallery className="@container my-3">
      <div
        className={cn(
          count === 1 ? "flex flex-col" : cn("grid gap-2", galleryColumnsClassName(count)),
        )}
      >
        <GalleryCountContext value={count}>{props.children}</GalleryCountContext>
      </div>
    </div>
  );
}

/** One gallery image with its caption (the alt text) and optional source link. */
export function MarkdownGalleryFigure(props: {
  caption: string;
  media: ReactNode;
  /** The link crediting the image, or null. */
  source: ReactNode;
}) {
  const single = use(GalleryCountContext) === 1;
  const hasCaption = props.caption.length > 0 || props.source !== null;
  return (
    <figure className={cn("flex min-w-0 flex-col gap-1.5", single && "w-full max-w-120")}>
      {props.media}
      {hasCaption ? (
        <figcaption className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-snug text-muted-foreground">
          {props.caption ? (
            // Copy-as-markdown already carries the alt text in the image itself.
            <span data-markdown-copy="" className="min-w-0">
              {props.caption}
            </span>
          ) : null}
          {props.source}
        </figcaption>
      ) : null}
    </figure>
  );
}

function expandProps(
  onImageExpand: ((preview: ExpandedImagePreview) => void) | undefined,
  name: string,
) {
  if (!onImageExpand) return {};
  const expand = (event: ReactMouseEvent | ReactKeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const item = markdownImageItems.get(event.currentTarget);
    if (item) onImageExpand(markdownImageGallery(event.currentTarget, item));
  };
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Preview ${name}`,
    onClick: expand,
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") expand(event);
    },
  };
}

const MEDIA_MOTION_CLASS_NAME = "duration-(--motion-duration-base) ease-out";

/**
 * A web image in a gallery row. Its slot holds the authored aspect ratio (else
 * 4:3) as a quiet skeleton until the bytes decode, then the image fades in.
 * Thumbnails keep that box and crop; a lone image eases to its natural ratio.
 * A failure tries the next source (the proxy, then direct) and, once none is
 * left, folds the slot away so only the caption and source link remain.
 */
export function MarkdownGalleryImage(props: {
  src: string;
  alt: string;
  width?: unknown;
  height?: unknown;
  copyMarkdown: string;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const single = use(GalleryCountContext) <= 1;
  const [source] = useState(() => inlineImageCandidates(props.src));
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    ratio: number;
    width: number;
    instant: boolean;
  } | null>(null);
  const candidates = source?.kind === "remote" ? source.candidates : [];
  const current = candidates[attempt] ?? null;
  const failed = current === null;
  const name = props.alt.trim() || "image";
  const originalUrl = source?.url ?? props.src;
  const reference = mediaUrlReference(originalUrl);
  const actionsSource: MediaActionSource = {
    kind: "image",
    name,
    src: current,
    ...(reference ? { reference } : {}),
  };
  const proxied = candidates.length > 1 && attempt === 0;

  const settle = (image: HTMLImageElement, instant: boolean) => {
    recordImageProxyResult({ proxied, retried: attempt > 0 });
    const ratio =
      image.naturalWidth > 0 && image.naturalHeight > 0
        ? image.naturalWidth / image.naturalHeight
        : inlineImageAspectRatio(props.width, props.height);
    setLoaded({ ratio, width: image.naturalWidth, instant });
  };
  // Runs on every render: the gallery registry follows the current source, and a cached image
  // is complete before `onLoad` can fire, so it shows without a fade.
  const registerImage = (image: HTMLImageElement | null) => {
    if (!image) return;
    markdownImageItems.set(image, { src: current, name, actionsSource, originalUrl });
    if (loaded === null && image.complete && image.naturalWidth > 0) settle(image, true);
  };

  const ratio = single && loaded ? loaded.ratio : inlineImageAspectRatio(props.width, props.height);
  const knownWidth = loaded?.width || Number(props.width);
  // A tall lone image is capped by height and a small one by its own width; the box follows.
  const slotStyle: CSSProperties = {
    aspectRatio: String(ratio),
    ...(single
      ? {
          maxWidth: `min(100%, ${30 * ratio}rem${
            Number.isFinite(knownWidth) && knownWidth > 0 ? `, ${knownWidth}px` : ""
          })`,
        }
      : {}),
  };

  return (
    <div
      aria-hidden={failed || undefined}
      inert={failed}
      className={cn(
        "grid transition-[grid-template-rows,opacity] motion-reduce:transition-opacity",
        MEDIA_MOTION_CLASS_NAME,
        failed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          style={slotStyle}
          className={cn(
            "relative w-full overflow-hidden rounded-xl border border-border/50 bg-muted/60",
            single &&
              !loaded?.instant &&
              cn(
                "transition-[aspect-ratio,max-width] motion-reduce:transition-none",
                MEDIA_MOTION_CLASS_NAME,
              ),
          )}
          {...(loaded || failed ? {} : { role: "status", "aria-label": "Loading image" })}
        >
          {current !== null ? (
            <MediaActions source={actionsSource}>
              <img
                key={current}
                ref={registerImage}
                src={current}
                alt={props.alt}
                data-markdown-copy={props.copyMarkdown}
                referrerPolicy="no-referrer"
                loading="lazy"
                decoding="async"
                draggable={false}
                className={cn(
                  "absolute inset-0 size-full object-cover",
                  !loaded?.instant && cn("transition-opacity", MEDIA_MOTION_CLASS_NAME),
                  single && "object-contain",
                  loaded ? "opacity-100" : "opacity-0",
                  props.onImageExpand && "cursor-zoom-in",
                )}
                {...expandProps(props.onImageExpand, name)}
                onLoad={(event) => {
                  if (loaded === null) settle(event.currentTarget, false);
                }}
                onError={() => {
                  setLoaded(null);
                  setAttempt((value) => value + 1);
                }}
              />
            </MediaActions>
          ) : null}
        </div>
      </div>
    </div>
  );
}
