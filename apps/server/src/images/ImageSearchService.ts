import {
  ImageSearchError,
  ImageSearchResult,
  type ImageSearchInput,
  type ImageSearchResultItem,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { probeImageUrl } from "../assets/ImageProxyFetch.ts";

/**
 * A source of web images behind the `image_search` tool. Wikimedia Commons
 * ships as the default backend (no key needed); add others by implementing
 * this interface and swapping the backend in {@link layer}.
 */
export interface ImageSearchBackend {
  readonly search: (
    query: string,
    limit: number,
  ) => Effect.Effect<ImageSearchResult, ImageSearchError>;
}

export class ImageSearchService extends Context.Service<
  ImageSearchService,
  {
    readonly search: (
      input: ImageSearchInput,
    ) => Effect.Effect<ImageSearchResult, ImageSearchError>;
  }
>()("cogenly-server/images/ImageSearchService") {}

const COMMONS_API_ENDPOINT = "https://commons.wikimedia.org/w/api.php";
const COMMONS_USER_AGENT = "CogenlyImageSearch/1.0";
/** The conversation prompt asks for 1-4 inline images, so four is the default. */
const DEFAULT_LIMIT = 4;

/** `action=query&generator=search` response in `formatversion=2` shape. */
const CommonsImageInfo = Schema.Struct({
  url: Schema.optional(Schema.String),
  descriptionurl: Schema.optional(Schema.String),
  thumburl: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
});
const CommonsPage = Schema.Struct({
  title: Schema.String,
  imageinfo: Schema.optional(Schema.Array(CommonsImageInfo)),
});
const CommonsResponse = Schema.Struct({
  query: Schema.optional(Schema.Struct({ pages: Schema.optional(Schema.Array(CommonsPage)) })),
});
const decodeCommonsResponse = Schema.decodeUnknownEffect(CommonsResponse);

export const wikimediaSearchUrl = (query: string, limit: number): string => {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|size",
    iiurlwidth: "640",
  });
  return `${COMMONS_API_ENDPOINT}?${params.toString()}`;
};

const asHttpsUrl = (value: string | undefined): string | undefined =>
  value !== undefined && value.startsWith("https://") ? value : undefined;

const asPositiveInt = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;

const displayTitle = (title: string): string => title.replace(/^File:/, "").replace(/_/g, " ");

const toResultItem = (page: typeof CommonsPage.Type): ImageSearchResultItem | null => {
  const info = page.imageinfo?.[0];
  const url = asHttpsUrl(info?.url);
  if (url === undefined) return null;
  const thumbnailUrl = asHttpsUrl(info?.thumburl);
  const width = asPositiveInt(info?.width);
  const height = asPositiveInt(info?.height);
  const sourcePageUrl = asHttpsUrl(info?.descriptionurl);
  return {
    url,
    ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    title: displayTitle(page.title),
    ...(sourcePageUrl === undefined ? {} : { sourcePageUrl }),
  };
};

export const commonsResponseToResult = (
  response: typeof CommonsResponse.Type,
): ImageSearchResult => ({
  results: (response.query?.pages ?? []).flatMap((page) => {
    const item = toResultItem(page);
    return item === null ? [] : [item];
  }),
});

/**
 * Wikimedia Commons backend. `fetchJson` is injected so tests can drive the
 * mapping without the network; production wires it to the shared HttpClient.
 */
export const makeWikimediaBackend = (
  fetchJson: (url: string) => Effect.Effect<unknown, ImageSearchError>,
): ImageSearchBackend => ({
  search: (query, limit) =>
    Effect.gen(function* () {
      const json = yield* fetchJson(wikimediaSearchUrl(query, limit));
      const response = yield* decodeCommonsResponse(json).pipe(
        Effect.mapError((cause) => new ImageSearchError({ operation: "search", cause })),
      );
      return commonsResponseToResult(response);
    }),
});

const failed = (cause: unknown) => new ImageSearchError({ operation: "search", cause });

/**
 * Drops results whose image URL does not answer as an image, so agents embed fewer dead
 * pictures. The probes run in parallel (at most the search limit of ten), each bounded by the
 * probe's own timeout, so the extra latency is one slow host, not the sum of all of them.
 */
export const keepReachableImages = <E, R>(
  result: ImageSearchResult,
  probe: (url: string) => Effect.Effect<boolean, E, R>,
): Effect.Effect<ImageSearchResult, E, R> =>
  Effect.forEach(result.results, (item) => probe(item.url), { concurrency: "unbounded" }).pipe(
    Effect.map((reachable) => ({
      results: result.results.filter((_, index) => reachable[index] === true),
    })),
  );

export const layer: Layer.Layer<ImageSearchService, never, HttpClient.HttpClient> = Layer.effect(
  ImageSearchService,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const backend = makeWikimediaBackend((url) =>
      client
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("user-agent", COMMONS_USER_AGENT),
            HttpClientRequest.setHeader("accept", "application/json"),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.timeout("10 seconds"),
          Effect.mapError(failed),
        ),
    );
    return ImageSearchService.of({
      search: (input) =>
        backend
          .search(input.query.trim(), input.limit ?? DEFAULT_LIMIT)
          .pipe(
            Effect.flatMap((result) =>
              keepReachableImages(result, (url) =>
                probeImageUrl(url).pipe(Effect.provideService(HttpClient.HttpClient, client)),
              ),
            ),
          ),
    });
  }),
);
