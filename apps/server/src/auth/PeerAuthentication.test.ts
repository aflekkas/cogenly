import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthPeerScopes } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpServerRequest } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  createPeerDpopProof,
  getOrCreatePeerDpopKey,
  removePeerDpopKey,
} from "../machines/peerCrypto.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlitePersistence.layerMemory,
      ServerSecretStore.layer,
      ServerEnvironment.layerIdentity,
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cogenly-peer-auth-" })),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(NodeServices.layer),
);

const issuePeer = Effect.gen(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const key = yield* getOrCreatePeerDpopKey;
  const grant = yield* auth.issuePeerGrant({ label: "Spoke", proofKeyThumbprint: key.thumbprint });
  return {
    key,
    issued: yield* auth.redeemPeerGrant({
      credential: grant.credential,
      proofKeyThumbprint: key.thumbprint,
      client: { deviceType: "bot" },
    }),
  };
});
const socketRequest = (ticket: string, path = "peer") =>
  HttpServerRequest.fromWeb(new Request(`http://127.0.0.1:4773/${path}?wsTicket=${ticket}`));

describe("peer authentication", () => {
  it.effect("refuses unbound legacy grants, wrong keys, spent grants, and expired grants", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const key = yield* getOrCreatePeerDpopKey;
      const redeem = (credential: string, proofKeyThumbprint = key.thumbprint) =>
        auth.redeemPeerGrant({ credential, proofKeyThumbprint, client: { deviceType: "bot" } });
      const legacy = yield* grants.issueOneTimeToken({ subject: "peer", scopes: AuthPeerScopes });
      assert.strictEqual(
        (yield* redeem(legacy.credential).pipe(Effect.flip))._tag,
        "ServerAuthInvalidCredentialError",
      );
      const grant = yield* auth.issuePeerGrant({
        label: "Bound",
        proofKeyThumbprint: key.thumbprint,
      });
      assert.strictEqual(
        (yield* redeem(grant.credential, "wrong-key").pipe(Effect.flip))._tag,
        "ServerAuthInvalidCredentialError",
      );
      yield* redeem(grant.credential);
      assert.strictEqual(
        (yield* redeem(grant.credential).pipe(Effect.flip))._tag,
        "ServerAuthInvalidCredentialError",
      );
      const expired = yield* auth.issuePeerGrant({
        label: "Expired",
        proofKeyThumbprint: key.thumbprint,
      });
      yield* TestClock.adjust("10 minutes");
      assert.strictEqual(
        (yield* redeem(expired.credential).pipe(Effect.flip))._tag,
        "ServerAuthInvalidCredentialError",
      );
    }).pipe(Effect.provide(layerAuth), Effect.scoped),
  );

  it.effect(
    "refuses peer tokens signed by another key and keeps HTTP, client WebSocket, and MCP audiences isolated",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const { key, issued } = yield* issuePeer;
        const request = (path: string, proofKey = key) =>
          Effect.gen(function* () {
            const url = `http://127.0.0.1:4773/${path}`;
            const dpop = yield* createPeerDpopProof({
              key: proofKey,
              method: "POST",
              url,
              accessToken: issued.token,
            });
            return HttpServerRequest.fromWeb(
              new Request(url, {
                method: "POST",
                headers: { host: "127.0.0.1:4773", authorization: `DPoP ${issued.token}`, dpop },
              }),
            );
          });
        yield* removePeerDpopKey;
        const otherKey = yield* getOrCreatePeerDpopKey;
        assert.notStrictEqual(otherKey.thumbprint, key.thumbprint);
        assert.strictEqual(
          (yield* auth
            .authenticatePeerRequest(yield* request("peer/ticket", otherKey))
            .pipe(Effect.flip))._tag,
          "ServerAuthInvalidCredentialError",
        );
        const session = yield* auth.authenticatePeerRequest(yield* request("peer/ticket"));
        assert.deepStrictEqual(session.scopes, [...AuthPeerScopes]);
        assert.strictEqual(
          (yield* auth
            .authenticateHttpRequest(yield* request("api/project/files"))
            .pipe(Effect.flip))._tag,
          "ServerAuthInvalidCredentialError",
        );
        const ticket = yield* auth.issueWebSocketTicket(session);
        assert.strictEqual(
          (yield* auth
            .authenticateWebSocketUpgrade(socketRequest(ticket.ticket, "ws"))
            .pipe(Effect.flip))._tag,
          "ServerAuthInvalidCredentialError",
        );
        assert.strictEqual(
          (yield* auth
            .authenticateMcpClient(
              HttpServerRequest.fromWeb(
                new Request("http://127.0.0.1:4773/mcp", {
                  headers: { authorization: `Bearer ${issued.token}` },
                }),
              ),
            )
            .pipe(Effect.flip))._tag,
          "ServerAuthInvalidCredentialError",
        );
      }).pipe(Effect.provide(layerAuth), Effect.scoped),
  );

  it.effect("rejects revoked and expired socket tickets and expires year-long peer sessions", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const { issued } = yield* issuePeer;
      const revoked = yield* auth.issueWebSocketTicket(issued.session);
      yield* auth.revokeSession(issued.session.sessionId);
      assert.strictEqual(
        (yield* auth.authenticatePeerWebSocket(socketRequest(revoked.ticket)).pipe(Effect.flip))
          ._tag,
        "ServerAuthInvalidCredentialError",
      );
      const second = (yield* issuePeer).issued;
      const ticket = yield* auth.issueWebSocketTicket(second.session);
      assert.strictEqual(
        (yield* auth.authenticatePeerWebSocket(socketRequest(ticket.ticket))).sessionId,
        second.session.sessionId,
      );
      yield* TestClock.setTime(DateTime.toEpochMillis(ticket.expiresAt));
      assert.strictEqual(
        (yield* auth.authenticatePeerWebSocket(socketRequest(ticket.ticket)).pipe(Effect.flip))
          ._tag,
        "ServerAuthInvalidCredentialError",
      );
      // Even a freshly minted ticket cannot outlive its peer session.
      yield* TestClock.setTime(DateTime.toEpochMillis(second.expiresAt));
      const afterExpiry = yield* auth.issueWebSocketTicket(second.session);
      assert.strictEqual(
        (yield* auth.authenticatePeerWebSocket(socketRequest(afterExpiry.ticket)).pipe(Effect.flip))
          ._tag,
        "ServerAuthInvalidCredentialError",
      );
    }).pipe(Effect.provide(layerAuth), Effect.scoped),
  );
});
