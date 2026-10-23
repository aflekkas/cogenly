/**
 * Handlers for the typed requests paired machines send each other. A feature
 * (sync, delegation) defines a `PeerChannel` in contracts and registers its
 * handler here on the receiving side, for the life of its own scope. Calls in
 * either direction end up in `dispatch`, which checks the calling link's
 * scopes before decoding anything.
 */
import {
  type AuthPeerScope,
  type EnvironmentId,
  PeerCallError,
  type PeerChannel,
} from "@t3tools/contracts";
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

type ChannelCodec = Schema.Codec<unknown, unknown, never, never>;
export type PeerChannelHandler<C extends PeerChannel> = (
  payload: C["payload"]["Type"],
  caller: PeerCaller,
) => Effect.Effect<C["success"]["Type"], C["error"]["Type"]>;

interface Registered {
  readonly channel: PeerChannel;
  readonly handle: (payload: unknown, caller: PeerCaller) => Effect.Effect<unknown, unknown>;
}

const json = (schema: Schema.Top) => Schema.toCodecJson(schema as ChannelCodec);

/** Encode a channel payload for the wire. */
export const encodePeerPayload = <C extends PeerChannel>(
  channel: C,
  payload: C["payload"]["Type"],
): Effect.Effect<Schema.Json, PeerCallError> =>
  Schema.encodeUnknownEffect(json(channel.payload))(payload).pipe(
    Effect.map((encoded) => encoded as Schema.Json),
    Effect.mapError(() => new PeerCallError({ channel: channel.name, reason: "invalid-payload" })),
  );

/** Decode a channel reply; a channel error comes back as `PeerCallError.error`. */
export const decodePeerResult = <C extends PeerChannel>(
  channel: C,
  value: Schema.Json,
): Effect.Effect<C["success"]["Type"], PeerCallError> =>
  Schema.decodeUnknownEffect(json(channel.success))(value).pipe(
    Effect.mapError(() => new PeerCallError({ channel: channel.name, reason: "invalid-payload" })),
  );

/** The channel's own error inside a failed call, when it carries one. */
export const decodePeerChannelError = <C extends PeerChannel>(
  channel: C,
  error: PeerCallError,
): Effect.Effect<C["error"]["Type"] | PeerCallError> =>
  error.reason !== "handler-failed" || error.error === undefined
    ? Effect.succeed(error)
    : Schema.decodeUnknownEffect(json(channel.error))(error.error).pipe(
        Effect.orElseSucceed(() => error),
      );

export class PeerChannels extends Context.Service<
  PeerChannels,
  {
    /** Serve `channel` until the surrounding scope closes. */
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
>()("t3/machines/PeerChannels") {}

const make = Effect.sync(() => {
  const handlers = new Map<string, Registered>();

  const register: PeerChannels["Service"]["register"] = (channel, handler) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (handlers.has(channel.name)) {
          throw new Error(`Peer channel ${channel.name} is already registered.`);
        }
        handlers.set(channel.name, {
          channel,
          handle: handler as Registered["handle"],
        });
      }),
      () => Effect.sync(() => handlers.delete(channel.name)),
    );

  const dispatch: PeerChannels["Service"]["dispatch"] = ({ channel: name, payload, caller }) =>
    Effect.gen(function* () {
      const registered = handlers.get(name);
      if (registered === undefined) {
        return yield* new PeerCallError({ channel: name, reason: "unknown-channel" });
      }
      const { channel } = registered;
      if (!caller.scopes.includes(channel.scope)) {
        return yield* new PeerCallError({ channel: name, reason: "forbidden" });
      }
      const decoded = yield* Schema.decodeUnknownEffect(json(channel.payload))(payload).pipe(
        Effect.mapError(() => new PeerCallError({ channel: name, reason: "invalid-payload" })),
      );
      const result = yield* registered.handle(decoded, caller).pipe(
        Effect.catch((error) =>
          Schema.encodeUnknownEffect(json(channel.error))(error).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.flatMap((encoded) =>
              Effect.fail(
                new PeerCallError({
                  channel: name,
                  reason: "handler-failed",
                  ...(encoded === undefined ? {} : { error: encoded as Schema.Json }),
                }),
              ),
            ),
          ),
        ),
      );
      return (yield* Schema.encodeUnknownEffect(json(channel.success))(result).pipe(
        Effect.mapError(() => new PeerCallError({ channel: name, reason: "handler-failed" })),
      )) as Schema.Json;
    });

  return PeerChannels.of({ register, dispatch });
});

export const layer = Layer.effect(PeerChannels, make);
