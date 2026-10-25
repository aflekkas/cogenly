import { VaultError } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VaultCrypto from "./VaultCrypto.ts";

const KEY_PAIR_STORE_NAME = "vault-x25519-key-pair";
const KeyPairJson = Schema.fromJsonString(
  Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String }),
);
const encodeKeyPairJson = Schema.encodeSync(KeyPairJson);
const decodeKeyPairOption = Schema.decodeUnknownOption(KeyPairJson);
const isVaultError = Schema.is(VaultError);

/**
 * This environment's vault key pair, created on first use. File-backed in the
 * server secret store today; on macOS this seam is where a Keychain-backed
 * store replaces it. Every caller loading it gets the same pair.
 */
export const makeVaultKeyStore = (
  store: ServerSecretStore.ServerSecretStore["Service"],
): VaultCrypto.VaultMachineKeyStore => {
  const decodeStored = (value: Uint8Array) => decodeKeyPairOption(new TextDecoder().decode(value));
  return {
    loadOrCreateKeyPair: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const existing = yield* store.get(KEY_PAIR_STORE_NAME);
          if (Option.isSome(existing)) {
            const decoded = decodeStored(existing.value);
            if (Option.isSome(decoded)) return decoded.value;
            return yield* new VaultError({ reason: "crypto" });
          }
          const pair = VaultCrypto.generateKeyPair();
          yield* store
            .create(KEY_PAIR_STORE_NAME, new TextEncoder().encode(encodeKeyPairJson(pair)))
            .pipe(
              Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () =>
                store.get(KEY_PAIR_STORE_NAME).pipe(
                  Effect.flatMap(
                    Option.match({
                      onSome: () => Effect.void,
                      onNone: () => Effect.die(new Error("vault key pair vanished")),
                    }),
                  ),
                ),
              ),
            );
          const stored = yield* store.get(KEY_PAIR_STORE_NAME);
          if (Option.isSome(stored)) {
            const decoded = decodeStored(stored.value);
            if (Option.isSome(decoded)) return decoded.value;
          }
          return pair;
        }).pipe(
          Effect.mapError((cause) =>
            isVaultError(cause) ? cause : new VaultError({ reason: "storage", cause }),
          ),
        ),
      ),
  };
};

/** A loader that reads the store once per process and caches the pair. */
export const makeVaultKeyPairLoader = (store: ServerSecretStore.ServerSecretStore["Service"]) => {
  const keyStore = makeVaultKeyStore(store);
  let keyPairPromise: Promise<VaultCrypto.VaultKeyPair> | undefined;
  return Effect.tryPromise({
    try: () => (keyPairPromise ??= keyStore.loadOrCreateKeyPair()),
    catch: (cause) => {
      keyPairPromise = undefined;
      return isVaultError(cause) ? cause : new VaultError({ reason: "storage", cause });
    },
  });
};
