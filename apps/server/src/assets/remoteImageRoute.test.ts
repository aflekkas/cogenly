import { assert, describe, it } from "@effect/vitest";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { layerAssetRoute, layerImageProxyRoute } from "../http.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { issueAssetUrl } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const requestedUpstreams: string[] = [];

// The upstream image host: answers any https URL with a PNG.
const upstream = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      requestedUpstreams.push(request.url);
      return HttpClientResponse.fromWeb(
        request,
        new Response(IMAGE_BYTES, { headers: { "content-type": "image/png" } }),
      );
    }),
  ),
);

// No credential ever authenticates: this is what a bearer-only client's `<img>` looks like.
const noSession = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: () =>
    Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError()),
});

const services = Layer.mergeAll(
  upstream,
  noSession,
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(9)),
  }),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(GitHubCredentials.GitHubCredentials)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-remote-image-route-" }),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer)));

const get = (path: string) =>
  Effect.gen(function* () {
    const handler = yield* HttpRouter.toHttpEffect(
      Layer.mergeAll(layerAssetRoute, layerImageProxyRoute),
    );
    const response = yield* handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`http://127.0.0.1${path}`)),
      ),
    );
    return HttpServerResponse.toWeb(response);
  }).pipe(Effect.scoped, Effect.provide(services));

describe("remote image routes", () => {
  it.effect("serves a signed image URL with no session", () =>
    Effect.gen(function* () {
      requestedUpstreams.length = 0;
      const { relativeUrl } = yield* issueAssetUrl({
        resource: { _tag: "remote-image", url: "https://cdn.test/photos/a.png" },
      });
      const response = yield* get(relativeUrl);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.deepEqual(
        new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
        IMAGE_BYTES,
      );
      assert.deepEqual(requestedUpstreams, ["https://cdn.test/photos/a.png"]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("does not serve a tampered signature", () =>
    Effect.gen(function* () {
      requestedUpstreams.length = 0;
      const { relativeUrl } = yield* issueAssetUrl({
        resource: { _tag: "remote-image", url: "https://cdn.test/photos/a.png" },
      });
      const [, , , token = "", name = ""] = relativeUrl.split("/");
      const [payload = "", signature = ""] = token.split(".");
      const response = yield* get(`/api/assets/${payload}.${signature.slice(0, -2)}AA/${name}`);
      assert.equal(response.status, 404);
      assert.deepEqual(requestedUpstreams, []);
    }).pipe(Effect.provide(services)),
  );

  it.effect("still requires a session on the unsigned image proxy", () =>
    Effect.gen(function* () {
      requestedUpstreams.length = 0;
      const response = yield* get(
        `/api/image-proxy?url=${encodeURIComponent("https://cdn.test/photos/a.png")}`,
      );
      assert.equal(response.status, 401);
      assert.deepEqual(requestedUpstreams, []);
    }).pipe(Effect.provide(services)),
  );
});
