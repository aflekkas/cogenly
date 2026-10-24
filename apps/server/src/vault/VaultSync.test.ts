import {
  AuthSyncReplicateScope,
  EnvironmentId,
  type MachineInfo,
  type MachineListResult,
  PeerCallError,
  type SharedDocumentChange,
  ThreadId,
  VaultItemId,
  VaultPeerKey,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SharedState from "../sync/SharedState.ts";
import { compareClock } from "../sync/merge.ts";
import * as Vault from "./Vault.ts";
import * as VaultCrypto from "./VaultCrypto.ts";
import * as VaultSync from "./VaultSync.ts";
import * as VaultSyncCapture from "./VaultSyncCapture.ts";
import {
  LOCAL_GOOGLE_CLIENT_ITEM,
  effectivePortability,
  loadMachineOnlyRules,
} from "./vaultPortability.ts";

const memoryStore = () => {
  const values = new Map<string, Uint8Array>();
  return Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) =>
      Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) =>
      values.has(name)
        ? Effect.die(new Error("exists"))
        : Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        if (!values.has(name)) values.set(name, new Uint8Array(bytes).fill(7));
        return values.get(name)!;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  } as ServerSecretStore.ServerSecretStore["Service"]);
};

/**
 * Paired machines in one process: who is whose hub, and each machine's peer
 * channels, so `Machines.call` reaches the other machine's real handlers over
 * a direct link only, like the authenticated socket.
 */
class Network {
  readonly names = new Map<string, string>();
  readonly hubOf = new Map<string, { readonly hub: string; readonly pairedAt: number }>();
  readonly channels = new Map<string, PeerChannels.PeerChannels["Service"]>();
  private pairings = 0;

  pair(hub: Node, spoke: Node) {
    this.hubOf.set(spoke.environmentId, {
      hub: hub.environmentId,
      pairedAt: 1_700_000_000_000 + ++this.pairings,
    });
  }
  unpair(spoke: Node) {
    this.hubOf.delete(spoke.environmentId);
  }
  direct(a: string, b: string) {
    return this.hubOf.get(a)?.hub === b || this.hubOf.get(b)?.hub === a;
  }
  private info(id: string, relation: MachineInfo["relation"], pairedAt: number | null) {
    return {
      environmentId: EnvironmentId.make(id),
      name: this.names.get(id)!,
      kind: relation === "this" ? "this-computer" : "other-computer",
      hardware: "laptop",
      platform: "darwin",
      relation,
      online: true,
      lastSeenAt: null,
      pairedAt: pairedAt === null ? null : DateTime.makeUnsafe(pairedAt),
      pairing: relation === "this" ? "self" : "paired",
      providers: [],
    } satisfies MachineInfo;
  }
  view(self: string): MachineListResult {
    const link = this.hubOf.get(self);
    if (link)
      return {
        machines: [
          this.info(self, "this", null),
          this.info(link.hub, "hub", link.pairedAt),
          ...[...this.hubOf]
            .filter(([spoke, other]) => other.hub === link.hub && spoke !== self)
            .map(([spoke, other]) => this.info(spoke, "peer", other.pairedAt)),
        ],
        link: {
          _tag: "spoke",
          hubEnvironmentId: EnvironmentId.make(link.hub),
          status: "online",
          route: null,
          lastError: null,
        },
      };
    const spokes = [...this.hubOf].filter(([, other]) => other.hub === self);
    return {
      machines: [
        this.info(self, "this", null),
        ...spokes.map(([spoke, other]) => this.info(spoke, "spoke", other.pairedAt)),
      ],
      link: spokes.length > 0 ? { _tag: "hub", spokes: spokes.length } : { _tag: "standalone" },
    };
  }
  machines(self: string): Machines.Machines["Service"] {
    const channels = this.channels;
    const direct = (a: string, b: string) => this.direct(a, b);
    const call = (
      target: string,
      channel: typeof VaultPeerKey,
      payload: typeof VaultPeerKey.payload.Type,
    ) =>
      Effect.gen(function* () {
        const remote = channels.get(target);
        if (!direct(self, target) || remote === undefined)
          return yield* new PeerCallError({ channel: channel.name, reason: "offline" });
        const encoded = yield* PeerChannels.encodePeerPayload(channel, payload);
        const reply = yield* remote.dispatch({
          channel: channel.name,
          payload: encoded,
          caller: { environmentId: EnvironmentId.make(self), scopes: [AuthSyncReplicateScope] },
        });
        return yield* PeerChannels.decodePeerResult(channel, reply);
      });
    return {
      list: Effect.sync(() => this.view(self)),
      subscribe: Stream.never,
      update: () => Effect.die("unused"),
      prepareJoin: Effect.die("unused"),
      createPeerGrant: () => Effect.die("unused"),
      joinHub: () => Effect.die("unused"),
      unpair: () => Effect.die("unused"),
      // Only vault channels are exercised here; the cast stands in for the generic signature.
      call: call as unknown as Machines.Machines["Service"]["call"],
    };
  }
}

const startNode = Effect.fn("startVaultNode")(function* (network: Network, name: string) {
  const environmentId = EnvironmentId.make(`env-${name.toLowerCase()}`);
  network.names.set(environmentId, name);
  const base = Layer.mergeAll(
    Sqlite.layerMemory.pipe(Layer.provide(NodeServices.layer)),
    NodeServices.layer,
    NodeCrypto.layer,
    memoryStore(),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  );
  // Explicit reconcile passes in tests, never a background stream.
  const quietState = Layer.effect(
    SharedState.SharedState,
    SharedState.SharedState.pipe(Effect.map((state) => ({ ...state, changes: Stream.never }))),
  ).pipe(Layer.provide(SharedState.layer));
  const layer = VaultSync.layer.pipe(
    Layer.provideMerge(Vault.layer),
    Layer.provideMerge(VaultSyncCapture.layer),
    Layer.provideMerge(quietState),
    Layer.provideMerge(PeerChannels.layer),
    Layer.provideMerge(Layer.succeed(Machines.Machines, network.machines(environmentId))),
    Layer.provideMerge(base),
  );
  const context = yield* Layer.build(layer);
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideContext(effect, context as Context.Context<Layer.Success<typeof layer>>);
  network.channels.set(environmentId, yield* run(PeerChannels.PeerChannels));
  return {
    name,
    environmentId,
    run,
    vault: yield* run(Vault.Vault),
    sync: yield* run(VaultSync.VaultSync),
    state: yield* run(SharedState.SharedState),
    capture: yield* run(VaultSyncCapture.VaultSyncCapture),
    sql: yield* run(SqlClient.SqlClient),
  };
});
type Node = Effect.Success<ReturnType<typeof startNode>>;

/** One direction of a SharedSync pass: a spoke sends only its own changes; the hub relays. */
const push = (from: Node, to: Node, toIsSpoke: boolean) =>
  Effect.gen(function* () {
    while (true) {
      const after = (yield* to.state.cursors(from.environmentId)).received;
      const batch = yield* from.state.readBatch(after, to.environmentId, !toIsSpoke);
      if (batch.cursor === batch.after) return;
      yield* to.state.receive(batch, from.environmentId, toIsSpoke);
    }
  });

/** Exchange documents and reconcile until every machine has what it can get. */
const settle = (hub: Node, spokes: ReadonlyArray<Node>) =>
  Effect.gen(function* () {
    for (let round = 0; round < 3; round++) {
      for (const spoke of spokes) yield* push(spoke, hub, false);
      yield* hub.sync.reconcile("incoming");
      for (const spoke of spokes) {
        yield* push(hub, spoke, true);
        yield* spoke.sync.reconcile("incoming");
      }
    }
  });

const share = (from: Node, to: Node) =>
  from.sync.setPeerSharing({ environmentId: to.environmentId, enabled: true });

const reveal = (node: Node, itemId: VaultItemId, field: "password" | "username" = "password") =>
  node.vault
    .use({ itemId, field, caller: { kind: "human" } })
    .pipe(Effect.map((result) => (result.status === "allowed" ? result.value : result.status)));

const changeCount = (node: Node) =>
  node.sql<{ count: number }>`SELECT COUNT(*) AS count FROM shared_changes`.pipe(
    Effect.map((rows) => rows[0]!.count),
  );

/** Every string stored in any table of the machine's database. */
const storedText = (node: Node) =>
  Effect.gen(function* () {
    const tables = yield* node.sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
    const values: Array<string> = [];
    for (const { name } of tables) {
      const columns = yield* node.sql.unsafe<{ name: string; type: string }>(
        `PRAGMA table_info("${name}")`,
      );
      if (!columns.some((column) => column.type.toUpperCase().includes("TEXT"))) continue;
      for (const row of yield* node.sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`))
        for (const value of Object.values(row)) if (typeof value === "string") values.push(value);
    }
    return values.join("\n");
  });

const needles = (values: ReadonlyArray<string>) =>
  values.flatMap((value) => [value, Buffer.from(value).toString("base64")]);
const expectAbsent = (haystack: string, values: ReadonlyArray<string>) => {
  for (const needle of needles(values)) expect(haystack).not.toContain(needle);
};

const login = (name: string, password: string, domain = "github.com") => ({
  name,
  type: "login" as const,
  allowedDomains: [domain],
  secretFields: { username: `${name}-user`, password },
});

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

        yield* spoke.vault.delete({ id: item.id });
        yield* settle(hub, [spoke]);
        expect((yield* hub.vault.list({})).items).toEqual([]);
        expect((yield* Effect.flip(reveal(hub, item.id))).reason).toBe("not_found");
        expect((yield* hub.state.get("vault", item.id))?.tombstone).not.toBeNull();
      }).pipe(Effect.scoped),
  );

  it.effect("a hub that does not share relays items it cannot read, and cannot forge them", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const spoke = yield* startNode(network, "Laptop");
      const other = yield* startNode(network, "Desktop");
      network.pair(hub, spoke);
      network.pair(hub, other);
      // Both spokes trust the hub; the hub has not agreed to hold anything.
      yield* share(spoke, hub);
      yield* share(other, hub);
      const { item } = yield* spoke.vault.create(login("Bank", "bank-password-1", "bank.test"));
      yield* settle(hub, [spoke, other]);

      expect(yield* hub.state.get("vault", item.id)).toBeDefined();
      expect((yield* hub.vault.list({})).items).toEqual([]);
      expect((yield* hub.sync.sharingStatus).itemsWaiting).toBe(1);
      expect((yield* other.vault.list({})).items).toEqual([]);
      expect((yield* other.sync.sharingStatus).itemsWaiting).toBe(1);
      // Nothing about the item is readable on the hub, its name and domain included.
      const hubText = yield* storedText(hub);
      expectAbsent(hubText, ["bank-password-1", "Bank-user", "bank.test"]);
      expect(hubText).not.toMatch(/"name":"Bank"/);

      // The hub writes its own content under a newer clock and a wrap that
      // claims to be the spoke's own: the spoke keeps what it had.
      const hubKeys = yield* hub.capture.keyPair;
      const spokeKeys = yield* spoke.capture.keyPair;
      yield* hub.state.writeBuilt("vault", item.id, (clock) =>
        Effect.sync(() => {
          const dataKey = VaultCrypto.randomDataKey();
          const sealed = VaultCrypto.sealVaultPayload({
            dataKey,
            plaintext: JSON.stringify({
              name: "Bank",
              type: "login",
              scopeProjectId: null,
              allowedDomains: ["evil.test"],
              secretFields: { password: "forged-password" },
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
            itemId: item.id,
            author: hub.environmentId,
            clock,
          });
          const forged = VaultCrypto.wrapVaultDataKey({
            dataKey,
            itemId: item.id,
            sealed,
            by: spoke.environmentId,
            senderPrivateKey: hubKeys.privateKey,
            recipient: spoke.environmentId,
            recipientPublicKey: spokeKeys.publicKey,
          });
          return {
            sealed: sealed as unknown as Schema.Json,
            [`wrap:${spoke.environmentId}`]: forged as unknown as Schema.Json,
          };
        }),
      );
      yield* settle(hub, [spoke, other]);
      expect(yield* reveal(spoke, item.id)).toBe("bank-password-1");
      expect((yield* spoke.vault.getMetadata(item.id)).allowedDomains).toEqual(["bank.test"]);
      expect((yield* spoke.sync.sharingStatus).itemsWaiting).toBe(1);
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
      const wrap = (yield* hub.state.get("vault", item.id))?.fields[`wrap:${b.environmentId}`];
      expect(wrap).toMatchObject({ by: hub.environmentId });
      expect((yield* hub.sync.sharingStatus).peers.map((peer) => peer.itemsShared)).toEqual([1, 1]);

      // An edit on B travels back through the hub to A.
      yield* b.vault.update({ id: item.id, secretFields: { password: "mail-password-2" } });
      yield* settle(hub, [a, b]);
      expect(yield* reveal(a, item.id)).toBe("mail-password-2");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "concurrent edits converge on the newest; a delete wins; colliding names are renamed",
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
        const spokeClock = (yield* spoke.state.get("vault", item.id))!.clocks.sealed!;
        const hubClock = (yield* hub.state.get("vault", item.id))!.clocks.sealed!;
        const winner = compareClock(spokeClock, hubClock) > 0 ? "from-spoke" : "from-hub";
        yield* settle(hub, [spoke]);
        expect(yield* reveal(hub, item.id)).toBe(winner);
        expect(yield* reveal(spoke, item.id)).toBe(winner);
        expect(yield* hub.state.get("vault", item.id)).toEqual(
          yield* spoke.state.get("vault", item.id),
        );

        yield* spoke.vault.delete({ id: item.id });
        yield* hub.vault.update({ id: item.id, secretFields: { password: "after-delete" } });
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
      const document = (yield* hub.state.get("vault", item.id))!;
      const digest = VaultCrypto.sealedDigestOf(document.fields.sealed);
      expect(document.fields[`wrap:${b.environmentId}`]).not.toMatchObject({
        sealedDigest: digest,
      });

      // Pairing again is a new pairing: B gets the documents but not the key.
      network.pair(hub, b);
      yield* settle(hub, [a, b]);
      expect(yield* reveal(b, item.id)).toBe("cloud-1");
      expect((yield* b.sync.sharingStatus).itemsWaiting).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps what a newer build added: payload keys, document fields and wraps", () =>
    Effect.gen(function* () {
      const network = new Network();
      const hub = yield* startNode(network, "Server");
      const spoke = yield* startNode(network, "Laptop");
      network.pair(hub, spoke);
      yield* share(spoke, hub);
      yield* share(hub, spoke);
      const { item } = yield* spoke.vault.create(login("Future", "future-1"));
      yield* settle(hub, [spoke]);

      // The hub, as a newer build, seals a payload key and adds a document
      // field and a wrap for a machine this build has never seen.
      const hubKeys = yield* hub.capture.keyPair;
      const spokeKeys = yield* spoke.capture.keyPair;
      const current = (yield* hub.capture.open((yield* hub.state.get("vault", item.id))!)) as {
        readonly raw: Record<string, Schema.Json>;
      };
      yield* hub.state.writeBuilt("vault", item.id, (clock) =>
        Effect.sync(() => {
          const dataKey = VaultCrypto.randomDataKey();
          const sealed = VaultCrypto.sealVaultPayload({
            dataKey,
            plaintext: JSON.stringify({ ...current.raw, futureKey: { kept: true } }),
            itemId: item.id,
            author: hub.environmentId,
            clock,
          });
          const wrap = (recipient: string, publicKey: string) =>
            VaultCrypto.wrapVaultDataKey({
              dataKey,
              itemId: item.id,
              sealed,
              by: hub.environmentId,
              senderPrivateKey: hubKeys.privateKey,
              recipient,
              recipientPublicKey: publicKey,
            }) as unknown as Schema.Json;
          return {
            sealed: sealed as unknown as Schema.Json,
            [`wrap:${hub.environmentId}`]: wrap(hub.environmentId, hubKeys.publicKey),
            [`wrap:${spoke.environmentId}`]: wrap(spoke.environmentId, spokeKeys.publicKey),
            "wrap:env-future": wrap("env-future", VaultCrypto.generateKeyPair().publicKey),
          };
        }),
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

      // An edit on this build keeps all of it.
      yield* spoke.vault.update({ id: item.id, secretFields: { password: "future-2" } });
      yield* settle(hub, [spoke]);
      const document = (yield* hub.state.get("vault", item.id))!;
      expect(document.fields.futureField).toEqual({ v: 9 });
      expect(document.fields["wrap:env-future"]).toBeDefined();
      expect(document.fields.sealed).toMatchObject({ author: spoke.environmentId });
      const opened = yield* hub.capture.open(document);
      expect(opened._tag).toBe("opened");
      if (opened._tag === "opened") {
        expect(opened.raw.futureKey).toEqual({ kept: true });
        expect(opened.payload.secretFields.password).toBe("future-2");
      }
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

  it.effect("enabling needs a direct online peer and refuses a changed key", () =>
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
