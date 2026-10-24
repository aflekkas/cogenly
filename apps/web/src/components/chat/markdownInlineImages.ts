/**
 * Pure helpers behind inline web images in assistant markdown: which images
 * become captioned figures and gallery rows, how each one's URL is loaded, and
 * how a half-streamed image is held back until its markdown is complete.
 */

import type { AssetUrlState } from "@t3tools/client-runtime/state/assets";
import type { AssetResource } from "@t3tools/contracts";

/** The slice of a hast node these helpers read and build. */
export interface InlineImageHastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: InlineImageHastNode[];
}

export type InlineImageSource =
  /**
   * `url` is the authored image (for "open source"); `src` is what the `<img>` loads when the
   * server cannot sign it. `proxied` marks a third-party image the server should sign and fetch.
   */
  | {
      readonly kind: "remote";
      readonly url: string;
      readonly src: string;
      readonly proxied: boolean;
    }
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

/** The server's image proxy route, relative to the environment's HTTP base. */
export const IMAGE_PROXY_PATH = "/api/image-proxy";

/** Points the image proxy endpoint (`…/api/image-proxy`) at a third-party image URL. */
export function imageProxyUrl(proxyEndpoint: string, url: string): string {
  const proxied = new URL(proxyEndpoint);
  proxied.search = "";
  proxied.searchParams.set("url", url);
  return proxied.toString();
}

/**
 * Resolves where a web image loads from. Third-party https images go through
 * the server's image proxy when one is known, so the client never hotlinks;
 * images on the app's own origins, or with no proxy available, load directly.
 * Plain http is never loaded.
 */
export function resolveInlineImageSource(
  src: string,
  options: {
    /** The image proxy endpoint, or null when no proxy is available. */
    readonly proxyEndpoint?: string | null | undefined;
    /** Origins that serve the app itself; their images need no proxy. */
    readonly firstPartyOrigins?: readonly string[] | undefined;
  } = {},
): InlineImageSource | null {
  const url = parseWebUrl(src);
  if (!url) return null;
  const href = url.toString();
  if (url.protocol === "http:") return { kind: "blocked", url: href };
  const firstParty = options.firstPartyOrigins?.includes(url.origin) ?? false;
  const proxied =
    !firstParty && options.proxyEndpoint ? imageProxyUrl(options.proxyEndpoint, href) : null;
  return { kind: "remote", url: href, src: proxied ?? href, proxied: proxied !== null };
}

/** The asset the server signs for a proxied image, or null when the image loads as authored. */
export function remoteImageAssetResource(
  source: InlineImageSource | null,
): Extract<AssetResource, { readonly _tag: "remote-image" }> | null {
  return source?.kind === "remote" && source.proxied
    ? { _tag: "remote-image", url: source.url }
    : null;
}

/**
 * What a remote image's `<img>` loads from. A proxied image waits for its signed URL, because
 * an `<img>` cannot send the bearer token the proxy route would need; if the server cannot sign
 * it (an older server), the cookie-authenticated proxy URL is the best that remains. Null means
 * "not yet".
 */
export function resolveRemoteImageSrc(
  source: Extract<InlineImageSource, { readonly kind: "remote" }>,
  signed: AssetUrlState | null,
): string | null {
  if (!source.proxied || signed === null) return source.src;
  if (signed._tag === "Success") return signed.url;
  return signed._tag === "Loading" ? null : source.src;
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

// Punctuation that sits between an image, its caption, and its source links: "·", "—", "|", "(…)".
const SEPARATORS = /[\s·•|—–\-:,;/()[\]]+/g;
const LEADING_EDGE_SEPARATORS = /^[\s·•|—–\-:,;/]+/;
const TRAILING_EDGE_SEPARATORS = /[\s·•|—–\-:,;/]+$/;
const EDGE_SEPARATOR_ONLY = /^[\s·•|—–\-:,;/]*$/;
// Words that open a credit rather than a sentence: "Source:", "via", "Photo by", "©".
const ATTRIBUTION_LEAD =
  /^(?:©|(?:sources?|via|credits?|photo(?:graph)?|image|picture|from|courtesy|by)\b)/i;
const ATTRIBUTION_WORDS =
  /©|\b(?:sources?|via|credits?|photo(?:graph)?|image|picture|from|courtesy(?:\s+of)?|by)\b/gi;
/** Caption or title text longer than this reads as prose, so the image stays inline. */
const MAX_CAPTION_TEXT_LENGTH = 120;
const CAPTION_INLINE_TAGS = new Set([
  "a",
  "b",
  "code",
  "del",
  "em",
  "i",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
]);
const EMPHASIS_TAGS = new Set(["b", "em", "i", "strong"]);
const BLOCK_TAGS = new Set([
  "blockquote",
  "details",
  "div",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "ol",
  "p",
  "pre",
  "table",
  "ul",
]);

function textNode(value: string): InlineImageHastNode {
  return { type: "text", value };
}

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

function hastText(node: InlineImageHastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function containsImage(node: InlineImageHastNode): boolean {
  return isElement(node, "img") || (node.children ?? []).some(containsImage);
}

function isSeparatorText(node: InlineImageHastNode): boolean {
  return node.type === "text" && (node.value ?? "").replace(SEPARATORS, "") === "";
}

interface GalleryUnit {
  readonly image: InlineImageHastNode;
  /** The page a wrapping `[![alt](image)](page)` link pointed at, as a host-labelled link. */
  readonly source: InlineImageHastNode | null;
  /** A title that named the image before it, such as `**Salem Witch Museum**`. */
  lead: InlineImageHastNode[];
  /** Credit text and source links that followed the image. */
  caption: InlineImageHastNode[];
}

/** A web image, or `[![alt](image)](page)` whose page becomes the image's source link. */
function figureImage(node: InlineImageHastNode): Omit<GalleryUnit, "lead" | "caption"> | null {
  if (isWebImage(node)) return { image: node, source: null };
  const href = webLinkHref(node);
  if (href === null) return null;
  const inner = meaningfulChildren(node);
  const image = inner[0];
  if (inner.length !== 1 || !image || !isWebImage(image)) return null;
  return {
    image,
    source: {
      type: "element",
      tagName: "a",
      properties: { ...node.properties },
      children: [textNode(hostLabel(href))],
    },
  };
}

function isCaptionNode(node: InlineImageHastNode): boolean {
  if (node.type === "text") return true;
  return (
    node.type === "element" && CAPTION_INLINE_TAGS.has(node.tagName ?? "") && !containsImage(node)
  );
}

/** What a run of caption nodes says once its links and separators are set aside. */
function captionShape(nodes: readonly InlineImageHastNode[]) {
  let hasLink = false;
  let emphasized = true;
  const parts: string[] = [];
  for (const node of nodes) {
    if (isElement(node, "a")) {
      hasLink = true;
      continue;
    }
    if (isSeparatorText(node)) continue;
    if (node.type !== "element" || !EMPHASIS_TAGS.has(node.tagName ?? "")) emphasized = false;
    parts.push(hastText(node));
  }
  const words = parts.join(" ").replace(SEPARATORS, " ").trim();
  return { words, hasLink, emphasized: emphasized && words.length > 0 };
}

/**
 * Whether text beside an image credits or names it rather than continuing a sentence: nothing
 * but links and separators, or short text that is emphasized, opens with a credit word, or sits
 * with a source link. Plain words with no link ("is our logo") and lowercase text that carries on
 * a sentence stay prose.
 */
function isCaption(nodes: readonly InlineImageHastNode[]): boolean {
  if (!nodes.every(isCaptionNode)) return false;
  const { words, hasLink, emphasized } = captionShape(nodes);
  if (words.length === 0) return true;
  if (words.length > MAX_CAPTION_TEXT_LENGTH) return false;
  if (emphasized || ATTRIBUTION_LEAD.test(words)) return true;
  return hasLink && !/^\p{Ll}/u.test(words);
}

/** A short bold or italic title, such as `**Salem Witch Museum**`, that names a figure. */
function isTitle(nodes: readonly InlineImageHastNode[]): boolean {
  if (!nodes.every(isCaptionNode)) return false;
  const { words, hasLink, emphasized } = captionShape(nodes);
  return !hasLink && emphasized && words.length <= MAX_CAPTION_TEXT_LENGTH;
}

/** Whether caption content names its image itself, so the alt text need not repeat it. */
function describesImage(nodes: readonly InlineImageHastNode[]): boolean {
  return captionShape(nodes).words.replace(ATTRIBUTION_WORDS, "").trim().length > 0;
}

/** Drops the separators at a caption's edges and a "(…)" wrapped around all of it. */
function trimCaption(nodes: readonly InlineImageHastNode[]): InlineImageHastNode[] {
  const result = [...nodes];
  const isEdgeSeparator = (node: InlineImageHastNode | undefined) =>
    node?.type === "text" && EDGE_SEPARATOR_ONLY.test(node.value ?? "");
  const trimEdges = () => {
    while (isEdgeSeparator(result[0])) result.shift();
    while (isEdgeSeparator(result.at(-1))) result.pop();
    const first = result[0];
    if (first?.type === "text") {
      result[0] = textNode((first.value ?? "").replace(LEADING_EDGE_SEPARATORS, ""));
    }
    const last = result.at(-1);
    if (last?.type === "text") {
      result[result.length - 1] = textNode(
        (last.value ?? "").replace(TRAILING_EDGE_SEPARATORS, ""),
      );
    }
  };
  trimEdges();
  const first = result[0];
  const last = result.at(-1);
  if (
    first?.type === "text" &&
    last?.type === "text" &&
    (first.value ?? "").startsWith("(") &&
    (last.value ?? "").endsWith(")")
  ) {
    result[0] = textNode((first.value ?? "").slice(1));
    const lastIndex = result.length - 1;
    const lastValue = result[lastIndex]?.value ?? "";
    result[lastIndex] = textNode(lastValue.slice(0, -1));
    trimEdges();
  }
  return result.filter((node) => node.type !== "text" || (node.value ?? "").length > 0);
}

/** Joins two caption parts with a " · " that copy-as-markdown leaves out. */
function joinCaption(
  first: InlineImageHastNode[],
  second: InlineImageHastNode[],
): InlineImageHastNode[] {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  const separator: InlineImageHastNode = {
    type: "element",
    tagName: "span",
    properties: { ariaHidden: "true", dataMarkdownCopy: " " },
    children: [textNode(" · ")],
  };
  return [...first, separator, ...second];
}

interface Line {
  readonly nodes: InlineImageHastNode[];
  /** The soft (`\n`) or hard (`<br>`) break that ended the line, for rejoining prose. */
  end: InlineImageHastNode | null;
}

/** Splits inline content at its soft and hard line breaks. */
function splitLines(children: readonly InlineImageHastNode[]): Line[] {
  let line: Line = { nodes: [], end: null };
  const lines = [line];
  const breakLine = (end: InlineImageHastNode) => {
    line.end = end;
    line = { nodes: [], end: null };
    lines.push(line);
  };
  for (const child of children) {
    if (isElement(child, "br")) {
      breakLine(child);
      continue;
    }
    const value = child.type === "text" ? (child.value ?? "") : "";
    if (!value.includes("\n")) {
      line.nodes.push(child);
      continue;
    }
    value.split("\n").forEach((part, index) => {
      if (index > 0) breakLine(textNode("\n"));
      if (part) line.nodes.push(textNode(part));
    });
  }
  return lines;
}

function isBlankLine(line: Line): boolean {
  return line.nodes.every(isWhitespaceText);
}

/**
 * Reads one line as figures: web images, each optionally followed by its caption, with an
 * optional title before the first. Null when the line is prose with an image in it.
 */
function figureLine(nodes: readonly InlineImageHastNode[]): GalleryUnit[] | null {
  const lead: InlineImageHastNode[] = [];
  const units: GalleryUnit[] = [];
  for (const node of nodes) {
    const found = figureImage(node);
    if (found) {
      units.push({ ...found, lead: [], caption: [] });
    } else {
      (units.at(-1)?.caption ?? lead).push(node);
    }
  }
  const first = units[0];
  if (!first) return null;
  if (!(lead.every(isCaptionNode) && captionShape(lead).words === "") && !isTitle(lead)) {
    return null;
  }
  if (!units.every((unit) => isCaption(unit.caption))) return null;
  first.lead = lead;
  return units;
}

type Segment = { readonly prose: Line[] } | { readonly units: GalleryUnit[] };

/**
 * Splits a paragraph's inline content into prose and figures. A line holding only images and
 * their captions becomes figures; a title line right above one names it, and a credit line right
 * below one captions its last image. Null when the content has no figure line.
 */
function figureSegments(children: readonly InlineImageHastNode[]): Segment[] | null {
  const segments: Segment[] = [];
  let prose: Line[] = [];
  let captionTarget: GalleryUnit | null = null;
  for (const line of splitLines(children)) {
    if (isBlankLine(line)) {
      if (prose.length > 0) prose.push(line);
      continue;
    }
    const units = figureLine(line.nodes);
    if (units) {
      const title = prose.at(-1);
      const first = units[0];
      if (first && first.lead.every(isWhitespaceText) && title && isTitle(title.nodes)) {
        prose.pop();
        first.lead = title.nodes;
      }
      if (prose.some((proseLine) => !isBlankLine(proseLine))) segments.push({ prose });
      prose = [];
      const previous = segments.at(-1);
      if (previous && "units" in previous) previous.units.push(...units);
      else segments.push({ units });
      captionTarget = units.at(-1) ?? null;
      continue;
    }
    if (captionTarget && isCaption(line.nodes)) {
      captionTarget.caption = joinCaption(
        trimCaption(captionTarget.caption),
        trimCaption(line.nodes),
      );
      captionTarget = null;
      continue;
    }
    captionTarget = null;
    prose.push(line);
  }
  if (!segments.some((segment) => "units" in segment)) return null;
  if (prose.some((line) => !isBlankLine(line))) segments.push({ prose });
  return segments;
}

/** Rejoins prose lines with the breaks between them, dropping blank lines at the edges. */
function proseNodes(lines: readonly Line[]): InlineImageHastNode[] {
  const start = lines.findIndex((line) => !isBlankLine(line));
  let end = lines.length;
  while (end > start && isBlankLine(lines[end - 1] ?? { nodes: [], end: null })) end -= 1;
  return lines
    .slice(Math.max(start, 0), end)
    .flatMap((line, index, kept) =>
      index < kept.length - 1 && line.end ? [...line.nodes, line.end] : line.nodes,
    );
}

function galleryFigure(unit: GalleryUnit): InlineImageHastNode {
  const caption = joinCaption(
    joinCaption(trimCaption(unit.lead), trimCaption(unit.caption)),
    unit.source ? [unit.source] : [],
  );
  const alt = unit.image.properties?.alt;
  return {
    type: "element",
    tagName: "figure",
    properties: {
      dataMarkdownGalleryItem: true,
      // The alt text labels the caption unless the authored caption already names the image.
      dataCaption: typeof alt === "string" && !describesImage(caption) ? alt.trim() : "",
    },
    children: [
      { ...unit.image, properties: { ...unit.image.properties, dataGalleryItem: true } },
      ...caption,
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

/** A tight list item: its inline content sits directly in the `li`, with no paragraph. */
function isInlineListItem(node: InlineImageHastNode): boolean {
  return (
    isElement(node, "li") &&
    !(node.children ?? []).some(
      (child) => child.type === "element" && BLOCK_TAGS.has(child.tagName ?? ""),
    )
  );
}

/**
 * Turns figure lines into gallery rows: a `div` carrying `dataMarkdownGallery` and
 * `dataGalleryCount`, holding one `figure` per image. Each figure's first child is the image;
 * the rest is its caption (title, credit text, source links), and `dataCaption` is the alt text
 * to label it with when that caption does not name the image itself.
 *
 * A figure line holds only web images plus links, separators like "·" or "—", and short
 * attribution or title text. Prose lines around it stay paragraphs, and an image inside a
 * sentence stays inline. Consecutive figures, whether in one paragraph or in adjacent ones,
 * share a row. Mutates and returns the tree.
 */
export function groupInlineImageGalleries<T extends InlineImageHastNode>(tree: T): T {
  const visit = (node: InlineImageHastNode) => {
    const children = node.children;
    if (!children) return;
    if (isInlineListItem(node)) {
      const segments = figureSegments(children);
      if (segments) {
        node.children = segments.flatMap((segment) =>
          "units" in segment ? [galleryRow(segment.units)] : proseNodes(segment.prose),
        );
      }
      return;
    }
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
      const segments = isElement(child, "p") ? figureSegments(child.children ?? []) : null;
      if (segments) {
        for (const segment of segments) {
          if ("units" in segment) {
            run.push(...segment.units);
            pending = [];
          } else {
            flush();
            next.push({ ...child, children: proseNodes(segment.prose) });
          }
        }
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
