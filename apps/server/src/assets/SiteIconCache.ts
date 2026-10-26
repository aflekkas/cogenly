/**
 * SiteIconCache - website icons by host, cached on this server's disk.
 *
 * Vault logins show their site's icon in Settings and on sign-in cards, on
 * every client and connection mode, so the icon is fetched once here and
 * served as a signed `site-icon` asset rather than hotlinked by each client.
 * The favicon comes the way `SiteFavicon` asks for one (Google's favicon
 * service by public hostname), then the site's own `/favicon.ico`. An icon an
 * agent supplied wins over the fetched one and never expires.
 *
 * Any feature that shows a site by host can resolve through this service.
 *
 * @module SiteIconCache
 */
import { faviconUrlForOrigin } from "@cogenly/shared/favicon";
import { isProjectFaviconPath } from "@cogenly/shared/projectFavicon";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import * as ServerConfig from "../config.ts";
import { inferImageExtension, parseBase64DataUrl } from "../imageMime.ts";
import { fetchImageBytes } from "./ImageProxyFetch.ts";

export interface SiteIconImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Fetches one image URL: its bytes and type, or null for a miss or failure. */
export type SiteIconFetch = (url: string, maxBytes: number) => Effect.Effect<SiteIconImage | null>;

export class SiteIconCache extends Context.Service<
  SiteIconCache,
  {
    /** The cached icon file for a host, fetching its favicon on a miss; null when it has none. */
    readonly resolve: (host: string) => Effect.Effect<string | null>;
    /** Fetches a host's favicon unless an icon is cached: the save-time prefetch and backfill. */
    readonly ensure: (host: string) => Effect.Effect<void>;
    /**
     * Caches an icon an agent supplied (https or image data URL) as the host's
     * icon. False when it is not a usable image; the fetched favicon stays.
     */
    readonly provide: (host: string, iconUrl: string) => Effect.Effect<boolean>;
  }
>()("cogenly-server/assets/SiteIconCache") {}

export const MAX_SITE_ICON_BYTES = 256 * 1024;
// A fetched icon is refetched after a month; a host with none is not asked again for an hour.
const FETCHED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** A lowercase hostname, or null for anything that is not one. */
export const siteIconHost = (host: string): string | null => {
  const normalized = host.trim().toLowerCase().replace(/\.+$/, "");
  return normalized.length > 0 && normalized.length <= 253 && HOST_PATTERN.test(normalized)
    ? normalized
    : null;
};

/** Where a host's favicon is asked for, in order. */
export const siteIconCandidates = (host: string): ReadonlyArray<string> => {
  const service = faviconUrlForOrigin(`https://${host}`, 64);
  return [...(service === null ? [] : [service]), `https://${host}/favicon.ico`];
};

const extensionFor = (contentType: string): string | null => {
  const type = contentType.toLowerCase();
  const extension =
    type === "image/x-icon" || type === "image/vnd.microsoft.icon"
      ? ".ico"
      : inferImageExtension({ mimeType: type });
  return isProjectFaviconPath(`icon${extension}`) ? extension : null;
};

type Source = "provided" | "fetched";

export const makeWith = (fetchImage: SiteIconFetch) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const cacheDir = path.join(config.providerStatusCacheDir, "site-icons");
    const misses = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    const digestOf = (host: string) =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(host))
        .pipe(Effect.map((bytes) => Hex.encode(bytes).slice(0, 40)));

    /** The cached file for a host from one source, if any. */
    const cachedFile = (digest: string, source: Source) =>
      fileSystem.readDirectory(cacheDir).pipe(
        Effect.map((names) => {
          const name = names.find((entry) => entry.startsWith(`${digest}.${source}.`));
          return name === undefined ? null : path.join(cacheDir, name);
        }),
        Effect.orElseSucceed(() => null),
      );

    const ageOf = (file: string) =>
      Effect.gen(function* () {
        const info = yield* fileSystem.stat(file).pipe(Effect.option);
        const mtime = Option.flatMap(info, (stat) => stat.mtime);
        if (Option.isNone(mtime)) return Number.POSITIVE_INFINITY;
        return (yield* Clock.currentTimeMillis) - mtime.value.getTime();
      });

    /** Replaces a host's icon from one source, written whole so a reader never sees half. */
    const store = (digest: string, source: Source, image: SiteIconImage) =>
      Effect.gen(function* () {
        const extension = extensionFor(image.contentType);
        if (extension === null) return null;
        yield* fileSystem.makeDirectory(cacheDir, { recursive: true });
        const previous = yield* cachedFile(digest, source);
        const target = path.join(cacheDir, `${digest}.${source}${extension}`);
        const staging = `${target}.tmp`;
        yield* fileSystem.writeFile(staging, image.bytes);
        yield* fileSystem.rename(staging, target);
        if (previous !== null && previous !== target) yield* fileSystem.remove(previous);
        return target;
      }).pipe(Effect.orElseSucceed(() => null));

    const fetchFavicon = (host: string, digest: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (((yield* Ref.get(misses)).get(host) ?? 0) > now) return null;
        for (const url of siteIconCandidates(host)) {
          const image = yield* fetchImage(url, MAX_SITE_ICON_BYTES).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (image === null) continue;
          const stored = yield* store(digest, "fetched", image);
          if (stored !== null) return stored;
        }
        yield* Ref.update(misses, (current) => new Map(current).set(host, now + MISS_TTL_MS));
        return null;
      });

    const lookup = (rawHost: string, fetchOnMiss: boolean) =>
      Effect.gen(function* () {
        const host = siteIconHost(rawHost);
        if (host === null) return null;
        const digest = yield* digestOf(host);
        const provided = yield* cachedFile(digest, "provided");
        if (provided !== null) return provided;
        const fetched = yield* cachedFile(digest, "fetched");
        if (fetched !== null && (yield* ageOf(fetched)) < FETCHED_MAX_AGE_MS) return fetched;
        if (!fetchOnMiss) return fetched;
        // A stale icon beats none when the site cannot be reached now.
        return (yield* fetchFavicon(host, digest)) ?? fetched;
      }).pipe(Effect.orElseSucceed(() => null));

    const provide: SiteIconCache["Service"]["provide"] = (rawHost, iconUrl) =>
      Effect.gen(function* () {
        const host = siteIconHost(rawHost);
        if (host === null) return false;
        const dataUrl = parseBase64DataUrl(iconUrl);
        let image: SiteIconImage | null = null;
        if (dataUrl !== null) {
          const decoded = Base64.decode(dataUrl.base64);
          image =
            Result.isSuccess(decoded) &&
            decoded.success.length > 0 &&
            decoded.success.length <= MAX_SITE_ICON_BYTES &&
            dataUrl.mimeType.startsWith("image/")
              ? { bytes: decoded.success, contentType: dataUrl.mimeType }
              : null;
        } else {
          image = yield* fetchImage(iconUrl, MAX_SITE_ICON_BYTES).pipe(
            Effect.orElseSucceed(() => null),
          );
        }
        if (image === null) return false;
        return (yield* store(yield* digestOf(host), "provided", image)) !== null;
      }).pipe(
        Effect.orElseSucceed(() => false),
        Effect.withSpan("SiteIconCache.provide"),
      );

    return SiteIconCache.of({
      resolve: (host) => lookup(host, true).pipe(Effect.withSpan("SiteIconCache.resolve")),
      ensure: (host) =>
        lookup(host, true).pipe(Effect.asVoid, Effect.withSpan("SiteIconCache.ensure")),
      provide,
    });
  });

const liveFetch: SiteIconFetch = (url, maxBytes) =>
  fetchImageBytes(url, maxBytes).pipe(Effect.provide(FetchHttpClient.layer));

export const layer = Layer.effect(SiteIconCache, makeWith(liveFetch));
