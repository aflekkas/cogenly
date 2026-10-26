import {
  IntegrationError,
  IntegrationScope,
  VaultItemId,
  type VaultField,
  type VaultItemMetadata,
} from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Vault from "../vault/Vault.ts";
import { OAuthClientRegistration, OAuthServer } from "./IntegrationOAuth.ts";

/**
 * OAuth secrets for one integration account, kept as one vault item. Each
 * secret has its own vault field so the vault's exact-value scrubbing covers
 * every one of them in tool output: the access token is `value`, the refresh
 * token `password`, and a dynamically registered client's secret `username`.
 */
export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly clientSecret?: string | undefined;
}

/**
 * The non-secret half of a sign-in, kept with its vault item so it travels to
 * every machine the vault is shared with: which integration it signs in, the
 * authorization server and client it came from, when the access token
 * expires, and the one machine allowed to refresh it.
 */
export const SignInAttachment = Schema.Struct({
  kind: Schema.Literal("integration-oauth"),
  v: Schema.Literal(1),
  integrationId: Schema.String,
  server: OAuthServer,
  registration: Schema.optional(OAuthClientRegistration),
  /** Access token expiry in epoch milliseconds; null when the server gave none. */
  expiresAt: Schema.NullOr(Schema.Number),
  refreshAt: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Environment id of the only machine that may call the token endpoint. */
  refreshOwner: Schema.String,
  /** The definition authorized with this grant; adoption cannot broaden it. */
  authorization: Schema.optional(
    Schema.Struct({
      url: Schema.String,
      scope: IntegrationScope,
      oauthScope: Schema.optional(Schema.String),
      clientId: Schema.optional(Schema.String),
    }),
  ),
});
export type SignInAttachment = typeof SignInAttachment.Type;
const decodeAttachment = Schema.decodeUnknownOption(SignInAttachment);
const encodeAttachment = Schema.encodeSync(SignInAttachment);

/** A sign-in item as it is stored now, from the reading machine's point of view. */
export interface StoredSignIn {
  readonly tokens: StoredTokens;
  /** Grows with every change to the secrets, here or through sync. */
  readonly revision: number;
  readonly attachment: SignInAttachment | undefined;
}

/** A sign-in item found by its attachment; metadata only, nothing decrypted. */
export interface AttachedSignIn {
  readonly item: VaultItemMetadata;
  readonly attachment: SignInAttachment;
  readonly hasAccessToken: boolean;
  readonly hasRefreshToken: boolean;
}

export class IntegrationTokens extends Context.Service<
  IntegrationTokens,
  {
    /** None when the item is gone or holds no access token. */
    readonly read: (itemId: string) => Effect.Effect<Option.Option<StoredSignIn>, IntegrationError>;
    /** None when the item is gone. Cheap: nothing is decrypted. */
    readonly revision: (itemId: string) => Effect.Effect<Option.Option<number>, IntegrationError>;
    /** A registered client's secret, kept even after the grant itself is cleared. */
    readonly clientSecret: (itemId: string) => Effect.Effect<string | undefined, IntegrationError>;
    /**
     * Replaces the secrets of `itemId`, or creates the item, and its
     * attachment in the same write; returns its id and revision.
     */
    readonly write: (input: {
      readonly itemId: string | undefined;
      readonly name: string;
      readonly label: string;
      readonly host: string;
      readonly tokens: StoredTokens;
      readonly attachment: SignInAttachment;
    }) => Effect.Effect<{ readonly itemId: string; readonly revision: number }, IntegrationError>;
    /** Adds upgrade metadata only when the item still has no attachment. */
    readonly backfillAttachment: (
      itemId: string,
      attachment: SignInAttachment,
    ) => Effect.Effect<void, IntegrationError>;
    /**
     * Empties the access and refresh tokens of a grant that no longer works,
     * so every machine sharing the item stops using it; the client secret stays.
     */
    readonly clearGrant: (itemId: string) => Effect.Effect<void, IntegrationError>;
    readonly remove: (itemId: string) => Effect.Effect<void>;
    /** Every sign-in item here, newest first, from this machine or a peer. */
    readonly attached: Effect.Effect<ReadonlyArray<AttachedSignIn>, IntegrationError>;
    /** Item ids a peer's vault sync changed or removed here. */
    readonly syncedChanges: Stream.Stream<Vault.VaultSyncedChange>;
  }
>()("cogenly-server/integrations/IntegrationTokens") {}

const storage = (operation: string) => (cause: unknown) =>
  new IntegrationError({ operation, reason: "storage", cause });

const makeVault = Effect.gen(function* () {
  const vault = yield* Vault.Vault;
  const field = (itemId: string, name: VaultField) =>
    vault
      .use({
        itemId: VaultItemId.make(itemId),
        field: name,
        caller: { kind: "server" },
        action: "resolve",
      })
      .pipe(
        Effect.map((result) => (result.status === "allowed" ? result.value : undefined)),
        Effect.catchIf(
          (error) => error.reason === "field_missing",
          () => Effect.succeed(undefined),
        ),
      );
  const revision = (itemId: string) =>
    vault.credentialRevision(VaultItemId.make(itemId)).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => error.reason === "not_found",
        () => Effect.succeed(Option.none<number>()),
      ),
    );
  const attachmentOf = (raw: unknown) => Option.getOrUndefined(decodeAttachment(raw));
  return IntegrationTokens.of({
    read: (itemId) =>
      Effect.gen(function* () {
        const snapshot = yield* vault.readCredential(VaultItemId.make(itemId));
        const accessToken = snapshot.secretFields.value;
        if (accessToken === undefined) return Option.none();
        return Option.some({
          tokens: {
            accessToken,
            refreshToken: snapshot.secretFields.password,
            clientSecret: snapshot.secretFields.username,
          },
          revision: snapshot.revision,
          attachment: attachmentOf(snapshot.attachment),
        });
      }).pipe(
        Effect.catchIf(
          (error) => error.reason === "not_found",
          () => Effect.succeed(Option.none<StoredSignIn>()),
        ),
        Effect.mapError(storage("read tokens")),
      ),
    revision: (itemId) => revision(itemId).pipe(Effect.mapError(storage("read tokens"))),
    clientSecret: (itemId) =>
      field(itemId, "username").pipe(
        Effect.catchIf(
          (error) => error.reason === "not_found",
          () => Effect.succeed(undefined),
        ),
        Effect.mapError(storage("read tokens")),
      ),
    write: (input) => {
      // An empty string removes a field, so a missing refresh token never survives.
      const secretFields = {
        value: input.tokens.accessToken,
        password: input.tokens.refreshToken ?? "",
        username: input.tokens.clientSecret ?? "",
      };
      const options = {
        syncAttachment: encodeAttachment(input.attachment) as Record<string, Schema.Json>,
      };
      const create = vault
        .create(
          {
            name: input.name,
            type: "api_key",
            scopeProjectId: null,
            label: input.label,
            allowedDomains: [input.host],
            policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [] },
            secretFields,
          },
          options,
        )
        .pipe(Effect.map(({ item, revision }) => ({ itemId: item.id as string, revision })));
      return (
        input.itemId === undefined
          ? create
          : vault.update({ id: VaultItemId.make(input.itemId), secretFields }, options).pipe(
              Effect.map(({ item, revision }) => ({ itemId: item.id as string, revision })),
              // The owner deleted the item from the vault: start a new one.
              Effect.catchIf(
                (error) => error.reason === "not_found",
                () => create,
              ),
            )
      ).pipe(Effect.mapError(storage("write tokens")));
    },
    backfillAttachment: (itemId, attachment) =>
      vault
        .setSyncAttachment(
          VaultItemId.make(itemId),
          encodeAttachment(attachment) as Record<string, Schema.Json>,
          { onlyIfMissing: true },
        )
        .pipe(
          Effect.catchIf(
            (error) => error.reason === "not_found",
            () => Effect.void,
          ),
          Effect.mapError(storage("backfill sign-in")),
        ),
    clearGrant: (itemId) =>
      vault
        .update({ id: VaultItemId.make(itemId), secretFields: { value: "", password: "" } })
        .pipe(
          Effect.asVoid,
          Effect.catchIf(
            (error) => error.reason === "not_found",
            () => Effect.void,
          ),
          Effect.mapError(storage("clear tokens")),
        ),
    remove: (itemId) => vault.delete({ id: VaultItemId.make(itemId) }).pipe(Effect.ignore),
    attached: vault.listSyncAttachments.pipe(
      Effect.map((items) =>
        items.flatMap(({ item, attachment }) => {
          const decoded = attachmentOf(attachment);
          return decoded === undefined
            ? []
            : [
                {
                  item,
                  attachment: decoded,
                  hasAccessToken: item.fields.includes("value"),
                  hasRefreshToken: item.fields.includes("password"),
                },
              ];
        }),
      ),
      Effect.mapError(storage("list tokens")),
    ),
    syncedChanges: vault.syncedChanges,
  });
});

/** Tokens are vault items. */
export const layer: Layer.Layer<IntegrationTokens, never, Vault.Vault> = Layer.effect(
  IntegrationTokens,
  makeVault,
);
