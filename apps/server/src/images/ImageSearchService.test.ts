import { ImageSearchError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { assert, describe, it } from "@effect/vitest";

import {
  commonsResponseToResult,
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
