import { IntegrationError, VaultItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Vault from "../../vault/Vault.ts";

export const GoogleGrant = Schema.Struct({
  email: Schema.String,
  credentials: Schema.Struct({
    token: Schema.NullOr(Schema.String),
    refresh_token: Schema.NullOr(Schema.String),
    token_uri: Schema.String,
    client_id: Schema.String,
    client_secret: Schema.String,
    scopes: Schema.NullOr(Schema.Array(Schema.String)),
    expiry: Schema.NullOr(Schema.String),
  }),
});
export type GoogleGrant = typeof GoogleGrant.Type;
const json = Schema.fromJsonString(GoogleGrant);

/** The managed Python process uses this vault-backed store instead of credential files. */
export class GoogleTokenStore extends Context.Service<
  GoogleTokenStore,
  {
    readonly read: (id: string) => Effect.Effect<Option.Option<GoogleGrant>, IntegrationError>;
    readonly write: (id: string, grant: GoogleGrant) => Effect.Effect<void, IntegrationError>;
    readonly remove: (id: string) => Effect.Effect<void, IntegrationError>;
  }
>()("cogenly-server/integrations/local/GoogleTokenStore") {}

export const layer = Layer.effect(
  GoogleTokenStore,
  Effect.gen(function* () {
    const vault = yield* Vault.Vault;
    const itemFor = (id: string) =>
      vault
        .list({})
        .pipe(Effect.map(({ items }) => items.find((item) => item.name === `google-grant-${id}`)));
    const storage = (cause: unknown) =>
      new IntegrationError({ operation: "store Google grant in vault", reason: "storage", cause });
    return GoogleTokenStore.of({
      read: (id) =>
        Effect.gen(function* () {
          const item = yield* itemFor(id);
          if (!item) return Option.none<GoogleGrant>();
          const result = yield* vault.use({
            itemId: item.id,
            field: "value",
            caller: { kind: "server" },
            action: "resolve",
          });
          if (result.status !== "allowed" || result.value === undefined)
            return Option.none<GoogleGrant>();
          return Option.some(yield* Schema.decodeUnknownEffect(json)(result.value));
        }).pipe(Effect.mapError(storage)),
      write: (id, grant) =>
        Effect.gen(function* () {
          const item = yield* itemFor(id);
          const secretFields = {
            value: yield* Schema.encodeEffect(json)(grant),
            // Individual fields also register exact-value redaction of both tokens.
            username: grant.credentials.token ?? "",
            password: grant.credentials.refresh_token ?? "",
          };
          if (item) yield* vault.update({ id: item.id, secretFields });
          else
            yield* vault.create({
              name: `google-grant-${id}`,
              type: "api_key",
              scopeProjectId: null,
              allowedDomains: ["accounts.google.com", "oauth2.googleapis.com"],
              secretFields,
            });
        }).pipe(Effect.mapError(storage)),
      remove: (id) =>
        Effect.gen(function* () {
          const item = yield* itemFor(id);
          if (item) yield* vault.delete({ id: VaultItemId.make(item.id) });
        }).pipe(Effect.mapError(storage)),
    });
  }),
);
