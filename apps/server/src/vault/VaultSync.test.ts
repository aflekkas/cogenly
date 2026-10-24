import {
  EnvironmentId,
  type SharedDocumentChange,
  ThreadId,
  VaultItemId,
  VaultPeerKey,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { compareClock } from "../sync/merge.ts";
import * as VaultCrypto from "./VaultCrypto.ts";
import { revisionsOf } from "./VaultSyncCapture.ts";
import {
  Network,
  type VaultNode as Node,
  expectAbsent,
  push,
  settle,
  share,
  startNode,
  storedText,
} from "./vaultSync.testkit.ts";
import {
  LOCAL_GOOGLE_CLIENT_ITEM,
  effectivePortability,
  loadMachineOnlyRules,
} from "./vaultPortability.ts";

const reveal = (node: Node, itemId: VaultItemId, field: "password" | "username" = "password") =>
  node.vault
    .use({ itemId, field, caller: { kind: "human" } })
    .pipe(Effect.map((result) => (result.status === "allowed" ? result.value : result.status)));

const changeCount = (node: Node) =>
  node.sql<{ count: number }>`SELECT COUNT(*) AS count FROM shared_changes`.pipe(
    Effect.map((rows) => rows[0]!.count),
  );

const login = (name: string, password: string, domain = "github.com") => ({
  name,
  type: "login" as const,
  allowedDomains: [domain],
  secretFields: { username: `${name}-user`, password },
});

const documentOf = (node: Node, itemId: string) =>
  node.state.get("vault", itemId).pipe(Effect.map((document) => document!));

/** The newest revision of an item that `node` can open, if any. */
const readable = (node: Node, itemId: string) =>
  Effect.gen(function* () {
    const document = yield* node.state.get("vault", itemId);
    if (!document) return undefined;
    const opened = yield* node.capture.open(document);
    return opened._tag === "opened" ? opened : undefined;
  });

const recipientOf = (node: Node) =>
  node.capture.keyPair.pipe(
    Effect.map((pair) => ({
      environmentId: node.environmentId as string,
      publicKey: pair.publicKey,
    })),
  );

/**
 * A revision `author` seals and wraps itself, outside capture: what a newer
 * build, or a machine outside the vault, can write into its own document.
 */
const sealAs = (
  author: Node,
  itemId: string,
  plaintext: string,
  recipients: ReadonlyArray<{ readonly environmentId: string; readonly publicKey: string }>,
) =>
  Effect.gen(function* () {
    const keys = yield* author.capture.keyPair;
    yield* author.state.writeBuilt("vault", itemId, (clock) =>
      Effect.sync(() => {
        const dataKey = VaultCrypto.randomDataKey();
        const sealed = VaultCrypto.sealVaultPayload({
          dataKey,
          plaintext,
          itemId,
          author: author.environmentId,
          clock,
        });
        const sealedDigest = VaultCrypto.sealedDigestOf(author.environmentId, sealed);
        return {
          [`sealed:${author.environmentId}`]: sealed as unknown as Schema.Json,
          ...Object.fromEntries(
            recipients.map((recipient) => [
              `wrap:${recipient.environmentId}:${author.environmentId}`,
              VaultCrypto.wrapVaultDataKey({
                dataKey,
                itemId,
                sealedDigest,
                by: author.environmentId,
                senderPrivateKey: keys.privateKey,
                recipient: recipient.environmentId,
                recipientPublicKey: recipient.publicKey,
              }) as unknown as Schema.Json,
            ]),
          ),
        };
      }),
    );
  });

/** Appends a change to a machine's own log, as a machine that controls its database can. */
const appendChange = (node: Node, change: object) =>
  node.sql`INSERT INTO shared_changes(change_json) VALUES (${JSON.stringify(change)})`;

const wrapKeysFor = (document: SharedDocumentChange, recipient: string) =>
  Object.keys(document.fields).filter((key) => key.startsWith(`wrap:${recipient}:`));

const forgedPayload = JSON.stringify({
  name: "Bank",
  type: "login",
  scopeProjectId: null,
  allowedDomains: ["evil.test"],
  secretFields: { password: "forged-password" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** A low-order X25519 point as a base64 SPKI public key: it parses, but exchanges nothing. */
const lowOrderKey = Buffer.concat([
  Buffer.from("302a300506032b656e032100", "hex"),
  Buffer.alloc(32, 0),
]).toString("base64");

describe("vault sync between paired machines", () => {
  it.effect(
    "shares both ways: create, edit and delete arrive; policy and approvals stay local",
    () =>
      Effect.gen(function* () {
        const network = new Network();
        const hub = yield* startNode(network, "Server");
        const spoke = yield* startNode(network, "Laptop");
        network.pair(hub, spoke);
        yield* share(spoke, hub);
        expect((yield* spoke.sync.sharingStatus).peers[0]?.state).toBe("waiting_for_peer");
        yield* share(hub, spoke);
        expect((yield* spoke.sync.sharingStatus).peers[0]?.state).toBe("shared");

        const { item } = yield* spoke.vault.create(login("GitHub", "spoke-password-1"));
        yield* settle(hub, [spoke]);
        expect(yield* reveal(hub, item.id)).toBe("spoke-password-1");
        const arrived = yield* hub.vault.getMetadata(item.id);
        expect(arrived).toMatchObject({ name: "GitHub", allowedDomains: ["github.com"] });
        expect(arrived.policy.mode).toBe("ask");

        // A grant on the hub is the hub's alone and writes nothing to sync.
        const before = yield* changeCount(hub);
        yield* hub.vault.update({
          id: item.id,
          policy: {
            mode: "allow",
            allowedAgentIds: [],
            allowedThreadIds: [ThreadId.make("thread:hub")],
            allowedDomains: [],
          },
        });
        expect(yield* changeCount(hub)).toBe(before);
        // An approval request on the spoke stays on the spoke.
        const asked = yield* spoke.vault.use({
          itemId: item.id,
          field: "password",
          caller: { kind: "thread", threadId: "thread:spoke" },
        });
        expect(asked.status).toBe("approval_required");

        yield* spoke.vault.update({ id: item.id, secretFields: { password: "spoke-password-2" } });
        yield* settle(hub, [spoke]);
        expect(yield* reveal(hub, item.id)).toBe("spoke-password-2");
        expect((yield* hub.vault.getMetadata(item.id)).policy.allowedThreadIds).toEqual([
          "thread:hub",
        ]);
        expect((yield* spoke.vault.getMetadata(item.id)).policy.mode).toBe("ask");
        const approvals = yield* spoke.sql<{ id: string }>`SELECT id FROM agent_approvals`;
        expect(approvals).toHaveLength(1);
        expect(yield* hub.sql`SELECT id FROM agent_approvals`).toEqual([]);
        for (const node of [hub, spoke]) {
          const documents = yield* node.sql<{
            kind: string;
            fields_json: string;
          }>`SELECT kind, fields_json FROM shared_documents`;
          expect(documents.every((document) => document.kind === "vault")).toBe(true);
          expect(JSON.stringify(documents)).not.toContain(approvals[0]!.id);
          expect(JSON.stringify(documents)).not.toContain("thread:hub");
        }

        // Edits flow the other way too.
        yield* hub.vault.update({ id: item.id, allowedDomains: ["github.com", "api.github.com"] });
        yield* settle(hub, [spoke]);
        expect((yield* spoke.vault.getMetadata(item.id)).allowedDomains).toEqual([
          "github.com",
          "api.github.com",
        ]);

        // A delete is a sealed revision like any other, never a tombstone.
        yield* spoke.vault.delete({ id: item.id });
        yield* settle(hub, [spoke]);
        expect((yield* hub.vault.list({})).items).toEqual([]);
        expect((yield* Effect.flip(reveal(hub, item.id))).reason).toBe("not_found");
        expect((yield* documentOf(hub, item.id)).tombstone).toBeNull();
        expect((yield* readable(hub, item.id))?.content).toEqual({ _tag: "deleted" });
      }).pipe(Effect.scoped),
  );

  it.effect("a hub that does not share back gets nothing it can read, and cannot alter items", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const spoke = yield* startNode(network, "Laptop");
      const other = yield* startNode(network, "Desktop");
      network.pair(hub, spoke);
      network.pair(hub, other);
      // Both spokes share with the hub; the hub has not agreed to hold anything.
      yield* share(spoke, hub);
      yield* share(other, hub);
      const { item } = yield* spoke.vault.create(login("Bank", "bank-password-1", "bank.test"));
      yield* settle(hub, [spoke, other]);

      // Nothing is wrapped for the hub until it shares back, so it relays blind.
      expect(wrapKeysFor(yield* documentOf(hub, item.id), hub.environmentId)).toEqual([]);
      expect((yield* hub.vault.list({})).items).toEqual([]);
      expect((yield* hub.sync.sharingStatus).itemsWaiting).toBe(1);
      expect((yield* other.vault.list({})).items).toEqual([]);
      expect((yield* other.sync.sharingStatus).itemsWaiting).toBe(1);
      // Nothing about the item is readable on the hub, its name and domain included.
      const hubText = yield* storedText(hub);
      expectAbsent(hubText, ["bank-password-1", "Bank-user", "bank.test"]);
      expect(hubText).not.toMatch(/"name":"Bank"/);

      // The hub seals its own content for the spoke under a newer clock. The
      // spoke takes revisions only from machines that share back.
      yield* sealAs(hub, item.id, forgedPayload, [yield* recipientOf(spoke)]);
      yield* settle(hub, [spoke, other]);
      expect(yield* reveal(spoke, item.id)).toBe("bank-password-1");
      expect((yield* spoke.vault.getMetadata(item.id)).allowedDomains).toEqual(["bank.test"]);

      // As the relay it can also claim the spoke's own authorship and replace
      // the spoke's revision. Without the spoke's private key the wrap does
      // not verify: that withholds the revision, but alters nothing.
      const hubKeys = yield* hub.capture.keyPair;
      const sealedKey = `sealed:${spoke.environmentId}`;
      const wrapKey = `wrap:${spoke.environmentId}:${spoke.environmentId}`;
      const clock = (yield* documentOf(spoke, item.id)).clocks[sealedKey]!;
      const later = { ...clock, logical: clock.logical + 1000 };
      const dataKey = VaultCrypto.randomDataKey();
      const sealed = VaultCrypto.sealVaultPayload({
        dataKey,
        plaintext: forgedPayload,
        itemId: item.id,
        author: spoke.environmentId,
        clock: later,
      });
      const forged = {
        kind: "vault",
        id: item.id,
        fields: {
          [sealedKey]: sealed,
          [wrapKey]: VaultCrypto.wrapVaultDataKey({
            dataKey,
            itemId: item.id,
            sealedDigest: VaultCrypto.sealedDigestOf(spoke.environmentId, sealed),
            by: spoke.environmentId,
            senderPrivateKey: hubKeys.privateKey,
            recipient: spoke.environmentId,
            recipientPublicKey: (yield* recipientOf(spoke)).publicKey,
          }),
        },
        clocks: { [sealedKey]: later, [wrapKey]: later },
        tombstone: null,
        updatedBy: spoke.environmentId,
      };
      yield* appendChange(hub, forged);
      const received = (yield* spoke.state.cursors(hub.environmentId)).received;
      yield* spoke.state.receive(
        { after: received, cursor: received + 1, changes: [forged as never] },
        hub.environmentId,
        true,
      );
      yield* spoke.sync.reconcile("incoming");
      expect(yield* reveal(spoke, item.id)).toBe("bank-password-1");
      expect((yield* spoke.vault.getMetadata(item.id)).allowedDomains).toEqual(["bank.test"]);
      // The spoke's next edit is a newer revision of its own again.
      yield* spoke.vault.update({ id: item.id, secretFields: { password: "bank-password-2" } });
      expect((yield* readable(spoke, item.id))?.digest).toBe(
        revisionsOf(yield* documentOf(spoke, item.id))[0]?.digest,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a holder hub forwards to other spokes; a spoke it never trusted cannot read", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      const b = yield* startNode(network, "Desktop");
      network.pair(hub, a);
      network.pair(hub, b);
      yield* share(a, hub);
      yield* share(b, hub);
      const { item } = yield* a.vault.create(login("Mail", "mail-password-1", "mail.test"));
      yield* settle(hub, [a, b]);
      expect((yield* b.vault.list({})).items).toEqual([]);

      // Once the hub holds for both, it forwards the current revision to B.
      yield* share(hub, a);
      yield* share(hub, b);
      yield* settle(hub, [a, b]);
      expect(yield* reveal(hub, item.id)).toBe("mail-password-1");
      expect(yield* reveal(b, item.id)).toBe("mail-password-1");
      const document = yield* documentOf(hub, item.id);
      expect(document.fields[`wrap:${b.environmentId}:${hub.environmentId}`]).toBeDefined();
      expect((yield* hub.sync.sharingStatus).peers.map((peer) => peer.itemsShared)).toEqual([1, 1]);

      // An edit on B travels back through the hub to A.
      yield* b.vault.update({ id: item.id, secretFields: { password: "mail-password-2" } });
      yield* settle(hub, [a, b]);
      expect(yield* reveal(a, item.id)).toBe("mail-password-2");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "the newest change wins, edit or delete, on every holder; colliding names are renamed",
    () =>
      Effect.gen(function* () {
        const network = new Network();
        const hub = yield* startNode(network, "Server");
        const spoke = yield* startNode(network, "Laptop");
        network.pair(hub, spoke);
        yield* share(spoke, hub);
        yield* share(hub, spoke);
        const { item } = yield* spoke.vault.create(login("Shared", "first"));
        yield* settle(hub, [spoke]);

        yield* spoke.vault.update({ id: item.id, secretFields: { password: "from-spoke" } });
        yield* hub.vault.update({ id: item.id, secretFields: { password: "from-hub" } });
        const spokeClock = (yield* documentOf(spoke, item.id)).clocks[
          `sealed:${spoke.environmentId}`
        ]!;
        const hubClock = (yield* documentOf(hub, item.id)).clocks[`sealed:${hub.environmentId}`]!;
        const winner = compareClock(spokeClock, hubClock) > 0 ? "from-spoke" : "from-hub";
        yield* settle(hub, [spoke]);
        expect(yield* reveal(hub, item.id)).toBe(winner);
        expect(yield* reveal(spoke, item.id)).toBe(winner);
        expect(yield* documentOf(hub, item.id)).toEqual(yield* documentOf(spoke, item.id));

        // A delete, then a later edit elsewhere: the edit brings the item
        // back everywhere, as a new arrival that asks first.
        yield* spoke.vault.update({
          id: item.id,
          policy: { mode: "allow", allowedAgentIds: [], allowedDomains: [] },
        });
        yield* spoke.vault.delete({ id: item.id });
        yield* TestClock.adjust(Duration.seconds(1));
        yield* hub.vault.update({ id: item.id, secretFields: { password: "after-delete" } });
        yield* settle(hub, [spoke]);
        expect(yield* reveal(hub, item.id)).toBe("after-delete");
        expect(yield* reveal(spoke, item.id)).toBe("after-delete");
        expect((yield* spoke.vault.getMetadata(item.id)).policy.mode).toBe("ask");

        // An edit, then a later delete elsewhere: the delete wins everywhere.
        yield* hub.vault.update({ id: item.id, secretFields: { password: "before-delete" } });
        yield* TestClock.adjust(Duration.seconds(1));
        yield* spoke.vault.delete({ id: item.id });
        yield* settle(hub, [spoke]);
        expect((yield* hub.vault.list({})).items).toEqual([]);
        expect((yield* spoke.vault.list({})).items).toEqual([]);

        // Both machines already have a "Work" item; each keeps its own name.
        const fromSpoke = (yield* spoke.vault.create(login("Work", "spoke-work"))).item;
        const fromHub = (yield* hub.vault.create(login("Work", "hub-work"))).item;
        yield* settle(hub, [spoke]);
        expect((yield* hub.vault.getMetadata(fromSpoke.id)).name).toBe("Work (from Laptop)");
        expect((yield* spoke.vault.getMetadata(fromHub.id)).name).toBe("Work (from Server)");
        // Editing the renamed copy keeps the synced name everywhere else.
        yield* hub.vault.update({ id: fromSpoke.id, secretFields: { password: "edited-on-hub" } });
        yield* settle(hub, [spoke]);
        expect((yield* spoke.vault.getMetadata(fromSpoke.id)).name).toBe("Work");
        expect(yield* reveal(spoke, fromSpoke.id)).toBe("edited-on-hub");
        expect((yield* hub.vault.getMetadata(fromSpoke.id)).name).toBe("Work (from Laptop)");

        // A long machine name is cut so the renamed item stays within the name limit.
        network.names.set(hub.environmentId, "H".repeat(300));
        const long = (yield* hub.vault.create(login("W".repeat(200), "long-1"))).item;
        yield* spoke.vault.create(login("W".repeat(200), "long-2"));
        yield* settle(hub, [spoke]);
        const renamed = (yield* spoke.vault.getMetadata(long.id)).name;
        expect(renamed.length).toBeLessThanOrEqual(200);
        expect(renamed).toMatch(/\(from H+…\)$/);
      }).pipe(Effect.scoped),
  );

  it.effect("unpairing revokes sharing: later revisions are not wrapped for that machine", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      const b = yield* startNode(network, "Desktop");
      network.pair(hub, a);
      network.pair(hub, b);
      for (const [from, to] of [
        [a, hub],
        [hub, a],
        [b, hub],
        [hub, b],
      ] as const)
        yield* share(from, to);
      const { item } = yield* a.vault.create(login("Cloud", "cloud-1"));
      yield* settle(hub, [a, b]);
      expect(yield* reveal(b, item.id)).toBe("cloud-1");

      network.unpair(b);
      yield* hub.sync.revokeStale;
      yield* b.sync.revokeStale;
      expect((yield* hub.capture.shares).map((peer) => peer.environmentId)).toEqual([
        a.environmentId,
      ]);
      expect(yield* b.capture.shares).toEqual([]);

      yield* a.vault.update({ id: item.id, secretFields: { password: "cloud-2" } });
      yield* settle(hub, [a]);
      const document = yield* documentOf(hub, item.id);
      const newest = revisionsOf(document)[0]!;
      expect(newest.author).toBe(a.environmentId);
      for (const by of [a, hub, b])
        expect(document.fields[`wrap:${b.environmentId}:${by.environmentId}`]).not.toMatchObject({
          sealedDigest: newest.digest,
        });

      // Pairing again is a new pairing: B gets the documents but not the key.
      network.pair(hub, b);
      yield* settle(hub, [a, b]);
      expect(yield* reveal(b, item.id)).toBe("cloud-1");
      expect((yield* readable(b, item.id))?.digest).not.toBe(newest.digest);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps what a newer build added: payload keys at any depth, fields and wraps", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const spoke = yield* startNode(network, "Laptop");
      network.pair(hub, spoke);
      yield* share(spoke, hub);
      yield* share(hub, spoke);
      const { item } = yield* spoke.vault.create(login("Future", "future-1"));
      yield* settle(hub, [spoke]);

      // The hub, as a newer build, seals a top-level key and a secret field
      // this build does not know, and adds a document field and a wrap for a
      // machine this build has never seen.
      const current = yield* readable(hub, item.id);
      if (current?.content._tag !== "item") return yield* Effect.die("unreadable");
      const raw = current.content.raw;
      yield* sealAs(
        hub,
        item.id,
        JSON.stringify({
          ...raw,
          futureKey: { kept: true },
          secretFields: { ...(raw.secretFields as object), passkey: "newer-build-passkey" },
        }),
        [
          yield* recipientOf(hub),
          yield* recipientOf(spoke),
          { environmentId: "env-future", publicKey: VaultCrypto.generateKeyPair().publicKey },
        ],
      );
      const future: SharedDocumentChange = {
        kind: "vault",
        id: item.id,
        fields: { futureField: { v: 9 } },
        clocks: { futureField: { wall: 1, logical: 0, node: "env-future" } },
        tombstone: null,
        updatedBy: EnvironmentId.make("env-future"),
      };
      yield* hub.state.receive(
        { after: 0, cursor: 1, changes: [future] },
        EnvironmentId.make("env-future"),
        false,
      );
      yield* settle(hub, [spoke]);
      expect(yield* reveal(spoke, item.id)).toBe("future-1");

      const expectKept = (password: string) =>
        Effect.gen(function* () {
          const document = yield* documentOf(hub, item.id);
          expect(document.fields.futureField).toEqual({ v: 9 });
          expect(document.fields[`wrap:env-future:${hub.environmentId}`]).toBeDefined();
          expect(revisionsOf(document)[0]?.author).toBe(spoke.environmentId);
          const opened = yield* readable(hub, item.id);
          if (opened?.content._tag !== "item") return yield* Effect.die("unreadable");
          expect(opened.content.raw.futureKey).toEqual({ kept: true });
          expect(opened.content.raw.secretFields).toMatchObject({
            password,
            passkey: "newer-build-passkey",
          });
          return opened.content.payload;
        });
      // A secret edit on this build keeps all of it.
      yield* spoke.vault.update({ id: item.id, secretFields: { password: "future-2" } });
      yield* settle(hub, [spoke]);
      yield* expectKept("future-2");
      // So does an edit that touches nothing secret.
      yield* spoke.vault.update({ id: item.id, label: "Renamed label" });
      yield* settle(hub, [spoke]);
      expect((yield* expectKept("future-2")).label).toBe("Renamed label");
      // Kept locally, the newer build's secret is encrypted like any other.
      for (const node of [hub, spoke])
        expectAbsent(yield* storedText(node), ["newer-build-passkey"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "machine-only items, local integration credentials and unshared machines never produce documents",
    () =>
      Effect.gen(function* () {
        const network = new Network();
        const hub = yield* startNode(network, "Server");
        const spoke = yield* startNode(network, "Laptop");
        network.pair(hub, spoke);
        const early = (yield* spoke.vault.create(login("Early", "early-1"))).item;
        expect(yield* spoke.state.get("vault", early.id)).toBeUndefined();

        yield* share(spoke, hub);
        // Turning sharing on captures what was already there.
        expect(yield* spoke.state.get("vault", early.id)).toBeDefined();
        const local = (yield* spoke.vault.create({
          ...login("Local only", "local-1"),
          portability: "machine",
        })).item;
        const google = (yield* spoke.vault.create({
          name: LOCAL_GOOGLE_CLIENT_ITEM,
          type: "api_key",
          allowedDomains: ["accounts.google.com"],
          secretFields: { value: '{"web":{"client_secret":"google-secret"}}' },
        })).item;
        yield* spoke.sql`INSERT INTO integrations(id, name, payload_json, deleted_at, updated_at) VALUES ('integration:local', 'workspace', ${JSON.stringify({ transport: "local", headers: { Authorization: "Bearer {{credential:Runner token.value}}" } })}, NULL, '2026-01-01T00:00:00.000Z')`;
        const runner = (yield* spoke.vault.create({
          name: "Runner token",
          type: "api_key",
          allowedDomains: [],
          secretFields: { value: "runner-secret" },
        })).item;
        expect(local.portability).toBe("machine");
        expect(google).toMatchObject({
          portability: "machine",
          portabilityReason: "local_integration",
        });
        expect(runner).toMatchObject({
          portability: "machine",
          portabilityReason: "local_integration",
        });
        for (const id of [local.id, google.id, runner.id])
          expect(yield* spoke.state.get("vault", id)).toBeUndefined();

        // Switching an item to machine-only stops later revisions; the copy elsewhere stays.
        yield* share(hub, spoke);
        yield* settle(hub, [spoke]);
        yield* spoke.vault.update({ id: early.id, portability: "machine" });
        yield* spoke.vault.update({ id: early.id, secretFields: { password: "early-2" } });
        yield* settle(hub, [spoke]);
        expect(yield* reveal(hub, early.id)).toBe("early-1");
        expect((yield* hub.vault.list({})).items.map((entry) => entry.name)).toEqual(["Early"]);
      }).pipe(Effect.scoped),
  );

  it.effect("enabling needs a direct online peer and refuses a changed or low-order key", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      const b = yield* startNode(network, "Desktop");
      network.pair(hub, a);
      network.pair(hub, b);
      // Another spoke is visible through the hub but is not a direct peer.
      expect(
        (yield* Effect.flip(
          a.sync.setPeerSharing({ environmentId: b.environmentId, enabled: true }),
        )).reason,
      ).toBe("peer_unavailable");
      yield* share(a, hub);
      yield* a.sql`UPDATE vault_peer_shares SET public_key = ${VaultCrypto.generateKeyPair().publicKey}`;
      expect((yield* Effect.flip(share(a, hub))).reason).toBe("peer_key_changed");
      expect(
        (yield* a.sync.sharingStatus).peers.find((peer) => peer.environmentId === hub.environmentId)
          ?.state,
      ).toBe("key_changed");
      const reply = yield* network
        .machines(a.environmentId)
        .call(hub.environmentId, VaultPeerKey, {});
      expect(VaultCrypto.isX25519PublicKey(reply.publicKey)).toBe(true);
      yield* a.sync.setPeerSharing({ environmentId: hub.environmentId, enabled: false });
      yield* share(a, hub);
      expect((yield* a.capture.shares)[0]?.publicKey).toBe(reply.publicKey);

      // A machine presenting a low-order key, which would fail every wrap for it, is refused.
      const rogue = EnvironmentId.make("env-rogue");
      const channels = Context.get(
        yield* Layer.build(PeerChannels.layer),
        PeerChannels.PeerChannels,
      );
      yield* channels.register(VaultPeerKey, () =>
        Effect.succeed({ publicKey: lowOrderKey, sharing: true }),
      );
      network.names.set(rogue, "Rogue");
      network.channels.set(rogue, channels);
      network.pair(hub, { environmentId: rogue } as Node);
      expect(
        (yield* Effect.flip(hub.sync.setPeerSharing({ environmentId: rogue, enabled: true })))
          .reason,
      ).toBe("peer_key_invalid");
      expect(yield* hub.capture.recordedShares).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("no secret, item name or domain reaches stored text, logs or spans", () => {
    const logs: Array<string> = [];
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const collector = Logger.make((options) => {
      let line = "";
      try {
        line = JSON.stringify(options.message);
      } catch {
        line = String(options.message);
      }
      logs.push(`${line} ${String(options.cause)}`);
    });
    const secrets = ["scan-password-1", "scan-password-2", "Scan item-user", "otp-secret-AAAA"];
    const named = ["Scan item", "scan-domain.test"];
    return Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      const b = yield* startNode(network, "Desktop");
      network.pair(hub, a);
      network.pair(hub, b);
      yield* share(a, hub);
      yield* share(hub, a);
      yield* share(b, hub);
      const { item } = yield* a.vault.create({
        ...login("Scan item", "scan-password-1", "scan-domain.test"),
        secretFields: {
          username: "Scan item-user",
          password: "scan-password-1",
          totpSecret: "otp-secret-AAAA",
        },
      });
      yield* settle(hub, [a, b]);
      yield* a.vault.update({ id: item.id, secretFields: { password: "scan-password-2" } });
      yield* settle(hub, [a, b]);
      expect(yield* reveal(hub, item.id)).toBe("scan-password-2");
      yield* a.vault.delete({ id: item.id });
      yield* settle(hub, [a, b]);
      for (const node of [hub, a, b]) expectAbsent(yield* storedText(node), secrets);
      // B never shared with by the hub: not even the name or domain.
      expectAbsent(yield* storedText(b), named);
      const logged = logs.join("\n");
      expect(logged.length).toBeGreaterThan(0);
      expectAbsent(logged, [...secrets, ...named]);
      const traced = spans
        .map((span) => `${span.name} ${JSON.stringify([...span.attributes.entries()])}`)
        .join("\n");
      expect(traced).toContain("VaultSyncCapture.capture");
      expectAbsent(traced, [...secrets, ...named]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Logger.layer([collector])),
      Effect.provideService(Tracer.Tracer, tracer),
    );
  });
});

describe("machines that do not hold the vault cannot delete, freeze or read items", () => {
  it.effect("a tombstone deletes nothing, and no machine writes one", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      const c = yield* startNode(network, "Intruder");
      network.pair(hub, a);
      network.pair(hub, c);
      yield* share(a, hub);
      yield* share(hub, a);
      // Nobody shares with C, and C shares with nobody.
      const { item } = yield* a.vault.create(login("Bank", "bank-password-1", "bank.test"));
      const mail = (yield* c.vault.create(login("Mail", "mail-password-1"))).item;
      yield* settle(hub, [a, c]);
      expect(yield* c.state.get("vault", item.id)).toBeDefined();
      // No machine writes a vault tombstone, even for a document it has.
      expect((yield* Effect.flip(c.state.write("vault", item.id, {}, true))).reason).toBe(
        "invalid-document",
      );

      // C controls its own database and appends one anyway; the hub does the
      // same for an item on a spoke that never turned sharing on.
      yield* appendChange(c, {
        kind: "vault",
        id: item.id,
        fields: {},
        clocks: {},
        tombstone: { wall: 4_000_000_000_000, logical: 0, node: c.environmentId },
        updatedBy: c.environmentId,
      });
      yield* appendChange(hub, {
        kind: "vault",
        id: mail.id,
        fields: {},
        clocks: {},
        tombstone: { wall: 4_000_000_000_000, logical: 0, node: hub.environmentId },
        updatedBy: hub.environmentId,
      });
      yield* settle(hub, [a, c]);
      expect(yield* reveal(a, item.id)).toBe("bank-password-1");
      expect(yield* reveal(hub, item.id)).toBe("bank-password-1");
      expect(yield* reveal(c, mail.id)).toBe("mail-password-1");
      for (const node of [hub, a, c])
        expect((yield* documentOf(node, item.id)).tombstone).toBeNull();
      expect(yield* c.state.get("vault", mail.id)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("a sealed delete from a machine that is not a holder is ignored", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      const c = yield* startNode(network, "Intruder");
      network.pair(hub, a);
      network.pair(hub, c);
      yield* share(a, hub);
      yield* share(hub, a);
      // C shares one way; nobody shares back with it.
      yield* share(c, hub);
      const { item } = yield* a.vault.create(login("Bank", "bank-password-1", "bank.test"));
      yield* settle(hub, [a, c]);
      // C seals a delete and wraps it for both holders with its own key.
      yield* sealAs(c, item.id, JSON.stringify({ deleted: true }), [
        yield* recipientOf(a),
        yield* recipientOf(hub),
      ]);
      yield* settle(hub, [a, c]);
      expect(yield* reveal(a, item.id)).toBe("bank-password-1");
      expect(yield* reveal(hub, item.id)).toBe("bank-password-1");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a far-future revision from another machine neither masks nor freezes later edits",
    () =>
      Effect.gen(function* () {
        const network = new Network();
        const hub = yield* startNode(network, "Server");
        const a = yield* startNode(network, "Laptop");
        const c = yield* startNode(network, "Intruder");
        network.pair(hub, a);
        network.pair(hub, c);
        yield* share(a, hub);
        yield* share(hub, a);
        const { item } = yield* a.vault.create(login("Git", "git-password-1"));
        yield* settle(hub, [a, c]);
        expect(yield* reveal(hub, item.id)).toBe("git-password-1");

        // C sends well-formed junk dated far in the future: as its own revision,
        // and as A's revision and wrap, which C may not write.
        const current = yield* documentOf(hub, item.id);
        const junk = current.fields[`sealed:${a.environmentId}`];
        const future = { wall: 4_000_000_000_000, logical: 0, node: c.environmentId };
        yield* appendChange(c, {
          kind: "vault",
          id: item.id,
          fields: {
            [`sealed:${c.environmentId}`]: junk,
            [`sealed:${a.environmentId}`]: junk,
            [`wrap:${a.environmentId}:${a.environmentId}`]:
              current.fields[`wrap:${a.environmentId}:${a.environmentId}`],
          },
          clocks: {
            [`sealed:${c.environmentId}`]: future,
            [`sealed:${a.environmentId}`]: future,
            [`wrap:${a.environmentId}:${a.environmentId}`]: future,
          },
          tombstone: null,
          updatedBy: c.environmentId,
        });
        yield* settle(hub, [a, c]);
        const masked = yield* documentOf(hub, item.id);
        expect(masked.fields[`sealed:${c.environmentId}`]).toBeDefined();
        expect(masked.clocks[`sealed:${a.environmentId}`]?.node).toBe(a.environmentId);

        // A's later edit still reaches the hub, and nothing waits.
        yield* a.vault.update({ id: item.id, secretFields: { password: "git-password-2" } });
        yield* settle(hub, [a, c]);
        expect(yield* reveal(hub, item.id)).toBe("git-password-2");
        expect((yield* a.sync.sharingStatus).itemsWaiting).toBe(0);
        expect((yield* hub.sync.sharingStatus).itemsWaiting).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("junk wraps from another machine do not stop a holder forwarding", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      const b = yield* startNode(network, "Desktop");
      const c = yield* startNode(network, "Intruder");
      for (const spoke of [a, b, c]) network.pair(hub, spoke);
      for (const spoke of [a, b]) {
        yield* share(spoke, hub);
        yield* share(hub, spoke);
      }
      const { item } = yield* a.vault.create(login("Mail", "mail-password-1"));
      yield* settle(hub, [a, b, c]);
      expect(yield* reveal(b, item.id)).toBe("mail-password-1");

      // A edits; before the hub forwards, C sees the new revision and writes
      // wraps for B that name it: its own, and one claiming to be the hub's.
      yield* a.vault.update({ id: item.id, secretFields: { password: "mail-password-2" } });
      yield* push(a, hub, false);
      yield* push(hub, c, true);
      const document = yield* documentOf(c, item.id);
      const newest = revisionsOf(document)[0]!;
      const junk = {
        ...(document.fields[`wrap:${hub.environmentId}:${a.environmentId}`] as object),
        sealedDigest: newest.digest,
      };
      yield* c.state.write("vault", item.id, {
        [`wrap:${b.environmentId}:${c.environmentId}`]: junk as Schema.Json,
      });
      const future = { wall: 4_000_000_000_000, logical: 0, node: c.environmentId };
      yield* appendChange(c, {
        kind: "vault",
        id: item.id,
        fields: { [`wrap:${b.environmentId}:${hub.environmentId}`]: junk },
        clocks: { [`wrap:${b.environmentId}:${hub.environmentId}`]: future },
        tombstone: null,
        updatedBy: c.environmentId,
      });
      yield* settle(hub, [a, b, c]);
      expect(yield* reveal(b, item.id)).toBe("mail-password-2");
      expect(
        (yield* hub.sync.sharingStatus).peers.find((peer) => peer.environmentId === b.environmentId)
          ?.itemsShared,
      ).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("sharing one way releases nothing until the other machine shares back", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const spoke = yield* startNode(network, "Laptop");
      network.pair(hub, spoke);
      yield* share(spoke, hub);
      const { item } = yield* spoke.vault.create(login("Bank", "bank-password-1", "bank.test"));
      yield* settle(hub, [spoke]);
      // The hub holds the document but no wrap it could open with its own key.
      expect(wrapKeysFor(yield* documentOf(hub, item.id), hub.environmentId)).toEqual([]);
      expect(yield* readable(hub, item.id)).toBeUndefined();
      expect((yield* spoke.sync.sharingStatus).peers[0]).toMatchObject({
        state: "waiting_for_peer",
        peerSharing: false,
        itemsShared: 0,
      });

      yield* share(hub, spoke);
      yield* settle(hub, [spoke]);
      expect(yield* reveal(hub, item.id)).toBe("bank-password-1");
      expect((yield* spoke.sync.sharingStatus).peers[0]).toMatchObject({
        state: "shared",
        itemsShared: 1,
      });

      // When the hub stops sharing back, the spoke stops releasing to it.
      yield* hub.sync.setPeerSharing({ environmentId: spoke.environmentId, enabled: false });
      yield* settle(hub, [spoke]);
      yield* spoke.vault.update({ id: item.id, secretFields: { password: "bank-password-2" } });
      yield* settle(hub, [spoke]);
      const document = yield* documentOf(hub, item.id);
      const newest = revisionsOf(document)[0]!;
      expect(
        yield* spoke.capture.hasRevision(document, yield* recipientOf(hub), newest.digest),
      ).toBe(false);
      expect(yield* reveal(hub, item.id)).toBe("bank-password-1");
      expect((yield* spoke.sync.sharingStatus).peers[0]?.state).toBe("waiting_for_peer");
    }).pipe(Effect.scoped),
  );

  it.effect("an edit made while sharing was off survives sharing again", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const spoke = yield* startNode(network, "Laptop");
      network.pair(hub, spoke);
      yield* share(spoke, hub);
      yield* share(hub, spoke);
      const { item } = yield* spoke.vault.create(login("Bank", "bank-1"));
      yield* settle(hub, [spoke]);
      yield* spoke.sync.setPeerSharing({ environmentId: hub.environmentId, enabled: false });
      // An earlier edit on the hub, then a later rotation on the spoke while
      // it shares with nobody.
      yield* hub.vault.update({ id: item.id, secretFields: { password: "bank-from-hub-older" } });
      yield* settle(hub, [spoke]);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* spoke.vault.update({ id: item.id, secretFields: { password: "bank-rotated-newer" } });
      expect(yield* reveal(spoke, item.id)).toBe("bank-rotated-newer");
      yield* share(spoke, hub);
      yield* settle(hub, [spoke]);
      expect(yield* reveal(spoke, item.id)).toBe("bank-rotated-newer");
      expect(yield* reveal(hub, item.id)).toBe("bank-rotated-newer");
    }).pipe(Effect.scoped),
  );

  it.effect("a peer whose pinned key fails does not block writes", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      network.pair(hub, a);
      yield* share(a, hub);
      yield* share(hub, a);
      // A key pinned before low-order keys were refused.
      yield* hub.sql`UPDATE vault_peer_shares SET public_key = ${lowOrderKey}`;
      const { item } = yield* hub.vault.create(login("Any", "any-password"));
      expect(yield* reveal(hub, item.id)).toBe("any-password");
      const document = yield* documentOf(hub, item.id);
      expect(document.fields[`wrap:${hub.environmentId}:${hub.environmentId}`]).toBeDefined();
      expect(document.fields[`wrap:${a.environmentId}:${hub.environmentId}`]).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("a share is not honored once its pairing changes, before anything revokes it", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      network.pair(hub, a);
      yield* share(a, hub);
      yield* share(hub, a);
      const { item } = yield* a.vault.create(login("Cloud", "cloud-1"));
      yield* settle(hub, [a]);
      expect(yield* reveal(hub, item.id)).toBe("cloud-1");

      // A new pairing; no machine list change has reached either side.
      network.unpair(a);
      network.pair(hub, a);
      expect(yield* hub.capture.recordedShares).toHaveLength(1);
      expect(yield* hub.capture.shares).toEqual([]);
      yield* hub.vault.update({ id: item.id, secretFields: { password: "cloud-2" } });
      const document = yield* documentOf(hub, item.id);
      const newest = revisionsOf(document)[0]!;
      expect(newest.author).toBe(hub.environmentId);
      expect(yield* hub.capture.hasRevision(document, yield* recipientOf(a), newest.digest)).toBe(
        false,
      );

      // Nor does A take a revision the hub wraps for it under the old share.
      yield* sealAs(hub, item.id, forgedPayload, [yield* recipientOf(a)]);
      yield* push(hub, a, true);
      const arrived = yield* documentOf(a, item.id);
      expect((yield* readable(a, item.id))?.digest).not.toBe(revisionsOf(arrived)[0]?.digest);
    }).pipe(Effect.scoped),
  );

  it.effect("a sealed revision reveals a size bucket, not the length of a secret", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const a = yield* startNode(network, "Laptop");
      network.pair(hub, a);
      yield* share(a, hub);
      const short = (yield* a.vault.create(login("Pin", "1"))).item;
      const long = (yield* a.vault.create(login("Pin 2", "a-much-longer-password-value-42"))).item;
      yield* settle(hub, [a]);
      const lengthOf = (itemId: string) =>
        documentOf(hub, itemId).pipe(
          Effect.map(
            (document) =>
              Buffer.from(
                (document.fields[`sealed:${a.environmentId}`] as { ciphertext: string }).ciphertext,
                "base64",
              ).length,
          ),
        );
      expect(yield* lengthOf(short.id)).toBe(yield* lengthOf(long.id));
    }).pipe(Effect.scoped),
  );
});

describe("authenticated revision continuity", () => {
  it.effect(
    "ending sharing keeps the newest copied edit and never resurrects a copied delete",
    () =>
      Effect.gen(function* () {
        const network = new Network();
        const hub = yield* startNode(network, "Server");
        const spoke = yield* startNode(network, "Laptop");
        network.pair(hub, spoke);
        yield* share(spoke, hub);
        yield* share(hub, spoke);
        const { item } = yield* spoke.vault.create(login("Mail", "mail-original"));
        const removed = (yield* spoke.vault.create(login("Deleted", "delete-original"))).item;
        yield* settle(hub, [spoke]);
        yield* hub.vault.update({ id: item.id, secretFields: { password: "mail-newest" } });
        yield* hub.vault.delete({ id: removed.id });
        yield* settle(hub, [spoke]);
        yield* spoke.sync.setPeerSharing({ environmentId: hub.environmentId, enabled: false });
        yield* settle(hub, [spoke]);
        expect(yield* reveal(spoke, item.id)).toBe("mail-newest");
        expect((yield* Effect.flip(reveal(spoke, removed.id))).reason).toBe("not_found");
        yield* spoke.sync.reconcile("full");
        expect(yield* reveal(spoke, item.id)).toBe("mail-newest");
        expect((yield* Effect.flip(reveal(spoke, removed.id))).reason).toBe("not_found");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "status rejects a copied wrap for the wrong recipient and reconcile repairs fan-out",
    () =>
      Effect.gen(function* () {
        const network = new Network();
        const hub = yield* startNode(network, "Server");
        const spoke = yield* startNode(network, "Laptop");
        network.pair(hub, spoke);
        yield* share(spoke, hub);
        yield* share(hub, spoke);
        const { item } = yield* hub.vault.create(login("Mail", "mail-first"));
        yield* settle(hub, [spoke]);
        yield* hub.vault.update({ id: item.id, secretFields: { password: "mail-next" } });
        const document = yield* documentOf(hub, item.id);
        // This ciphertext is genuine and names the right revision, but opens
        // only for the hub. Shape and digest checks would count it for the spoke.
        yield* hub.state.write("vault", item.id, {
          [`wrap:${spoke.environmentId}:${hub.environmentId}`]:
            document.fields[`wrap:${hub.environmentId}:${hub.environmentId}`]!,
        });
        expect((yield* hub.sync.sharingStatus).peers[0]?.itemsShared).toBe(0);
        yield* settle(hub, [spoke]);
        expect(yield* reveal(spoke, item.id)).toBe("mail-next");
        expect((yield* hub.sync.sharingStatus).peers[0]?.itemsShared).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "each new revision sends its ciphertext, nonce and all holder wraps in one change",
    () =>
      Effect.gen(function* () {
        const network = new Network();
        const hub = yield* startNode(network, "Server");
        const a = yield* startNode(network, "Laptop");
        const b = yield* startNode(network, "Desktop");
        for (const spoke of [a, b]) {
          network.pair(hub, spoke);
          yield* share(spoke, hub);
          yield* share(hub, spoke);
        }
        const { item } = yield* hub.vault.create(login("Mail", "mail-first"));
        yield* settle(hub, [a, b]);
        const cursor = (yield* a.state.cursors(hub.environmentId)).received;
        yield* hub.vault.update({ id: item.id, secretFields: { password: "mail-next" } });
        const batch = yield* hub.state.readBatch(cursor, a.environmentId, false);
        const change = batch.changes.find((entry) => entry.fields[`sealed:${hub.environmentId}`])!;
        const sealed = change.fields[`sealed:${hub.environmentId}`];
        expect(sealed).toMatchObject({
          v: 1,
          nonce: expect.any(String),
          ciphertext: expect.any(String),
        });
        const digest = VaultCrypto.sealedDigestOf(hub.environmentId, sealed);
        for (const recipient of [hub, a, b]) {
          const key = `wrap:${recipient.environmentId}:${hub.environmentId}`;
          expect(change.fields[key]).toMatchObject({ v: 1, sealedDigest: digest });
          expect(change.clocks[key]).toEqual(change.clocks[`sealed:${hub.environmentId}`]);
        }
        yield* a.state.receive(batch, hub.environmentId, true);
        yield* a.sync.reconcile("incoming");
        expect(yield* reveal(a, item.id)).toBe("mail-next");
      }).pipe(Effect.scoped),
  );
});

describe("machine-only rules", () => {
  it.effect("collect local integration references and machine-only account credentials", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO integrations(id, name, payload_json, deleted_at, updated_at) VALUES ('i1', 'local', ${JSON.stringify({ transport: "local", auth: { type: "oauth", clientSecret: "{{credential:Client.password}}" } })}, NULL, 'now'), ('i2', 'remote', ${JSON.stringify({ transport: "http", headers: { A: "{{credential:Remote.value}}" } })}, NULL, 'now'), ('i3', 'gone', ${JSON.stringify({ transport: "local", headers: { A: "{{credential:Gone.value}}" } })}, 'then', 'now')`;
      yield* sql`INSERT INTO accounts(id, scope_project_id, payload_json) VALUES ('account:1', NULL, ${JSON.stringify(
        {
          credentials: [
            { id: "c1", vaultItemId: "vault:pinned", portability: "machine" },
            { id: "c2", vaultItemId: "vault:roams", portability: "shared" },
          ],
        },
      )})`;
      const rules = yield* loadMachineOnlyRules();
      expect([...rules.localIntegrationItems].toSorted()).toEqual([
        "Client",
        LOCAL_GOOGLE_CLIENT_ITEM,
      ]);
      expect([...rules.machineCredentialItems]).toEqual(["vault:pinned"]);
      const of = (id: string, name: string, portability = "shared") =>
        effectivePortability({ id, name, portability }, rules);
      expect(of("vault:1", "Client")).toEqual({
        portability: "machine",
        reason: "local_integration",
      });
      expect(of("vault:pinned", "Other")).toEqual({
        portability: "machine",
        reason: "machine_credential",
      });
      expect(of("vault:roams", "Remote")).toEqual({ portability: "shared" });
      expect(of("vault:2", "Remote", "machine")).toEqual({ portability: "machine" });
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)))),
  );
});
