/**
 * Vault replication between directly paired machines. The owner shares this
 * vault with a peer explicitly (`setPeerSharing`); a peer becomes a holder
 * once it says over the direct link that it shares back. Revisions are
 * wrapped only for holders, and a machine reads a revision only through a
 * wrap made by itself or by a holder. Incoming documents project into
 * `vault_items` here, asynchronously, with this machine's own encryption; a
 * holder then forwards the current revision to its other holders. Transports
 * call these methods; agents have no tool that authorizes a new holder. See
 * docs/internals/vault-sync.md.
 */
import {
  type MachineInfo,
  type HybridClock,
  type SharedDocumentChange,
  VaultError,
  VaultPeerKey,
  type VaultPeerSharing,
  type VaultSetPeerSharingInput,
  type VaultSharingStatus,
} from "@cogenly/contracts";
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
import * as SharedState from "../sync/SharedState.ts";
import { canonicalPeerJson } from "../machines/peerCrypto.ts";
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
    /** Asks each online direct peer whether it shares back, and records the answer. */
    readonly sharingStatus: Effect.Effect<VaultSharingStatus, VaultError>;
    /**
     * Idempotent. `incoming` projects and forwards what peers sent; `full`
     * also captures local items that never synced, for startup and after
     * the share list changes. Both first ask online share peers whether they
     * still share back.
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
  readonly clock_json: string | null;
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

  // Read on every use of a share, so an expired or revoked pairing ends it
  // even when no machine list change announces that.
  yield* capture.bindPairings(
    directPeers.pipe(
      Effect.map(
        (peers) =>
          new Map(peers.map((peer) => [peer.environmentId as string, pairingKeyOf(peer)] as const)),
      ),
    ),
  );

  yield* channels.register(VaultPeerKey, (_, caller) =>
    Effect.gen(function* () {
      const pair = yield* capture.keyPair;
      const shares = yield* capture.shares;
      return {
        publicKey: pair.publicKey,
        sharing: shares.some((share) => share.environmentId === caller.environmentId),
      };
    }).pipe(Effect.orDie),
  );

  const revokeStale: VaultSync["Service"]["revokeStale"] = Effect.gen(function* () {
    const paired = new Map((yield* directPeers).map((m) => [m.environmentId, pairingKeyOf(m)]));
    for (const share of yield* capture.recordedShares)
      if (paired.get(share.environmentId) !== share.pairingKey) {
        // Unpairing on either side, or pairing again, ends sharing. Copies stay.
        yield* sql`DELETE FROM vault_peer_shares WHERE environment_id = ${share.environmentId}`;
        lastSeen.delete(share.environmentId);
        yield* Effect.logInfo("Stopped vault sharing with a machine that is no longer paired", {
          peer: share.environmentId,
        });
      }
  }).pipe(Effect.mapError(storage), Effect.withSpan("VaultSync.revokeStale"));

  /**
   * What an online direct peer says now about its key and whether it shares
   * with this machine. On a share, that answer decides whether the peer is a
   * holder: nothing is wrapped for it or accepted from it until it says yes,
   * and a no or a different key stops both.
   */
  const ask = (peer: MachineInfo, share: VaultSyncCapture.VaultShare | undefined) =>
    Effect.gen(function* () {
      if (!peer.online) return;
      const reply = yield* machines
        .call(peer.environmentId, VaultPeerKey, {})
        .pipe(Effect.timeout("5 seconds"), Effect.option);
      if (Option.isNone(reply)) return;
      const keyChanged = share !== undefined && reply.value.publicKey !== share.publicKey;
      lastSeen.set(peer.environmentId, { sharing: reply.value.sharing, keyChanged });
      if (share === undefined) return;
      const peerSharing = reply.value.sharing && !keyChanged;
      if (peerSharing === share.peerSharing) return;
      yield* sql`UPDATE vault_peer_shares SET peer_sharing = ${peerSharing ? 1 : 0} WHERE environment_id = ${share.environmentId} AND pairing_key = ${share.pairingKey}`;
      yield* Effect.logInfo(
        peerSharing
          ? "A paired machine now shares its vault back"
          : "A paired machine no longer shares its vault back",
        { peer: share.environmentId },
      );
    });

  /** Asks online direct peers, those this machine shares with or, for status, all of them. */
  const refreshPeers = (everyone: boolean) =>
    Effect.gen(function* () {
      const peers = yield* directPeers;
      const shares = yield* capture.shares;
      yield* Effect.forEach(
        peers,
        (peer) => {
          const share = shares.find((row) => row.environmentId === peer.environmentId);
          return everyone || share !== undefined ? ask(peer, share) : Effect.void;
        },
        { concurrency: "unbounded", discard: true },
      );
    });

  const appliedRows = sql<AppliedRow>`SELECT * FROM vault_sync_applied`.pipe(
    Effect.map((rows) => new Map(rows.map((row) => [row.item_id, row]))),
  );
  const markApplied = (
    itemId: string,
    digest: string | null,
    applied: AppliedRow["state"],
    localName: string | null,
    clock: HybridClock | null,
  ) =>
    sql`INSERT INTO vault_sync_applied(item_id, sealed_digest, state, local_name, clock_json) VALUES (${itemId}, ${digest}, ${applied}, ${localName}, ${clock === null ? null : canonicalPeerJson(clock)}) ON CONFLICT(item_id) DO UPDATE SET sealed_digest = excluded.sealed_digest, state = excluded.state, local_name = excluded.local_name, clock_json = excluded.clock_json`;

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

  /**
   * Brings the local row to the newest revision this machine can read, edit
   * or delete alike, so every holder ends on the same one.
   */
  const project = (snapshot: SharedDocumentChange, labels: ReadonlyMap<string, string>) =>
    Effect.gen(function* () {
      // Read and project in one transaction with local vault mutations. A
      // local edit committed after a pass began must not be overwritten by
      // the pass's earlier snapshot.
      const document = yield* state.get("vault", snapshot.id);
      if (document === undefined) return;
      const applied =
        (yield* sql<AppliedRow>`SELECT * FROM vault_sync_applied WHERE item_id = ${document.id}`)[0];
      const local = (yield* sql<{
        name: string;
        portability: string;
        deleted_at: string | null;
      }>`SELECT name, portability, deleted_at FROM vault_items WHERE id = ${document.id}`)[0];
      const machineOnly =
        local !== undefined &&
        effectivePortability({ id: document.id, ...local }, yield* rules).portability === "machine";
      const opened = yield* capture.open(document);
      if (opened._tag === "missing") return;
      if (opened._tag === "waiting") {
        // Nothing here is readable yet. An item already here stays as it is.
        if (applied === undefined || applied.state === "waiting")
          yield* markApplied(document.id, null, "waiting", applied?.local_name ?? null, null);
        return;
      }
      const deleted = opened.content._tag === "deleted";
      if (applied?.sealed_digest === opened.digest && applied.state !== "waiting") {
        // Already here; a holder still forwards to holders that lack it.
        if (!machineOnly) yield* capture.forward(document, opened);
        return;
      }
      // A machine-only item here keeps its local copy and is not forwarded.
      if (machineOnly) {
        yield* markApplied(
          document.id,
          opened.digest,
          deleted ? "deleted" : "applied",
          applied?.local_name ?? null,
          opened.clock,
        );
        return;
      }
      if (opened.content._tag === "deleted") {
        if (local && !local.deleted_at) yield* vault.removeSynced(document.id);
        yield* markApplied(document.id, opened.digest, "deleted", null, opened.clock);
      } else {
        const { payload, extras } = opened.content;
        const localName = yield* vault.applySynced({
          itemId: document.id,
          payload,
          extras,
          sourceLabel: labels.get(opened.author) ?? "another machine",
        });
        yield* markApplied(
          document.id,
          opened.digest,
          "applied",
          localName === payload.name ? null : localName,
          opened.clock,
        );
      }
      yield* capture.forward(document, opened);
    }).pipe(
      sql.withTransaction,
      Effect.mapError(storage),
      Effect.withSpan("VaultSync.project", { attributes: { "vault.item_id": snapshot.id } }),
    );

  const reconcileOnce = (mode: ReconcileMode) =>
    Effect.gen(function* () {
      yield* revokeStale;
      yield* refreshPeers(false);
      const labels = new Map(
        (yield* topology.pipe(
          Effect.map((view) => view.machines),
          Effect.orElseSucceed((): ReadonlyArray<MachineInfo> => []),
        )).map((machine) => [machine.environmentId as string, machine.name]),
      );
      const documents = yield* vaultDocuments;
      for (const document of documents)
        yield* project(document, labels).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Vault sync could not apply an item", {
              itemId: document.id,
              reason: error.reason,
            }),
          ),
        );
      if (mode === "incoming") return;
      if ((yield* capture.shares).length === 0) return;
      // Every item with a document was brought up to date and forwarded
      // above; local edits to it wrote their own revisions. What remains is
      // items that never synced.
      const synced = new Set(documents.map((document) => document.id));
      const rows = yield* sql<{
        id: string;
      }>`SELECT id FROM vault_items WHERE deleted_at IS NULL ORDER BY id`;
      for (const row of rows) {
        if (synced.has(row.id)) continue;
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
    yield* refreshPeers(true);
    const peers = yield* directPeers;
    const shares = yield* capture.shares;
    const documents = yield* vaultDocuments;
    const applied = yield* appliedRows;
    // The revision each readable item has here, as projection or capture recorded it.
    const current = documents.flatMap((document) => {
      const row = applied.get(document.id);
      if (row?.state !== "applied") return [];
      const revision = VaultSyncCapture.revisionsOf(document).find(
        (candidate) => candidate.digest === row.sealed_digest,
      );
      return revision ? [{ document, revision }] : [];
    });
    const itemsWaiting = documents.filter(
      (document) => applied.get(document.id)?.state === "waiting",
    ).length;
    const entries = yield* Effect.forEach(peers, (peer) =>
      Effect.gen(function* () {
        const share = shares.find((row) => row.environmentId === peer.environmentId);
        const seen = lastSeen.get(peer.environmentId);
        // Only a wrap successfully produced here, for this pinned key, proves
        // that this machine has shared this revision. Digests alone prove nothing.
        const itemsShared = share?.peerSharing
          ? (yield* Effect.filter(current, ({ document, revision }) =>
              capture.hasRevision(document, share, revision.digest),
            )).length
          : 0;
        return {
          environmentId: peer.environmentId,
          label: peer.name,
          online: peer.online,
          state: !share
            ? "not_shared"
            : seen?.keyChanged
              ? "key_changed"
              : share.peerSharing
                ? "shared"
                : "waiting_for_peer",
          peerSharing: share ? share.peerSharing : (seen?.sharing ?? null),
          itemsShared,
        } satisfies VaultPeerSharing;
      }),
    );
    return { peers: entries, itemsShared: current.length, itemsWaiting };
  }).pipe(Effect.mapError(storage), Effect.withSpan("VaultSync.sharingStatus"));

  const setPeerSharing: VaultSync["Service"]["setPeerSharing"] = (input) =>
    Effect.gen(function* () {
      yield* revokeStale;
      if (!input.enabled) {
        yield* sql`UPDATE vault_peer_shares SET sharing_enabled = 0, peer_sharing = 0 WHERE environment_id = ${input.environmentId}`;
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
      const existing = (yield* capture.recordedShares).find(
        (share) => share.environmentId === peer.environmentId,
      );
      if (existing) {
        // The pin belongs to the pairing, independently of sharing authorization.
        if (existing.publicKey !== reply.publicKey) {
          lastSeen.set(peer.environmentId, { sharing: reply.sharing, keyChanged: true });
          yield* Effect.logWarning("A paired machine presented a different vault key", {
            peer: peer.environmentId,
          });
          return yield* new VaultError({ reason: "peer_key_changed" });
        }
        yield* sql`UPDATE vault_peer_shares SET sharing_enabled = 1 WHERE environment_id = ${input.environmentId}`;
        yield* ask(peer, existing);
        yield* reconcile("full");
        return yield* sharingStatus;
      }
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO vault_peer_shares(environment_id, public_key, pairing_key, authorized_at, peer_sharing) VALUES (${peer.environmentId}, ${reply.publicKey}, ${pairingKeyOf(peer)}, ${at}, ${reply.sharing ? 1 : 0})`;
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
  yield* logged(reconcile("full"));
  // A pairing, presence or session change can end a share or make a peer a holder.
  yield* machines.subscribe.pipe(
    Stream.runForEach(() => logged(reconcile("incoming"))),
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
