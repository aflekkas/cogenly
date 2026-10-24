// @effect-diagnostics nodeBuiltinImport:off -- The test serves real loopback HTTP and proxies TCP to drop sockets.

import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { type MachineRole, type MachineSelfReport } from "@cogenly/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";

import * as Duration from "effect/Duration";

import * as Layer from "effect/Layer";

import * as Stream from "effect/Stream";

import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HubLink from "./HubLink.ts";

import * as MachineIdentity from "./MachineIdentity.ts";
import * as Machines from "./Machines.ts";
import * as PeerChannels from "./PeerChannels.ts";
import * as PeerHttp from "./peerHttp.ts";
import * as PeerHub from "./PeerHub.ts";

interface MachineOverrides {
  readonly secrets?: (
    secrets: ServerSecretStore.ServerSecretStore["Service"],
  ) => ServerSecretStore.ServerSecretStore["Service"];
  readonly fetch?: typeof globalThis.fetch;
  readonly crypto?: (crypto: Crypto.Crypto) => Crypto.Crypto;
  readonly auth?: (
    auth: EnvironmentAuth.EnvironmentAuth["Service"],
  ) => EnvironmentAuth.EnvironmentAuth["Service"];
}

const layerIdentity = (name: string, role: MachineRole) =>
  Layer.effect(
    MachineIdentity.MachineIdentity,
    Effect.gen(function* () {
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const report: MachineSelfReport = {
        environmentId: yield* environment.getEnvironmentId,
        name,
        role,
        hardware: role === "cloud-server" ? "server" : "laptop",
        platform: role === "cloud-server" ? "linux" : "darwin",
        serverVersion: "0.0.0-test",
        providers: [],
      };
      return MachineIdentity.MachineIdentity.of({
        self: Effect.succeed(report),
        update: () => Effect.void,
        changes: Stream.never,
      });
    }),
  );

/**
 * One Cogenly server: its own in-memory database, secrets directory,
 * environment id and keys, serving the `/peer` routes on a loopback port.
 * Redials are immediate so reconnects need no clock; a refused or untrusted
 * hub is retried only after an hour, so the status it settles on holds.
 */
const machineLayer = (
  name: string,
  role: MachineRole,
  socketConstructor?: Socket.WebSocketConstructor["Service"],
  overrides: MachineOverrides = {},
) => {
  const infra = Layer.mergeAll(
    SqlitePersistence.layerMemory,
    Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        return overrides.secrets?.(secrets) ?? secrets;
      }),
    ).pipe(Layer.provide(ServerSecretStore.layer)),
    ServerEnvironment.layerIdentity,
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: `cogenly-machine-${name}-` }),
    ),
  );
  const machines = Machines.layer.pipe(
    Layer.provideMerge(HubLink.layer),
    Layer.provideMerge(PeerHub.layer),
    Layer.provideMerge(PeerChannels.layer),
    Layer.provideMerge(layerIdentity(name, role)),
    Layer.provideMerge(
      Layer.effect(
        EnvironmentAuth.EnvironmentAuth,
        Effect.gen(function* () {
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          return overrides.auth?.(auth) ?? auth;
        }),
      ).pipe(Layer.provideMerge(EnvironmentAuth.layer)),
    ),
    Layer.provideMerge(infra),
    Layer.provide(
      Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, overrides.fetch ?? globalThis.fetch)),
    Layer.provide(
      Layer.effect(
        Crypto.Crypto,
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          return overrides.crypto?.(crypto) ?? crypto;
        }),
      ),
    ),
    Layer.provide(
      socketConstructor === undefined
        ? Socket.layerWebSocketConstructorGlobal
        : Layer.succeed(Socket.WebSocketConstructor, socketConstructor),
    ),
    Layer.provide(
      Layer.succeed(HubLink.HubLinkRetry, {
        base: Duration.zero,
        max: Duration.zero,
        refused: Duration.hours(1),
      }),
    ),
  );
  return HttpRouter.serve(PeerHttp.layer, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provideMerge(
      NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
    ),
    Layer.provideMerge(machines),
    Layer.provideMerge(NodeServices.layer),
  );
};

type MachineContext = Layer.Success<ReturnType<typeof machineLayer>>;

export const startMachine = Effect.fn("startMachine")(function* (
  name: string,
  role: MachineRole,
  socketConstructor?: Socket.WebSocketConstructor["Service"],
  overrides: MachineOverrides = {},
) {
  const context = yield* Layer.build(machineLayer(name, role, socketConstructor, overrides));
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideContext(effect, context as Context.Context<MachineContext>);
  const server = yield* run(HttpServer.HttpServer);
  const address = server.address;
  if (!("port" in address)) return yield* Effect.die("expected a TCP address");
  const machines = yield* run(Machines.Machines);
  const hubLink = yield* run(HubLink.HubLink);
  const self = yield* run(
    MachineIdentity.MachineIdentity.pipe(Effect.flatMap((identity) => identity.self)),
  );
  return {
    run,
    machines,
    hubLink,
    environmentId: self.environmentId,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/`,
  };
});
export type Machine = Effect.Success<ReturnType<typeof startMachine>>;

/** Pull link states until one matches; each pull waits for the next change. */
export const awaitLinkState = (
  machine: Machine,
  predicate: (state: Omit<HubLink.HubLinkView, "link">) => boolean,
) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(machine.hubLink.states);
    while (true) {
      const states = yield* pull.pipe(Effect.orDie);
      const match = states.find(predicate);
      if (match !== undefined) return match;
    }
  }).pipe(Effect.scoped);

export const pair = Effect.fn("pair")(function* (hub: Machine, spoke: Machine, hubUrl = hub.url) {
  const identity = yield* spoke.machines.prepareJoin;
  const code = yield* hub.machines.createPeerGrant({
    spokeKeyThumbprint: identity.keyThumbprint,
    spokeName: identity.name,
  });
  yield* spoke.machines.joinHub({ hubUrls: [hubUrl], code });
  yield* awaitLinkState(spoke, (state) => state.status === "online");
});

/** A TCP relay in front of a machine, so a test can cut every socket through it. */
export const startProxy = (target: Machine) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly dropAll: Effect.Effect<void>;
      readonly stallAll: Effect.Effect<void>;
      readonly server: NodeNet.Server;
    }>((resume) => {
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer((client) => {
        const upstream = NodeNet.connect(target.port, "127.0.0.1");
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
          socket.on("error", () => socket.destroy());
        }
        client.pipe(upstream).pipe(client);
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as NodeNet.AddressInfo;
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${address.port}/`,
            server,
            dropAll: Effect.sync(() => {
              for (const socket of sockets) socket.destroy();
            }),
            stallAll: Effect.sync(() => {
              for (const socket of sockets) socket.pause();
            }),
          }),
        );
      });
    }),
    ({ server }) => Effect.sync(() => server.close()),
  );
