import { ImageSearchError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { assert, describe, it } from "@effect/vitest";

import { probeImageUrl } from "../assets/ImageProxyFetch.ts";
import {
  commonsResponseToResult,
  keepReachableImages,
  makeWikimediaBackend,
  wikimediaSearchUrl,
} from "./ImageSearchService.ts";

const commonsPayload = {
  query: {
    pages: [
      {
        pageid: 1,
        title: "File:Red_fox_sitting.jpg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/1/2/Red_fox_sitting.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Red_fox_sitting.jpg",
            thumburl:
              "https://upload.wikimedia.org/wikipedia/commons/thumb/1/2/Red_fox_sitting.jpg/640px-Red_fox_sitting.jpg",
            width: 4000,
            height: 3000,
          },
        ],
      },
      // No imageinfo: skipped, never an empty-URL result.
      { pageid: 2, title: "File:Missing.jpg" },
      // Non-https file URL: skipped.
      {
        pageid: 3,
        title: "File:Plain.jpg",
        imageinfo: [{ url: "http://example.com/plain.jpg" }],
      },
    ],
  },
};

describe("wikimedia image search backend", () => {
  it("requests the Commons file namespace with image info", () => {
    const url = new URL(wikimediaSearchUrl("red fox", 4));
    assert.equal(url.origin, "https://commons.wikimedia.org");
    assert.equal(url.searchParams.get("generator"), "search");
    assert.equal(url.searchParams.get("gsrsearch"), "red fox");
    assert.equal(url.searchParams.get("gsrnamespace"), "6");
    assert.equal(url.searchParams.get("gsrlimit"), "4");
    assert.equal(url.searchParams.get("prop"), "imageinfo");
  });

  it.effect("maps Commons pages to results and skips unusable entries", () =>
    Effect.gen(function* () {
      let requested: string | undefined;
      const backend = makeWikimediaBackend((url) => {
        requested = url;
        return Effect.succeed(commonsPayload);
      });
      const result = yield* backend.search("red fox", 4);
      assert.include(requested ?? "", "gsrsearch=red+fox");
      assert.deepEqual(result, {
        results: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/1/2/Red_fox_sitting.jpg",
            thumbnailUrl:
              "https://upload.wikimedia.org/wikipedia/commons/thumb/1/2/Red_fox_sitting.jpg/640px-Red_fox_sitting.jpg",
            width: 4000,
            height: 3000,
            title: "Red fox sitting.jpg",
            sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Red_fox_sitting.jpg",
          },
        ],
      });
    }),
  );

  it.effect("returns no results when Commons finds nothing", () =>
    Effect.gen(function* () {
      const backend = makeWikimediaBackend(() => Effect.succeed({ batchcomplete: true }));
      const result = yield* backend.search("nothing matches this", 4);
      assert.deepEqual(result, { results: [] });
    }),
  );

  it.effect("fails the search when the fetch fails", () =>
    Effect.gen(function* () {
      const backend = makeWikimediaBackend(() =>
        Effect.fail(new ImageSearchError({ operation: "search", cause: "offline" })),
      );
      const exit = yield* Effect.exit(backend.search("red fox", 4));
      assert.equal(exit._tag, "Failure");
    }),
  );

  it.effect("fails the search when Commons answers outside its schema", () =>
    Effect.gen(function* () {
      const backend = makeWikimediaBackend(() =>
        Effect.succeed({ query: { pages: [{ title: 42 }] } }),
      );
      const exit = yield* Effect.exit(backend.search("red fox", 4));
      assert.equal(exit._tag, "Failure");
    }),
  );

  it("maps a bare decoded response without pages to no results", () => {
    assert.deepEqual(commonsResponseToResult({}), { results: [] });
  });
});

// Each host answers HEAD like the images an agent might be handed: a real one, a page that
// 200s with HTML, a dead link, a host without HEAD, and one that never answers.
const upstreamAnswers: Record<string, () => Response | Promise<Response>> = {
  "https://img.test/ok.jpg": () =>
    new Response(null, { headers: { "content-type": "image/jpeg" } }),
  "https://img.test/page.jpg": () =>
    new Response(null, { headers: { "content-type": "text/html" } }),
  "https://img.test/dead.jpg": () => new Response(null, { status: 404 }),
  "https://img.test/nohead.jpg": () => new Response(null, { status: 405 }),
  "https://img.test/huge.jpg": () =>
    new Response(null, {
      headers: { "content-type": "image/jpeg", "content-length": String(50 * 1024 * 1024) },
    }),
  "https://img.test/silent.jpg": () => new Promise<Response>(() => {}),
};
const methods: string[] = [];
const mockUpstream = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.promise(async () => {
      methods.push(request.method);
      const answer = upstreamAnswers[request.url];
      return HttpClientResponse.fromWeb(
        request,
        answer ? await answer() : new Response(null, { status: 404 }),
      );
    }),
  ),
);

const searchResult = (...urls: string[]) => ({
  results: urls.map((url) => ({ url, title: url })),
});

describe("image search result verification", () => {
  it.effect("keeps only results whose image URL answers as an image", () =>
    Effect.gen(function* () {
      const search = yield* Effect.forkChild(
        keepReachableImages(
          searchResult(...Object.keys(upstreamAnswers), "https://127.0.0.1/internal.jpg"),
          probeImageUrl,
        ).pipe(Effect.provide(mockUpstream)),
      );
      // The silent host is only dropped once its probe times out.
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(search);
      assert.deepEqual(
        result.results.map((item) => item.url),
        // The host without HEAD support keeps the benefit of the doubt.
        ["https://img.test/ok.jpg", "https://img.test/nohead.jpg"],
      );
    }),
  );

  it.effect("asks with HEAD, never downloading the image", () =>
    Effect.gen(function* () {
      methods.length = 0;
      yield* probeImageUrl("https://img.test/ok.jpg").pipe(Effect.provide(mockUpstream));
      assert.deepEqual(methods, ["HEAD"]);
    }),
  );
});
