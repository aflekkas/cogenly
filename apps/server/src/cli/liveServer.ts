/**
 * How a CLI command that changes a Cogenly home reaches it: through the
 * server that owns the home when one answers, else directly once the CLI
 * owns the home itself. It never writes behind a running server.
 *
 * Auth is the path `cogenly project` and `cogenly connect` use: a CLI that
 * can read the home's secrets mints a short-lived bearer session for the
 * scopes it needs, and revokes it when done. Over that token it trades for a
 * WebSocket ticket and talks to the server's ordinary RPCs, so the server
 * authorizes each call exactly as it does for a client.
 *
 * @module cli/liveServer
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

/**
 * What `cogenly setup` and `cogenly t3-import` may do on a running server:
 * read its config and providers, import (settings), add provider instances,
 * and create projects for the raw session import. Nothing administrative.
 */
export const SETUP_CLI_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
] as const;

export class LiveServerConnectError extends Schema.TaggedError<LiveServerConnectError>()(
  "LiveServerConnectError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't connect to the running Cogenly server at ${this.origin}.`;
  }
}

export type CliServerRoute =
  | { readonly _tag: "live"; readonly origin: string }
  | { readonly _tag: "offline" };

/**
 * Pick where a CLI write goes. A recorded server that answers is used live.
 * Otherwise the CLI must own the home: `acquireOwnership` fails while any
 * server still holds it (running but not answering), so the command stops
 * instead of writing behind it.
 */
export const resolveCliServerRoute = <E1, R1, E2, R2>(input: {
  readonly recordedOrigin: Option.Option<string>;
  readonly reachable: (origin: string) => Effect.Effect<boolean, E1, R1>;
  readonly acquireOwnership: Effect.Effect<void, E2, R2>;
}): Effect.Effect<CliServerRoute, E1 | E2, R1 | R2> =>
  Effect.gen(function* () {
    if (Option.isSome(input.recordedOrigin)) {
      const origin = input.recordedOrigin.value;
      if (yield* input.reachable(origin)) return { _tag: "live", origin } as const;
    }
    yield* input.acquireOwnership;
    return { _tag: "offline" } as const;
  });

const LIVE_SERVER_TIMEOUT = Duration.seconds(3);

/** The server's `/ws` URL with a one-time ticket for `token`'s session. */
export const liveWebSocketUrl = (origin: string, token: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
    const { ticket } = yield* client.auth.webSocketTicket({
      headers: { authorization: `Bearer ${token}` },
    });
    const url = new URL("/ws", origin.replace(/^http/, "ws"));
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    return url.toString();
  }).pipe(
    Effect.timeout(LIVE_SERVER_TIMEOUT),
    Effect.mapError((cause) => new LiveServerConnectError({ origin, cause })),
  );

/**
 * Where the RPC client connects, evaluated on every (re)connect. A ticket is
 * single use, so after the first URL each reconnect trades `token` for a
 * fresh one; if that fails the last URL is reused, its open is refused, and
 * the client's socket retries on its own schedule.
 */
export const liveWebSocketUrlSource = (input: {
  readonly origin: string;
  readonly token: string;
  /** A URL already minted (by the reachability probe) and not yet used. */
  readonly first: string;
}) => {
  let pending: string | null = input.first;
  let last = input.first;
  return Effect.suspend(() => {
    if (pending !== null) {
      last = pending;
      pending = null;
      return Effect.succeed(last);
    }
    return liveWebSocketUrl(input.origin, input.token).pipe(
      Effect.tap((url) =>
        Effect.sync(() => {
          last = url;
        }),
      ),
      Effect.orElseSucceed(() => last),
    );
  });
};

/**
 * An RPC client on the server's WebSocket, open until the surrounding scope
 * closes. With a URL source (`liveWebSocketUrlSource`) it reconnects after a
 * drop; calls in flight at the drop fail, and callers that follow a stream
 * subscribe again.
 */
export const makeLiveRpcClient = (url: string | Effect.Effect<string>) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(url)),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
  });
