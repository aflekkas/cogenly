/**
 * Vault - encrypted secrets agents use without ever seeing.
 *
 * Items live in `vault_items`: plaintext metadata, policy and allowed
 * domains beside one AES-256-GCM ciphertext whose random data key is wrapped
 * for this environment's X25519 key (see VaultCrypto). Decryption happens
 * only inside this service, for a named purpose, and every use is audited in
 * `vault_usage`. The private key lives in the server secret store through
 * the VaultMachineKeyStore seam; a Keychain store can replace it on macOS.
 */
import {
  AgentApprovalAction,
  AgentId,
  ThreadId,
  VaultError,
  VaultItemId,
  VaultPolicy,
  defaultVaultPolicy,
  type VaultCreateInput,
  type VaultDeleteInput,
  type VaultField,
  type VaultItemMetadata,
  type VaultItemType,
  type VaultListInput,
  type VaultSecretFields,
  type VaultUpdateInput,
  type VaultUsageListInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as VaultCrypto from "./VaultCrypto.ts";
import { evaluateVaultPolicy, hostMatchesAnyDomain, type VaultUseCaller } from "./VaultPolicy.ts";
import {
  VAULT_WITHHELD,
  redactShortSecrets,
  redactShortValue,
  redactText,
  redactValue,
  withholdValue,
} from "./VaultRedactor.ts";
import { totp } from "./VaultTotp.ts";

export interface VaultUseInput {
  readonly itemId?: VaultItemId | undefined;
  readonly name?: string | undefined;
  /** Project (label) scope to prefer when a name exists in several scopes. */
  readonly scopeProjectId?: string | null | undefined;
  readonly field: VaultField;
  readonly caller: VaultUseCaller;
  readonly threadId?: ThreadId | undefined;
  /** Page host the value will be used on, when known (browser fill). */
  readonly domain?: string | null | undefined;
  /** Audit action name, e.g. "fill", "resolve". Defaults to "use". */
  readonly action?: string | undefined;
  /** Reject replacement between account authorization and field resolution. */
  readonly expectedRevision?: number | undefined;
  /** Browser fill refuses domains outside the item's allowedDomains. */
  readonly enforceAllowedDomains?: boolean | undefined;
}

export type VaultUseResult =
  | {
      readonly status: "allowed";
      readonly item: VaultItemMetadata;
      readonly field: VaultField;
      readonly value: string;
    }
  | {
      readonly status: "approval_required";
      readonly item: VaultItemMetadata;
      readonly field: VaultField;
      readonly approvalId: string | null;
      readonly message: string;
    }
  | {
      readonly status: "denied";
      readonly item: VaultItemMetadata;
      readonly field: VaultField;
      readonly reason: string;
    };

const isVaultError = Schema.is(VaultError);
const wrap = (cause: unknown): VaultError =>
  isVaultError(cause) ? cause : new VaultError({ reason: "storage", cause });

interface VaultRow {
  readonly credential_revision: number;
  readonly account_id?: string;
  readonly credential_id?: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly scope_project_id: string | null;
  readonly metadata_json: string;
  readonly policy_json: string;
  readonly allowed_domains_json: string;
  readonly ciphertext: string;
  readonly wrapped_keys_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

const FIELD_KEYS = [
  "username",
  "password",
  "totp",
  "value",
  "cardNumber",
  "cardExpiry",
  "cardCvc",
  "cardholderName",
] as const;
type StoredFields = {
  username?: string;
  password?: string;
  totpSecret?: string;
  value?: string;
  cardNumber?: string;
  cardExpiryMonth?: string;
  cardExpiryYear?: string;
  cardCvc?: string;
  cardholderName?: string;
};

/** Fillable field -> stored key; `totp` and the derived `cardExpiry` are special. */
const storedKeyForField = (field: (typeof FIELD_KEYS)[number]): keyof StoredFields | null =>
  field === "totp" ? "totpSecret" : field === "cardExpiry" ? null : field;

const cardDigits = (stored: StoredFields): string => (stored.cardNumber ?? "").replace(/\D/g, "");

/** The only secret-derived fragment kept in plaintext metadata; see contracts. */
const cardLast4Of = (stored: StoredFields): string | undefined => {
  const digits = cardDigits(stored);
  return digits.length >= 4 ? digits.slice(-4) : undefined;
};

/** `MM/YY` from the stored month/year, or undefined when either half is missing. */
const cardExpiryOf = (stored: StoredFields): string | undefined => {
  const month = (stored.cardExpiryMonth ?? "").trim();
  const year = (stored.cardExpiryYear ?? "").trim();
  if (!month || !year) return undefined;
  return `${month.padStart(2, "0")}/${year.slice(-2)}`;
};

const fieldsOf = (stored: StoredFields): VaultItemMetadata["fields"] =>
  FIELD_KEYS.filter((field) => {
    if (field === "cardExpiry") return cardExpiryOf(stored) !== undefined;
    const key = storedKeyForField(field);
    const value = key === null ? undefined : stored[key];
    return typeof value === "string" && value.length > 0;
  });

const StoredFieldsJson = Schema.fromJsonString(
  Schema.Struct({
    username: Schema.optional(Schema.String),
    password: Schema.optional(Schema.String),
    totpSecret: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
    cardNumber: Schema.optional(Schema.String),
    cardExpiryMonth: Schema.optional(Schema.String),
    cardExpiryYear: Schema.optional(Schema.String),
    cardCvc: Schema.optional(Schema.String),
    cardholderName: Schema.optional(Schema.String),
  }),
);
const MetadataJson = Schema.fromJsonString(
  Schema.Struct({
    label: Schema.optional(Schema.String),
    fields: Schema.optional(Schema.Array(Schema.String)),
    cardLast4: Schema.optional(Schema.String),
  }),
);
const PolicyJson = Schema.fromJsonString(VaultPolicy);
const DomainsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const WrappedKeysJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      ephemeralPublicKey: Schema.String,
      nonce: Schema.String,
      ciphertext: Schema.String,
    }),
  ),
);
const BodyJson = Schema.fromJsonString(
  Schema.Struct({ nonce: Schema.String, ciphertext: Schema.String }),
);
const KeyPairJson = Schema.fromJsonString(
  Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String }),
);
const ApprovalActionJson = Schema.fromJsonString(AgentApprovalAction);
const encodeStoredJson = Schema.encodeSync(StoredFieldsJson);
const encodeMetadataJson = Schema.encodeSync(MetadataJson);
const encodePolicyJson = Schema.encodeSync(PolicyJson);
const encodeDomainsJson = Schema.encodeSync(DomainsJson);
const encodeWrappedKeysJson = Schema.encodeSync(WrappedKeysJson);
const encodeBodyJson = Schema.encodeSync(BodyJson);
const encodeKeyPairJson = Schema.encodeSync(KeyPairJson);
const encodeApprovalActionJson = Schema.encodeSync(ApprovalActionJson);
interface MetadataShape {
  readonly label?: string | undefined;
  readonly fields?: ReadonlyArray<string> | undefined;
  readonly cardLast4?: string | undefined;
}
const decodeMetadataOption = Schema.decodeUnknownOption(MetadataJson);
const decodePolicyOption = Schema.decodeUnknownOption(PolicyJson);
const decodeDomainsOption = Schema.decodeUnknownOption(DomainsJson);
const decodeWrappedKeysOption = Schema.decodeUnknownOption(WrappedKeysJson);
const decodeBodyOption = Schema.decodeUnknownOption(BodyJson);
const decodeStoredFieldsOption = Schema.decodeUnknownOption(StoredFieldsJson);
const decodeKeyPairOption = Schema.decodeUnknownOption(KeyPairJson);
const parseMetadata = (text: string): MetadataShape =>
  Option.getOrElse(decodeMetadataOption(text), () => ({}));

const parsePolicy = (text: string): VaultPolicy =>
  Option.getOrElse(decodePolicyOption(text), () => defaultVaultPolicy);
const parseDomains = (text: string): Array<string> =>
  Option.match(decodeDomainsOption(text), {
    onNone: () => [],
    onSome: (domains) => [...domains],
  });

export class Vault extends Context.Service<
  Vault,
  {
    readonly list: (
      input: VaultListInput,
    ) => Effect.Effect<{ items: ReadonlyArray<VaultItemMetadata> }, VaultError>;
    readonly getMetadata: (itemId: VaultItemId) => Effect.Effect<VaultItemMetadata, VaultError>;
    readonly create: (
      input: VaultCreateInput,
    ) => Effect.Effect<{ item: VaultItemMetadata }, VaultError>;
    readonly update: (
      input: VaultUpdateInput,
    ) => Effect.Effect<{ item: VaultItemMetadata }, VaultError>;
    readonly delete: (
      input: VaultDeleteInput,
    ) => Effect.Effect<{ id: VaultItemId; deleted: boolean }, VaultError>;
    readonly listUsage: (
      input: VaultUsageListInput,
    ) => Effect.Effect<
      { usage: ReadonlyArray<import("@t3tools/contracts").VaultUsageEntry> },
      VaultError
    >;
    /** Decrypts one field for a caller, after policy (and domain) checks, and audits it. */
    readonly use: (input: VaultUseInput) => Effect.Effect<VaultUseResult, VaultError>;
    /**
     * Server-internal only (integrations gateway, 2B): resolves a secret by
     * item name for server code. Never expose this through MCP or RPC; agents
     * use `use` via vault_fill so values stay out of model context.
     */
    readonly resolveSecretByName: (input: {
      readonly name: string;
      readonly field?: VaultField | undefined;
      readonly scopeProjectId?: string | null | undefined;
      readonly threadId?: ThreadId | undefined;
    }) => Effect.Effect<{ item: VaultItemMetadata; field: VaultField; value: string }, VaultError>;
    /** Stores a privately-entered value (request_secret saveToVault) as an item. */
    readonly saveSecretValue: (input: {
      readonly name: string;
      readonly type: VaultItemType;
      readonly domains?: ReadonlyArray<string> | undefined;
      readonly value: string;
      readonly scopeProjectId?: string | null | undefined;
    }) => Effect.Effect<{ item: VaultItemMetadata }, VaultError>;
    /** Retained through server lifetime: descendants and retained output may outlive a PTY. */
    readonly registerProcessSecrets: (values: ReadonlyArray<string>) => Effect.Effect<void>;
    readonly scrubText: (text: string) => Effect.Effect<string>;
    readonly scrubValue: <A>(value: A) => Effect.Effect<A>;
  }
>()("cogenly-server/vault/Vault") {}

const KEY_PAIR_STORE_NAME = "vault-x25519-key-pair";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const crypto = yield* Crypto.Crypto;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const scrubCache = yield* Ref.make<{
    loaded: boolean;
    secrets: Set<string>;
    shortSecrets: Set<string>;
    totpSecrets: ReadonlyArray<string>;
  }>({
    loaded: false,
    secrets: new Set<string>(),
    shortSecrets: new Set<string>(),
    totpSecrets: [],
  });

  const processSecrets = yield* Ref.make(new Set<string>());
  const environmentId = yield* identity.getEnvironmentId;

  // VaultMachineKeyStore (file-backed today; Keychain replaces this on macOS).
  const keyStore: VaultCrypto.VaultMachineKeyStore = {
    loadOrCreateKeyPair: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const existing = yield* store.get(KEY_PAIR_STORE_NAME);
          if (Option.isSome(existing)) {
            const decoded = decodeKeyPairOption(new TextDecoder().decode(existing.value));
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
            const decoded = decodeKeyPairOption(new TextDecoder().decode(stored.value));
            if (Option.isSome(decoded)) return decoded.value;
          }
          return pair;
        }).pipe(Effect.mapError(wrap)),
      ),
  };
  let keyPairPromise: Promise<VaultCrypto.VaultKeyPair> | undefined;
  const loadKeyPair = () => (keyPairPromise ??= keyStore.loadOrCreateKeyPair());

  const metadataOf = (row: VaultRow, stored?: StoredFields): VaultItemMetadata => {
    const metadata = parseMetadata(row.metadata_json);
    const cardLast4 = stored ? cardLast4Of(stored) : metadata.cardLast4;
    return {
      id: VaultItemId.make(row.id),
      ...(row.account_id ? { accountId: row.account_id } : {}),
      ...(row.credential_id ? { credentialId: row.credential_id } : {}),
      name: row.name,
      type: row.type as VaultItemMetadata["type"],
      scopeProjectId: row.scope_project_id
        ? (row.scope_project_id as VaultItemMetadata["scopeProjectId"])
        : null,
      ...(metadata.label ? { label: metadata.label as VaultItemMetadata["label"] } : {}),
      allowedDomains: parseDomains(row.allowed_domains_json),
      policy: parsePolicy(row.policy_json),
      fields: stored ? fieldsOf(stored) : ((metadata.fields ?? []) as VaultItemMetadata["fields"]),
      ...(cardLast4 ? { cardLast4 } : {}),
      createdAt: row.created_at as VaultItemMetadata["createdAt"],
      updatedAt: row.updated_at as VaultItemMetadata["updatedAt"],
    } as VaultItemMetadata;
  };

  const loadRow = (itemId: string) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<VaultRow>`SELECT vault_items.*, (SELECT c.account_id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS account_id, (SELECT c.id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS credential_id FROM vault_items WHERE id = ${itemId} AND deleted_at IS NULL`;
      if (!rows[0]) return yield* new VaultError({ reason: "not_found" });
      return rows[0];
    });

  const findRow = (input: {
    itemId?: VaultItemId | undefined;
    name?: string | undefined;
    scopeProjectId?: string | null | undefined;
  }) =>
    Effect.gen(function* () {
      if (input.itemId) return yield* loadRow(input.itemId);
      if (!input.name) return yield* new VaultError({ reason: "invalid_input" });
      const rows =
        yield* sql<VaultRow>`SELECT vault_items.*, (SELECT c.account_id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS account_id, (SELECT c.id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS credential_id FROM vault_items WHERE name = ${input.name} AND deleted_at IS NULL ORDER BY updated_at DESC`;
      if (rows.length === 0) return yield* new VaultError({ reason: "not_found" });
      if (rows.length === 1) return rows[0]!;
      const scoped = rows.filter(
        (row) =>
          row.scope_project_id === (input.scopeProjectId ?? null) || row.scope_project_id === null,
      );
      if (scoped.length === 1) return scoped[0]!;
      return yield* new VaultError({ reason: "ambiguous_name" });
    });

  const decryptStored = (row: VaultRow) =>
    Effect.gen(function* () {
      if (!row.ciphertext) return yield* new VaultError({ reason: "crypto" });
      const wrappedOption = decodeWrappedKeysOption(row.wrapped_keys_json);
      if (Option.isNone(wrappedOption)) return yield* new VaultError({ reason: "crypto" });
      const wrapped = wrappedOption.value;
      const mine = wrapped.find((entry) => entry.environmentId === environmentId);
      if (!mine) return yield* new VaultError({ reason: "crypto" });
      const pair = yield* Effect.promise(loadKeyPair).pipe(Effect.mapError(wrap));
      const bodyOption = decodeBodyOption(row.ciphertext);
      if (Option.isNone(bodyOption)) return yield* new VaultError({ reason: "crypto" });
      const body = bodyOption.value;
      const plaintext = yield* Effect.try({
        try: () =>
          VaultCrypto.decryptBody({
            dataKey: VaultCrypto.unwrapDataKey({
              wrapped: mine,
              privateKey: pair.privateKey,
              itemId: row.id,
            }),
            body,
            itemId: row.id,
          }),
        catch: (cause) => new VaultError({ reason: "crypto", cause }),
      });
      const storedOption = decodeStoredFieldsOption(plaintext);
      if (Option.isNone(storedOption)) return yield* new VaultError({ reason: "crypto" });
      return cleanStored(storedOption.value);
    });

  const encryptStored = (itemId: string, stored: StoredFields) =>
    Effect.gen(function* () {
      const pair = yield* Effect.promise(loadKeyPair).pipe(Effect.mapError(wrap));
      const dataKey = VaultCrypto.randomDataKey();
      const body = VaultCrypto.encryptBody({
        dataKey,
        plaintext: encodeStoredJson(stored),
        itemId,
      });
      const wrapped = VaultCrypto.wrapDataKey({
        recipientPublicKey: pair.publicKey,
        dataKey,
        environmentId,
        itemId,
      });
      return { ciphertext: encodeBodyJson(body), wrappedKeys: encodeWrappedKeysJson([wrapped]) };
    });

  const audit = (input: {
    itemId: string;
    threadId?: ThreadId | undefined;
    agentId?: string | null;
    action: string;
    domain?: string | null | undefined;
    outcome: string;
  }) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4();
      const at = yield* now;
      yield* sql`INSERT INTO vault_usage(id, item_id, thread_id, agent_id, action, domain, at, outcome) VALUES (${`usage:${id}`}, ${input.itemId}, ${input.threadId ?? null}, ${input.agentId ?? null}, ${input.action}, ${input.domain ?? null}, ${at}, ${input.outcome})`;
    }).pipe(Effect.mapError(wrap), Effect.ignore);

  const invalidateScrubCache = Ref.set(scrubCache, {
    loaded: false,
    secrets: new Set<string>(),
    shortSecrets: new Set<string>(),
    totpSecrets: [],
  });

  const ensureScrubSecrets = Effect.gen(function* () {
    const cache = yield* Ref.get(scrubCache);
    if (cache.loaded) return cache;
    const rows =
      yield* sql<VaultRow>`SELECT vault_items.*, (SELECT c.account_id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS account_id, (SELECT c.id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS credential_id FROM vault_items WHERE deleted_at IS NULL`.pipe(
        Effect.mapError(wrap),
      );
    const secrets = new Set<string>();
    const shortSecrets = new Set<string>();
    const totpSecrets: Array<string> = [];
    for (const row of rows) {
      const stored = yield* decryptStored(row).pipe(Effect.option);
      if (Option.isNone(stored)) continue;
      for (const value of Object.values(stored.value))
        if (typeof value === "string" && value.length > 0) secrets.add(value);
      // Card values echo back in shapes other than the stored one: a page may
      // return the number digits-only or grouped, and the expiry as MM/YYYY.
      // The CVC and MM/YY are too short for the general pass, so they go to
      // the whole-token short pass instead.
      const digits = cardDigits(stored.value);
      if (digits.length > 0) {
        secrets.add(digits);
        secrets.add(digits.replace(/(\d{4})(?=\d)/g, "$1 "));
      }
      const expiry = cardExpiryOf(stored.value);
      if (expiry !== undefined) {
        shortSecrets.add(expiry);
        const year = (stored.value.cardExpiryYear ?? "").trim();
        if (year.length === 4) secrets.add(`${expiry.slice(0, 3)}${year}`);
      }
      if (stored.value.cardCvc) shortSecrets.add(stored.value.cardCvc);
      if (stored.value.totpSecret) totpSecrets.push(stored.value.totpSecret);
    }
    const loaded = { loaded: true, secrets, shortSecrets, totpSecrets };
    yield* Ref.set(scrubCache, loaded);
    return loaded;
  });

  /**
   * The cached scrub set plus the TOTP codes valid now: a filled code can echo
   * back in page text, and codes change every 30 seconds, so they are computed
   * per scrub for the current window and its neighbours. Six digits is short
   * enough to collide with ordinary numbers, so they take the whole-token pass.
   */
  const scrubSets = Effect.gen(function* () {
    const { secrets, shortSecrets, totpSecrets } = yield* ensureScrubSecrets;
    if (totpSecrets.length === 0) return { secrets, shortSecrets };
    const nowMs = yield* Clock.currentTimeMillis;
    const withCodes = new Set(shortSecrets);
    for (const secret of totpSecrets)
      for (const offset of [-30_000, 0, 30_000]) {
        const code = Option.liftThrowable(totp)(secret, { atMs: nowMs + offset });
        if (Option.isSome(code)) withCodes.add(code.value);
      }
    return { secrets, shortSecrets: withCodes };
  });

  /** Unscrubbed text never leaves: a scrub set that cannot load withholds the result. */
  const withheldOnFailure = <A>(withheld: () => A) =>
    Effect.catch((error: VaultError) =>
      Effect.logError(
        "Vault secrets could not be loaded for scrubbing; output withheld.",
        error,
      ).pipe(Effect.andThen(Effect.sync(withheld))),
    );

  const cleanStored = (fields: VaultSecretFields): StoredFields => {
    const stored: StoredFields = {};
    if (fields.username) stored.username = fields.username;
    if (fields.password) stored.password = fields.password;
    if (fields.totpSecret) stored.totpSecret = fields.totpSecret;
    if (fields.value) stored.value = fields.value;
    if (fields.cardNumber) stored.cardNumber = fields.cardNumber;
    if (fields.cardExpiryMonth) stored.cardExpiryMonth = fields.cardExpiryMonth;
    if (fields.cardExpiryYear) stored.cardExpiryYear = fields.cardExpiryYear;
    if (fields.cardCvc) stored.cardCvc = fields.cardCvc;
    if (fields.cardholderName) stored.cardholderName = fields.cardholderName;
    return stored;
  };

  const create: Vault["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const id = VaultItemId.make(`vault:${yield* crypto.randomUUIDv4()}`);
      const stored = cleanStored(input.secretFields);
      const encrypted = yield* encryptStored(id, stored);
      const at = yield* now;
      const policy = input.policy ?? defaultVaultPolicy;
      yield* sql`INSERT INTO vault_items(id, name, type, scope_project_id, metadata_json, policy_json, allowed_domains_json, ciphertext, wrapped_keys_json, created_at, updated_at) VALUES (${id}, ${input.name}, ${input.type}, ${input.scopeProjectId ?? null}, ${encodeMetadataJson({ ...(input.label ? { label: input.label } : {}), fields: fieldsOf(stored), ...(cardLast4Of(stored) ? { cardLast4: cardLast4Of(stored) } : {}) })}, ${encodePolicyJson(policy)}, ${encodeDomainsJson(input.allowedDomains ?? [])}, ${encrypted.ciphertext}, ${encrypted.wrappedKeys}, ${at}, ${at})`.pipe(
        Effect.mapError((cause) =>
          String(cause).includes("UNIQUE")
            ? new VaultError({ reason: "name_conflict", cause })
            : wrap(cause),
        ),
      );
      yield* invalidateScrubCache;
      const row = yield* loadRow(id);
      return { item: metadataOf(row, stored) };
    }).pipe(Effect.mapError(wrap));

  const list: Vault["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<VaultRow>`SELECT vault_items.*, (SELECT c.account_id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS account_id, (SELECT c.id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS credential_id FROM vault_items WHERE deleted_at IS NULL AND (${input.scopeProjectId ?? null} IS NULL OR scope_project_id IS NULL OR scope_project_id = ${input.scopeProjectId ?? null}) ORDER BY name`.pipe(
          Effect.mapError(wrap),
        );
      return { items: rows.map((row) => metadataOf(row)) };
    });

  const update: Vault["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const row = yield* loadRow(input.id);
      const current = yield* decryptStored(row);
      let stored = current;
      let ciphertext = row.ciphertext;
      let wrappedKeys = row.wrapped_keys_json;
      if (input.secretFields) {
        stored = { ...current };
        for (const [key, value] of Object.entries(input.secretFields)) {
          if (value === "") delete stored[key as keyof StoredFields];
          else if (value !== undefined) stored[key as keyof StoredFields] = value;
        }
        const encrypted = yield* encryptStored(row.id, stored);
        ciphertext = encrypted.ciphertext;
        wrappedKeys = encrypted.wrappedKeys;
      }
      const at = yield* now;
      const policy = input.policy ?? parsePolicy(row.policy_json);
      const label =
        input.label === null ? undefined : (input.label ?? parseMetadata(row.metadata_json).label);
      yield* sql`UPDATE vault_items SET name = ${input.name ?? row.name}, type = ${input.type ?? row.type}, scope_project_id = ${input.scopeProjectId === undefined ? row.scope_project_id : input.scopeProjectId}, metadata_json = ${encodeMetadataJson({ ...(label ? { label } : {}), fields: fieldsOf(stored), ...(cardLast4Of(stored) ? { cardLast4: cardLast4Of(stored) } : {}) })}, policy_json = ${encodePolicyJson(policy)}, allowed_domains_json = ${encodeDomainsJson(input.allowedDomains ?? parseDomains(row.allowed_domains_json))}, ciphertext = ${ciphertext}, wrapped_keys_json = ${wrappedKeys}, credential_revision = ${row.credential_revision + (input.secretFields ? 1 : 0)}, updated_at = ${at} WHERE id = ${row.id}`.pipe(
        Effect.mapError((cause) =>
          String(cause).includes("UNIQUE")
            ? new VaultError({ reason: "name_conflict", cause })
            : wrap(cause),
        ),
      );
      yield* invalidateScrubCache;
      return { item: metadataOf(yield* loadRow(row.id), stored) };
    }).pipe(Effect.mapError(wrap));

  const fieldValue = (stored: StoredFields, field: VaultField): string | undefined => {
    if (field === "totp") return stored.totpSecret ? totp(stored.totpSecret) : undefined;
    if (field === "cardExpiry") return cardExpiryOf(stored);
    const key = storedKeyForField(field);
    const value = key === null ? undefined : stored[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const use: Vault["Service"]["use"] = (input) =>
    Effect.gen(function* () {
      const row = yield* findRow({
        itemId: input.itemId,
        name: input.name,
        scopeProjectId: input.scopeProjectId,
      });
      if (
        input.expectedRevision !== undefined &&
        row.credential_revision !== input.expectedRevision
      )
        return yield* new VaultError({ reason: "invalid_input" });
      const item = metadataOf(row);
      const agentId = input.caller.kind === "agent" ? input.caller.agentId : null;
      const action = input.action ?? "use";
      const record = (outcome: string) =>
        audit({
          itemId: row.id,
          threadId: input.threadId,
          agentId,
          action,
          domain: input.domain,
          outcome,
        });
      if (
        input.enforceAllowedDomains &&
        !(input.domain && hostMatchesAnyDomain(input.domain, item.allowedDomains))
      ) {
        yield* record("denied_domain");
        return {
          status: "denied",
          item,
          field: input.field,
          reason: "domain_not_allowed",
        } as const;
      }
      const decision = evaluateVaultPolicy({
        policy: item.policy,
        caller: input.caller,
        domain: input.domain,
      });
      if (decision === "ask") {
        // Reuse the existing agent approval mechanism: one pending approval
        // per agent/item/field/domain, decided by the owner (see
        // AgentWorkspaceService.approve's vault_use case, which grants the
        // item policy so a retry succeeds).
        let approvalId: string | null = null;
        if (input.caller.kind === "agent") {
          approvalId = `approval:vault:${row.id}:${input.caller.agentId}:${input.field}:${input.domain ?? ""}`;
          const actionJson = encodeApprovalActionJson({
            actionKind: "vault_use",
            payload: {
              vaultItemId: row.id as never,
              vaultItemName: row.name as never,
              field: input.field,
              domain: input.domain ?? null,
              threadId: input.threadId ?? null,
            },
          });
          yield* sql`INSERT OR IGNORE INTO agent_approvals(id, agent_id, action_json, status, requested_at, source_run_id) VALUES (${approvalId}, ${input.caller.agentId}, ${actionJson}, 'pending', ${yield* now}, ${null})`.pipe(
            Effect.mapError(wrap),
          );
        }
        yield* record("approval_required");
        return {
          status: "approval_required",
          item,
          field: input.field,
          approvalId,
          message:
            "Waiting on you: this vault use needs owner approval. Ask again after it is approved.",
        } as const;
      }
      if (decision === "deny") {
        yield* record("denied_policy");
        return { status: "denied", item, field: input.field, reason: "policy" } as const;
      }
      const stored = yield* decryptStored(row);
      const value = fieldValue(stored, input.field);
      if (value === undefined) {
        yield* record("field_missing");
        return yield* new VaultError({ reason: "field_missing" });
      }
      yield* record("allowed");
      return { status: "allowed", item, field: input.field, value } as const;
    }).pipe(Effect.mapError(wrap));

  return Vault.of({
    list,
    getMetadata: (itemId) =>
      loadRow(itemId).pipe(
        Effect.map((row) => metadataOf(row)),
        Effect.mapError(wrap),
      ),
    create,
    update,
    delete: (input) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE vault_items SET deleted_at = ${yield* now}, ciphertext = '', wrapped_keys_json = '[]', updated_at = ${yield* now} WHERE id = ${input.id} AND deleted_at IS NULL RETURNING id`.pipe(
            Effect.mapError(wrap),
          );
        yield* invalidateScrubCache;
        return { id: input.id, deleted: rows.length > 0 };
      }),
    listUsage: (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
          item_id: string;
          credential_id: string | null;
          credential_revision: string | null;
          environment_id: string | null;
          project_id: string | null;
          delivery_method: string | null;
          terminal_id: string | null;
          provider_instance_id: string | null;
          thread_id: string | null;
          agent_id: string | null;
          action: string;
          domain: string | null;
          at: string;
          outcome: string;
        }>`SELECT * FROM vault_usage WHERE (${input.itemId ?? null} IS NULL OR item_id = ${input.itemId ?? null}) ORDER BY at DESC, id LIMIT ${input.limit ?? 100}`.pipe(
          Effect.mapError(wrap),
        );
        return {
          usage: rows.map((row) => ({
            id: row.id as never,
            itemId: VaultItemId.make(row.item_id),
            credentialId: row.credential_id as never,
            credentialRevision: row.credential_revision,
            environmentId: row.environment_id,
            projectId: row.project_id,
            deliveryMethod: row.delivery_method,
            terminalId: row.terminal_id,
            providerInstanceId: row.provider_instance_id,
            threadId: row.thread_id ? ThreadId.make(row.thread_id) : null,
            agentId: row.agent_id ? AgentId.make(row.agent_id) : null,
            action: row.action as never,
            domain: row.domain,
            at: row.at as never,
            outcome: row.outcome as never,
          })),
        };
      }),
    use,
    resolveSecretByName: (input) =>
      Effect.gen(function* () {
        const result = yield* use({
          name: input.name,
          scopeProjectId: input.scopeProjectId,
          field: input.field ?? "value",
          caller: { kind: "server" },
          threadId: input.threadId,
          action: "resolve",
        });
        if (result.status !== "allowed")
          return yield* new VaultError({ reason: "approval_required" });
        return { item: result.item, field: result.field, value: result.value };
      }),
    saveSecretValue: (input) =>
      create({
        name: input.name as never,
        type: input.type,
        scopeProjectId: (input.scopeProjectId ?? null) as never,
        allowedDomains: [...(input.domains ?? [])] as never,
        secretFields: input.type === "login" ? { password: input.value } : { value: input.value },
      }),
    registerProcessSecrets: (values) =>
      Ref.update(processSecrets, (current) => {
        const next = new Set(current);
        for (const value of values) {
          next.add(value);
          next.add(Buffer.from(value).toString("base64"));
          next.add(encodeURIComponent(value));
          next.add(JSON.stringify(value).slice(1, -1));
        }
        return next;
      }),
    scrubText: (text) =>
      scrubSets.pipe(
        Effect.map(({ secrets, shortSecrets }) =>
          redactShortSecrets(redactText(text, secrets), shortSecrets),
        ),
        withheldOnFailure(() => VAULT_WITHHELD),
        Effect.flatMap((scrubbed) =>
          Ref.get(processSecrets).pipe(Effect.map((secrets) => redactText(scrubbed, secrets))),
        ),
      ),
    scrubValue: (value) =>
      scrubSets.pipe(
        Effect.map(({ secrets, shortSecrets }) =>
          redactShortValue(redactValue(value, secrets), shortSecrets),
        ),
        withheldOnFailure(() => withholdValue(value)),
        Effect.flatMap((scrubbed) =>
          Ref.get(processSecrets).pipe(Effect.map((secrets) => redactValue(scrubbed, secrets))),
        ),
      ),
  });
});

export const layer = Layer.effect(Vault, make);
