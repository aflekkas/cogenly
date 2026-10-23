import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  type HttpClientResponse,
} from "effect/http";

/** `GET /api/image-proxy?url=<https-image-url>`: serves third-party chat images from our origin. */
export const IMAGE_PROXY_PATH = "/api/image-proxy";
/** Inline chat images never need more than this; larger bodies are rejected, not truncated. */
export const MAX_PROXIED_IMAGE_BYTES = 10 * 1024 * 1024;
/** A chain this long is not an image host answering with bytes. */
const MAX_REDIRECTS = 3;
/**
 * Following redirects here is what re-validates every hop below. No Referer goes out on any hop:
 * the chat origin is nothing an image host should learn, and hosts that block hotlinks key on it.
 */
const MANUAL_REDIRECT: RequestInit = { redirect: "manual", referrerPolicy: "no-referrer" };
/** Some image hosts and CDNs refuse requests that do not look like a browser's. */
export const IMAGE_PROXY_REQUEST_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "accept-encoding": "identity",
} as const;
/** Only pictures leave this origin, decided from the upstream content type. */
const IMAGE_CONTENT_TYPE_PATTERN = /^image\/[\w!#$&^.+-]+$/i;
const SVG_CONTENT_TYPE = "image/svg+xml";
// An SVG is a document: same policy the asset route gives a workspace SVG, so
// one embedded in a chat cannot run script against this origin.
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const isPrivateIpv4 = (parts: ReadonlyArray<number>): boolean => {
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 0 && b === 0)
  );
};

/** Expands an IPv6 literal to its eight 16-bit groups, or null when not IPv6. */
const expandIpv6 = (normalized: string): ReadonlyArray<number> | null => {
  if (!normalized.includes(":")) return null;
  const zoneIndex = normalized.indexOf("%");
  const address = (zoneIndex === -1 ? normalized : normalized.slice(0, zoneIndex)).replace(
    /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
    (_match, a: string, b: string, c: string, d: string) =>
      `:${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`,
  );
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const groups =
    halves.length === 1
      ? head
      : [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => "0"), ...tail];
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
};

/**
 * True for literal IPs that never serve public web images: loopback,
 * link-local, and private ranges. Hostnames pass — resolving them here would
 * not stop DNS rebinding anyway — but every redirect hop is re-checked.
 */
export const isBlockedProxyHost = (hostname: string): boolean => {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (LOOPBACK_HOSTNAMES.has(normalized) || normalized === "0.0.0.0") return true;
  const v4 = normalized.split(".");
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part))) {
    const parts = v4.map(Number);
    if (parts.every((part) => part >= 0 && part <= 255)) return isPrivateIpv4(parts);
  }
  const v6 = expandIpv6(normalized);
  if (v6 === null) return false;
  // IPv4-mapped (::ffff:0:0/96) carries the same ranges as the embedded IPv4.
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    return isPrivateIpv4([v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff]);
  }
  // Link-local (fe80::/10) and unique-local (fc00::/7).
  return (v6[0]! & 0xffc0) === 0xfe80 || (v6[0]! & 0xfe00) === 0xfc00;
};

export type ImageProxyTargetError =
  | { readonly status: 400; readonly message: string }
  | { readonly status: 403; readonly message: string };

/** The target URL is valid only on https and never on a blocked host. */
export const parseImageProxyTarget = (
  rawUrl: string,
): { readonly url: string } | { readonly error: ImageProxyTargetError } => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { error: { status: 400, message: "The url query parameter is not a valid URL." } };
  }
  if (parsed.protocol !== "https:") {
    return { error: { status: 400, message: "Only https image URLs can be proxied." } };
  }
  if (isBlockedProxyHost(parsed.hostname)) {
    return { error: { status: 403, message: "That host cannot be proxied." } };
  }
  return { url: parsed.toString() };
};

export interface ProxiedImageUpstream {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly declaredLength: number | undefined;
  readonly bodyLength: number;
}

/**
 * Decides the proxied response from the upstream headers and the buffered
 * body length. Pure so the validation is testable without the network.
 */
export const selectProxiedImageResponse = (
  upstream: ProxiedImageUpstream,
):
  | { readonly status: 200; readonly contentType: string }
  | { readonly status: 413 | 415; readonly message: string }
  | { readonly status: number; readonly passthrough: true } => {
  if (upstream.status >= 400) return { status: upstream.status, passthrough: true };
  if (upstream.declaredLength !== undefined && upstream.declaredLength > MAX_PROXIED_IMAGE_BYTES) {
    return { status: 413, message: "The image is larger than the proxy limit." };
  }
  if (upstream.bodyLength > MAX_PROXIED_IMAGE_BYTES) {
    return { status: 413, message: "The image is larger than the proxy limit." };
  }
  const contentType = upstream.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!IMAGE_CONTENT_TYPE_PATTERN.test(contentType)) {
    return { status: 415, message: "The proxied URL is not an image." };
  }
  return { status: 200, contentType };
};

export const imageProxyResponseHeaders = (contentType: string): Record<string, string> => ({
  "cache-control": "private, max-age=3600",
  "x-content-type-options": "nosniff",
  ...(contentType === SVG_CONTENT_TYPE
    ? { "content-security-policy": SVG_CONTENT_SECURITY_POLICY }
    : {}),
});

/** Follows redirects manually so every hop is re-validated as a proxy target. */
const fetchFollowingRedirects = Effect.fn("ImageProxyFetch.fetchFollowingRedirects")(function* (
  url: string,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  let target = url;
  for (let hop = 0; ; hop += 1) {
    // No credentials ride along: the default fetch dispatcher sends no
    // cookies cross-origin, and nothing here sets Cookie or Authorization.
    const response: HttpClientResponse.HttpClientResponse = yield* httpClient
      .execute(
        HttpClientRequest.get(target).pipe(
          HttpClientRequest.setHeaders(IMAGE_PROXY_REQUEST_HEADERS),
        ),
      )
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400) return response;
    if (!location || hop >= MAX_REDIRECTS) return null;
    const next = new URL(location, target);
    const parsed = parseImageProxyTarget(next.toString());
    if (!("url" in parsed)) return null;
    target = parsed.url;
  }
});

/**
 * Serves a third-party image through this origin so chat clients dodge
 * hotlink protection, mixed content, and tracker cookies. Https only, images
 * only, bounded in size and time.
 */
export const imageProxyResponse = Effect.fn("ImageProxyFetch.imageProxyResponse")(function* (
  rawUrl: string,
) {
  const parsed = parseImageProxyTarget(rawUrl);
  if (!("url" in parsed)) {
    return HttpServerResponse.text(parsed.error.message, { status: parsed.error.status });
  }
  const response = yield* fetchFollowingRedirects(parsed.url).pipe(
    Effect.timeout("15 seconds"),
    Effect.orElseSucceed(() => null),
  );
  if (response === null) {
    return HttpServerResponse.text("The image could not be fetched.", { status: 502 });
  }
  // An upstream refusal is the client's answer, not this server's fault. It
  // carries none of the upstream entity headers: a `content-length` with no
  // body behind it holds the connection open until the browser gives up.
  if (response.status >= 400) {
    return HttpServerResponse.empty({
      status: response.status >= 500 ? 502 : response.status,
    });
  }
  const declaredLength = (() => {
    const value = response.headers["content-length"];
    if (value === undefined) return undefined;
    const parsedLength = Number(value);
    return Number.isInteger(parsedLength) && parsedLength >= 0 ? parsedLength : undefined;
  })();
  // Refuse an over-limit body before buffering a byte of it; the capped
  // stream below catches upstreams that lie about (or omit) the length. One
  // byte past the cap distinguishes "exactly the limit" from "over it".
  if (declaredLength !== undefined && declaredLength > MAX_PROXIED_IMAGE_BYTES) {
    return HttpServerResponse.text("The image is larger than the proxy limit.", { status: 413 });
  }
  const chunks = yield* response.stream.pipe(
    Stream.take(MAX_PROXIED_IMAGE_BYTES + 1),
    Stream.runCollect,
  );
  let bodyLength = 0;
  for (const chunk of chunks) bodyLength += chunk.length;
  const decision = selectProxiedImageResponse({
    status: response.status,
    contentType: response.headers["content-type"],
    declaredLength,
    bodyLength,
  });
  // Unreachable: refusals return above before buffering. Kept so the decision
  // table stays total for its own callers.
  if ("passthrough" in decision) {
    return HttpServerResponse.empty({
      status: decision.status >= 500 ? 502 : decision.status,
    });
  }
  if (decision.status !== 200) {
    return HttpServerResponse.text(decision.message, { status: decision.status });
  }
  const body = new Uint8Array(bodyLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return HttpServerResponse.uint8Array(body, {
    contentType: decision.contentType,
    headers: imageProxyResponseHeaders(decision.contentType),
  });
});
