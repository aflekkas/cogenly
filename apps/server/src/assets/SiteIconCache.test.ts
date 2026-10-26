import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as SiteIconCache from "./SiteIconCache.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** A fake network: answers per URL and records every request. */
const network = (answers: Record<string, SiteIconCache.SiteIconImage | null>) => {
  const requests: Array<string> = [];
  const fetch: SiteIconCache.SiteIconFetch = (url) =>
    Effect.sync(() => {
      requests.push(url);
      return answers[url] ?? null;
    });
  return { requests, fetch };
};

const cacheWith = (fetch: SiteIconCache.SiteIconFetch) =>
  Layer.effect(SiteIconCache.SiteIconCache, SiteIconCache.makeWith(fetch)).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "site-icon-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );

const [service, own] = SiteIconCache.siteIconCandidates("github.com");

describe("SiteIconCache", () => {
  it("asks the favicon service, then the site itself, and only for real hostnames", () => {
    expect(service).toBe("https://www.google.com/s2/favicons?domain=github.com&sz=64");
    expect(own).toBe("https://github.com/favicon.ico");
    expect(SiteIconCache.siteIconHost("GitHub.com.")).toBe("github.com");
    expect(SiteIconCache.siteIconHost("../etc/passwd")).toBeNull();
    // A private host never goes to the public favicon service.
    expect(SiteIconCache.siteIconCandidates("router.local")).toEqual([
      "https://router.local/favicon.ico",
    ]);
  });

  it.effect("fetches a favicon once and serves the cached file after", () => {
    const fake = network({ [service!]: { bytes: PNG, contentType: "image/png" } });
    return Effect.gen(function* () {
      const icons = yield* SiteIconCache.SiteIconCache;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* icons.ensure("github.com");
      const path = yield* icons.resolve("GitHub.com");
      expect(path).toMatch(/\.fetched\.png$/);
      expect([...(yield* fileSystem.readFile(path!))]).toEqual([...PNG]);
      expect(fake.requests).toEqual([service]);
    }).pipe(Effect.provide(cacheWith(fake.fetch)));
  });

  it.effect("falls back to the site's own favicon, and to none without retrying at once", () => {
    const fake = network({ [own!]: { bytes: PNG, contentType: "image/x-icon" } });
    const unreachable = network({});
    return Effect.gen(function* () {
      const icons = yield* SiteIconCache.SiteIconCache;
      expect(yield* icons.resolve("github.com")).toMatch(/\.fetched\.ico$/);
      expect(fake.requests).toEqual([service, own]);
    })
      .pipe(Effect.provide(cacheWith(fake.fetch)))
      .pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const icons = yield* SiteIconCache.SiteIconCache;
            expect(yield* icons.resolve("nothing.test")).toBeNull();
            expect(yield* icons.resolve("nothing.test")).toBeNull();
            // One ask (a .test host skips the public service); the miss is remembered,
            // so a failing site is not asked again on every render.
            expect(unreachable.requests).toEqual(["https://nothing.test/favicon.ico"]);
          }).pipe(Effect.provide(cacheWith(unreachable.fetch))),
        ),
      );
  });

  it.effect("keeps an icon an agent supplied over the fetched favicon", () => {
    const fake = network({ [service!]: { bytes: PNG, contentType: "image/png" } });
    return Effect.gen(function* () {
      const icons = yield* SiteIconCache.SiteIconCache;
      yield* icons.ensure("adso.test");
      const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
      expect(yield* icons.provide("adso.test", svg)).toBe(true);
      expect(yield* icons.resolve("adso.test")).toMatch(/\.provided\.svg$/);
      // Not an image: refused, and the cached icon stays.
      expect(yield* icons.provide("adso.test", "data:text/html;base64,PGI+")).toBe(false);
      expect(yield* icons.resolve("adso.test")).toMatch(/\.provided\.svg$/);
    }).pipe(Effect.provide(cacheWith(fake.fetch)));
  });
});
