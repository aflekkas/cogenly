import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { VaultField } from "@cogenly/contracts";

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

/** The vault item exists, but neither its domains nor the owner allow this destination. */
export class IntegrationCredentialNotAllowedError extends Schema.TaggedError<IntegrationCredentialNotAllowedError>()(
  "IntegrationCredentialNotAllowedError",
  { ref: Schema.String },
) {
  override get message(): string {
    return `Credential ${this.ref} may not be sent to this integration.`;
  }
}

/** Where a resolved credential will be sent, and what the owner approved for it. */
export interface CredentialDestination {
  /** The integration endpoint's host. */
  readonly host: string;
  readonly scopeProjectId?: string | null | undefined;
  /** Vault item names the owner approved for this endpoint. */
  readonly approvedItems: ReadonlyArray<string>;
}

export class IntegrationCredentials extends Context.Service<
  IntegrationCredentials,
  {
    /**
     * The secret for `ref` when it may go to `destination`: the item's allowed
     * domains include its host, or the owner approved the item for it. None
     * when the item/field does not exist.
     */
    readonly resolve: (
      ref: string,
      destination: CredentialDestination,
    ) => Effect.Effect<
      Option.Option<string>,
      IntegrationCredentialError | IntegrationCredentialNotAllowedError
    >;
  }
>()("cogenly-server/integrations/IntegrationCredentials") {}

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
    resolve: (ref, destination) => {
      const parsed = parseCredentialRef(ref);
      if (parsed === undefined || parsed.item.length === 0 || !isVaultField(parsed.field)) {
        return Effect.succeed(Option.none<string>());
      }
      return vault
        .resolveSecretByName({
          name: parsed.item,
          scopeProjectId: destination.scopeProjectId,
          field: parsed.field,
          destinationHost: destination.host,
          approved: destination.approvedItems.includes(parsed.item),
        })
        .pipe(
          Effect.map(({ value }) => Option.some(value)),
          // A missing item or field is "no credential", which fails the request
          // closed upstream; anything else is a real vault fault.
          Effect.catchIf(
            (error) => error.reason === "not_found" || error.reason === "field_missing",
            () => Effect.succeed(Option.none<string>()),
          ),
          Effect.mapError((cause) =>
            cause.reason === "domain_not_allowed"
              ? new IntegrationCredentialNotAllowedError({ ref })
              : new IntegrationCredentialError({ ref, cause }),
          ),
        );
    },
  });
});

/** Credentials are vault items, referenced as `<item name>.<field>`. */
export const layer: Layer.Layer<IntegrationCredentials, never, Vault.Vault> = Layer.effect(
  IntegrationCredentials,
  makeVault,
);

/** A secret typed into Settings, stored under one environment-wide vault item name. */
export interface IntegrationSecretInput {
  readonly item: string;
  readonly type: "login" | "api_key";
  readonly fields: {
    readonly username?: string;
    readonly password?: string;
    readonly value?: string;
  };
  /** Hosts the secret may be sent to. */
  readonly domains: ReadonlyArray<string>;
  readonly label: string;
}

/**
 * Writes the secrets Settings collects for an integration (an app's client
 * secret, an API key). Saving again replaces the item of that name, fields
 * and domains alike, so a fixed item never keeps a stale field.
 */
export class IntegrationSecrets extends Context.Service<
  IntegrationSecrets,
  {
    readonly save: (
      input: IntegrationSecretInput,
    ) => Effect.Effect<void, IntegrationCredentialError>;
  }
>()("cogenly-server/integrations/IntegrationCredentials/IntegrationSecrets") {}

export const secretsLayer: Layer.Layer<IntegrationSecrets, never, Vault.Vault> = Layer.effect(
  IntegrationSecrets,
  Effect.gen(function* () {
    const vault = yield* Vault.Vault;
    return IntegrationSecrets.of({
      save: (input) =>
        Effect.gen(function* () {
          const { items } = yield* vault.list({});
          const existing = items.find(
            (item) => item.name === input.item && item.scopeProjectId === null,
          );
          if (existing === undefined) {
            yield* vault.create({
              name: input.item,
              type: input.type,
              label: input.label,
              scopeProjectId: null,
              allowedDomains: [...input.domains],
              secretFields: input.fields,
            });
            return;
          }
          // An empty string removes a field, e.g. the JSON value an older Google item held.
          yield* vault.update({
            id: existing.id,
            type: input.type,
            label: input.label,
            allowedDomains: [...input.domains],
            secretFields: {
              username: input.fields.username ?? "",
              password: input.fields.password ?? "",
              value: input.fields.value ?? "",
            },
          });
        }).pipe(
          Effect.mapError((cause) => new IntegrationCredentialError({ ref: input.item, cause })),
        ),
    });
  }),
);
