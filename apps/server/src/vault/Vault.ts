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
} from "@cogenly/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ApprovalChanges from "../agents/ApprovalChanges.ts";
import * as ProjectFiles from "../projectLabels/ProjectFiles.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as VaultCrypto from "./VaultCrypto.ts";
import { makeVaultKeyPairLoader } from "./VaultKeyPair.ts";
import {
  effectivePortability,
  loadMachineOnlyRules,
  type MachineOnlyRules,
} from "./vaultPortability.ts";
import * as VaultSyncCapture from "./VaultSyncCapture.ts";
import { evaluateVaultPolicy, hostMatchesAnyDomain, type VaultUseCaller } from "./VaultPolicy.ts";
import {
  VAULT_WITHHELD,
  processOutputRedactor,
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
  readonly portability: string;
  readonly sync_attachment_json: string | null;
  readonly sync_extras: string | null;
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
const AttachmentJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const SyncExtrasJson = Schema.fromJsonString(
  Schema.Struct({
    body: Schema.Struct({ nonce: Schema.String, ciphertext: Schema.String }),
    key: Schema.Struct({
      environmentId: Schema.String,
      ephemeralPublicKey: Schema.String,
      nonce: Schema.String,
      ciphertext: Schema.String,
    }),
  }),
);
const encodeSyncExtrasJson = Schema.encodeSync(SyncExtrasJson);
const decodeSyncExtrasOption = Schema.decodeUnknownOption(SyncExtrasJson);
const ApprovalActionJson = Schema.fromJsonString(AgentApprovalAction);
const encodeStoredJson = Schema.encodeSync(StoredFieldsJson);
const encodeMetadataJson = Schema.encodeSync(MetadataJson);
const encodePolicyJson = Schema.encodeSync(PolicyJson);
const encodeDomainsJson = Schema.encodeSync(DomainsJson);
const encodeWrappedKeysJson = Schema.encodeSync(WrappedKeysJson);
const encodeBodyJson = Schema.encodeSync(BodyJson);
const encodeAttachmentJson = Schema.encodeSync(AttachmentJson);
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
const decodeAttachmentOption = Schema.decodeUnknownOption(AttachmentJson);
const parseMetadata = (text: string): MetadataShape =>
  Option.getOrElse(decodeMetadataOption(text), () => ({}));

/** Server-internal extras for `create` and `update`, never reachable from RPC or MCP. */
export interface VaultWriteOptions {
  /** Replaces the item's sync attachment in the same write; null removes it. */
  readonly syncAttachment?: Readonly<Record<string, Schema.Json>> | null | undefined;
}

/** An item a peer's sync just changed here. */
export interface VaultSyncedChange {
  readonly itemId: string;
  readonly removed: boolean;
}

/** A live item carrying a sync attachment, as features that own attachments read them. */
export interface VaultAttachedItem {
  readonly item: VaultItemMetadata;
  readonly attachment: Readonly<Record<string, Schema.Json>>;
}

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
      threadId?: ThreadId,
    ) => Effect.Effect<{ items: ReadonlyArray<VaultItemMetadata> }, VaultError>;
    readonly getMetadata: (itemId: VaultItemId) => Effect.Effect<VaultItemMetadata, VaultError>;
    readonly create: (
      input: VaultCreateInput,
      options?: VaultWriteOptions,
    ) => Effect.Effect<{ item: VaultItemMetadata; revision: number }, VaultError>;
    readonly update: (
      input: VaultUpdateInput,
      options?: VaultWriteOptions,
    ) => Effect.Effect<{ item: VaultItemMetadata; revision: number }, VaultError>;
    readonly delete: (
      input: VaultDeleteInput,
      threadId?: ThreadId,
    ) => Effect.Effect<{ id: VaultItemId; deleted: boolean }, VaultError>;
    readonly listUsage: (
      input: VaultUsageListInput,
    ) => Effect.Effect<
      { usage: ReadonlyArray<import("@cogenly/contracts").VaultUsageEntry> },
      VaultError
    >;
    /** Decrypts one field for a caller, after policy (and domain) checks, and audits it. */
    readonly use: (input: VaultUseInput) => Effect.Effect<VaultUseResult, VaultError>;
    /**
     * Server-internal only (integrations gateway, 2B): resolves a secret by
     * item name for server code sending it to `destinationHost`. The item's
     * allowed domains must include that host unless the owner `approved` this
     * item for it; otherwise it fails with `domain_not_allowed`. Never expose
     * this through MCP or RPC; agents use `use` via vault_fill so values stay
     * out of model context.
     */
    readonly resolveSecretByName: (input: {
      readonly name: string;
      readonly field?: VaultField | undefined;
      readonly scopeProjectId?: string | null | undefined;
      readonly threadId?: ThreadId | undefined;
      readonly destinationHost: string;
      readonly approved: boolean;
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
    readonly registerProcessSecrets: (
      values: ReadonlyArray<string>,
    ) => Effect.Effect<void, VaultError>;
    readonly makeOutputRedactor: () => Effect.Effect<
      (chunk: string, final?: boolean) => Effect.Effect<string>
    >;
    readonly scrubText: (text: string) => Effect.Effect<string>;
    readonly scrubValue: <A>(value: A) => Effect.Effect<A>;
    /**
     * Server-internal: non-secret JSON another feature keeps with an item; it
     * syncs inside the item's sealed payload. Null removes it.
     */
    readonly setSyncAttachment: (
      itemId: VaultItemId,
      attachment: Readonly<Record<string, Schema.Json>> | null,
      options?: { readonly onlyIfMissing: boolean },
    ) => Effect.Effect<void, VaultError>;
    readonly getSyncAttachment: (
      itemId: VaultItemId,
    ) => Effect.Effect<Readonly<Record<string, Schema.Json>> | undefined, VaultError>;
    /** Server-internal: every live item with a sync attachment, metadata only. */
    readonly listSyncAttachments: Effect.Effect<ReadonlyArray<VaultAttachedItem>, VaultError>;
    /**
     * Server-internal: a counter that grows whenever the item's secrets change,
     * here or through sync, so a cache of decrypted values knows when to drop.
     */
    readonly credentialRevision: (itemId: VaultItemId) => Effect.Effect<number, VaultError>;
    /** Server-internal: secrets and their sign-in metadata from one row snapshot. */
    readonly readCredential: (itemId: VaultItemId) => Effect.Effect<
      {
        readonly secretFields: VaultSecretFields;
        readonly revision: number;
        readonly attachment: Readonly<Record<string, Schema.Json>> | undefined;
      },
      VaultError
    >;
    /** Items a peer's sync applied or removed here, after the write. */
    readonly syncedChanges: Stream.Stream<VaultSyncedChange>;
    /** VaultSync only: bring this item's synced document up to date with its row. */
    readonly recapture: (itemId: string) => Effect.Effect<void, VaultError>;
    /**
     * VaultSync only: store a synced item with this machine's own encryption,
     * keeping local policy. An item deleted here comes back as a new arrival.
     * Returns the name it has here, which differs from the synced one when
     * that name was taken in the item's scope.
     */
    readonly applySynced: (input: {
      readonly itemId: string;
      readonly payload: VaultSyncCapture.VaultSyncPayload;
      readonly extras: VaultSyncCapture.VaultSyncExtras;
      readonly sourceLabel: string;
    }) => Effect.Effect<string, VaultError>;
    /** VaultSync only: an incoming delete; wipes the ciphertext like `delete`. */
    readonly removeSynced: (itemId: string) => Effect.Effect<void, VaultError>;
  }
>()("cogenly-server/vault/Vault") {}

const MAX_DELIVERED_SECRET_COUNT = 16_384;
const MAX_DELIVERED_SECRET_BYTES = 4 * 1024 * 1024;

interface ScrubCache {
  readonly version: number;
  readonly loaded: boolean;
  readonly secrets: Set<string>;
  readonly shortSecrets: Set<string>;
  readonly totpSecrets: ReadonlyArray<string>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const crypto = yield* Crypto.Crypto;
  const notifyApprovals = (yield* ApprovalChanges.optional).notify;
  const syncedChanges = yield* PubSub.unbounded<VaultSyncedChange>();
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const scrubCache = yield* Ref.make<ScrubCache>({
    version: 0,
    loaded: false,
    secrets: new Set(),
    shortSecrets: new Set(),
    totpSecrets: [],
  });

  const deliveredSecrets = yield* Ref.make({
    secrets: new Set<string>(),
    shortSecrets: new Set<string>(),
    bytes: 0,
  });
  const registerDelivered = (values: ReadonlyArray<string>, wholeToken = false) =>
    Ref.modify(deliveredSecrets, (current) => {
      const secrets = new Set(current.secrets),
        shortSecrets = new Set(current.shortSecrets);
      let bytes = current.bytes;
      for (const value of values) {
        if (!value) continue;
        const target = wholeToken || value.length < 6 ? shortSecrets : secrets;
        if (target.has(value)) continue;
        bytes += Buffer.byteLength(value);
        target.add(value);
        if (
          secrets.size + shortSecrets.size > MAX_DELIVERED_SECRET_COUNT ||
          bytes > MAX_DELIVERED_SECRET_BYTES
        )
          return [false, current] as const;
      }
      return [true, { secrets, shortSecrets, bytes }] as const;
    }).pipe(
      Effect.flatMap((registered) =>
        registered ? Effect.void : Effect.fail(new VaultError({ reason: "storage" })),
      ),
    );

  const projectFiles = yield* Effect.serviceOption(ProjectFiles.ProjectFiles);
  const projectForThread = (threadId: ThreadId | undefined) =>
    threadId === undefined || Option.isNone(projectFiles)
      ? Effect.succeed(null)
      : projectFiles.value.folderForThread(threadId).pipe(
          Effect.map((folder) => folder?.labelId ?? null),
          Effect.mapError(wrap),
        );
  const visibleIn = (row: VaultRow, scope: string | null | undefined) =>
    scope === undefined || row.scope_project_id === null || row.scope_project_id === scope;

  const environmentId = yield* identity.getEnvironmentId;

  const keyPair = makeVaultKeyPairLoader(store);
  const syncCapture = yield* Effect.serviceOption(VaultSyncCapture.VaultSyncCapture);
  const rules = loadMachineOnlyRules().pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.mapError(wrap),
  );

  const metadataOf = (
    row: VaultRow,
    machineOnly: MachineOnlyRules,
    stored?: StoredFields,
  ): VaultItemMetadata => {
    const metadata = parseMetadata(row.metadata_json);
    const cardLast4 = stored ? cardLast4Of(stored) : metadata.cardLast4;
    const portability = effectivePortability(row, machineOnly);
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
      portability: portability.portability,
      ...(portability.reason ? { portabilityReason: portability.reason } : {}),
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
      if (input.itemId) {
        const row = yield* loadRow(input.itemId);
        if (!visibleIn(row, input.scopeProjectId))
          return yield* new VaultError({ reason: "not_found" });
        return row;
      }
      if (!input.name) return yield* new VaultError({ reason: "invalid_input" });
      const rows =
        yield* sql<VaultRow>`SELECT vault_items.*, (SELECT c.account_id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS account_id, (SELECT c.id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS credential_id FROM vault_items WHERE name = ${input.name} AND deleted_at IS NULL ORDER BY updated_at DESC`;
      const scoped = rows.filter((row) => visibleIn(row, input.scopeProjectId));
      if (scoped.length === 0) return yield* new VaultError({ reason: "not_found" });
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
      const pair = yield* keyPair;
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
      const pair = yield* keyPair;
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

  // A synced item's payload keys this build cannot read, encrypted like its
  // secrets (they may be secrets) under their own data key.
  const extrasScope = (itemId: string) => `${itemId}#sync-extras`;
  const encryptExtras = (itemId: string, extras: VaultSyncCapture.VaultSyncExtras | undefined) =>
    Effect.gen(function* () {
      if (extras === undefined || Object.keys(extras).length === 0) return null;
      const pair = yield* keyPair;
      const dataKey = VaultCrypto.randomDataKey();
      return encodeSyncExtrasJson({
        body: VaultCrypto.encryptBody({
          dataKey,
          plaintext: encodeAttachmentJson(extras),
          itemId: extrasScope(itemId),
        }),
        key: VaultCrypto.wrapDataKey({
          recipientPublicKey: pair.publicKey,
          dataKey,
          environmentId,
          itemId: extrasScope(itemId),
        }),
      });
    });
  const decryptExtras = (row: VaultRow) =>
    Effect.gen(function* () {
      if (row.sync_extras === null) return undefined;
      const sealed = Option.getOrUndefined(decodeSyncExtrasOption(row.sync_extras));
      if (sealed === undefined || sealed.key.environmentId !== environmentId) return undefined;
      const pair = yield* keyPair;
      const plaintext = Option.liftThrowable(() =>
        VaultCrypto.decryptBody({
          dataKey: VaultCrypto.unwrapDataKey({
            wrapped: sealed.key,
            privateKey: pair.privateKey,
            itemId: extrasScope(row.id),
          }),
          body: sealed.body,
          itemId: extrasScope(row.id),
        }),
      )();
      return Option.isNone(plaintext)
        ? undefined
        : Option.getOrUndefined(decodeAttachmentOption(plaintext.value));
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

  const invalidateScrubCache = Ref.update(scrubCache, (cache) => ({
    version: cache.version + 1,
    loaded: false,
    secrets: new Set<string>(),
    shortSecrets: new Set<string>(),
    totpSecrets: [],
  }));

  const ensureScrubSecrets: Effect.Effect<ScrubCache, VaultError> = Effect.gen(function* () {
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
      // A peer's item not wrapped for this machine holds nothing this machine
      // could deliver, so it is skipped. Failing to read a local item fails the
      // whole load, and scrubbing withholds output rather than miss its secret.
      const wrapped = decodeWrappedKeysOption(row.wrapped_keys_json);
      if (
        Option.isSome(wrapped) &&
        wrapped.value.length > 0 &&
        !wrapped.value.some((entry) => entry.environmentId === environmentId)
      ) {
        continue;
      }
      const stored = yield* decryptStored(row);
      for (const value of Object.values(stored))
        if (typeof value === "string" && value.length > 0)
          (value.length < 6 ? shortSecrets : secrets).add(value);
      // Card values echo back in shapes other than the stored one: a page may
      // return the number digits-only or grouped, and the expiry as MM/YYYY.
      // The CVC and MM/YY are too short for the general pass, so they go to
      // the whole-token short pass instead.
      const digits = cardDigits(stored);
      if (digits.length > 0) {
        secrets.add(digits);
        secrets.add(digits.replace(/(\d{4})(?=\d)/g, "$1 "));
      }
      const expiry = cardExpiryOf(stored);
      if (expiry !== undefined) {
        shortSecrets.add(expiry);
        const year = (stored.cardExpiryYear ?? "").trim();
        if (year.length === 4) secrets.add(`${expiry.slice(0, 3)}${year}`);
      }
      if (stored.cardCvc) shortSecrets.add(stored.cardCvc);
      if (stored.totpSecret) totpSecrets.push(stored.totpSecret);
    }
    const loaded = { version: cache.version, loaded: true, secrets, shortSecrets, totpSecrets };
    const committed = yield* Ref.modify(scrubCache, (current) =>
      current.version === cache.version ? ([true, loaded] as const) : ([false, current] as const),
    );
    return committed ? loaded : yield* ensureScrubSecrets;
  });

  /**
   * The cached scrub set plus the TOTP codes valid now: a filled code can echo
   * back in page text, and codes change every 30 seconds, so they are computed
   * per scrub for the current window and its neighbours. Six digits is short
   * enough to collide with ordinary numbers, so they take the whole-token pass.
   */
  const scrubSets = Effect.gen(function* () {
    const cached = yield* ensureScrubSecrets;
    const delivered = yield* Ref.get(deliveredSecrets);
    const secrets = new Set([...cached.secrets, ...delivered.secrets]);
    const shortSecrets = new Set([...cached.shortSecrets, ...delivered.shortSecrets]);
    const { totpSecrets } = cached;
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

  const attachmentOf = (row: VaultRow) =>
    row.sync_attachment_json === null
      ? undefined
      : Option.getOrUndefined(decodeAttachmentOption(row.sync_attachment_json));

  /** What syncs of a row: the sealed payload's content, never policy or usage. */
  const syncSource = (
    row: VaultRow,
    stored: StoredFields,
    extras: VaultSyncCapture.VaultSyncExtras | undefined,
  ): VaultSyncCapture.VaultSyncSource => {
    const label = parseMetadata(row.metadata_json).label;
    const cardLast4 = cardLast4Of(stored);
    const attachment = attachmentOf(row);
    return {
      id: row.id,
      deleted: false,
      portability: row.portability,
      extras,
      payload: {
        name: row.name,
        type: row.type as VaultItemType,
        scopeProjectId: row.scope_project_id as VaultItemMetadata["scopeProjectId"],
        ...(label ? { label } : {}),
        allowedDomains: parseDomains(row.allowed_domains_json),
        secretFields: stored,
        ...(cardLast4 ? { cardLast4 } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(attachment ? { attachment } : {}),
      },
    };
  };
  const capture = (source: VaultSyncCapture.VaultSyncSource) =>
    Option.isSome(syncCapture) ? syncCapture.value.capture(source) : Effect.void;
  /** Re-reads the committed row so the document matches exactly what is stored. */
  const captureRow = (itemId: string) =>
    Effect.gen(function* () {
      if (Option.isNone(syncCapture)) return;
      const rows = yield* sql<VaultRow>`SELECT * FROM vault_items WHERE id = ${itemId}`;
      const row = rows[0];
      if (!row) return;
      if (row.deleted_at !== null)
        return yield* capture({
          id: row.id,
          deleted: true,
          name: row.name,
          portability: row.portability,
        });
      yield* capture(syncSource(row, yield* decryptStored(row), yield* decryptExtras(row)));
    });

  const encodeAttachment = (attachment: Readonly<Record<string, Schema.Json>> | null) =>
    attachment === null ? null : encodeAttachmentJson(attachment);

  const create: Vault["Service"]["create"] = (input, options) =>
    Effect.gen(function* () {
      const id = VaultItemId.make(`vault:${yield* crypto.randomUUIDv4()}`);
      const stored = cleanStored(input.secretFields);
      const encrypted = yield* encryptStored(id, stored);
      const at = yield* now;
      const policy = input.policy ?? defaultVaultPolicy;

      yield* sql`INSERT INTO vault_items(id, name, type, scope_project_id, metadata_json, policy_json, allowed_domains_json, ciphertext, wrapped_keys_json, created_at, updated_at, portability, sync_attachment_json) VALUES (${id}, ${input.name}, ${input.type}, ${input.scopeProjectId ?? null}, ${encodeMetadataJson({ ...(input.label ? { label: input.label } : {}), fields: fieldsOf(stored), ...(cardLast4Of(stored) ? { cardLast4: cardLast4Of(stored) } : {}) })}, ${encodePolicyJson(policy)}, ${encodeDomainsJson(input.allowedDomains ?? [])}, ${encrypted.ciphertext}, ${encrypted.wrappedKeys}, ${at}, ${at}, ${input.portability ?? "shared"}, ${encodeAttachment(options?.syncAttachment ?? null)})`.pipe(
        Effect.mapError((cause) =>
          String(cause).includes("UNIQUE")
            ? new VaultError({ reason: "name_conflict", cause })
            : wrap(cause),
        ),
      );
      yield* captureRow(id);

      const row = yield* loadRow(id);
      return { item: metadataOf(row, yield* rules, stored), revision: row.credential_revision };
    }).pipe(
      sql.withTransaction,
      Effect.tap(() => invalidateScrubCache),
      Effect.mapError(wrap),
    );

  const list: Vault["Service"]["list"] = (input, threadId) =>
    Effect.gen(function* () {
      const scope =
        threadId === undefined ? input.scopeProjectId : yield* projectForThread(threadId);
      const rows =
        yield* sql<VaultRow>`SELECT vault_items.*, (SELECT c.account_id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS account_id, (SELECT c.id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS credential_id FROM vault_items WHERE deleted_at IS NULL ORDER BY name`.pipe(
          Effect.mapError(wrap),
        );
      const machineOnly = yield* rules;
      return {
        items: rows
          .filter((row) => visibleIn(row, scope))
          .map((row) => metadataOf(row, machineOnly)),
      };
    });

  const update: Vault["Service"]["update"] = (input, options) =>
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
      // Policy is local; an edit that changes only policy has nothing to sync.
      const synced =
        input.name !== undefined ||
        input.type !== undefined ||
        input.scopeProjectId !== undefined ||
        input.label !== undefined ||
        input.allowedDomains !== undefined ||
        input.secretFields !== undefined ||
        input.portability !== undefined ||
        options?.syncAttachment !== undefined;
      const attachment =
        options?.syncAttachment === undefined
          ? row.sync_attachment_json
          : encodeAttachment(options.syncAttachment);
      yield* sql`UPDATE vault_items SET name = ${input.name ?? row.name}, type = ${input.type ?? row.type}, scope_project_id = ${input.scopeProjectId === undefined ? row.scope_project_id : input.scopeProjectId}, metadata_json = ${encodeMetadataJson({ ...(label ? { label } : {}), fields: fieldsOf(stored), ...(cardLast4Of(stored) ? { cardLast4: cardLast4Of(stored) } : {}) })}, policy_json = ${encodePolicyJson(policy)}, allowed_domains_json = ${encodeDomainsJson(input.allowedDomains ?? parseDomains(row.allowed_domains_json))}, ${input.secretFields ? sql`ciphertext = ${ciphertext}, wrapped_keys_json = ${wrappedKeys}, credential_revision = credential_revision + 1,` : sql``} portability = ${input.portability ?? row.portability}, sync_attachment_json = ${attachment}, updated_at = ${at} WHERE id = ${row.id}`.pipe(
        Effect.mapError((cause) =>
          String(cause).includes("UNIQUE")
            ? new VaultError({ reason: "name_conflict", cause })
            : wrap(cause),
        ),
      );
      if (synced) yield* captureRow(row.id);
      const updated = yield* loadRow(row.id);
      return {
        item: metadataOf(updated, yield* rules, stored),
        revision: updated.credential_revision,
      };
    }).pipe(
      sql.withTransaction,
      Effect.tap(() => invalidateScrubCache),
      Effect.mapError(wrap),
    );

  const fieldValue = (
    stored: StoredFields,
    field: VaultField,
    atMs: number,
  ): string | undefined => {
    if (field === "totp") return stored.totpSecret ? totp(stored.totpSecret, { atMs }) : undefined;
    if (field === "cardExpiry") return cardExpiryOf(stored);
    const key = storedKeyForField(field);
    const value = key === null ? undefined : stored[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const use: Vault["Service"]["use"] = (input) =>
    Effect.gen(function* () {
      const callingThreadId =
        input.caller.kind === "thread" ? ThreadId.make(input.caller.threadId) : input.threadId;
      const scope =
        input.caller.kind === "agent" || input.caller.kind === "thread"
          ? yield* projectForThread(
              input.caller.kind === "thread"
                ? ThreadId.make(input.caller.threadId)
                : input.threadId,
            )
          : input.scopeProjectId;
      const row = yield* findRow({
        itemId: input.itemId,
        name: input.name,
        scopeProjectId: scope,
      });
      if (
        input.expectedRevision !== undefined &&
        row.credential_revision !== input.expectedRevision
      )
        return yield* new VaultError({ reason: "invalid_input" });
      const item = metadataOf(row, yield* rules);
      const agentId = input.caller.kind === "agent" ? input.caller.agentId : null;
      const action = input.action ?? "use";
      const record = (outcome: string) =>
        audit({
          itemId: row.id,
          threadId: callingThreadId,
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
        let declinedBefore = false;
        if (input.caller.kind === "agent" || input.caller.kind === "thread") {
          const callerKey =
            input.caller.kind === "agent" ? input.caller.agentId : input.caller.threadId;
          const actionJson = encodeApprovalActionJson({
            actionKind: "vault_use",
            payload: {
              vaultItemId: row.id as never,
              vaultItemName: row.name as never,
              field: input.field,
              domain: input.domain ?? null,
              threadId: callingThreadId ?? null,
            },
          });
          const requested = yield* Effect.gen(function* () {
            const latest = yield* sql<{
              id: string;
              status: string;
              decided_by: string | null;
            }>`SELECT id, status, decided_by FROM agent_approvals WHERE agent_id IS ${agentId} AND action_json = ${actionJson} ORDER BY requested_at DESC, rowid DESC LIMIT 1`;
            if (latest[0]?.status === "pending")
              return { id: latest[0].id, created: false, declinedBefore: false };
            const id = `approval:vault:${row.id}:${callerKey}:${yield* crypto.randomUUIDv4()}`;
            yield* sql`INSERT INTO agent_approvals(id, agent_id, action_json, status, requested_at, source_run_id) VALUES (${id}, ${agentId}, ${actionJson}, 'pending', ${yield* now}, ${null})`;
            return {
              id,
              created: true,
              declinedBefore: latest[0]?.status === "rejected" && latest[0].decided_by === "user",
            };
          }).pipe(sql.withTransaction, Effect.mapError(wrap));
          approvalId = requested.id;
          declinedBefore = requested.declinedBefore;
          if (requested.created) yield* notifyApprovals;
        }
        yield* record("approval_required");
        // A thread's approval shows as a card in that thread; an agent's in its workspace.
        const where =
          input.caller.kind === "thread"
            ? "The user sees an approval card in this thread."
            : "The owner sees it in this agent's open items.";
        return {
          status: "approval_required",
          item,
          field: input.field,
          approvalId,
          message: `Waiting on the user: this vault use needs their approval. ${where} ${
            declinedBefore
              ? "They declined the last request for this; don't retry unless they ask you to."
              : "Wait for them to decide, then call again; it succeeds once they allow it."
          }`,
        } as const;
      }
      if (decision === "deny") {
        yield* record("denied_policy");
        return { status: "denied", item, field: input.field, reason: "policy" } as const;
      }
      const stored = yield* decryptStored(row);
      const value = fieldValue(stored, input.field, yield* Clock.currentTimeMillis);
      if (value === undefined) {
        yield* record("field_missing");
        return yield* new VaultError({ reason: "field_missing" });
      }
      // Never deliver a value we cannot keep scrubbing for this process's lifetime.
      yield* registerDelivered([value], input.field === "totp");
      yield* record("allowed");
      return { status: "allowed", item, field: input.field, value } as const;
    }).pipe(Effect.mapError(wrap));

  // The contract's item name limit, and the share of it a machine's name may take in a suffix.
  const SYNC_NAME_LIMIT = 200;
  const SYNC_LABEL_LIMIT = 60;
  const applySynced: Vault["Service"]["applySynced"] = ({ itemId, payload, extras, sourceLabel }) =>
    Effect.gen(function* () {
      const found = (yield* sql<VaultRow>`SELECT * FROM vault_items WHERE id = ${itemId}`)[0];
      // An item deleted here and edited elsewhere later arrives again, as new.
      const existing = found?.deleted_at ? undefined : found;
      const stored = cleanStored(payload.secretFields);
      const encrypted = yield* encryptStored(itemId, stored);
      const sealedExtras = yield* encryptExtras(itemId, extras);
      const taken = (name: string) =>
        sql<{
          id: string;
        }>`SELECT id FROM vault_items WHERE COALESCE(scope_project_id, '') = ${payload.scopeProjectId ?? ""} AND name = ${name} AND deleted_at IS NULL AND id <> ${itemId}`.pipe(
          Effect.map((rows) => rows.length > 0),
        );
      // Two machines can each have an item with this name; the arrival is renamed here.
      const label =
        sourceLabel.length > SYNC_LABEL_LIMIT
          ? `${sourceLabel.slice(0, SYNC_LABEL_LIMIT - 1).trimEnd()}…`
          : sourceLabel;
      const withSuffix = (suffix: string) =>
        `${payload.name.slice(0, SYNC_NAME_LIMIT - suffix.length).trimEnd()}${suffix}`;
      let name: string = payload.name;
      if (yield* taken(name)) name = withSuffix(` (from ${label})`);
      if (yield* taken(name)) name = withSuffix(` (from ${label}, ${itemId.slice(-6)})`);
      const metadata = encodeMetadataJson({
        ...(payload.label ? { label: payload.label } : {}),
        fields: fieldsOf(stored),
        ...(cardLast4Of(stored) ? { cardLast4: cardLast4Of(stored) } : {}),
      });
      const domains = encodeDomainsJson(payload.allowedDomains);
      const attachment = payload.attachment ? encodeAttachmentJson(payload.attachment) : null;
      if (existing) {
        const previous = yield* Effect.option(decryptStored(existing));
        const secretsChanged =
          Option.isNone(previous) || encodeStoredJson(previous.value) !== encodeStoredJson(stored);
        // Local policy, approvals and portability stay as they are.
        yield* sql`UPDATE vault_items SET name = ${name}, type = ${payload.type}, scope_project_id = ${payload.scopeProjectId}, metadata_json = ${metadata}, allowed_domains_json = ${domains}, ciphertext = ${encrypted.ciphertext}, wrapped_keys_json = ${encrypted.wrappedKeys}, credential_revision = credential_revision + ${secretsChanged ? 1 : 0}, sync_attachment_json = ${attachment}, sync_extras = ${sealedExtras}, created_at = ${payload.createdAt}, updated_at = ${payload.updatedAt} WHERE id = ${itemId} AND deleted_at IS NULL`;
      } else if (found) {
        // Back from a local delete: like a first arrival, it asks before any agent uses it.
        yield* sql`UPDATE vault_items SET name = ${name}, type = ${payload.type}, scope_project_id = ${payload.scopeProjectId}, metadata_json = ${metadata}, policy_json = ${encodePolicyJson(defaultVaultPolicy)}, allowed_domains_json = ${domains}, ciphertext = ${encrypted.ciphertext}, wrapped_keys_json = ${encrypted.wrappedKeys}, credential_revision = credential_revision + 1, sync_attachment_json = ${attachment}, sync_extras = ${sealedExtras}, created_at = ${payload.createdAt}, updated_at = ${payload.updatedAt}, deleted_at = NULL WHERE id = ${itemId}`;
      } else {
        // A first arrival asks before any agent here may use it.
        yield* sql`INSERT INTO vault_items(id, name, type, scope_project_id, metadata_json, policy_json, allowed_domains_json, ciphertext, wrapped_keys_json, created_at, updated_at, sync_attachment_json, sync_extras) VALUES (${itemId}, ${name}, ${payload.type}, ${payload.scopeProjectId}, ${metadata}, ${encodePolicyJson(defaultVaultPolicy)}, ${domains}, ${encrypted.ciphertext}, ${encrypted.wrappedKeys}, ${payload.createdAt}, ${payload.updatedAt}, ${attachment}, ${sealedExtras})`;
      }
      yield* invalidateScrubCache;
      yield* PubSub.publish(syncedChanges, { itemId, removed: false });
      return name;
    }).pipe(
      Effect.mapError(wrap),
      Effect.withSpan("Vault.applySynced", { attributes: { "vault.item_id": itemId } }),
    );

  const removeSynced: Vault["Service"]["removeSynced"] = (itemId) =>
    Effect.gen(function* () {
      const at = yield* now;
      const removed =
        yield* sql`UPDATE vault_items SET deleted_at = ${at}, ciphertext = '', wrapped_keys_json = '[]', sync_extras = NULL, updated_at = ${at} WHERE id = ${itemId} AND deleted_at IS NULL RETURNING id`;
      yield* invalidateScrubCache;
      if (removed.length > 0) yield* PubSub.publish(syncedChanges, { itemId, removed: true });
    }).pipe(
      Effect.mapError(wrap),
      Effect.withSpan("Vault.removeSynced", { attributes: { "vault.item_id": itemId } }),
    );

  const setSyncAttachment: Vault["Service"]["setSyncAttachment"] = (itemId, attachment, options) =>
    Effect.gen(function* () {
      const at = yield* now;
      const updated =
        yield* sql`UPDATE vault_items SET sync_attachment_json = ${attachment === null ? null : encodeAttachmentJson(attachment)}, updated_at = ${at} WHERE id = ${itemId} AND deleted_at IS NULL ${options?.onlyIfMissing ? sql`AND sync_attachment_json IS NULL` : sql``} RETURNING id`;
      if (updated.length === 0) {
        yield* loadRow(itemId);
        return;
      }
      yield* captureRow(itemId);
    }).pipe(sql.withTransaction, Effect.mapError(wrap));

  return Vault.of({
    readCredential: (itemId) =>
      Effect.gen(function* () {
        const row = yield* loadRow(itemId);
        const secretFields = yield* decryptStored(row);
        yield* registerDelivered(Object.values(secretFields));
        yield* audit({ itemId, action: "resolve", outcome: "allowed" });
        return { secretFields, revision: row.credential_revision, attachment: attachmentOf(row) };
      }).pipe(Effect.mapError(wrap)),
    setSyncAttachment,
    getSyncAttachment: (itemId) =>
      loadRow(itemId).pipe(Effect.map(attachmentOf), Effect.mapError(wrap)),
    listSyncAttachments: Effect.gen(function* () {
      const rows =
        yield* sql<VaultRow>`SELECT * FROM vault_items WHERE deleted_at IS NULL AND sync_attachment_json IS NOT NULL ORDER BY updated_at DESC, id`;
      const machineOnly = yield* rules;
      return rows.flatMap((row) => {
        const attachment = attachmentOf(row);
        return attachment === undefined ? [] : [{ item: metadataOf(row, machineOnly), attachment }];
      });
    }).pipe(Effect.mapError(wrap)),
    credentialRevision: (itemId) =>
      loadRow(itemId).pipe(
        Effect.map((row) => row.credential_revision),
        Effect.mapError(wrap),
      ),
    syncedChanges: Stream.fromPubSub(syncedChanges),
    recapture: (itemId) => captureRow(itemId).pipe(sql.withTransaction, Effect.mapError(wrap)),
    applySynced,
    removeSynced,
    list,
    getMetadata: (itemId) =>
      Effect.all([loadRow(itemId), rules]).pipe(
        Effect.map(([row, machineOnly]) => metadataOf(row, machineOnly)),
        Effect.mapError(wrap),
      ),
    create,
    update,
    delete: (input, threadId) =>
      Effect.gen(function* () {
        if (threadId !== undefined)
          yield* findRow({ itemId: input.id, scopeProjectId: yield* projectForThread(threadId) });
        const at = yield* now;
        const rows = yield* Effect.gen(function* () {
          const deleted = yield* sql<{
            name: string;
            portability: string;
          }>`UPDATE vault_items SET deleted_at = ${at}, ciphertext = '', wrapped_keys_json = '[]', sync_extras = NULL, updated_at = ${at} WHERE id = ${input.id} AND deleted_at IS NULL RETURNING name, portability`;
          if (deleted[0])
            yield* capture({
              id: input.id,
              deleted: true,
              name: deleted[0].name,
              portability: deleted[0].portability,
            });
          return deleted;
        }).pipe(sql.withTransaction, Effect.mapError(wrap));
        yield* invalidateScrubCache;
        return { id: input.id, deleted: rows.length > 0 };
      }).pipe(Effect.mapError(wrap)),
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
          domain: input.destinationHost,
          enforceAllowedDomains: !input.approved,
          action: "resolve",
        });
        if (result.status === "denied" && result.reason === "domain_not_allowed")
          return yield* new VaultError({ reason: "domain_not_allowed" });
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
      registerDelivered(
        values.flatMap((value) => [
          value,
          Buffer.from(value).toString("base64"),
          encodeURIComponent(value),
          JSON.stringify(value).slice(1, -1),
        ]),
      ),
    makeOutputRedactor: () =>
      Effect.sync(() => {
        let values: Array<string> = [];
        let shortValues: Array<string> = [];
        let redact = processOutputRedactor(
          () => values,
          () => shortValues,
        );
        return (chunk, final = false) =>
          Effect.gen(function* () {
            const { secrets, shortSecrets } = yield* scrubSets;
            values = [...secrets];
            shortValues = [...shortSecrets];
            return redact(chunk, final);
          }).pipe(
            withheldOnFailure(() => {
              // Discard any held prefix too: it cannot be released unchecked.
              redact = processOutputRedactor(
                () => values,
                () => shortValues,
              );
              return VAULT_WITHHELD;
            }),
          );
      }),
    scrubText: (text) =>
      scrubSets.pipe(
        Effect.map(({ secrets, shortSecrets }) =>
          redactShortSecrets(redactText(text, secrets), shortSecrets),
        ),
        withheldOnFailure(() => VAULT_WITHHELD),
      ),
    scrubValue: (value) =>
      scrubSets.pipe(
        Effect.map(({ secrets, shortSecrets }) =>
          redactShortValue(redactValue(value, secrets), shortSecrets),
        ),
        withheldOnFailure(() => withholdValue(value)),
      ),
  });
});

export const layer = Layer.effect(Vault, make);
