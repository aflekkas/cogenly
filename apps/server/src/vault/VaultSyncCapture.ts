/**
 * Writes this machine's vault items into synced `vault` documents and reads
 * them back. Vault calls `capture` inside its own mutation transaction;
 * VaultSync uses `open` and `forward` to project and relay what peers sent.
 * Nothing here logs or annotates more than item and environment ids. See
 * docs/internals/vault-sync.md.
 */
import {
  type EnvironmentId,
  type HybridClock,
  IsoDateTime,
  SharedStateError,
  type SharedDocumentChange,
  VaultError,
  VaultItemMetadata,
  VaultItemType,
  VaultSecretFields,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { canonicalPeerJson } from "../machines/peerCrypto.ts";
import { VAULT_WRAP_PREFIX, decodeVaultSealed, decodeVaultWrap } from "../sync/documentSchemas.ts";
import * as SharedState from "../sync/SharedState.ts";
import * as VaultCrypto from "./VaultCrypto.ts";
import { makeVaultKeyPairLoader } from "./VaultKeyPair.ts";
import { effectivePortability, loadMachineOnlyRules } from "./vaultPortability.ts";

/**
 * The sealed plaintext. Policy, approvals, usage and portability are never
 * in it: they stay with each machine. `attachment` is opaque non-secret JSON
 * other features keep with the item.
 */
export const VaultSyncPayload = Schema.Struct({
  name: VaultItemMetadata.fields.name,
  type: VaultItemType,
  scopeProjectId: VaultItemMetadata.fields.scopeProjectId,
  label: VaultItemMetadata.fields.label,
  allowedDomains: VaultItemMetadata.fields.allowedDomains,
  secretFields: VaultSecretFields,
  cardLast4: VaultItemMetadata.fields.cardLast4,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  attachment: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});
export type VaultSyncPayload = typeof VaultSyncPayload.Type;
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(VaultSyncPayload));
const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** What Vault hands over about one of its rows. */
export type VaultSyncSource =
  | {
      readonly id: string;
      readonly deleted: true;
      readonly name: string;
      readonly portability: string;
    }
  | {
      readonly id: string;
      readonly deleted: false;
      readonly portability: string;
      readonly payload: VaultSyncPayload;
    };

export interface VaultShare {
  readonly environmentId: EnvironmentId;
  readonly publicKey: string;
  readonly pairingKey: string;
}

/** A document this machine could read: a trusted wrap opened its current revision. */
export interface OpenedVaultDocument {
  readonly digest: string;
  readonly payload: VaultSyncPayload;
  /** The decrypted payload as sealed, keys a newer build added included. */
  readonly raw: Record<string, Schema.Json>;
  readonly dataKey: Uint8Array;
  readonly sealed: VaultCrypto.VaultSealed;
  readonly author: string;
}

export type OpenResult =
  | { readonly _tag: "missing" }
  | { readonly _tag: "waiting"; readonly digest: string }
  | ({ readonly _tag: "opened" } & OpenedVaultDocument);

const KNOWN_PAYLOAD_KEYS = [
  "name",
  "type",
  "scopeProjectId",
  "label",
  "allowedDomains",
  "secretFields",
  "cardLast4",
  "createdAt",
  "updatedAt",
  "attachment",
] as const;

/** The sealed content as this build compares it; `updatedAt` alone never reseals. */
const contentKey = (payload: VaultSyncPayload) => {
  const { updatedAt: _, ...content } = payload;
  return canonicalPeerJson(content);
};

const isVaultError = Schema.is(VaultError);
const vaultError = (cause: unknown) =>
  isVaultError(cause) ? cause : new VaultError({ reason: "storage", cause });

export class VaultSyncCapture extends Context.Service<
  VaultSyncCapture,
  {
    readonly environmentId: EnvironmentId;
    readonly keyPair: Effect.Effect<VaultCrypto.VaultKeyPair, VaultError>;
    readonly shares: Effect.Effect<ReadonlyArray<VaultShare>, VaultError>;
    /**
     * Brings the item's document up to date with this machine's row, inside
     * the caller's transaction. A no-op while this machine shares with nobody,
     * for machine-only items, and when only local state (policy) changed.
     */
    readonly capture: (source: VaultSyncSource) => Effect.Effect<void, VaultError>;
    /** Opens the current revision with this machine's wrap from a holder it trusts. */
    readonly open: (document: SharedDocumentChange) => Effect.Effect<OpenResult, VaultError>;
    /** Adds a wrap for every share peer that lacks one for the current revision. */
    readonly forward: (
      document: SharedDocumentChange,
      opened: OpenedVaultDocument,
    ) => Effect.Effect<void, VaultError>;
    /** Share peers without a wrap for the document's current revision. */
    readonly missingRecipients: (
      document: SharedDocumentChange,
      digest: string,
    ) => Effect.Effect<ReadonlyArray<VaultShare>, VaultError>;
  }
>()("cogenly-server/vault/VaultSyncCapture") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* SharedState.SharedState;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  const keyPair = makeVaultKeyPairLoader(store);

  const shares = sql<{
    environment_id: string;
    public_key: string;
    pairing_key: string;
  }>`SELECT environment_id, public_key, pairing_key FROM vault_peer_shares ORDER BY environment_id`.pipe(
    Effect.map((rows) =>
      rows.map((row): VaultShare => ({
        environmentId: row.environment_id as EnvironmentId,
        publicKey: row.public_key,
        pairingKey: row.pairing_key,
      })),
    ),
    Effect.mapError(vaultError),
  );

  const wrapsFor = (
    itemId: string,
    sealed: VaultCrypto.VaultSealed,
    dataKey: Uint8Array,
    privateKey: string,
    recipients: ReadonlyArray<{ readonly environmentId: string; readonly publicKey: string }>,
  ) =>
    Object.fromEntries(
      recipients.map((recipient) => [
        `${VAULT_WRAP_PREFIX}${recipient.environmentId}`,
        VaultCrypto.wrapVaultDataKey({
          dataKey,
          itemId,
          sealed,
          by: environmentId,
          senderPrivateKey: privateKey,
          recipient: recipient.environmentId,
          recipientPublicKey: recipient.publicKey,
        }) as unknown as Schema.Json,
      ]),
    );

  const recordApplied = (
    itemId: string,
    digest: string | null,
    applied: "applied" | "deleted",
    localName?: string | null,
  ) =>
    localName === undefined
      ? sql`INSERT INTO vault_sync_applied(item_id, sealed_digest, state) VALUES (${itemId}, ${digest}, ${applied}) ON CONFLICT(item_id) DO UPDATE SET sealed_digest = excluded.sealed_digest, state = excluded.state`
      : sql`INSERT INTO vault_sync_applied(item_id, sealed_digest, state, local_name) VALUES (${itemId}, ${digest}, ${applied}, ${localName}) ON CONFLICT(item_id) DO UPDATE SET sealed_digest = excluded.sealed_digest, state = excluded.state, local_name = excluded.local_name`;

  const open: VaultSyncCapture["Service"]["open"] = (document) =>
    Effect.gen(function* () {
      const raw = document.fields.sealed;
      const sealed = Option.getOrUndefined(decodeVaultSealed(raw));
      const clock: HybridClock | undefined = document.clocks.sealed;
      if (sealed === undefined || clock === undefined) return { _tag: "missing" } as const;
      const digest = VaultCrypto.sealedDigestOf(raw);
      const waiting = { _tag: "waiting", digest } as const;
      // The author of a revision is the machine whose clock it carries.
      if (sealed.author !== clock.node) return waiting;
      const wrap = Option.getOrUndefined(
        decodeVaultWrap(document.fields[`${VAULT_WRAP_PREFIX}${environmentId}`]),
      );
      if (wrap === undefined || wrap.sealedDigest !== digest) return waiting;
      const pair = yield* keyPair;
      // Mutual consent: only wraps made here or by a machine this owner shares with.
      const senderPublicKey =
        wrap.by === environmentId
          ? pair.publicKey
          : (yield* shares).find((share) => share.environmentId === wrap.by)?.publicKey;
      if (senderPublicKey === undefined) return waiting;
      const opened = Option.liftThrowable(() => {
        const dataKey = VaultCrypto.unwrapVaultDataKey({
          wrap,
          itemId: document.id,
          sealed: raw as unknown as VaultCrypto.VaultSealed,
          recipient: environmentId,
          recipientPrivateKey: pair.privateKey,
          senderPublicKey,
        });
        const plaintext = VaultCrypto.openVaultPayload({
          dataKey,
          sealed,
          itemId: document.id,
          clock,
        });
        return { dataKey, plaintext };
      })();
      if (Option.isNone(opened)) return waiting;
      const payload = decodePayload(opened.value.plaintext);
      const rawPayload = decodeRecord(opened.value.plaintext);
      if (Option.isNone(payload) || Option.isNone(rawPayload)) return waiting;
      return {
        _tag: "opened",
        digest,
        payload: payload.value,
        raw: rawPayload.value,
        dataKey: opened.value.dataKey,
        sealed,
        author: sealed.author,
      } as const;
    });

  const missingRecipients: VaultSyncCapture["Service"]["missingRecipients"] = (document, digest) =>
    shares.pipe(
      Effect.map((all) =>
        all.filter((share) => {
          const wrap = decodeVaultWrap(
            document.fields[`${VAULT_WRAP_PREFIX}${share.environmentId}`],
          );
          return Option.isNone(wrap) || wrap.value.sealedDigest !== digest;
        }),
      ),
    );

  const forward: VaultSyncCapture["Service"]["forward"] = (document, opened) =>
    Effect.gen(function* () {
      const missing = yield* missingRecipients(document, opened.digest);
      if (missing.length === 0) return;
      const pair = yield* keyPair;
      const wraps = yield* Effect.try({
        try: () =>
          wrapsFor(
            document.id,
            document.fields.sealed as unknown as VaultCrypto.VaultSealed,
            opened.dataKey,
            pair.privateKey,
            missing,
          ),
        catch: (cause) => new VaultError({ reason: "crypto", cause }),
      });
      yield* state.write("vault", document.id, wraps).pipe(Effect.mapError(vaultError));
    }).pipe(
      Effect.withSpan("VaultSyncCapture.forward", { attributes: { "vault.item_id": document.id } }),
    );

  const capture: VaultSyncCapture["Service"]["capture"] = (source) =>
    Effect.gen(function* () {
      const peers = yield* shares;
      if (peers.length === 0) return;
      const document = yield* state.get("vault", source.id).pipe(Effect.mapError(vaultError));
      // Machine-only stops future sync; machines that have a copy keep it, deletes included.
      const rules = yield* loadMachineOnlyRules().pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const name = source.deleted ? source.name : source.payload.name;
      if (
        effectivePortability({ id: source.id, name, portability: source.portability }, rules)
          .portability === "machine"
      )
        return;
      if (source.deleted) {
        if (document && !document.tombstone) {
          yield* state.write("vault", source.id, {}, true).pipe(Effect.mapError(vaultError));
          yield* recordApplied(source.id, null, "deleted");
        }
        return;
      }
      // A delete anywhere is permanent for this id; projection removes the row here.
      if (document?.tombstone) return;
      const opened = document ? yield* open(document) : ({ _tag: "missing" } as const);
      const applied = yield* sql<{
        local_name: string | null;
      }>`SELECT local_name FROM vault_sync_applied WHERE item_id = ${source.id}`;
      const localName = applied[0]?.local_name ?? null;
      // An incoming item renamed here to avoid a collision keeps its synced name.
      const keepSyncedName = opened._tag === "opened" && localName === source.payload.name;
      const payload: VaultSyncPayload = keepSyncedName
        ? { ...source.payload, name: opened.payload.name }
        : source.payload;
      if (document && opened._tag === "opened") {
        if (contentKey(opened.payload) === contentKey(payload)) {
          yield* forward(document, opened);
          return;
        }
      }
      // Start from what is sealed now so a newer build's payload keys survive.
      const merged: Record<string, unknown> = opened._tag === "opened" ? { ...opened.raw } : {};
      for (const key of KNOWN_PAYLOAD_KEYS) {
        if (payload[key] === undefined) delete merged[key];
        else merged[key] = payload[key];
      }
      const plaintext = encodeJson(merged);
      const pair = yield* keyPair;
      const recipients = [{ environmentId, publicKey: pair.publicKey }, ...peers];
      let digest = "";
      yield* state
        .writeBuilt("vault", source.id, (clock) =>
          Effect.try({
            try: () => {
              // A fresh data key per revision: a revoked machine's old key opens nothing new.
              const dataKey = VaultCrypto.randomDataKey();
              const sealed = VaultCrypto.sealVaultPayload({
                dataKey,
                plaintext,
                itemId: source.id,
                author: environmentId,
                clock,
              });
              digest = VaultCrypto.sealedDigestOf(sealed);
              return {
                sealed: sealed as unknown as Schema.Json,
                ...wrapsFor(source.id, sealed, dataKey, pair.privateKey, recipients),
              };
            },
            catch: (cause) => new SharedStateError({ reason: "invalid-document", cause }),
          }),
        )
        .pipe(Effect.mapError(vaultError));
      yield* recordApplied(source.id, digest, "applied", keepSyncedName ? localName : null);
    }).pipe(
      Effect.mapError(vaultError),
      Effect.withSpan("VaultSyncCapture.capture", { attributes: { "vault.item_id": source.id } }),
    );

  return VaultSyncCapture.of({
    environmentId,
    keyPair,
    shares,
    capture,
    open: (document) =>
      open(document).pipe(
        Effect.mapError(vaultError),
        Effect.withSpan("VaultSyncCapture.open", {
          attributes: { "vault.item_id": document.id },
        }),
      ),
    forward: (document, opened) => forward(document, opened).pipe(Effect.mapError(vaultError)),
    missingRecipients,
  });
});

export const layer = Layer.effect(VaultSyncCapture, make);
