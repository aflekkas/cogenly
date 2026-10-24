import { AssetRemoteImageUrlValidationError } from "@cogenly/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

const signingKey = new Uint8Array(32).fill(7);

// Only the signing key is read on the remote-image path; the rest of the service graph is
// what the other asset kinds use.
const layer = Layer.mergeAll(
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    getOrCreateRandom: () => Effect.succeed(signingKey),
  }),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-asset-access-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

// `/api/assets/<token>/<file name>` → the token and file name `resolveAsset` takes.
const splitAssetUrl = (relativeUrl: string) => {
  const [token = "", ...rest] = relativeUrl.slice("/api/assets/".length).split("/");
  return { token, fileName: rest.join("/") };
};

const mint = (url: string) =>
  issueAssetUrl({ resource: { _tag: "remote-image", url } }).pipe(
    Effect.map((issued) => ({ issued, ...splitAssetUrl(issued.relativeUrl) })),
  );

describe("remote-image asset URLs", () => {
  it.effect("signs a public https image so it resolves without a session", () =>
    Effect.gen(function* () {
      const { token, fileName } = yield* mint("https://littlespoonfarm.com/wp/photos/tomatoes.jpg");
      assert.equal(fileName, "tomatoes.jpg");
      assert.deepEqual(yield* resolveAsset(token, fileName), {
        kind: "remote-image",
        url: "https://littlespoonfarm.com/wp/photos/tomatoes.jpg",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses to sign anything the proxy would not fetch", () =>
    Effect.gen(function* () {
      for (const url of [
        "http://cdn.test/a.png",
        "https://127.0.0.1/a.png",
        "https://169.254.169.254/latest/meta-data",
        "not a url",
      ]) {
        const error = yield* mint(url).pipe(Effect.flip);
        assert.instanceOf(error, AssetRemoteImageUrlValidationError);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a signature that does not match its claims", () =>
    Effect.gen(function* () {
      const { token, fileName } = yield* mint("https://cdn.test/a.png");
      const [payload = "", signature = ""] = token.split(".");
      // Re-point the signed claims at another host while keeping the old signature.
      const forged = Buffer.from(
        Buffer.from(payload, "base64url")
          .toString("utf8")
          .replace("https://cdn.test/a.png", "https://evil.test/a.png"),
      ).toString("base64url");
      assert.isNull(yield* resolveAsset(`${forged}.${signature}`, fileName));
      assert.isNull(yield* resolveAsset(`${payload}.${signature.slice(0, -2)}AA`, fileName));
      assert.isNull(yield* resolveAsset(payload, fileName));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stops resolving once the URL expires, and a fresh mint works again", () =>
    Effect.gen(function* () {
      const first = yield* mint("https://cdn.test/a.png");
      const ttlMs = first.issued.expiresAt - (yield* Clock.currentTimeMillis);
      yield* TestClock.adjust(`${ttlMs - 1000} millis`);
      assert.isNotNull(yield* resolveAsset(first.token, first.fileName));
      yield* TestClock.adjust("2 seconds");
      assert.isNull(yield* resolveAsset(first.token, first.fileName));
      const second = yield* mint("https://cdn.test/a.png");
      assert.isNotNull(yield* resolveAsset(second.token, second.fileName));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names a bare host image after a fallback instead of an empty path segment", () =>
    Effect.gen(function* () {
      const { fileName } = yield* mint("https://cdn.test/");
      assert.equal(fileName, "image");
    }).pipe(Effect.provide(layer)),
  );
});
