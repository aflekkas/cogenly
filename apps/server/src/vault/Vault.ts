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
  VAULT_LOGIN_USERNAME_MAX_LENGTH,
  defaultVaultLoginLabel,
  defaultVaultPolicy,
  groupVaultLoginsBySite,
  vaultLoginLabel,
  vaultLoginSummary,
  type VaultCreateInput,
  type VaultDeleteInput,
  type VaultField,
  type VaultItemMetadata,
  type VaultItemType,
  type VaultListInput,
  type VaultLoginSite,
  type VaultLoginSummary,
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
import * as SiteIconCache from "../assets/SiteIconCache.ts";
import * as VaultCrypto from "./VaultCrypto.ts";
import { makeVaultKeyPairLoader } from "./VaultKeyPair.ts";
import {
  effectivePortability,
  loadMachineOnlyRules,
  type MachineOnlyRules,
} from "./vaultPortability.ts";
import * as VaultSyncCapture from "./VaultSyncCapture.ts";
import {
  evaluateVaultPolicy,
  hostMatchesAnyDomain,
  isApprovedSite,
  normalizeHost,
  type VaultUseCaller,
} from "./VaultPolicy.ts";
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

export interface VaultUseInput extends VaultLoginSelector {
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
  /** Server destinations must respect any explicit restriction, even with owner approval. */
  readonly enforceRestrictedDomains?: boolean | undefined;
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
    }
  | {
      /** Several logins match and none was named: the caller must pick one. */
      readonly status: "ambiguous";
      readonly field: VaultField;
      readonly candidates: ReadonlyArray<VaultLoginSummary>;
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
  readonly integration_ids_json?: string | null;
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
    username: Schema.optional(Schema.String),
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
  readonly username?: string | undefined;
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

/**
 * A login's username kept as plaintext display text (see contracts). Other
 * types keep `username` secret: integration token items hold a client secret
 * in it.
 */
const displayUsernameOf = (type: string, stored: StoredFields): string | undefined =>
  type === "login" &&
  stored.username !== undefined &&
  stored.username.length <= VAULT_LOGIN_USERNAME_MAX_LENGTH
    ? stored.username
    : undefined;

/** The plaintext metadata a row keeps, derived from its type, label and secrets. */
const metadataJsonFor = (type: string, label: string | undefined, stored: StoredFields) => {
  const cardLast4 = cardLast4Of(stored);
  const username = displayUsernameOf(type, stored);
  return encodeMetadataJson({
    ...(label ? { label } : {}),
    fields: fieldsOf(stored),
    ...(cardLast4 ? { cardLast4 } : {}),
    ...(username === undefined ? {} : { username }),
  });
};

const IntegrationIdsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
const integrationIdsOf = (row: VaultRow): Array<string> =>
  row.integration_ids_json
    ? Option.match(IntegrationIdsJson(row.integration_ids_json), {
        onNone: () => [],
        onSome: (ids) => ids.filter((id): id is string => typeof id === "string" && id !== ""),
      })
    : [];

/** How an agent names a login: by id, by label or name, or by username. */
export interface VaultLoginSelector {
  readonly itemId?: VaultItemId | undefined;
  readonly name?: string | undefined;
  readonly label?: string | undefined;
  readonly username?: string | undefined;
}

export type VaultFindResult =
  | { readonly status: "found"; readonly item: VaultItemMetadata }
  | { readonly status: "ambiguous"; readonly candidates: ReadonlyArray<VaultLoginSummary> }
  | { readonly status: "not_found" };

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
    ) => Effect.Effect<
      { items: ReadonlyArray<VaultItemMetadata>; sites: ReadonlyArray<VaultLoginSite> },
      VaultError
    >;
    /**
     * The one item a selector names, as a caller in `threadId` sees the vault.
     * With no id, name, label or username, the logins for `domain` are the
     * candidates; several of them come back as `ambiguous`, never a guess.
     */
    readonly findLogin: (
      input: VaultLoginSelector & {
        readonly domain?: string | null | undefined;
        readonly threadId?: ThreadId | undefined;
        readonly scopeProjectId?: string | null | undefined;
      },
    ) => Effect.Effect<VaultFindResult, VaultError>;
    /**
     * Startup upgrade: copies each login's username into its display metadata
     * (older items kept it only encrypted) and caches every login site's icon.
     * Password-only logins stay as they are; lists mark them missing a username.
     */
    readonly upgradeLogins: Effect.Effect<{ readonly usernames: number }, VaultError>;
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
     * allowed domains must include that host. Owner approval can authorize an item
     * with no domains, but cannot override an explicit domain restriction. Never expose
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
    /**
     * Stores a login the user entered on an agent's sign-in card. A new item
     * is environment-wide and usable by any agent on `domain` without asking;
     * updating an existing login replaces only the entered secrets, adds the
     * domain if missing, and keeps the owner's policy. Audited as saved from
     * the asking thread (and agent).
     */
    readonly saveLogin: (input: {
      readonly name: string;
      readonly domain: string;
      /** A site icon the agent supplied, cached for the domain. */
      readonly iconUrl?: string | undefined;
      readonly secretFields: Pick<
        VaultSecretFields,
        "username" | "password" | "totpSecret" | "value"
      >;
      readonly updateItemId?: VaultItemId | undefined;
      /** Temporary logins stay on this machine; the caller removes them. */
      readonly temporary: boolean;
      readonly threadId: ThreadId;
      readonly agentId: string | null;
    }) => Effect.Effect<{ item: VaultItemMetadata; updated: boolean }, VaultError>;
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
  // Every read of a live row carries its account association and integration links.
  const rowColumns = sql`vault_items.*, (SELECT c.account_id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS account_id, (SELECT c.id FROM account_credentials c JOIN accounts a ON a.id = c.account_id AND a.deleted_at IS NULL WHERE c.vault_item_id = vault_items.id) AS credential_id, (SELECT json_group_array(l.integration_id) FROM vault_login_integrations l WHERE l.item_id = vault_items.id) AS integration_ids_json`;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const siteIcons = yield* Effect.serviceOption(SiteIconCache.SiteIconCache);
  const layerScope = yield* Effect.scope;
  /**
   * Caches a login site's icon in the background: an agent-supplied one, else
   * the fetched favicon. Saving never waits on, or fails with, the network.
   */
  const prefetchIcon = (host: string | null | undefined, iconUrl?: string) =>
    Option.isNone(siteIcons) || !host
      ? Effect.void
      : (iconUrl === undefined
          ? siteIcons.value.ensure(host)
          : siteIcons.value
              .provide(host, iconUrl)
              .pipe(
                Effect.flatMap((provided) =>
                  provided ? Effect.void : siteIcons.value.ensure(host),
                ),
              )
        ).pipe(Effect.forkIn(layerScope), Effect.asVoid);
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
    const username = stored
      ? displayUsernameOf(row.type, stored)
      : row.type === "login"
        ? metadata.username
        : undefined;
    const integrationIds = integrationIdsOf(row);
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
      ...(username === undefined ? {} : { username }),
      ...(row.type === "login" && integrationIds.length > 0 ? { integrationIds } : {}),
      portability: portability.portability,
      ...(portability.reason ? { portabilityReason: portability.reason } : {}),
      createdAt: row.created_at as VaultItemMetadata["createdAt"],
      updatedAt: row.updated_at as VaultItemMetadata["updatedAt"],
    } as VaultItemMetadata;
  };

  const loadRow = (itemId: string) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<VaultRow>`SELECT ${rowColumns} FROM vault_items WHERE id = ${itemId} AND deleted_at IS NULL`;
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
        yield* sql<VaultRow>`SELECT ${rowColumns} FROM vault_items WHERE name = ${input.name} AND deleted_at IS NULL ORDER BY updated_at DESC`;
      const scoped = rows.filter((row) => visibleIn(row, input.scopeProjectId));
      if (scoped.length === 0) return yield* new VaultError({ reason: "not_found" });
      if (scoped.length === 1) return scoped[0]!;
      return yield* new VaultError({ reason: "ambiguous_name" });
    });

  /**
   * The row a selector names. Without an id, name, label and username narrow
   * the visible items, and with none of them the logins allowed on `domain`
   * are the candidates. Several logins left over are returned for the caller
   * to choose from; several items of other types stay `ambiguous_name`.
   */
  const resolveRow = (
    input: VaultLoginSelector & {
      readonly domain?: string | null | undefined;
      readonly scopeProjectId?: string | null | undefined;
    },
  ) =>
    Effect.gen(function* () {
      if (input.itemId)
        return {
          row: yield* findRow({ itemId: input.itemId, scopeProjectId: input.scopeProjectId }),
        };
      const name = input.name?.trim().toLowerCase();
      const label = input.label?.trim().toLowerCase();
      const username = input.username?.trim().toLowerCase();
      if (!name && !label && !username && !input.domain)
        return yield* new VaultError({ reason: "invalid_input" });
      const rows =
        (yield* sql<VaultRow>`SELECT ${rowColumns} FROM vault_items WHERE deleted_at IS NULL ORDER BY updated_at DESC`).filter(
          (row) => visibleIn(row, input.scopeProjectId),
        );
      const machineOnly = yield* rules;
      const entries = rows.map((row) => ({ row, item: metadataOf(row, machineOnly) }));
      const onSite = (entry: (typeof entries)[number]) =>
        !!input.domain && hostMatchesAnyDomain(input.domain, entry.item.allowedDomains);
      let matches = entries.filter(
        (entry) =>
          (!name || entry.item.name.toLowerCase() === name) &&
          (!label ||
            vaultLoginLabel(entry.item).toLowerCase() === label ||
            entry.item.name.toLowerCase() === label) &&
          (!username || entry.item.username?.toLowerCase() === username) &&
          (name || label || username ? true : entry.item.type === "login" && onSite(entry)),
      );
      // A name shared by several sites' logins: the page's site decides.
      if (matches.length > 1 && input.domain && matches.some(onSite))
        matches = matches.filter(onSite);
      if (matches.length === 0) return yield* new VaultError({ reason: "not_found" });
      if (matches.length === 1) return { row: matches[0]!.row };
      if (matches.every((entry) => entry.item.type === "login"))
        return { candidates: matches.map((entry) => vaultLoginSummary(entry.item)) };
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
      yield* sql<VaultRow>`SELECT ${rowColumns} FROM vault_items WHERE deleted_at IS NULL`.pipe(
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
      // A login's username is display text, listed by vault_list; scrubbing it
      // would blank the list it belongs in.
      const shown = displayUsernameOf(row.type, stored) !== undefined;
      for (const [key, value] of Object.entries(stored))
        if (typeof value === "string" && value.length > 0 && !(shown && key === "username"))
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
      if (input.type === "login")
        yield* assertLoginLabelFree({
          scopeProjectId: input.scopeProjectId ?? null,
          name: input.name,
          label: vaultLoginLabel({
            name: input.name,
            label: input.label,
            username: displayUsernameOf("login", stored),
          }),
        });

      yield* sql`INSERT INTO vault_items(id, name, type, scope_project_id, metadata_json, policy_json, allowed_domains_json, ciphertext, wrapped_keys_json, created_at, updated_at, portability, sync_attachment_json) VALUES (${id}, ${input.name}, ${input.type}, ${input.scopeProjectId ?? null}, ${metadataJsonFor(input.type, input.label, stored)}, ${encodePolicyJson(policy)}, ${encodeDomainsJson(input.allowedDomains ?? [])}, ${encrypted.ciphertext}, ${encrypted.wrappedKeys}, ${at}, ${at}, ${input.portability ?? "shared"}, ${encodeAttachment(options?.syncAttachment ?? null)})`.pipe(
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
      Effect.tap(({ item }) =>
        item.type === "login" ? prefetchIcon(item.allowedDomains[0], input.iconUrl) : Effect.void,
      ),
      Effect.mapError(wrap),
    );

  /**
   * Logins for one site share its name, so each needs its own label (shown
   * label: the owner's, else "<Site> · <username>").
   */
  const assertLoginLabelFree = (input: {
    readonly scopeProjectId: string | null;
    readonly name: string;
    readonly label: string;
    readonly exceptId?: string;
  }) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        id: string;
        name: string;
        metadata_json: string;
      }>`SELECT id, name, metadata_json FROM vault_items WHERE type = 'login' AND deleted_at IS NULL AND COALESCE(scope_project_id, '') = ${input.scopeProjectId ?? ""} AND name = ${input.name} AND id <> ${input.exceptId ?? ""}`;
      const wanted = input.label.toLowerCase();
      const taken = rows.some((row) => {
        const metadata = parseMetadata(row.metadata_json);
        return (
          vaultLoginLabel({
            name: row.name,
            label: metadata.label as VaultItemMetadata["label"],
            username: metadata.username,
          }).toLowerCase() === wanted
        );
      });
      if (taken) return yield* new VaultError({ reason: "label_conflict" });
    });

  const list: Vault["Service"]["list"] = (input, threadId) =>
    Effect.gen(function* () {
      const scope =
        threadId === undefined ? input.scopeProjectId : yield* projectForThread(threadId);
      const rows =
        yield* sql<VaultRow>`SELECT ${rowColumns} FROM vault_items WHERE deleted_at IS NULL ORDER BY name`.pipe(
          Effect.mapError(wrap),
        );
      const machineOnly = yield* rules;
      const items = rows
        .filter((row) => visibleIn(row, scope))
        .map((row) => metadataOf(row, machineOnly));
      return { items, sites: groupVaultLoginsBySite(items) };
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
      const type = input.type ?? row.type;
      const name = input.name ?? row.name;
      if (
        type === "login" &&
        (input.name !== undefined ||
          input.label !== undefined ||
          input.type !== undefined ||
          input.scopeProjectId !== undefined ||
          input.secretFields?.username !== undefined)
      )
        yield* assertLoginLabelFree({
          scopeProjectId:
            input.scopeProjectId === undefined ? row.scope_project_id : input.scopeProjectId,
          name,
          label: vaultLoginLabel({
            name,
            label: label as VaultItemMetadata["label"],
            username: displayUsernameOf("login", stored),
          }),
          exceptId: row.id,
        });
      if (input.integrationIds !== undefined) {
        if (type !== "login") return yield* new VaultError({ reason: "invalid_input" });
        const linkedAt = yield* now;
        yield* sql`DELETE FROM vault_login_integrations WHERE item_id = ${row.id}`;
        for (const integrationId of new Set(input.integrationIds))
          yield* sql`INSERT INTO vault_login_integrations(item_id, integration_id, linked_at) VALUES (${row.id}, ${integrationId}, ${linkedAt})`;
      }
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
      yield* sql`UPDATE vault_items SET name = ${name}, type = ${type}, scope_project_id = ${input.scopeProjectId === undefined ? row.scope_project_id : input.scopeProjectId}, metadata_json = ${metadataJsonFor(type, label, stored)}, policy_json = ${encodePolicyJson(policy)}, allowed_domains_json = ${encodeDomainsJson(input.allowedDomains ?? parseDomains(row.allowed_domains_json))}, ${input.secretFields ? sql`ciphertext = ${ciphertext}, wrapped_keys_json = ${wrappedKeys}, credential_revision = credential_revision + 1,` : sql``} portability = ${input.portability ?? row.portability}, sync_attachment_json = ${attachment}, updated_at = ${at} WHERE id = ${row.id}`.pipe(
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
      Effect.tap(({ item }) =>
        item.type === "login" && input.allowedDomains !== undefined
          ? prefetchIcon(item.allowedDomains[0])
          : Effect.void,
      ),
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
      const resolved = yield* resolveRow({
        itemId: input.itemId,
        name: input.name,
        label: input.label,
        username: input.username,
        domain: input.domain,
        scopeProjectId: scope,
      });
      if ("candidates" in resolved)
        return {
          status: "ambiguous",
          field: input.field,
          candidates: resolved.candidates,
        } as const;
      const row = resolved.row;
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
      const isAgent = input.caller.kind === "agent" || input.caller.kind === "thread";
      const offSite =
        (input.enforceAllowedDomains ||
          (input.enforceRestrictedDomains && item.allowedDomains.length > 0)) &&
        !(isAgent
          ? isApprovedSite(input.domain, item)
          : input.domain && hostMatchesAnyDomain(input.domain, item.allowedDomains));
      // Server destinations outside the allowed sites are refused outright.
      if (offSite && !isAgent) {
        yield* record("denied_domain");
        return {
          status: "denied",
          item,
          field: input.field,
          reason: "domain_not_allowed",
        } as const;
      }
      // Block wins everywhere; a page outside the item's sites always asks the
      // owner, whatever the rule; on its sites the rule decides.
      const policyDecision = evaluateVaultPolicy({
        policy: item.policy,
        caller: input.caller,
        domain: input.domain,
      });
      const decision = policyDecision === "deny" ? "deny" : offSite ? "ask" : policyDecision;
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
        const why = offSite
          ? `${input.domain ?? "This page"} is not one of this item's allowed sites, so the user decides.`
          : "The owner set this item to ask first.";
        const where =
          input.caller.kind === "thread"
            ? "The user sees an approval card in this thread."
            : "The owner sees it in this agent's open items.";
        return {
          status: "approval_required",
          item,
          field: input.field,
          approvalId,
          message: `Waiting on the user: this vault use needs their approval. ${why} ${where} ${
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
      // Never deliver a value we cannot keep scrubbing for this process's
      // lifetime. A login's username is display text, not a secret to scrub.
      if (!(input.field === "username" && item.username === value))
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
      // Two machines can each have an item with this name; the arrival is renamed
      // here. Logins for one site share its name, so they keep theirs.
      const label =
        sourceLabel.length > SYNC_LABEL_LIMIT
          ? `${sourceLabel.slice(0, SYNC_LABEL_LIMIT - 1).trimEnd()}…`
          : sourceLabel;
      const withSuffix = (suffix: string) =>
        `${payload.name.slice(0, SYNC_NAME_LIMIT - suffix.length).trimEnd()}${suffix}`;
      let name: string = payload.name;
      if (payload.type !== "login") {
        if (yield* taken(name)) name = withSuffix(` (from ${label})`);
        if (yield* taken(name)) name = withSuffix(` (from ${label}, ${itemId.slice(-6)})`);
      }
      const metadata = metadataJsonFor(payload.type, payload.label, stored);
      const domains = encodeDomainsJson(payload.allowedDomains);
      const attachment = payload.attachment ? encodeAttachmentJson(payload.attachment) : null;
      if (existing) {
        const previous = yield* Effect.option(decryptStored(existing));
        const secretsChanged =
          Option.isNone(previous) || encodeStoredJson(previous.value) !== encodeStoredJson(stored);
        // Local policy, approvals and portability stay as they are.
        yield* sql`UPDATE vault_items SET name = ${name}, type = ${payload.type}, scope_project_id = ${payload.scopeProjectId}, metadata_json = ${metadata}, allowed_domains_json = ${domains}, ciphertext = ${encrypted.ciphertext}, wrapped_keys_json = ${encrypted.wrappedKeys}, credential_revision = credential_revision + ${secretsChanged ? 1 : 0}, sync_attachment_json = ${attachment}, sync_extras = ${sealedExtras}, created_at = ${payload.createdAt}, updated_at = ${payload.updatedAt} WHERE id = ${itemId} AND deleted_at IS NULL`;
      } else if (found) {
        // Back from a local delete: like a first arrival, it takes the default rule.
        yield* sql`UPDATE vault_items SET name = ${name}, type = ${payload.type}, scope_project_id = ${payload.scopeProjectId}, metadata_json = ${metadata}, policy_json = ${encodePolicyJson(defaultVaultPolicy)}, allowed_domains_json = ${domains}, ciphertext = ${encrypted.ciphertext}, wrapped_keys_json = ${encrypted.wrappedKeys}, credential_revision = credential_revision + 1, sync_attachment_json = ${attachment}, sync_extras = ${sealedExtras}, created_at = ${payload.createdAt}, updated_at = ${payload.updatedAt}, deleted_at = NULL WHERE id = ${itemId}`;
      } else {
        // A first arrival takes the default rule: the owner's agents may fill it on its sites.
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
        yield* sql`UPDATE vault_items SET deleted_at = ${at}, ciphertext = '', wrapped_keys_json = '[]', sync_extras = NULL, metadata_json = json_remove(metadata_json, '$.username'), updated_at = ${at} WHERE id = ${itemId} AND deleted_at IS NULL RETURNING id`;
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

  const findLogin: Vault["Service"]["findLogin"] = (input) =>
    Effect.gen(function* () {
      const scope =
        input.threadId === undefined
          ? input.scopeProjectId
          : yield* projectForThread(input.threadId);
      const resolved = yield* resolveRow({ ...input, scopeProjectId: scope }).pipe(
        Effect.map((found) => Option.some(found)),
        Effect.catchIf(
          (error) => error.reason === "not_found",
          () => Effect.succeed(Option.none()),
        ),
      );
      if (Option.isNone(resolved)) return { status: "not_found" } as const;
      if ("candidates" in resolved.value)
        return { status: "ambiguous", candidates: resolved.value.candidates } as const;
      return {
        status: "found",
        item: metadataOf(resolved.value.row, yield* rules),
      } as const;
    }).pipe(Effect.mapError(wrap));

  const upgradeLogins: Vault["Service"]["upgradeLogins"] = Effect.gen(function* () {
    const rows =
      yield* sql<VaultRow>`SELECT * FROM vault_items WHERE type = 'login' AND deleted_at IS NULL`;
    let usernames = 0;
    for (const row of rows) {
      const metadata = parseMetadata(row.metadata_json);
      if (metadata.username === undefined && (metadata.fields ?? []).includes("username")) {
        // A peer's item not wrapped for this machine is upgraded where it can be read.
        const stored = yield* decryptStored(row).pipe(Effect.option);
        if (Option.isSome(stored) && displayUsernameOf(row.type, stored.value) !== undefined) {
          // Display metadata only: no new revision, and nothing new to sync.
          yield* sql`UPDATE vault_items SET metadata_json = ${metadataJsonFor(row.type, metadata.label, stored.value)} WHERE id = ${row.id} AND deleted_at IS NULL`;
          usernames += 1;
        }
      }
    }
    if (usernames > 0) yield* invalidateScrubCache;
    for (const host of new Set(
      rows.flatMap((row) => parseDomains(row.allowed_domains_json).slice(0, 1)),
    ))
      yield* prefetchIcon(host);
    return { usernames };
  }).pipe(Effect.mapError(wrap), Effect.withSpan("Vault.upgradeLogins"));

  yield* upgradeLogins.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not upgrade vault logins", cause)),
    Effect.forkScoped,
  );

  return Vault.of({
    findLogin,
    upgradeLogins,
    readCredential: (itemId) =>
      Effect.gen(function* () {
        const row = yield* loadRow(itemId);
        const secretFields = yield* decryptStored(row);
        const shown = displayUsernameOf(row.type, secretFields);
        yield* registerDelivered(
          Object.entries(secretFields).flatMap(([key, value]) =>
            key === "username" && shown !== undefined ? [] : [value],
          ),
        );
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
          }>`UPDATE vault_items SET deleted_at = ${at}, ciphertext = '', wrapped_keys_json = '[]', sync_extras = NULL, metadata_json = json_remove(metadata_json, '$.username'), updated_at = ${at} WHERE id = ${input.id} AND deleted_at IS NULL RETURNING name, portability`;
          yield* sql`DELETE FROM vault_login_integrations WHERE item_id = ${input.id}`;
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
          enforceRestrictedDomains: true,
          action: "resolve",
        });
        if (result.status === "denied" && result.reason === "domain_not_allowed")
          return yield* new VaultError({ reason: "domain_not_allowed" });
        if (result.status === "ambiguous")
          return yield* new VaultError({ reason: "ambiguous_name" });
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
    saveLogin: (input) =>
      Effect.gen(function* () {
        const domain = normalizeHost(input.domain);
        if (!domain) return yield* new VaultError({ reason: "invalid_input" });
        const secretFields: VaultSecretFields = Object.fromEntries(
          Object.entries(input.secretFields).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
          ),
        );
        if (Object.keys(secretFields).length === 0)
          return yield* new VaultError({ reason: "invalid_input" });
        const record = (itemId: string, action: string) =>
          audit({
            itemId,
            threadId: input.threadId,
            agentId: input.agentId,
            action,
            domain,
            outcome: "saved",
          });
        if (input.updateItemId !== undefined) {
          const row = yield* loadRow(input.updateItemId);
          if (row.type !== "login") return yield* new VaultError({ reason: "invalid_input" });
          const domains = parseDomains(row.allowed_domains_json);
          const { item } = yield* update({
            id: input.updateItemId,
            secretFields,
            ...(hostMatchesAnyDomain(domain, domains)
              ? {}
              : { allowedDomains: [...domains, domain] as never }),
          });
          yield* record(item.id, "updated_from_request");
          if (input.iconUrl !== undefined) yield* prefetchIcon(domain, input.iconUrl);
          return { item, updated: true };
        }
        // Logins for one site share its name and differ by label, "<Site> ·
        // <username>" by default. A taken label gets a numbered sibling: the
        // user already typed the login, so a clash must not throw it away.
        const baseLabel = defaultVaultLoginLabel(input.name, secretFields.username);
        const created = yield* Effect.gen(function* () {
          for (let attempt = 1; ; attempt += 1) {
            const label = attempt === 1 ? undefined : `${baseLabel} (${attempt})`;
            const result = yield* create({
              name: input.name as never,
              ...(label === undefined ? {} : { label: label as never }),
              ...(input.iconUrl === undefined ? {} : { iconUrl: input.iconUrl as never }),
              type: "login",
              scopeProjectId: null,
              allowedDomains: [domain] as never,
              // The default rule: the item's allowed site is the card's host.
              policy: defaultVaultPolicy,
              ...(input.temporary ? { portability: "machine" as const } : {}),
              secretFields,
            }).pipe(
              Effect.asSome,
              Effect.catchIf(
                (error) =>
                  (error.reason === "label_conflict" || error.reason === "name_conflict") &&
                  attempt < 20,
                () => Effect.succeedNone,
              ),
            );
            if (Option.isSome(result)) return result.value;
          }
        });
        yield* record(created.item.id, "saved_from_request");
        return { item: created.item, updated: false };
      }).pipe(Effect.mapError(wrap)),
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
