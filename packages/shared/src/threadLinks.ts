import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Agents mention another thread in Markdown as `[title](cogenly-thread://v1/<threadId>)`. The id is
 * the reference and resolves in the environment of the message that holds it. Titles change, so
 * clients show the thread's current title; the label only stands in for a thread they cannot see.
 */
export const THREAD_LINK_PROTOCOL = "cogenly-thread";
/** Older tool descriptions taught agents `t3-thread://v1/<id>`; messages written with it still resolve. */
export const LEGACY_THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const THREAD_LINK_HREF_PREFIXES = [THREAD_LINK_HREF_PREFIX, `${LEGACY_THREAD_LINK_PROTOCOL}://v1/`];
// Code comes first in the alternation so a link written inside a code span or fence is skipped.
const THREAD_LINK_OUTSIDE_CODE =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[[^\]\n]*\]\((?<href>(?:cogenly|t3)-thread:\/\/v1\/[^\s)]+)\)/g;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

/** The id as written. Thread ids can hold percent escapes of their own, so it is not decoded. */
export function parseThreadLinkHref(href: string): ThreadId | null {
  const prefix = THREAD_LINK_HREF_PREFIXES.find((candidate) => href.startsWith(candidate));
  if (prefix === undefined) return null;
  return Option.getOrNull(decodeThreadId(href.slice(prefix.length)));
}

// First path segments of app routes that are not `/<environmentId>/<threadId>`.
const NON_THREAD_ROUTE_SEGMENTS = new Set([
  "api",
  "connect",
  "connect-agent",
  "draft",
  "new",
  "oauth",
  "pair",
  "project",
  "projects",
  "settings",
  "usage",
  "welcome",
]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function originKey(url: URL): string {
  // `url.origin` is "null" for custom schemes such as the desktop renderer's `cogenly://app`.
  return `${url.protocol}//${url.host}`;
}

/**
 * A plain URL of one of the app's own thread pages, `<origin>/<environmentId>/<threadId>`, on the
 * page's own origin or a loopback dev server. The caller still checks that the thread exists,
 * since another local app can serve the same path shape.
 */
export function parseAppThreadUrl(
  href: string,
  currentUrl: string | null,
): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const sameOrigin = (() => {
    if (currentUrl === null) return false;
    try {
      return originKey(new URL(currentUrl)) === originKey(url);
    } catch {
      return false;
    }
  })();
  const loopback =
    (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (!sameOrigin && !loopback) return null;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length !== 2) return null;
  const [rawEnvironmentId = "", rawThreadId = ""] = segments;
  if (NON_THREAD_ROUTE_SEGMENTS.has(rawEnvironmentId)) return null;
  try {
    const environmentId = Option.getOrNull(
      decodeEnvironmentId(decodeURIComponent(rawEnvironmentId)),
    );
    const threadId = Option.getOrNull(decodeThreadId(decodeURIComponent(rawThreadId)));
    return environmentId === null || threadId === null ? null : { environmentId, threadId };
  } catch {
    return null;
  }
}

/**
 * Agents often percent-encode the id anyway. When the id as written names no thread, clients try
 * this decoded form. Null when decoding changes nothing or fails.
 */
export function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

/** A thread link whose label survives Markdown: no brackets, backslashes, or line breaks. */
export function formatThreadLink(threadId: string, label: string): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `[${cleaned || threadId}](${THREAD_LINK_HREF_PREFIX}${threadId})`;
}

export function hasThreadLinks(markdown: string): boolean {
  return THREAD_LINK_HREF_PREFIXES.some((prefix) => markdown.includes(`](${prefix}`));
}

/**
 * Relabels each thread link with `title(threadId)`, pointing it at the thread that title came from.
 * A link it returns nothing for keeps its label.
 */
export function relabelThreadLinks(
  markdown: string,
  title: (threadId: ThreadId) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  return markdown.replace(THREAD_LINK_OUTSIDE_CODE, (source, ...args) => {
    const href = (args.at(-1) as { href?: string }).href;
    if (href === undefined) return source;
    const written = parseThreadLinkHref(href);
    if (written === null) return source;
    // The decoded id only stands in when the id as written names no thread.
    const decoded = percentDecodedThreadLinkId(written);
    const threadId =
      title(written) === undefined && decoded !== null && title(decoded) !== undefined
        ? decoded
        : written;
    const label = title(threadId)?.trim();
    return label ? formatThreadLink(threadId, label) : source;
  });
}
