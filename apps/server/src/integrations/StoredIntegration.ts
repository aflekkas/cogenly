import { Integration, IntegrationSyncedFrom } from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import * as OAuth from "./IntegrationOAuth.ts";

/**
 * Server-only OAuth state, persisted with the integration and stripped before
 * it reaches any client or agent. Secrets are in the vault item it names.
 */
export const OAuthState = Schema.Struct({
  signedIn: Schema.Boolean,
  server: Schema.optional(OAuth.OAuthServer),
  /** The dynamically registered client; absent when the owner supplied a client id. */
  registration: Schema.optional(OAuth.OAuthClientRegistration),
  tokenItemId: Schema.optional(Schema.String),
  /** Access token expiry in epoch milliseconds; null when the server gave none. */
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
  refreshOwner: Schema.optional(Schema.String),
  refreshAt: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type OAuthState = typeof OAuthState.Type;

export const StoredIntegration = Schema.Struct({
  ...Integration.fields,
  oauthState: Schema.optional(OAuthState),
  browserOrigin: Schema.optional(Schema.String),
  /** Set by machine sync on a definition another machine signed in to. */
  syncedFrom: Schema.optional(IntegrationSyncedFrom),
});
export type StoredIntegration = typeof StoredIntegration.Type;
