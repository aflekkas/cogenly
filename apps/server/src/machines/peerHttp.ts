/**
 * The `/peer` endpoints, the only ones a `peer` session can use. A spoke
 * redeems its grant at `/peer/join` with a DPoP proof (no session yet),
 * trades its proof-bound token for a socket ticket at `/peer/ticket`, and
 * keeps `/peer` open as a WebSocket speaking `PeerRpcGroup`. Every other
 * path rejects the `peer` subject in EnvironmentAuth.
 */
import {
  AuthSyncReplicateScope,
  PEER_JOIN_PATH,
  PEER_IDENTITY_PATH,
  PeerIdentityRequest,
  PeerIdentityResult,
  PEER_METHODS,
  PEER_SOCKET_PATH,
  PEER_TICKET_PATH,
  PeerJoinRequest,
  PeerJoinResult,
  PeerRpcGroup,
  PeerScopeAuthorization,
  PeerTicketResult,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { verifyRequestDpopProof } from "../auth/dpop.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { rpcAuthorizationError } from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as PeerHub from "./PeerHub.ts";

const refuse = (status: number, code: string) =>
  HttpServerResponse.jsonUnsafe({ code }, { status, headers: { "cache-control": "no-store" } });

/**
 * Link methods need `sync:replicate`, which every paired machine holds.
 * `peer.call` is checked per channel against the channel's own scope.
 */
export const peerScopeAuthorizationLayer = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.succeed(PeerScopeAuthorization)((effect, { rpc }) =>
    rpc._tag === PEER_METHODS.call || scopes.includes(AuthSyncReplicateScope)
      ? effect
      : Effect.fail(rpcAuthorizationError(AuthSyncReplicateScope)),
  );

const PEER_RPC_SERVER_OPTIONS = { disableTracing: true, disableFatalDefects: true } as const;

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const hub = yield* PeerHub.PeerHub;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const crypto = yield* Crypto.Crypto;

    const identity = HttpRouter.add(
      "POST",
      PEER_IDENTITY_PATH,
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(PeerIdentityRequest).pipe(
          Effect.option,
        );
        if (body._tag === "None") return refuse(400, "invalid_request");
        const result = yield* hub.proveIdentity(body.value).pipe(Effect.option);
        if (result._tag === "None") return refuse(500, "internal_error");
        return yield* HttpServerResponse.schemaJson(PeerIdentityResult)(result.value, {
          headers: { "cache-control": "no-store" },
        }).pipe(Effect.orDie);
      }),
    );

    const join = HttpRouter.add(
      "POST",
      PEER_JOIN_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // The proof names the key the new session is bound to.
        const proofKeyThumbprint = yield* verifyRequestDpopProof({ request }).pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.option,
        );
        if (proofKeyThumbprint._tag === "None") return refuse(401, "invalid_proof");
        const body = yield* HttpServerRequest.schemaBodyJson(PeerJoinRequest).pipe(Effect.option);
        if (body._tag === "None") return refuse(400, "invalid_request");
        const result = yield* hub
          .redeem({
            grant: body.value.grant,
            nonce: body.value.nonce,
            proofKeyThumbprint: proofKeyThumbprint.value,
            spoke: body.value.spoke,
            client: deriveAuthClientMetadata({ request }),
          })
          .pipe(
            Effect.catchTags({
              PeerJoinRefusedError: (error) =>
                Effect.succeed(
                  error.reason === "hub-is-spoke"
                    ? refuse(409, "hub_is_spoke")
                    : refuse(401, "grant_rejected"),
                ),
              MachineError: (error) =>
                Effect.logError("Machine pairing failed", { cause: error }).pipe(
                  Effect.as(refuse(500, "internal_error")),
                ),
            }),
          );
        if (HttpServerResponse.isHttpServerResponse(result)) return result;
        return yield* HttpServerResponse.schemaJson(PeerJoinResult)(result, {
          headers: { "cache-control": "no-store" },
        }).pipe(Effect.orDie);
      }).pipe(Effect.withSpan("peer.join")),
    );

    const ticket = HttpRouter.add(
      "POST",
      PEER_TICKET_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* auth.authenticatePeerRequest(request).pipe(
          Effect.flatMap(hub.issueTicket),
          Effect.flatMap((issued) =>
            HttpServerResponse.schemaJson(PeerTicketResult)(issued, {
              headers: { "cache-control": "no-store" },
            }).pipe(Effect.orDie),
          ),
          Effect.catch((error) =>
            EnvironmentAuth.isServerAuthCredentialError(error) || error._tag === "PeerProtocolError"
              ? Effect.succeed(refuse(401, "not_paired"))
              : Effect.logError("Peer ticket failed", { cause: error }).pipe(
                  Effect.as(refuse(500, "internal_error")),
                ),
          ),
        );
      }).pipe(Effect.withSpan("peer.ticket")),
    );

    const socket = HttpRouter.add(
      "GET",
      PEER_SOCKET_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticatePeerWebSocket(request).pipe(Effect.option);
        if (session._tag === "None") return refuse(401, "not_paired");
        const connection = yield* hub.connect(session.value);
        const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
        yield* RpcServer.make(PeerRpcGroup, PEER_RPC_SERVER_OPTIONS).pipe(
          Effect.provideService(RpcServer.Protocol, protocol),
          Effect.provide(
            Layer.merge(
              PeerRpcGroup.toLayer({
                [PEER_METHODS.hello]: connection.hello,
                [PEER_METHODS.ping]: connection.ping,
                [PEER_METHODS.machines]: () => connection.machines,
                [PEER_METHODS.inbox]: () => connection.inbox,
                [PEER_METHODS.reply]: connection.reply,
                [PEER_METHODS.call]: connection.call,
                [PEER_METHODS.leave]: () => connection.leave,
              }),
              peerScopeAuthorizationLayer(session.value.scopes),
            ),
          ),
          Effect.forkScoped,
        );
        // Unpairing, a newer socket from the same spoke, or revoking the
        // session anywhere (Settings → Connections) closes this one, after
        // the spoke has been told so it forgets its credential.
        return yield* Effect.raceFirst(
          httpEffect,
          Effect.raceFirst(
            connection.closed,
            sessions
              .awaitInvalidation(session.value.sessionId)
              .pipe(Effect.ignore, Effect.andThen(connection.revoked)),
          ).pipe(Effect.as(HttpServerResponse.empty())),
        );
      }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.withSpan("peer.socket")),
    );

    return Layer.mergeAll(identity, join, ticket, socket);
  }),
);
