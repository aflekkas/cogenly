/**
 * Paired machines in one process for vault sync tests: each machine has its
 * own in-memory database, vault key and VaultSync, and documents move only
 * when a test calls `settle`.
 */
import {
  AuthSyncReplicateScope,
  EnvironmentId,
  type MachineInfo,
  type MachineListResult,
  PeerCallError,
  VaultPeerKey,
} from "@cogenly/contracts";
import { expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeCrypto } from "@effect/platform-node";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Machines from "../machines/Machines.ts";
import * as PeerChannels from "../machines/PeerChannels.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SharedState from "../sync/SharedState.ts";
import * as Vault from "./Vault.ts";
import * as VaultSync from "./VaultSync.ts";
import * as VaultSyncCapture from "./VaultSyncCapture.ts";

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
 * Who is whose hub, and each machine's peer channels, so `Machines.call`
 * reaches the other machine's real handlers over a direct link only, like the
 * authenticated socket.
 */
export class Network {
  readonly names = new Map<string, string>();
  readonly hubOf = new Map<string, { readonly hub: string; readonly pairedAt: number }>();
  readonly channels = new Map<string, PeerChannels.PeerChannels["Service"]>();
  private pairings = 0;

  pair(hub: VaultNode, spoke: VaultNode) {
    this.hubOf.set(spoke.environmentId, {
      hub: hub.environmentId,
      pairedAt: 1_700_000_000_000 + ++this.pairings,
    });
  }
  unpair(spoke: VaultNode) {
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

export const startNode = Effect.fn("startVaultNode")(function* (network: Network, name: string) {
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
  const layer = VaultSync.layer.pipe(
    Layer.provideMerge(Vault.layer),
    Layer.provideMerge(VaultSyncCapture.layer),
    Layer.provideMerge(SharedState.layer),
    Layer.provideMerge(PeerChannels.layer),
    Layer.provideMerge(Layer.succeed(Machines.Machines, network.machines(environmentId))),
    Layer.provideMerge(base),
  );
  const context = (yield* Layer.build(layer)) as Context.Context<Layer.Success<typeof layer>>;
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context);
  network.channels.set(environmentId, yield* run(PeerChannels.PeerChannels));
  return {
    name,
    environmentId,
    context,
    run,
    vault: yield* run(Vault.Vault),
    sync: yield* run(VaultSync.VaultSync),
    state: yield* run(SharedState.SharedState),
    capture: yield* run(VaultSyncCapture.VaultSyncCapture),
    machines: yield* run(Machines.Machines),
    sql: yield* run(SqlClient.SqlClient),
  };
});
export type VaultNode = Effect.Success<ReturnType<typeof startNode>>;

/** One direction of a SharedSync pass: a spoke sends only its own changes; the hub relays. */
export const push = (from: VaultNode, to: VaultNode, toIsSpoke: boolean) =>
  Effect.gen(function* () {
    while (true) {
      const after = (yield* to.state.cursors(from.environmentId)).received;
      const batch = yield* from.state.readBatch(after, to.environmentId, !toIsSpoke);
      if (batch.cursor === batch.after) return;
      yield* to.state.receive(batch, from.environmentId, toIsSpoke);
    }
  });

/** Exchange documents and reconcile until every machine has what it can get. */
export const settle = (hub: VaultNode, spokes: ReadonlyArray<VaultNode>) =>
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

export const share = (from: VaultNode, to: VaultNode) =>
  from.sync.setPeerSharing({ environmentId: to.environmentId, enabled: true });

/** Every string stored in any table of the machine's database. */
export const storedText = (node: VaultNode) =>
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
export const expectAbsent = (haystack: string, values: ReadonlyArray<string>) => {
  for (const needle of needles(values)) expect(haystack).not.toContain(needle);
};
