import { IntegrationError, VaultItemId, type VaultField } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Vault from "../vault/Vault.ts";

/**
 * OAuth secrets for one integration account, kept as one vault item. Each
 * secret has its own vault field so the vault's exact-value scrubbing covers
 * every one of them in tool output: the access token is `value`, the refresh
 * token `password`, and a dynamically registered client's secret `username`.
 * Expiry and the client registration are not secret; they live with the
 * integration.
 */
export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly clientSecret?: string | undefined;
}

export class IntegrationTokens extends Context.Service<
  IntegrationTokens,
  {
    /** None when the item is gone or holds no access token. */
    readonly read: (itemId: string) => Effect.Effect<Option.Option<StoredTokens>, IntegrationError>;
    /** Replaces the secrets of `itemId`, or creates the item; returns its id. */
    readonly write: (input: {
      readonly itemId: string | undefined;
      readonly name: string;
      readonly label: string;
      readonly host: string;
      readonly tokens: StoredTokens;
    }) => Effect.Effect<string, IntegrationError>;
    readonly remove: (itemId: string) => Effect.Effect<void>;
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
  return IntegrationTokens.of({
    read: (itemId) =>
      Effect.gen(function* () {
        const accessToken = yield* field(itemId, "value");
        if (accessToken === undefined) return Option.none();
        return Option.some({
          accessToken,
          refreshToken: yield* field(itemId, "password"),
          clientSecret: yield* field(itemId, "username"),
        });
      }).pipe(
        Effect.catchIf(
          (error) => error.reason === "not_found",
          () => Effect.succeed(Option.none<StoredTokens>()),
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
      const create = vault
        .create({
          name: input.name,
          type: "api_key",
          scopeProjectId: null,
          label: input.label,
          allowedDomains: [input.host],
          policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [] },
          secretFields,
        })
        .pipe(Effect.map(({ item }) => item.id as string));
      return (
        input.itemId === undefined
          ? create
          : vault.update({ id: VaultItemId.make(input.itemId), secretFields }).pipe(
              Effect.map(({ item }) => item.id as string),
              // The owner deleted the item from the vault: start a new one.
              Effect.catchIf(
                (error) => error.reason === "not_found",
                () => create,
              ),
            )
      ).pipe(Effect.mapError(storage("write tokens")));
    },
    remove: (itemId) => vault.delete({ id: VaultItemId.make(itemId) }).pipe(Effect.ignore),
  });
});

/** Tokens are vault items. */
export const layer: Layer.Layer<IntegrationTokens, never, Vault.Vault> = Layer.effect(
  IntegrationTokens,
  makeVault,
);
