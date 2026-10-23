/**
 * A spoke's record of its hub: where to dial, the hub key it pinned at join,
 * and its peer credential. Kept in the secret store because the access token
 * is a credential, even though it is useless without the spoke's proof key.
 */
import {
  AuthPeerScope,
  EnvironmentId,
  MachineSelfReport,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const HUB_LINK_SECRET = "machine-hub-link";

export const HubLinkRecord = Schema.Struct({
  hubEnvironmentId: EnvironmentId,
  hubName: TrimmedNonEmptyString,
  /** SPKI PEM of the hub's Ed25519 key, pinned at join. */
  hubPublicKey: TrimmedNonEmptyString,
  /** Tried in order on every connect. */
  routes: Schema.Array(TrimmedNonEmptyString),
  accessToken: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtcFromString,
  scopes: Schema.Array(AuthPeerScope),
  pairedAt: Schema.DateTimeUtcFromString,
  /** The hub's last self report, so an offline hub still lists with its kind. */
  hub: Schema.NullOr(MachineSelfReport),
  lastSeenAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** Set when the hub refused the credential: it unpaired this machine. */
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type HubLinkRecord = typeof HubLinkRecord.Type;

const HubLinkJson = Schema.fromJsonString(HubLinkRecord);
const decodeHubLink = Schema.decodeUnknownEffect(HubLinkJson);
const encodeHubLink = Schema.encodeEffect(HubLinkJson);

export const readHubLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const stored = yield* secrets.get(HUB_LINK_SECRET);
  if (Option.isNone(stored)) return Option.none<HubLinkRecord>();
  return Option.some(
    yield* decodeHubLink(new TextDecoder().decode(stored.value)).pipe(
      Effect.mapError(
        (cause) => new ServerSecretStore.SecretStoreDecodeError({ resource: "hub link", cause }),
      ),
    ),
  );
});

export const writeHubLink = Effect.fn("writeHubLink")(function* (link: HubLinkRecord) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const encoded = yield* encodeHubLink(link).pipe(
    Effect.mapError(
      (cause) => new ServerSecretStore.SecretStoreEncodeError({ resource: "hub link", cause }),
    ),
  );
  yield* secrets.set(HUB_LINK_SECRET, new TextEncoder().encode(encoded));
});

export const removeHubLink = ServerSecretStore.ServerSecretStore.pipe(
  Effect.flatMap((secrets) => secrets.remove(HUB_LINK_SECRET)),
);
