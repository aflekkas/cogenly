import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpServerResponse } from "effect/http";

import type { ResolvedAddress } from "../security/PublicAddress.ts";
import { ImageProxyHostLookup, imageProxyResponse } from "./ImageProxyFetch.ts";

const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// What each name resolves to. A name missing here does not resolve.
const dns: Record<string, ReadonlyArray<ResolvedAddress>> = {
  "cdn.test": [PUBLIC],
  "rebind.test": [{ address: "127.0.0.1", family: 4 }],
  "mixed.test": [PUBLIC, { address: "10.0.0.5", family: 4 }],
  "mapped.test": [{ address: "::ffff:127.0.0.1", family: 6 }],
  "internal.test": [{ address: "192.168.1.10", family: 4 }],
  localhost: [{ address: "127.0.0.1", family: 4 }],
};
const lookups: string[] = [];
const requested: string[] = [];

const upstream = Layer.mergeAll(
  Layer.succeed(ImageProxyHostLookup, async (host: string) => {
    lookups.push(host);
    return dns[host] ?? [];
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requested.push(request.url);
        const url = new URL(request.url);
        if (url.pathname === "/redirect") {
          return HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              status: 302,
              headers: { location: url.searchParams.get("to") ?? "" },
            }),
          );
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(IMAGE_BYTES, { headers: { "content-type": "image/png" } }),
        );
      }),
    ),
  ),
);

const proxy = (url: string) =>
  Effect.gen(function* () {
    lookups.length = 0;
    requested.length = 0;
    const response = yield* imageProxyResponse(url).pipe(Effect.scoped);
    return HttpServerResponse.toWeb(response);
  }).pipe(Effect.provide(upstream));

describe("imageProxyResponse address checks", () => {
  it.effect("serves an image whose host resolves to a public address", () =>
    Effect.gen(function* () {
      const response = yield* proxy("https://cdn.test/a.png");
      assert.equal(response.status, 200);
      assert.deepEqual(lookups, ["cdn.test"]);
      assert.deepEqual(requested, ["https://cdn.test/a.png"]);
    }),
  );

  it.effect.each([
    "https://localhost./a.png",
    "https://LOCALHOST/a.png",
    "https://100.64.1.2/a.png",
    "https://[::ffff:127.0.0.1]/a.png",
    "https://198.18.0.1/a.png",
  ])("refuses the internal literal %s without resolving or fetching it", (url) =>
    Effect.gen(function* () {
      const response = yield* proxy(url);
      assert.equal(response.status, 403);
      assert.deepEqual(lookups, []);
      assert.deepEqual(requested, []);
    }),
  );

  it.effect.each([
    "https://rebind.test/a.png",
    "https://rebind.test./a.png",
    "https://mixed.test/a.png",
    "https://mapped.test/a.png",
    "https://unresolvable.test/a.png",
  ])("refuses %s, whose name resolves to a non-public address, before connecting", (url) =>
    Effect.gen(function* () {
      const response = yield* proxy(url);
      assert.equal(response.status, 502);
      assert.deepEqual(requested, []);
    }),
  );

  it.effect("refuses a redirect into a name that resolves to a private address", () =>
    Effect.gen(function* () {
      const response = yield* proxy(
        `https://cdn.test/redirect?to=${encodeURIComponent("https://internal.test/a.png")}`,
      );
      assert.equal(response.status, 502);
      assert.deepEqual(lookups, ["cdn.test", "internal.test"]);
      assert.deepEqual(requested, [
        `https://cdn.test/redirect?to=${encodeURIComponent("https://internal.test/a.png")}`,
      ]);
    }),
  );
});
