import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

/**
 * Resolves one credential reference (`<vault item name>.<field>`) to its
 * secret value, server-side only. The value is used to build upstream
 * headers right before a request and is never returned to any caller.
 *
 * Temporary backing: until the Vault service (Phase 6) lands, values live in
 * ServerSecretStore under `integration:<item>:<field>`. Swapping to Vault is
 * a one-line change: replace `layerSecretStore` below with a layer that
 * resolves the same reference through `Vault.resolve(item, field)`.
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

/** Temporary ServerSecretStore backing; swap this one line for Vault. */
export const layerSecretStore: Layer.Layer<
  IntegrationCredentials,
  never,
  ServerSecretStore.ServerSecretStore
> = Layer.effect(IntegrationCredentials, makeSecretStore);

export const layer = layerSecretStore;
