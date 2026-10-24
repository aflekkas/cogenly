/**
 * Vault replication between directly paired machines. The owner shares this
 * vault with a peer explicitly (`setPeerSharing`); a machine reads an item only
 * through a wrap made by itself or by a peer it shares with. Incoming
 * documents project into `vault_items` here, asynchronously, with this
 * machine's own encryption; a holder then forwards the current revision to
 * its other share peers. Transports call these methods; agents have no tool
 * that authorizes a new holder. See docs/internals/vault-sync.md.
 */
import {
  type MachineInfo,
  type SharedDocumentChange,
  VaultError,
  VaultPeerKey,
  type VaultPeerSharing,
  type VaultSetPeerSharingInput,
  type VaultSharingStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import { VAULT_WRAP_PREFIX, decodeVaultWrap } from "../sync/documentSchemas.ts";
import * as SharedState from "../sync/SharedState.ts";
import * as Vault from "./Vault.ts";
import * as VaultCrypto from "./VaultCrypto.ts";
import * as VaultSyncCapture from "./VaultSyncCapture.ts";
import { effectivePortability, loadMachineOnlyRules } from "./vaultPortability.ts";

export type ReconcileMode = "incoming" | "full";

export class VaultSync extends Context.Service<
  VaultSync,
  {
    readonly setPeerSharing: (
      input: VaultSetPeerSharingInput,
    ) => Effect.Effect<VaultSharingStatus, VaultError>;
    readonly sharingStatus: Effect.Effect<VaultSharingStatus, VaultError>;
    /**
     * Idempotent. `incoming` projects and forwards what peers sent; `full`
     * also brings every local item's document up to date, for startup and
     * after the share list changes.
     */
    readonly reconcile: (mode: ReconcileMode) => Effect.Effect<void, VaultError>;
    /** Forgets shares whose peer is no longer directly paired under the same pairing. */
    readonly revokeStale: Effect.Effect<void, VaultError>;
  }
>()("cogenly-server/vault/VaultSync") {}

const isVaultError = Schema.is(VaultError);
const storage = (cause: unknown) =>
  isVaultError(cause) ? cause : new VaultError({ reason: "storage", cause });

/** The same per-pairing key SharedSync records its bootstrap under. */
const pairingKeyOf = (machine: MachineInfo) =>
  `${machine.environmentId}:${machine.pairedAt ? DateTime.toEpochMillis(machine.pairedAt) : 0}`;

/** Only the hub of this spoke, or a spoke of this hub, can vouch for its own key. */
const isDirectPeer = (machine: MachineInfo) =>
  (machine.relation === "hub" || machine.relation === "spoke") && machine.pairing === "paired";

interface AppliedRow {
  readonly item_id: string;
  readonly sealed_digest: string | null;
  readonly state: "applied" | "waiting" | "deleted";
  readonly local_name: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* SharedState.SharedState;
  const vault = yield* Vault.Vault;
  const capture = yield* VaultSyncCapture.VaultSyncCapture;
  const machines = yield* Machines.Machines;
  const channels = yield* PeerChannels.PeerChannels;
  const permit = yield* Semaphore.make(1);
  // What each peer last said about itself, for peers that are offline now.
  const lastSeen = new Map<string, { readonly sharing: boolean; readonly keyChanged: boolean }>();

  const topology = machines.list.pipe(Effect.mapError(storage));
  const directPeers = topology.pipe(Effect.map((view) => view.machines.filter(isDirectPeer)));
  const rules = loadMachineOnlyRules().pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.mapError(storage),
  );

  yield* channels.register(VaultPeerKey, (_, caller) =>
    Effect.gen(function* () {
      const pair = yield* capture.keyPair;
      const rows =
        yield* sql`SELECT 1 FROM vault_peer_shares WHERE environment_id = ${caller.environmentId}`;
      return { publicKey: pair.publicKey, sharing: rows.length > 0 };
    }).pipe(Effect.orDie),
  );

  const revokeStale: VaultSync["Service"]["revokeStale"] = Effect.gen(function* () {
    const paired = new Map((yield* directPeers).map((m) => [m.environmentId, pairingKeyOf(m)]));
    for (const share of yield* capture.shares)
      if (paired.get(share.environmentId) !== share.pairingKey) {
        // Unpairing on either side, or pairing again, ends sharing. Copies stay.
        yield* sql`DELETE FROM vault_peer_shares WHERE environment_id = ${share.environmentId}`;
        lastSeen.delete(share.environmentId);
        yield* Effect.logInfo("Stopped vault sharing with a machine that is no longer paired", {
          peer: share.environmentId,
        });
      }
  }).pipe(Effect.mapError(storage), Effect.withSpan("VaultSync.revokeStale"));

  const appliedRows = sql<AppliedRow>`SELECT * FROM vault_sync_applied`.pipe(
    Effect.map((rows) => new Map(rows.map((row) => [row.item_id, row]))),
  );
  const markApplied = (
    itemId: string,
    digest: string | null,
    applied: AppliedRow["state"],
    localName: string | null,
  ) =>
    sql`INSERT INTO vault_sync_applied(item_id, sealed_digest, state, local_name) VALUES (${itemId}, ${digest}, ${applied}, ${localName}) ON CONFLICT(item_id) DO UPDATE SET sealed_digest = excluded.sealed_digest, state = excluded.state, local_name = excluded.local_name`;

  const vaultDocuments = Effect.gen(function* () {
    const ids = yield* sql<{
      id: string;
    }>`SELECT id FROM shared_documents WHERE kind = 'vault' ORDER BY id`;
    const documents: Array<SharedDocumentChange> = [];
    for (const { id } of ids) {
      const document = yield* state.get("vault", id);
      if (document) documents.push(document);
    }
    return documents;
  });

  const project = (
    document: SharedDocumentChange,
    applied: AppliedRow | undefined,
    labels: ReadonlyMap<string, string>,
  ) =>
    Effect.gen(function* () {
      const local = (yield* sql<{
        name: string;
        portability: string;
        deleted_at: string | null;
      }>`SELECT name, portability, deleted_at FROM vault_items WHERE id = ${document.id}`)[0];
      const machineOnly =
        local !== undefined &&
        effectivePortability({ id: document.id, ...local }, yield* rules).portability === "machine";
      if (document.tombstone) {
        if (applied?.state === "deleted") return;
        if (local && !local.deleted_at && !machineOnly) yield* vault.removeSynced(document.id);
        yield* markApplied(document.id, null, "deleted", null);
        return;
      }
      if (document.fields.sealed === undefined) return;
      const digest = VaultCrypto.sealedDigestOf(document.fields.sealed);
      if (applied?.state === "applied" && applied.sealed_digest === digest) {
        // Already here; a holder still forwards to share peers that lack it.
        if (machineOnly) return;
        if ((yield* capture.missingRecipients(document, digest)).length === 0) return;
        const opened = yield* capture.open(document);
        if (opened._tag === "opened") yield* capture.forward(document, opened);
        return;
      }
      const opened = yield* capture.open(document);
      if (opened._tag !== "opened") {
        if (opened._tag === "waiting")
          yield* markApplied(document.id, digest, "waiting", applied?.local_name ?? null);
        return;
      }
      // A local delete wins (full reconcile tombstones it); a machine-only item
      // here keeps its local copy and is not forwarded.
      if (local?.deleted_at || machineOnly) {
        yield* markApplied(document.id, digest, "applied", applied?.local_name ?? null);
        return;
      }
      const localName = yield* vault.applySynced({
        itemId: document.id,
        payload: opened.payload,
        sourceLabel: labels.get(opened.author) ?? "another machine",
      });
      yield* markApplied(
        document.id,
        digest,
        "applied",
        localName === opened.payload.name ? null : localName,
      );
      yield* capture.forward(document, opened);
    }).pipe(
      Effect.mapError(storage),
      Effect.withSpan("VaultSync.project", { attributes: { "vault.item_id": document.id } }),
    );

  const reconcileOnce = (mode: ReconcileMode) =>
    Effect.gen(function* () {
      const labels = new Map(
        (yield* topology.pipe(
          Effect.map((view) => view.machines),
          Effect.orElseSucceed((): ReadonlyArray<MachineInfo> => []),
        )).map((machine) => [machine.environmentId as string, machine.name]),
      );
      const applied = yield* appliedRows;
      const documents = yield* vaultDocuments;
      for (const document of documents)
        yield* project(document, applied.get(document.id), labels).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Vault sync could not apply an item", {
              itemId: document.id,
              reason: error.reason,
            }),
          ),
        );
      if (mode === "incoming") return;
      if ((yield* capture.shares).length === 0) return;
      const after = yield* appliedRows;
      const byId = new Map(documents.map((document) => [document.id, document]));
      const rows = yield* sql<{
        id: string;
        deleted_at: string | null;
      }>`SELECT id, deleted_at FROM vault_items ORDER BY id`;
      for (const row of rows) {
        const document = byId.get(row.id);
        const live = document !== undefined && document.tombstone === null;
        const readable =
          live &&
          after.get(row.id)?.state === "applied" &&
          document.fields.sealed !== undefined &&
          after.get(row.id)?.sealed_digest === VaultCrypto.sealedDigestOf(document.fields.sealed);
        // Never overwrite a revision this machine cannot read with an older copy.
        const due = row.deleted_at === null ? document === undefined || readable : live;
        if (!due) continue;
        yield* vault.recapture(row.id).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Vault sync could not capture an item", {
              itemId: row.id,
              reason: error.reason,
            }),
          ),
        );
      }
    }).pipe(Effect.mapError(storage), Effect.withSpan("VaultSync.reconcile"));

  const reconcile: VaultSync["Service"]["reconcile"] = (mode) =>
    reconcileOnce(mode).pipe(permit.withPermits(1));

  const sharingStatus: VaultSync["Service"]["sharingStatus"] = Effect.gen(function* () {
    const peers = yield* directPeers;
    const shares = yield* capture.shares;
    const documents = (yield* vaultDocuments).filter(
      (document) => document.tombstone === null && document.fields.sealed !== undefined,
    );
    const digests = new Map(
      documents.map((document) => [
        document.id,
        VaultCrypto.sealedDigestOf(document.fields.sealed),
      ]),
    );
    const applied = yield* appliedRows;
    const count = (wanted: AppliedRow["state"]) =>
      documents.filter((document) => {
        const row = applied.get(document.id);
        return row?.state === wanted && row.sealed_digest === digests.get(document.id);
      }).length;
    const entries = yield* Effect.forEach(
      peers,
      (peer) =>
        Effect.gen(function* () {
          const share = shares.find((row) => row.environmentId === peer.environmentId);
          const remote = peer.online
            ? yield* machines
                .call(peer.environmentId, VaultPeerKey, {})
                .pipe(Effect.timeout("5 seconds"), Effect.option)
            : Option.none();
          if (Option.isSome(remote))
            lastSeen.set(peer.environmentId, {
              sharing: remote.value.sharing,
              keyChanged: share !== undefined && remote.value.publicKey !== share.publicKey,
            });
          const seen = lastSeen.get(peer.environmentId);
          const peerSharing = seen?.sharing ?? null;
          const itemsShared = share
            ? documents.filter((document) => {
                const wrap = decodeVaultWrap(
                  document.fields[`${VAULT_WRAP_PREFIX}${peer.environmentId}`],
                );
                return Option.isSome(wrap) && wrap.value.sealedDigest === digests.get(document.id);
              }).length
            : 0;
          return {
            environmentId: peer.environmentId,
            label: peer.name,
            online: peer.online,
            state: !share
              ? "not_shared"
              : seen?.keyChanged
                ? "key_changed"
                : peerSharing
                  ? "shared"
                  : "waiting_for_peer",
            peerSharing,
            itemsShared,
          } satisfies VaultPeerSharing;
        }),
      { concurrency: "unbounded" },
    );
    return { peers: entries, itemsShared: count("applied"), itemsWaiting: count("waiting") };
  }).pipe(Effect.mapError(storage), Effect.withSpan("VaultSync.sharingStatus"));

  const setPeerSharing: VaultSync["Service"]["setPeerSharing"] = (input) =>
    Effect.gen(function* () {
      yield* revokeStale;
      if (!input.enabled) {
        yield* sql`DELETE FROM vault_peer_shares WHERE environment_id = ${input.environmentId}`;
        return yield* sharingStatus;
      }
      const peer = (yield* directPeers).find(
        (machine) => machine.environmentId === input.environmentId,
      );
      if (!peer?.online) return yield* new VaultError({ reason: "peer_unavailable" });
      // The key comes from that machine itself over the authenticated link.
      const reply = yield* machines.call(peer.environmentId, VaultPeerKey, {}).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) => new VaultError({ reason: "peer_unavailable", cause })),
      );
      if (!VaultCrypto.isX25519PublicKey(reply.publicKey))
        return yield* new VaultError({ reason: "peer_key_invalid" });
      const existing = (yield* capture.shares).find(
        (share) => share.environmentId === peer.environmentId,
      );
      if (existing) {
        // A pinned key never changes silently; the owner turns sharing off and on.
        if (existing.publicKey !== reply.publicKey) {
          lastSeen.set(peer.environmentId, { sharing: reply.sharing, keyChanged: true });
          yield* Effect.logWarning("A paired machine presented a different vault key", {
            peer: peer.environmentId,
          });
          return yield* new VaultError({ reason: "peer_key_changed" });
        }
        return yield* sharingStatus;
      }
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO vault_peer_shares(environment_id, public_key, pairing_key, authorized_at) VALUES (${peer.environmentId}, ${reply.publicKey}, ${pairingKeyOf(peer)}, ${at})`;
      lastSeen.set(peer.environmentId, { sharing: reply.sharing, keyChanged: false });
      yield* reconcile("full");
      return yield* sharingStatus;
    }).pipe(
      Effect.mapError(storage),
      Effect.withSpan("VaultSync.setPeerSharing", {
        attributes: { peer: input.environmentId, enabled: input.enabled },
      }),
    );

  const logged = (effect: Effect.Effect<void, VaultError>) =>
    effect.pipe(
      Effect.catch((error) => Effect.logWarning("Vault sync deferred", { reason: error.reason })),
    );
  yield* logged(revokeStale.pipe(Effect.andThen(reconcile("full"))));
  yield* machines.subscribe.pipe(
    Stream.runForEach(() => logged(revokeStale)),
    Effect.catch((error) => Effect.logWarning("Vault sync stopped watching machines", { error })),
    Effect.forkScoped,
  );
  yield* state.changes.pipe(
    Stream.runForEach(() => logged(reconcile("incoming"))),
    Effect.forkScoped,
  );

  return VaultSync.of({ setPeerSharing, sharingStatus, reconcile, revokeStale });
});

export const layer = Layer.effect(VaultSync, make);
