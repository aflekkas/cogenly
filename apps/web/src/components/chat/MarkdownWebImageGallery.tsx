import {
  createContext,
  use,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ImageOffIcon } from "lucide-react";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { markdownImageGallery, markdownImageItems } from "./markdownImageGallery";
import {
  IMAGE_PROXY_PATH,
  inlineImageAspectRatio,
  remoteImageAssetResource,
  resolveInlineImageSource,
  resolveRemoteImageSrc,
  type InlineImageSource,
} from "./markdownInlineImages";

/** A signed URL this close to lapsing is treated as lapsed when its image fails to load. */
const SIGNED_URL_EXPIRY_MARGIN_MS = 60_000;

/**
 * Where a web image in assistant markdown loads from: third-party https
 * images through the image proxy, the app's own origins directly. A proxied
 * image's `src` is only the fallback for a server that cannot sign it; current
 * servers hand out a signed `remote-image` asset URL instead (see
 * `remoteImageAssetResource`). `url` stays the authored URL for "open source" links.
 */
export function inlineWebImageSource(src: string): InlineImageSource | null {
  const origins = typeof window === "undefined" ? [] : [window.location.origin];
  let proxyEndpoint: string | null = null;
  try {
    proxyEndpoint = resolvePrimaryEnvironmentHttpUrl(IMAGE_PROXY_PATH);
    origins.push(new URL(proxyEndpoint).origin);
  } catch {
    // No primary environment (desktop with its local environment disabled): load directly.
  }
  return resolveInlineImageSource(src, { proxyEndpoint, firstPartyOrigins: origins });
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

/**
 * One block image from a figure paragraph (see `groupInlineImageGalleries`) with its caption
 * beneath: the alt text as a label when the authored caption does not name the image, then the
 * authored title, credit text, and source links, whose favicons come from the link renderer.
 */
export function MarkdownFigure(props: {
  /** The alt text to label the caption with, or empty. */
  label: string;
  media: ReactNode;
  /** The authored caption, already rendered. */
  caption: ReactNode[];
}) {
  const single = use(GalleryCountContext) === 1;
  const hasLabel = props.label.length > 0;
  const hasCaption = props.caption.length > 0;
  return (
    <figure className={cn("flex min-w-0 flex-col gap-1.5", single && "w-full max-w-120")}>
      {props.media}
      {hasLabel || hasCaption ? (
        <figcaption className="min-w-0 text-xs leading-snug text-muted-foreground">
          {hasLabel ? (
            // Copy-as-markdown already carries the alt text in the image itself.
            <span data-markdown-copy="">{props.label}</span>
          ) : null}
          {hasLabel && hasCaption ? (
            <span aria-hidden data-markdown-copy="">
              {" · "}
            </span>
          ) : null}
          {props.caption}
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

/** The fade a web image eases in on once decoded; opacity only, so reduced motion keeps it. */
export const INLINE_IMAGE_FADE_CLASS_NAME =
  "transition-opacity duration-(--motion-duration-base) ease-out";

/**
 * A web image in a gallery row. Its slot holds the authored aspect ratio (else
 * 4:3) as a quiet skeleton until the bytes decode, then the image fades in.
 * Thumbnails keep that box and crop; a lone image eases to its natural ratio.
 * A failed load (proxy error included) keeps the slot as a muted broken-image
 * tile, so nothing around it moves; the caption and source link stay.
 */
export function MarkdownGalleryImage(props: {
  src: string;
  alt: string;
  width?: unknown;
  height?: unknown;
  copyMarkdown: string;
  /** The environment whose server signs the image URL; the primary one when absent. */
  environmentId: EnvironmentId | null;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const single = use(GalleryCountContext) <= 1;
  const [source] = useState(() => inlineWebImageSource(props.src));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryEnvironmentId;
  const resource = environmentId === null ? null : remoteImageAssetResource(source);
  const signedUrl = useAssetUrlState(environmentId, resource);
  const refreshSignedUrl = useAssetUrlRefresh(environmentId, resource);
  const [remintTried, setRemintTried] = useState(false);
  const [failed, setFailed] = useState(source?.kind !== "remote");
  const [loaded, setLoaded] = useState<{
    ratio: number;
    width: number;
    instant: boolean;
  } | null>(null);
  const resolvedSrc =
    source?.kind === "remote"
      ? resolveRemoteImageSrc(source, resource === null ? null : signedUrl)
      : null;
  const current = !failed ? resolvedSrc : null;
  const name = props.alt.trim() || "image";
  const originalUrl = source?.url ?? props.src;
  const reference = mediaUrlReference(originalUrl);
  const actionsSource: MediaActionSource = {
    kind: "image",
    name,
    src: current,
    ...(reference ? { reference } : {}),
  };

  const settle = (image: HTMLImageElement, instant: boolean) => {
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

  const authoredRatio = inlineImageAspectRatio(props.width, props.height);
  const hasAuthoredSize = Number(props.width) > 0 && Number(props.height) > 0;
  // A lone failed image settles to a shorter 16:9 placeholder unless its size was authored.
  const ratio =
    single && loaded ? loaded.ratio : single && failed && !hasAuthoredSize ? 16 / 9 : authoredRatio;
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
      style={slotStyle}
      className={cn(
        "relative w-full overflow-hidden rounded-xl border border-border/50 bg-muted/60",
        single &&
          !loaded?.instant &&
          "transition-[aspect-ratio,max-width] duration-(--motion-duration-base) ease-out motion-reduce:transition-none",
      )}
      {...(failed
        ? { role: "img", "aria-label": `${name} (unavailable)` }
        : loaded
          ? {}
          : { role: "status", "aria-label": "Loading image" })}
    >
      {current !== null ? (
        <MediaActions source={actionsSource}>
          <img
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
              !loaded?.instant && INLINE_IMAGE_FADE_CLASS_NAME,
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
              // A signed URL that lapsed while the thread sat open is re-minted once, so the
              // image comes back instead of showing "unavailable".
              if (
                signedUrl._tag === "Success" &&
                signedUrl.url === current &&
                !remintTried &&
                signedUrl.expiresAt <= Date.now() + SIGNED_URL_EXPIRY_MARGIN_MS
              ) {
                setRemintTried(true);
                refreshSignedUrl().catch(() => setFailed(true));
                return;
              }
              setFailed(true);
            }}
          />
        </MediaActions>
      ) : failed ? (
        <span
          data-markdown-copy={props.copyMarkdown}
          // Find indexes no image text, so the placeholder must not highlight either.
          data-thread-find-ignore
          className={cn(
            "absolute inset-0 flex items-center justify-center gap-1.5 p-2 text-xs text-muted-foreground/70",
            INLINE_IMAGE_FADE_CLASS_NAME,
            "starting:opacity-0",
          )}
        >
          <ImageOffIcon aria-hidden className="size-4 shrink-0" />
          <span aria-hidden>Image unavailable</span>
        </span>
      ) : null}
    </div>
  );
}
