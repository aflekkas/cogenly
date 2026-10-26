// @effect-diagnostics nodeBuiltinImport:off - Effect has no IP address parser.
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  type HttpClientResponse,
} from "effect/http";

import { makePinnedFetch } from "../outboundHttp.ts";
import {
  isLocalAddress,
  normalizeHostname,
  publicAddresses,
  systemHostLookup,
  type HostLookup,
} from "../security/PublicAddress.ts";

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

/**
 * True for hosts that never serve public web images: localhost names and
 * literal loopback, private, link-local, CGNAT, and other reserved addresses.
 * Names otherwise pass here; the fetch resolves each hop and refuses or pins
 * the addresses it connects to.
 */
export const isBlockedProxyHost = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname);
  if (normalized === "" || normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  const family = NodeNet.isIP(normalized);
  return family !== 0 && isLocalAddress(normalized, family);
};

/** How the proxy resolves a hop's host before connecting; tests swap in a fixed answer. */
export const ImageProxyHostLookup = Context.Reference<HostLookup>(
  "cogenly/assets/ImageProxyHostLookup",
  { defaultValue: () => systemHostLookup },
);

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

/**
 * Follows redirects manually so every hop is re-validated as a proxy target.
 * Each hop's host is resolved here and refused when any address is not
 * public; the connection then goes only to those checked addresses, so DNS
 * rebinding between check and connect reaches nothing new.
 */
const fetchFollowingRedirects = Effect.fn("ImageProxyFetch.fetchFollowingRedirects")(function* (
  url: string,
  method: "GET" | "HEAD" = "GET",
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const lookup = yield* ImageProxyHostLookup;
  let target = url;
  for (let hop = 0; ; hop += 1) {
    const host = new URL(target).hostname;
    const addresses = yield* Effect.promise(() => publicAddresses(host, lookup));
    if (addresses === undefined) return null;
    const pinned = yield* Effect.acquireRelease(
      Effect.sync(() => makePinnedFetch(addresses)),
      ({ close }) => Effect.promise(close),
    );
    // No credentials ride along: the pinned dispatcher sends no cookies, and
    // nothing here sets Cookie or Authorization.
    const response: HttpClientResponse.HttpClientResponse = yield* httpClient
      .execute(
        HttpClientRequest.make(method)(target).pipe(
          HttpClientRequest.setHeaders(IMAGE_PROXY_REQUEST_HEADERS),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
        Effect.provideService(FetchHttpClient.Fetch, pinned.fetch),
      );
    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400) return response;
    if (!location || hop >= MAX_REDIRECTS) return null;
    const next = new URL(location, target);
    const parsed = parseImageProxyTarget(next.toString());
    if (!("url" in parsed)) return null;
    target = parsed.url;
  }
});

const PROBE_TIMEOUT = "4 seconds";

/**
 * Whether the proxy would serve this URL as an image, asked with a bounded HEAD through the same
 * validated redirect chain. A host that cannot answer HEAD (405/501) gets the benefit of the
 * doubt; a refusal, a non-image, an over-limit declared size, or silence does not.
 */
export const probeImageUrl = Effect.fn("ImageProxyFetch.probeImageUrl")(function* (url: string) {
  const parsed = parseImageProxyTarget(url);
  if (!("url" in parsed)) return false;
  const response = yield* fetchFollowingRedirects(parsed.url, "HEAD").pipe(
    Effect.timeout(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => null),
    Effect.scoped,
  );
  if (response === null) return false;
  if (response.status === 405 || response.status === 501) return true;
  if (response.status >= 400) return false;
  const declaredLength = Number(response.headers["content-length"]);
  return (
    selectProxiedImageResponse({
      status: response.status,
      contentType: response.headers["content-type"],
      declaredLength: Number.isInteger(declaredLength) ? declaredLength : undefined,
      bodyLength: 0,
    }).status === 200
  );
});

/** One deadline for the whole fetch: every hop, its DNS, and the full body. */
const IMAGE_FETCH_TIMEOUT = "15 seconds";

/**
 * The body as one buffer, or null once it passes the cap. Counting bytes, not
 * chunks: stopping early ends the stream, which cancels the upstream read.
 */
const readCappedBody = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let length = 0;
    yield* stream.pipe(
      Stream.runForEachWhile((chunk) =>
        Effect.sync(() => {
          length += chunk.length;
          if (length > MAX_PROXIED_IMAGE_BYTES) return false;
          chunks.push(chunk);
          return true;
        }),
      ),
    );
    if (length > MAX_PROXIED_IMAGE_BYTES) return null;
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return body;
  });

const fetchProxiedImage = Effect.fn("ImageProxyFetch.fetchProxiedImage")(function* (url: string) {
  const response = yield* fetchFollowingRedirects(url);
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
  // Refuse an over-limit body before buffering a byte of it; the capped read
  // below catches upstreams that lie about (or omit) the length.
  if (declaredLength !== undefined && declaredLength > MAX_PROXIED_IMAGE_BYTES) {
    return HttpServerResponse.text("The image is larger than the proxy limit.", { status: 413 });
  }
  const body = yield* readCappedBody(response.stream);
  if (body === null) {
    return HttpServerResponse.text("The image is larger than the proxy limit.", { status: 413 });
  }
  const decision = selectProxiedImageResponse({
    status: response.status,
    contentType: response.headers["content-type"],
    declaredLength,
    bodyLength: body.length,
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
  return HttpServerResponse.uint8Array(body, {
    contentType: decision.contentType,
    headers: imageProxyResponseHeaders(decision.contentType),
  });
});

/**
 * A public https image's bytes and type, fetched through the same validated,
 * pinned redirect chain as the proxy. Null for anything that is not an image
 * of at most `maxBytes`, and on any failure or timeout.
 */
export const fetchImageBytes = Effect.fn("ImageProxyFetch.fetchImageBytes")(function* (
  rawUrl: string,
  maxBytes: number,
) {
  const parsed = parseImageProxyTarget(rawUrl);
  if (!("url" in parsed)) return null;
  return yield* Effect.gen(function* () {
    const response = yield* fetchFollowingRedirects(parsed.url);
    if (response === null || response.status >= 300) return null;
    const declaredLength = Number(response.headers["content-length"]);
    if (Number.isInteger(declaredLength) && declaredLength > maxBytes) return null;
    const body = yield* readCappedBody(response.stream);
    if (body === null || body.length === 0 || body.length > maxBytes) return null;
    const decision = selectProxiedImageResponse({
      status: response.status,
      contentType: response.headers["content-type"],
      declaredLength: undefined,
      bodyLength: body.length,
    });
    return decision.status === 200 && "contentType" in decision
      ? { bytes: body, contentType: decision.contentType }
      : null;
  }).pipe(
    Effect.scoped,
    Effect.timeout(IMAGE_FETCH_TIMEOUT),
    Effect.orElseSucceed(() => null),
  );
});

/**
 * Serves a third-party image through this origin so chat clients dodge
 * hotlink protection, mixed content, and tracker cookies. Https only, images
 * only, bounded in size and time. The fetch has its own scope, so the
 * upstream request is aborted the moment it finishes, fails, or times out.
 */
export const imageProxyResponse = Effect.fn("ImageProxyFetch.imageProxyResponse")(function* (
  rawUrl: string,
) {
  const parsed = parseImageProxyTarget(rawUrl);
  if (!("url" in parsed)) {
    return HttpServerResponse.text(parsed.error.message, { status: parsed.error.status });
  }
  return yield* fetchProxiedImage(parsed.url).pipe(
    Effect.scoped,
    Effect.timeout(IMAGE_FETCH_TIMEOUT),
    Effect.orElseSucceed(() =>
      HttpServerResponse.text("The image could not be fetched.", { status: 502 }),
    ),
  );
});
