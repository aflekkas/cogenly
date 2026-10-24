/**
 * Writes this machine's vault items into synced `vault` documents and reads
 * them back. Vault calls `capture` inside its own mutation transaction;
 * VaultSync uses `open` and `forward` to project and relay what peers sent.
 * Nothing here logs or annotates more than item and environment ids. See
 * docs/internals/vault-sync.md.
 */
import {
  type EnvironmentId,
  HybridClock,
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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { canonicalPeerJson } from "../machines/peerCrypto.ts";
import {
  decodeVaultSealed,
  decodeVaultWrap,
  parseVaultKey,
  vaultSealedKey,
  vaultWrapKey,
} from "../sync/documentSchemas.ts";
import { compareClock } from "../sync/merge.ts";
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
const decodePayload = Schema.decodeUnknownOption(VaultSyncPayload);
const encodePayload = Schema.encodeSync(VaultSyncPayload);
const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** What a delete seals: a revision like any other, so only a holder can make one. */
const DELETION = { deleted: true } as const;

/** Payload keys a newer build sealed that this build does not read, at any depth. */
export type VaultSyncExtras = Readonly<Record<string, Schema.Json>>;

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
      /** Kept from the revision this row came from, sealed back into the next one. */
      readonly extras: VaultSyncExtras | undefined;
    };

export interface VaultShare {
  readonly environmentId: EnvironmentId;
  readonly publicKey: string;
  readonly pairingKey: string;
  /**
   * The peer said over the direct link that it shares back. Only then is a
   * revision wrapped for it or a wrap it made accepted here.
   */
  readonly peerSharing: boolean;
}

export type VaultRevisionContent =
  | { readonly _tag: "deleted" }
  | {
      readonly _tag: "item";
      readonly payload: VaultSyncPayload;
      /** The decrypted payload as sealed, keys a newer build added included. */
      readonly raw: Record<string, Schema.Json>;
      readonly extras: VaultSyncExtras;
    };

/** The newest revision of a document this machine can read: a trusted wrap opened it. */
export interface OpenedVaultDocument {
  readonly digest: string;
  readonly author: string;
  readonly dataKey: Uint8Array;
  readonly clock: HybridClock;
  readonly content: VaultRevisionContent;
}

export type OpenResult =
  | { readonly _tag: "missing" }
  | { readonly _tag: "waiting" }
  | ({ readonly _tag: "opened" } & OpenedVaultDocument);

export interface VaultRevision {
  readonly author: string;
  readonly sealed: VaultCrypto.VaultSealed;
  readonly clock: HybridClock;
  readonly digest: string;
}

/** A document's `sealed:<author>` revisions that this build can read the shape of, newest first. */
export const revisionsOf = (document: SharedDocumentChange): ReadonlyArray<VaultRevision> =>
  Object.entries(document.fields)
    .flatMap(([key, value]): Array<VaultRevision> => {
      const parsed = parseVaultKey(key);
      const clock = document.clocks[key];
      if (parsed?._tag !== "sealed" || clock === undefined || clock.node !== parsed.author)
        return [];
      const sealed = decodeVaultSealed(value);
      return Option.isSome(sealed)
        ? [
            {
              author: parsed.author,
              sealed: sealed.value,
              clock,
              digest: VaultCrypto.sealedDigestOf(parsed.author, value),
            },
          ]
        : [];
    })
    .toSorted((left, right) => compareClock(right.clock, left.clock));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What `raw` holds that `known`, the same value as this build reads it, does not. */
const unknownOf = (
  raw: Record<string, unknown>,
  known: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(known, key)) result[key] = value;
    else if (isRecord(value) && isRecord(known[key])) {
      const nested = unknownOf(value, known[key]);
      if (Object.keys(nested).length > 0) result[key] = nested;
    }
  }
  return result;
};

/** `target` with `extras` put back wherever `target` has nothing of its own. */
const withExtras = (
  target: Record<string, unknown>,
  extras: Record<string, unknown>,
): Record<string, unknown> => {
  const result = { ...target };
  for (const [key, value] of Object.entries(extras)) {
    const own = result[key];
    if (!Object.hasOwn(result, key)) result[key] = value;
    else if (isRecord(own) && isRecord(value)) result[key] = withExtras(own, value);
  }
  return result;
};

const contentOf = (plaintext: string): VaultRevisionContent | undefined => {
  const raw = Option.getOrUndefined(decodeRecord(plaintext));
  if (raw === undefined) return undefined;
  if (raw.deleted === true) return { _tag: "deleted" };
  const payload = Option.getOrUndefined(decodePayload(raw));
  if (payload === undefined) return undefined;
  const extras = unknownOf(raw, encodePayload(payload)) as VaultSyncExtras;
  return { _tag: "item", payload, raw, extras };
};

/** The sealed content as this build compares it; `updatedAt` alone never reseals. */
const contentKey = (payload: Record<string, unknown>) => {
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
    /** Every share the owner recorded, whether or not its pairing is still current. */
    readonly recordedShares: Effect.Effect<ReadonlyArray<VaultShare>, VaultError>;
    /** Shares whose peer is still paired under the pairing the owner shared with. */
    readonly shares: Effect.Effect<ReadonlyArray<VaultShare>, VaultError>;
    /** Honored shares whose peer shares back: the machines that hold this vault with this one. */
    readonly holders: Effect.Effect<ReadonlyArray<VaultShare>, VaultError>;
    /**
     * VaultSync attaches the current pairings (environment id to pairing key)
     * once Machines exist. Until then, and when reading them fails, no share
     * is honored, so nothing is released or accepted.
     */
    readonly bindPairings: (
      current: Effect.Effect<ReadonlyMap<string, string>, VaultError>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Brings the item's document up to date with this machine's row, inside
     * the caller's transaction. Once an item has a document every change
     * writes a revision, wrapped for current holders. A no-op for machine-only
     * items, for items that never synced while this vault is shared with
     * nobody, and when only local state (policy) changed.
     */
    readonly capture: (source: VaultSyncSource) => Effect.Effect<void, VaultError>;
    /** The newest revision this machine can open with a wrap from itself or a holder. */
    readonly open: (document: SharedDocumentChange) => Effect.Effect<OpenResult, VaultError>;
    /** Verifies a current wrap against the exact bytes successfully made here for this key. */
    readonly hasRevision: (
      document: SharedDocumentChange,
      recipient: { readonly environmentId: string; readonly publicKey: string },
      digest: string,
    ) => Effect.Effect<boolean, VaultError>;
    /** Wraps that revision for this machine and every holder that lacks it. */
    readonly forward: (
      document: SharedDocumentChange,
      opened: OpenedVaultDocument,
    ) => Effect.Effect<void, VaultError>;
  }
>()("cogenly-server/vault/VaultSyncCapture") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* SharedState.SharedState;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  const keyPair = makeVaultKeyPairLoader(store);
  const unbound: Effect.Effect<ReadonlyMap<string, string>, VaultError> = Effect.succeed(new Map());
  const pairings = yield* Ref.make(unbound);

  const recordedShares = sql<{
    environment_id: string;
    public_key: string;
    pairing_key: string;
    peer_sharing: number;
  }>`SELECT environment_id, public_key, pairing_key, peer_sharing FROM vault_peer_shares ORDER BY environment_id`.pipe(
    Effect.map((rows) =>
      rows.map((row): VaultShare => ({
        environmentId: row.environment_id as EnvironmentId,
        publicKey: row.public_key,
        pairingKey: row.pairing_key,
        peerSharing: row.peer_sharing === 1,
      })),
    ),
    Effect.mapError(vaultError),
  );

  // Checked on every read, not only when the machine list changes: an expired
  // or revoked pairing ends sharing before anything notices it.
  const shares = Effect.gen(function* () {
    const rows = yield* recordedShares;
    if (rows.length === 0) return rows;
    const current = yield* (yield* Ref.get(pairings)).pipe(
      Effect.orElseSucceed((): ReadonlyMap<string, string> => new Map()),
    );
    return rows.filter((row) => current.get(row.environmentId) === row.pairingKey);
  });
  const holders = shares.pipe(Effect.map((rows) => rows.filter((row) => row.peerSharing)));

  /** One wrap per recipient, made by this machine. A recipient whose key fails is skipped. */
  const wrapsFor = (
    itemId: string,
    digest: string,
    dataKey: Uint8Array,
    privateKey: string,
    recipients: ReadonlyArray<{ readonly environmentId: string; readonly publicKey: string }>,
  ) =>
    Effect.gen(function* () {
      const fields: Record<string, Schema.Json> = {};
      const failed: Array<string> = [];
      for (const recipient of recipients) {
        const wrap = Option.liftThrowable(VaultCrypto.wrapVaultDataKey)({
          dataKey,
          itemId,
          sealedDigest: digest,
          by: environmentId,
          senderPrivateKey: privateKey,
          recipient: recipient.environmentId,
          recipientPublicKey: recipient.publicKey,
        });
        if (Option.isSome(wrap)) {
          fields[vaultWrapKey(recipient.environmentId, environmentId)] =
            wrap.value as unknown as Schema.Json;
          yield* sql`INSERT INTO vault_sync_wraps(item_id, recipient, public_key, wrap_json) VALUES (${itemId}, ${recipient.environmentId}, ${recipient.publicKey}, ${canonicalPeerJson(wrap.value)}) ON CONFLICT(item_id, recipient) DO UPDATE SET public_key = excluded.public_key, wrap_json = excluded.wrap_json`;
        } else failed.push(recipient.environmentId);
      }
      for (const peer of failed)
        yield* Effect.logWarning("Vault sync could not wrap an item for a machine", {
          itemId,
          peer,
        });
      return { fields, wrappedForSelf: !failed.includes(environmentId) };
    });

  const recordApplied = (
    itemId: string,
    digest: string,
    applied: "applied" | "deleted",
    localName: string | null,
    clock: HybridClock,
  ) =>
    sql`INSERT INTO vault_sync_applied(item_id, sealed_digest, state, local_name, clock_json) VALUES (${itemId}, ${digest}, ${applied}, ${localName}, ${encodeJson(clock)}) ON CONFLICT(item_id) DO UPDATE SET sealed_digest = excluded.sealed_digest, state = excluded.state, local_name = excluded.local_name, clock_json = excluded.clock_json`;

  const hasRevision: VaultSyncCapture["Service"]["hasRevision"] = (document, recipient, digest) =>
    Effect.gen(function* () {
      const raw = document.fields[vaultWrapKey(recipient.environmentId, environmentId)];
      const wrap = Option.getOrUndefined(decodeVaultWrap(raw));
      if (wrap?.sealedDigest !== digest) return false;
      const rows = yield* sql<{
        public_key: string;
        wrap_json: string;
      }>`SELECT public_key, wrap_json FROM vault_sync_wraps WHERE item_id = ${document.id} AND recipient = ${recipient.environmentId}`;
      return (
        rows[0]?.public_key === recipient.publicKey && rows[0].wrap_json === canonicalPeerJson(raw)
      );
    }).pipe(Effect.mapError(vaultError));

  const open: VaultSyncCapture["Service"]["open"] = (document) =>
    Effect.gen(function* () {
      const previous = (yield* sql<{
        clock_json: string | null;
        sealed_digest: string | null;
      }>`SELECT clock_json, sealed_digest FROM vault_sync_applied WHERE item_id = ${document.id}`)[0];
      const previousClock = previous?.clock_json
        ? yield* Schema.decodeEffect(Schema.fromJsonString(HybridClock))(previous.clock_json).pipe(
            Effect.mapError(vaultError),
          )
        : undefined;
      // Losing trust in a peer or receiving an incomplete envelope cannot roll
      // back a revision already projected here, including an authenticated delete.
      const revisions = revisionsOf(document).filter((revision) => {
        if (previousClock === undefined) return true;
        const order = compareClock(revision.clock, previousClock);
        return order > 0 || (order === 0 && revision.digest === previous?.sealed_digest);
      });
      if (revisions.length === 0) return { _tag: "missing" } as const;
      const pair = yield* keyPair;
      // Mutual consent: only wraps made here or by a holder this owner shares with.
      const trusted: ReadonlyArray<readonly [string, string]> = [
        [environmentId, pair.publicKey],
        ...(yield* holders).map((holder) => [holder.environmentId, holder.publicKey] as const),
      ];
      for (const revision of revisions)
        for (const [by, senderPublicKey] of trusted) {
          const wrap = Option.getOrUndefined(
            decodeVaultWrap(document.fields[vaultWrapKey(environmentId, by)]),
          );
          if (wrap === undefined || wrap.sealedDigest !== revision.digest) continue;
          const opened = Option.liftThrowable(() => {
            const dataKey = VaultCrypto.unwrapVaultDataKey({
              wrap,
              itemId: document.id,
              sealedDigest: revision.digest,
              by,
              senderPublicKey,
              recipient: environmentId,
              recipientPrivateKey: pair.privateKey,
            });
            const plaintext = VaultCrypto.openVaultPayload({
              dataKey,
              sealed: revision.sealed,
              itemId: document.id,
              author: revision.author,
              clock: revision.clock,
            });
            return { dataKey, plaintext };
          })();
          if (Option.isNone(opened)) continue;
          const content = contentOf(opened.value.plaintext);
          // An authentic revision this build cannot read still outranks older
          // ones; falling back to them would roll the item back here.
          if (content === undefined) return { _tag: "waiting" } as const;
          return {
            _tag: "opened",
            digest: revision.digest,
            author: revision.author,
            dataKey: opened.value.dataKey,
            clock: revision.clock,
            content,
          } as const;
        }
      return { _tag: "waiting" } as const;
    }).pipe(Effect.mapError(vaultError));

  const forward: VaultSyncCapture["Service"]["forward"] = (document, opened) =>
    Effect.gen(function* () {
      const pair = yield* keyPair;
      const recipients = [{ environmentId, publicKey: pair.publicKey }, ...(yield* holders)];
      const missing = yield* Effect.filter(recipients, (recipient) =>
        hasRevision(document, recipient, opened.digest).pipe(Effect.map((present) => !present)),
      );
      if (missing.length === 0) return;
      const { fields } = yield* wrapsFor(
        document.id,
        opened.digest,
        opened.dataKey,
        pair.privateKey,
        missing,
      );
      if (Object.keys(fields).length > 0)
        yield* state.write("vault", document.id, fields).pipe(Effect.mapError(vaultError));
    }).pipe(
      sql.withTransaction,
      Effect.mapError(vaultError),
      Effect.withSpan("VaultSyncCapture.forward", { attributes: { "vault.item_id": document.id } }),
    );

  /** A new revision by this machine, wrapped for itself and every current holder. */
  const writeRevision = (itemId: string, plaintext: string) =>
    Effect.gen(function* () {
      const pair = yield* keyPair;
      const recipients = [{ environmentId, publicKey: pair.publicKey }, ...(yield* holders)];
      let digest = "";
      let revisionClock: HybridClock | undefined;
      yield* state
        .writeBuilt("vault", itemId, (clock) =>
          Effect.gen(function* () {
            revisionClock = clock;
            // A fresh data key per revision: a revoked machine's old key opens nothing new.
            const dataKey = VaultCrypto.randomDataKey();
            const sealed = yield* Effect.try({
              try: () =>
                VaultCrypto.sealVaultPayload({
                  dataKey,
                  plaintext,
                  itemId,
                  author: environmentId,
                  clock,
                }),
              catch: (cause) => new SharedStateError({ reason: "invalid-document", cause }),
            });
            digest = VaultCrypto.sealedDigestOf(environmentId, sealed);
            const wraps = yield* wrapsFor(
              itemId,
              digest,
              dataKey,
              pair.privateKey,
              recipients,
            ).pipe(Effect.mapError((cause) => new SharedStateError({ reason: "storage", cause })));
            if (!wraps.wrappedForSelf)
              return yield* new SharedStateError({ reason: "invalid-document" });
            return {
              [vaultSealedKey(environmentId)]: sealed as unknown as Schema.Json,
              ...wraps.fields,
            };
          }),
        )
        .pipe(Effect.mapError(vaultError));
      return { digest, clock: revisionClock! };
    });

  const capture: VaultSyncCapture["Service"]["capture"] = (source) =>
    Effect.gen(function* () {
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
      const document = yield* state.get("vault", source.id).pipe(Effect.mapError(vaultError));
      if (document === undefined) {
        // An item starts syncing only once the owner shares this vault; a
        // delete of one that never synced has nothing to tell anyone.
        if (source.deleted || (yield* shares).length === 0) return;
      }
      const opened = document ? yield* open(document) : ({ _tag: "missing" } as const);
      if (source.deleted) {
        if (document && opened._tag === "opened" && opened.content._tag === "deleted")
          return yield* forward(document, opened);
        const revision = yield* writeRevision(source.id, encodeJson(DELETION));
        yield* recordApplied(source.id, revision.digest, "deleted", null, revision.clock);
        return;
      }
      const applied = yield* sql<{
        local_name: string | null;
      }>`SELECT local_name FROM vault_sync_applied WHERE item_id = ${source.id}`;
      const localName = applied[0]?.local_name ?? null;
      const current =
        opened._tag === "opened" && opened.content._tag === "item" ? opened.content : undefined;
      // An incoming item renamed here to avoid a collision keeps its synced name.
      const keepSyncedName = current !== undefined && localName === source.payload.name;
      const payload: VaultSyncPayload = keepSyncedName
        ? { ...source.payload, name: current.payload.name }
        : source.payload;
      // What a newer build sealed and this build cannot read goes back in.
      const sealedPayload = withExtras(
        encodePayload(payload) as Record<string, unknown>,
        source.extras ?? {},
      );
      if (document && opened._tag === "opened" && current !== undefined) {
        if (contentKey(current.raw) === contentKey(sealedPayload))
          return yield* forward(document, opened);
      }
      const revision = yield* writeRevision(source.id, encodeJson(sealedPayload));
      yield* recordApplied(
        source.id,
        revision.digest,
        "applied",
        keepSyncedName ? localName : null,
        revision.clock,
      );
    }).pipe(
      Effect.mapError(vaultError),
      Effect.withSpan("VaultSyncCapture.capture", { attributes: { "vault.item_id": source.id } }),
    );

  return VaultSyncCapture.of({
    environmentId,
    keyPair,
    recordedShares,
    shares,
    holders,
    hasRevision,
    bindPairings: (current) =>
      Effect.acquireRelease(Ref.set(pairings, current), () => Ref.set(pairings, unbound)),
    capture,
    open: (document) =>
      open(document).pipe(
        Effect.mapError(vaultError),
        Effect.withSpan("VaultSyncCapture.open", {
          attributes: { "vault.item_id": document.id },
        }),
      ),
    forward: (document, opened) => forward(document, opened).pipe(Effect.mapError(vaultError)),
  });
});

export const layer = Layer.effect(VaultSyncCapture, make);
