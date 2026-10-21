/**
 * Pure helpers behind inline web images in assistant markdown: which images
 * form a gallery row, how each one's URL is loaded, and how a half-streamed
 * image is held back until its markdown is complete.
 */

/** The slice of a hast node these helpers read and build. */
export interface InlineImageHastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: InlineImageHastNode[];
}

export type InlineImageSource =
  /** Load from these URLs in order; later ones are fallbacks for an earlier failure. */
  | { readonly kind: "remote"; readonly url: string; readonly candidates: readonly string[] }
  /** Plain `http:`: never loaded, so the message keeps only its caption and source. */
  | { readonly kind: "blocked"; readonly url: string };

function parseWebUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  // Protocol-relative URLs load over whatever the page uses; treat them as https.
  const candidate = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Whether a markdown image source is a web URL a gallery row can hold. */
export function isInlineWebImageSource(src: unknown): src is string {
  return typeof src === "string" && parseWebUrl(src) !== null;
}

/**
 * Resolves a web image's load order. Third-party https images go through the
 * server's image proxy first when one is known, then directly; images on the
 * app's own origins load directly. Plain http is never loaded.
 */
export function resolveInlineImageSource(
  src: string,
  options: {
    /** Builds the proxy URL for a remote image, or null when no proxy is available. */
    readonly proxyUrl?: ((url: string) => string | null) | undefined;
    /** Origins that serve the app itself; their images need no proxy. */
    readonly firstPartyOrigins?: readonly string[] | undefined;
  } = {},
): InlineImageSource | null {
  const url = parseWebUrl(src);
  if (!url) return null;
  const href = url.toString();
  if (url.protocol === "http:") return { kind: "blocked", url: href };
  const firstParty = options.firstPartyOrigins?.includes(url.origin) ?? false;
  const proxied = firstParty ? null : (options.proxyUrl?.(href) ?? null);
  return {
    kind: "remote",
    url: href,
    candidates: proxied && proxied !== href ? [proxied, href] : [href],
  };
}

/** The pixel box an author gave an image, as an aspect ratio for its placeholder. */
export function inlineImageAspectRatio(width: unknown, height: unknown): number {
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  return Number.isFinite(parsedWidth) &&
    Number.isFinite(parsedHeight) &&
    parsedWidth > 0 &&
    parsedHeight > 0
    ? parsedWidth / parsedHeight
    : 4 / 3;
}

// Text that may sit between an image and the link crediting it: "·", "—", "Source:", "via".
const SOURCE_SEPARATOR =
  /^[\s·•|—–\-:,(]*(?:(?:source|via|credit|photo|image|from)\s*:?)?[\s·•|—–\-:,(]*$/i;
const SOURCE_CLOSER = /^[\s)]*$/;

function isWhitespaceText(node: InlineImageHastNode): boolean {
  return node.type === "text" && (node.value ?? "").trim().length === 0;
}

function isElement(node: InlineImageHastNode | undefined, tagName: string): boolean {
  return node?.type === "element" && node.tagName === tagName;
}

function isWebImage(node: InlineImageHastNode | undefined): boolean {
  return isElement(node, "img") && isInlineWebImageSource(node?.properties?.src);
}

function webLinkHref(node: InlineImageHastNode | undefined): string | null {
  if (!isElement(node, "a")) return null;
  const href = node?.properties?.href;
  return typeof href === "string" && parseWebUrl(href) !== null ? href : null;
}

function meaningfulChildren(node: InlineImageHastNode): InlineImageHastNode[] {
  return (node.children ?? []).filter(
    (child) => !isWhitespaceText(child) && !isElement(child, "br"),
  );
}

function hostLabel(href: string): string {
  return parseWebUrl(href)?.hostname.replace(/^www\./, "") ?? href;
}

interface GalleryUnit {
  readonly image: InlineImageHastNode;
  readonly source: InlineImageHastNode | null;
}

/**
 * Reads a paragraph that holds nothing but web images, each optionally
 * credited by a link right after it or wrapped in one. Null for anything
 * else: an image inside a sentence stays inline.
 */
function paragraphGalleryUnits(paragraph: InlineImageHastNode): GalleryUnit[] | null {
  if (!isElement(paragraph, "p")) return null;
  const children = paragraph.children ?? [];
  const units: GalleryUnit[] = [];
  let index = 0;
  const skipWhitespace = () => {
    while (index < children.length) {
      const child = children[index];
      if (!child || !(isWhitespaceText(child) || isElement(child, "br"))) break;
      index += 1;
    }
  };
  skipWhitespace();
  while (index < children.length) {
    const child = children[index];
    if (!child) return null;
    if (isWebImage(child)) {
      index += 1;
      // An optional separator, then a text link that credits the image.
      let lookahead = index;
      const separator = children[lookahead];
      if (separator?.type === "text" && SOURCE_SEPARATOR.test(separator.value ?? "")) {
        lookahead += 1;
      }
      const link = children[lookahead];
      const linkHref = webLinkHref(link);
      if (link && linkHref && !meaningfulChildren(link).some((part) => isElement(part, "img"))) {
        index = lookahead + 1;
        const closer = children[index];
        if (closer?.type === "text" && SOURCE_CLOSER.test(closer.value ?? "")) index += 1;
        units.push({ image: child, source: link });
      } else {
        units.push({ image: child, source: null });
      }
    } else if (webLinkHref(child) !== null) {
      // `[![alt](image)](page)`: the page becomes the image's source chip.
      const inner = meaningfulChildren(child);
      const image = inner[0];
      if (inner.length !== 1 || !image || !isWebImage(image)) return null;
      index += 1;
      units.push({
        image,
        source: {
          type: "element",
          tagName: "a",
          properties: { ...child.properties },
          children: [{ type: "text", value: hostLabel(webLinkHref(child) ?? "") }],
        },
      });
    } else {
      return null;
    }
    skipWhitespace();
  }
  return units.length > 0 ? units : null;
}

function galleryFigure(unit: GalleryUnit): InlineImageHastNode {
  const alt = unit.image.properties?.alt;
  return {
    type: "element",
    tagName: "figure",
    properties: {
      dataMarkdownGalleryItem: true,
      dataCaption: typeof alt === "string" ? alt.trim() : "",
    },
    children: [
      { ...unit.image, properties: { ...unit.image.properties, dataGalleryItem: true } },
      ...(unit.source ? [unit.source] : []),
    ],
  };
}

function galleryRow(units: GalleryUnit[]): InlineImageHastNode {
  return {
    type: "element",
    tagName: "div",
    properties: { dataMarkdownGallery: true, dataGalleryCount: units.length },
    children: units.map(galleryFigure),
  };
}

/**
 * Turns each run of image-only paragraphs into one gallery row: a `div`
 * carrying `dataMarkdownGallery` and `dataGalleryCount`, holding one `figure`
 * per image with its caption (`dataCaption`) and an optional source link.
 * Consecutive images, whether in one paragraph or in adjacent ones, share a
 * row. Mutates and returns the tree.
 */
export function groupInlineImageGalleries<T extends InlineImageHastNode>(tree: T): T {
  const visit = (node: InlineImageHastNode) => {
    const children = node.children;
    if (!children) return;
    const next: InlineImageHastNode[] = [];
    let run: GalleryUnit[] = [];
    // Whitespace between paragraphs of one run; restored if the run ends there.
    let pending: InlineImageHastNode[] = [];
    const flush = () => {
      if (run.length > 0) next.push(galleryRow(run));
      run = [];
      next.push(...pending);
      pending = [];
    };
    for (const child of children) {
      const units = paragraphGalleryUnits(child);
      if (units) {
        run.push(...units);
        pending = [];
        continue;
      }
      if (run.length > 0 && isWhitespaceText(child)) {
        pending.push(child);
        continue;
      }
      flush();
      visit(child);
      next.push(child);
    }
    flush();
    node.children = next;
  };
  visit(tree);
  return tree;
}

const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;
// A trailing `![alt`, `![alt]`, `![alt](url` — or the same image inside a link still being written.
const PARTIAL_IMAGE_TAIL = /\[?!\[[^\]\n]*(?:\](?:\([^)\n]*)?)?$/;
const PARTIAL_LINKED_IMAGE_TAIL = /\[!\[[^\]\n]*\]\([^)\n]*\)(?:\](?:\([^)\n]*)?)?$/;

/**
 * Drops an image whose markdown is still arriving at the end of a streaming
 * message, so `![alt](https://exa` never flashes as text or a broken image.
 * Text inside an open code fence or inline code span is left alone.
 */
export function withoutPartialTrailingImage(text: string): string {
  const lineStart = text.lastIndexOf("\n") + 1;
  const lastLine = text.slice(lineStart);
  if (!lastLine.includes("![")) return text;
  let openFence = false;
  for (const line of text.slice(0, lineStart).split("\n")) {
    if (FENCE_LINE.test(line)) openFence = !openFence;
  }
  if (openFence || FENCE_LINE.test(lastLine)) return text;
  const match = PARTIAL_LINKED_IMAGE_TAIL.exec(lastLine) ?? PARTIAL_IMAGE_TAIL.exec(lastLine);
  if (!match) return text;
  const backticksBefore = lastLine.slice(0, match.index).split("`").length - 1;
  if (backticksBefore % 2 === 1) return text;
  return text.slice(0, lineStart + match.index).replace(/[ \t]+$/, "");
}
