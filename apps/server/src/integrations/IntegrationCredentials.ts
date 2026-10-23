import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { VaultField } from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Vault from "../vault/Vault.ts";

/**
 * Resolves one credential reference (`<vault item name>.<field>`) to its
 * secret value, server-side only. The value is used to build upstream
 * headers right before a request and is never returned to any caller.
 */
export class IntegrationCredentialError extends Schema.TaggedError<IntegrationCredentialError>()(
  "IntegrationCredentialError",
  {
    ref: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not resolve credential ${this.ref}.`;
  }
}
export const isIntegrationCredentialError = Schema.is(IntegrationCredentialError);

export class IntegrationCredentials extends Context.Service<
  IntegrationCredentials,
  {
    /** The secret for `ref`, or none when the item/field does not exist. */
    readonly resolve: (
      ref: string,
    ) => Effect.Effect<Option.Option<string>, IntegrationCredentialError>;
  }
>()("t3/integrations/IntegrationCredentials") {}

/** Splits `item.field` at the last dot; item names may contain dots. */
export const parseCredentialRef = (
  ref: string,
): { readonly item: string; readonly field: string } | undefined => {
  const dot = ref.lastIndexOf(".");
  if (dot <= 0 || dot === ref.length - 1) return undefined;
  return { item: ref.slice(0, dot).trim(), field: ref.slice(dot + 1).trim() };
};

const makeSecretStore = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  return IntegrationCredentials.of({
    resolve: (ref) =>
      Effect.gen(function* () {
        const parsed = parseCredentialRef(ref);
        if (parsed === undefined || parsed.item.length === 0 || parsed.field.length === 0) {
          return Option.none<string>();
        }
        const bytes = yield* store.get(`integration:${parsed.item}:${parsed.field}`);
        return Option.map(bytes, (value) => new TextDecoder().decode(value));
      }).pipe(Effect.mapError((cause) => new IntegrationCredentialError({ ref, cause }))),
  });
});

/** ServerSecretStore backing, for tests that run without a vault. */
export const layerSecretStore: Layer.Layer<
  IntegrationCredentials,
  never,
  ServerSecretStore.ServerSecretStore
> = Layer.effect(IntegrationCredentials, makeSecretStore);

const isVaultField = Schema.is(VaultField);

const makeVault = Effect.gen(function* () {
  const vault = yield* Vault.Vault;
  return IntegrationCredentials.of({
    resolve: (ref) => {
      const parsed = parseCredentialRef(ref);
      if (parsed === undefined || parsed.item.length === 0 || !isVaultField(parsed.field)) {
        return Effect.succeed(Option.none<string>());
      }
      return vault.resolveSecretByName({ name: parsed.item, field: parsed.field }).pipe(
        Effect.map(({ value }) => Option.some(value)),
        // A missing item or field is "no credential", which fails the request
        // closed upstream; anything else is a real vault fault.
        Effect.catchIf(
          (error) => error.reason === "not_found" || error.reason === "field_missing",
          () => Effect.succeed(Option.none<string>()),
        ),
        Effect.mapError((cause) => new IntegrationCredentialError({ ref, cause })),
      );
    },
  });
});

/** Credentials are vault items, referenced as `<item name>.<field>`. */
export const layer: Layer.Layer<IntegrationCredentials, never, Vault.Vault> = Layer.effect(
  IntegrationCredentials,
  makeVault,
);
