/**
 * Handlers for the typed requests paired machines send each other. A feature
 * (sync, delegation) defines a `PeerChannel` in contracts and registers its
 * handler here on the receiving side, for the life of its own scope. Calls in
 * either direction end up in `dispatch`, which checks the calling link's
 * scopes before decoding anything. Senders use `Machines.call`.
 */
import {
  type AuthPeerScope,
  type EnvironmentId,
  PeerCallError,
  type PeerChannel,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/** The machine on the other end of the link, as authenticated by it. */
export interface PeerCaller {
  readonly environmentId: EnvironmentId;
  readonly scopes: ReadonlyArray<AuthPeerScope>;
}

export type PeerChannelHandler<C extends PeerChannel> = (
  payload: C["payload"]["Type"],
  caller: PeerCaller,
) => Effect.Effect<C["success"]["Type"], C["error"]["Type"]>;

interface Registered {
  readonly scope: AuthPeerScope;
  readonly handle: (
    payload: Schema.Json,
    caller: PeerCaller,
  ) => Effect.Effect<Schema.Json, PeerCallError>;
}

type JsonCodec = Schema.Codec<unknown, unknown, never, never>;
const json = (schema: Schema.Top) => Schema.toCodecJson(schema as JsonCodec);

/** Encode a channel payload for the wire. */
export const encodePeerPayload = <C extends PeerChannel>(
  channel: C,
  payload: C["payload"]["Type"],
): Effect.Effect<Schema.Json, PeerCallError> =>
  Schema.encodeUnknownEffect(json(channel.payload))(payload).pipe(
    Effect.map((encoded) => encoded as Schema.Json),
    Effect.mapError(() => new PeerCallError({ channel: channel.name, reason: "invalid-payload" })),
  );

/** Decode a channel reply. */
export const decodePeerResult = <C extends PeerChannel>(
  channel: C,
  value: unknown,
): Effect.Effect<C["success"]["Type"], PeerCallError> =>
  Schema.decodeUnknownEffect(json(channel.success))(value).pipe(
    Effect.mapError(() => new PeerCallError({ channel: channel.name, reason: "invalid-payload" })),
  );

export class PeerChannels extends Context.Service<
  PeerChannels,
  {
    /** Serve `channel` until the surrounding scope closes. One handler per name. */
    readonly register: <C extends PeerChannel>(
      channel: C,
      handler: PeerChannelHandler<C>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly dispatch: (input: {
      readonly channel: string;
      readonly payload: Schema.Json;
      readonly caller: PeerCaller;
    }) => Effect.Effect<Schema.Json, PeerCallError>;
  }
>()("cogenly-server/machines/PeerChannels") {}

const make = Effect.sync(() => {
  const handlers = new Map<string, Registered>();

  const register: PeerChannels["Service"]["register"] = (channel, handler) => {
    const fail = (reason: PeerCallError["reason"], error?: Schema.Json) =>
      new PeerCallError({
        channel: channel.name,
        reason,
        ...(error === undefined ? {} : { error }),
      });
    const handle: Registered["handle"] = (payload, caller) =>
      Schema.decodeUnknownEffect(json(channel.payload))(payload).pipe(
        Effect.mapError(() => fail("invalid-payload")),
        Effect.flatMap((decoded) =>
          handler(decoded, caller).pipe(
            Effect.catch((error) =>
              Schema.encodeUnknownEffect(json(channel.error))(error).pipe(
                Effect.option,
                Effect.flatMap((encoded) =>
                  Effect.fail(
                    fail(
                      "handler-failed",
                      encoded._tag === "Some" ? (encoded.value as Schema.Json) : undefined,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        Effect.flatMap((result) =>
          Schema.encodeUnknownEffect(json(channel.success))(result).pipe(
            Effect.map((encoded) => encoded as Schema.Json),
            Effect.mapError(() => fail("handler-failed")),
          ),
        ),
      );
    return Effect.acquireRelease(
      Effect.suspend(() =>
        handlers.has(channel.name)
          ? Effect.die(new Error(`Peer channel ${channel.name} is already registered.`))
          : Effect.sync(() => void handlers.set(channel.name, { scope: channel.scope, handle })),
      ),
      () => Effect.sync(() => void handlers.delete(channel.name)),
    );
  };

  const dispatch: PeerChannels["Service"]["dispatch"] = ({ channel, payload, caller }) =>
    Effect.suspend(() => {
      const registered = handlers.get(channel);
      if (registered === undefined) {
        return Effect.fail(new PeerCallError({ channel, reason: "unknown-channel" }));
      }
      if (!caller.scopes.includes(registered.scope)) {
        return Effect.fail(new PeerCallError({ channel, reason: "forbidden" }));
      }
      return registered.handle(payload, caller);
    }).pipe(Effect.withSpan("PeerChannels.dispatch", { attributes: { channel } }));

  return PeerChannels.of({ register, dispatch });
});

export const layer = Layer.effect(PeerChannels, make);
