import {
  AuthAccessWriteScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
  type MachineJoinCode,
  type MachineJoinHubInput,
  type MachineListResult,
  type MachineSetupStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  createMachinePairingCommand,
  MachinePairingRefusedError,
  pairMachines,
  type MachinePairingHub,
  type MachinePairingSpoke,
} from "./pairMachines.ts";

vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const session = (canManageAccess: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: canManageAccess ? [AuthAccessWriteScope] : [],
  permissions: canManageAccess ? [AuthAccessWriteScope] : [],
});

const HUB = EnvironmentId.make("hub-environment");
const SPOKE = EnvironmentId.make("spoke-environment");
const NOW = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");

const status = (ready: boolean): MachineSetupStatus => ({
  observedAt: NOW,
  platform: "darwin",
  tailscale: {
    installed: true,
    version: "1.80.0",
    running: true,
    signedIn: true,
    tailnetName: "example.ts.net",
    magicDnsName: "hub.example.ts.net",
    httpsEnabled: true,
    served: ready,
    servePort: 443,
  },
  steps: [],
  ready,
  joinUrl: ready ? "https://hub.example.ts.net" : null,
  problem: null,
});

const CODE: MachineJoinCode = {
  grant: "one-time-grant-secret",
  hubEnvironmentId: HUB,
  hubName: "Studio",
  hubPublicKey: "-----BEGIN PUBLIC KEY-----",
  routes: ["https://hub.example.ts.net"],
  expiresAt: NOW,
};

const JOINED: MachineListResult = {
  machines: [],
  link: {
    _tag: "spoke",
    hubEnvironmentId: HUB,
    status: "connecting",
    route: null,
    lastError: null,
  },
};

/** Both sides of a pairing, recording each call in order. */
function machines(options: { readonly hubReady?: boolean; readonly spokeId?: EnvironmentId } = {}) {
  const calls: Array<string> = [];
  const joins: Array<MachineJoinHubInput> = [];
  const spokeId = options.spokeId ?? SPOKE;
  const hub: MachinePairingHub<never, never> = {
    environmentId: HUB,
    name: "Studio",
    setupStatus: Effect.sync(() => {
      calls.push("hub.setupStatus");
      return status(options.hubReady ?? true);
    }),
    createPeerGrant: (input) =>
      Effect.sync(() => {
        calls.push(`hub.createPeerGrant:${input.spokeKeyThumbprint}:${input.spokeName}`);
        return CODE;
      }),
  };
  const spoke: MachinePairingSpoke<never, never> = {
    environmentId: spokeId,
    prepareJoin: Effect.sync(() => {
      calls.push("spoke.prepareJoin");
      return { environmentId: spokeId, name: "MacBook", keyThumbprint: "spoke-thumbprint" };
    }),
    joinHub: (input) =>
      Effect.sync(() => {
        calls.push("spoke.joinHub");
        joins.push(input);
        return JOINED;
      }),
  };
  return { hub, spoke, calls, joins };
}

describe("pairMachines", () => {
  it.effect("prepares the spoke, grants on the hub, then joins with the code untouched", () =>
    Effect.gen(function* () {
      const { hub, spoke, calls, joins } = machines();
      const result = yield* pairMachines(hub, spoke);
      expect(result).toBe(JOINED);
      expect(calls).toEqual([
        "hub.setupStatus",
        "spoke.prepareJoin",
        "hub.createPeerGrant:spoke-thumbprint:MacBook",
        "spoke.joinHub",
      ]);
      expect(joins).toHaveLength(1);
      expect(joins[0]?.code).toBe(CODE);
      expect(joins[0]?.hubUrls).toEqual([]);
    }),
  );

  it.effect("refuses before any grant when the hub is not ready", () =>
    Effect.gen(function* () {
      const { hub, spoke, calls } = machines({ hubReady: false });
      const error = yield* Effect.flip(pairMachines(hub, spoke));
      expect(error).toBeInstanceOf(MachinePairingRefusedError);
      expect(error).toMatchObject({ reason: "hub-not-ready", hubName: "Studio" });
      expect(error.message).toBe("Studio isn't ready for pairing yet. Finish its steps first.");
      expect(calls).toEqual(["hub.setupStatus"]);
    }),
  );

  it.effect("refuses to pair a machine with itself without calling either side", () =>
    Effect.gen(function* () {
      const { hub, spoke, calls } = machines({ spokeId: HUB });
      const error = yield* Effect.flip(pairMachines(hub, spoke));
      expect(error).toMatchObject({ _tag: "MachinePairingRefusedError", reason: "same-machine" });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("refuses when two connections turn out to reach the same server", () =>
    Effect.gen(function* () {
      const { hub, spoke, calls } = machines();
      const sameServer: MachinePairingSpoke<never, never> = {
        ...spoke,
        prepareJoin: spoke.prepareJoin.pipe(
          Effect.map((identity) => ({ ...identity, environmentId: HUB })),
        ),
      };
      const error = yield* Effect.flip(pairMachines(hub, sameServer));
      expect(error).toMatchObject({ reason: "same-machine" });
      expect(calls).toEqual(["hub.setupStatus", "spoke.prepareJoin"]);
    }),
  );
});

describe("createMachinePairingCommand", () => {
  it.effect("authorizes each request against the machine it goes to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hub, spoke, calls } = machines();
        const client = (environmentId: EnvironmentId) =>
          environmentId === HUB
            ? {
                [WS_METHODS.machinesSetupStatus]: () => hub.setupStatus,
                [WS_METHODS.machinesCreatePeerGrant]: hub.createPeerGrant,
              }
            : {
                [WS_METHODS.machinesPrepareJoin]: () => spoke.prepareJoin,
                [WS_METHODS.machinesJoinHub]: spoke.joinHub,
              };
        const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
        for (const environmentId of [HUB, SPOKE]) {
          supervisors.set(environmentId, {
            target: { environmentId, label: environmentId },
            session: yield* SubscriptionRef.make(Option.some({ client: client(environmentId) })),
          } as unknown as EnvironmentSupervisor["Service"]);
        }
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry, {
            run: (environmentId, effect) =>
              effect.pipe(
                Effect.provideService(EnvironmentSupervisor, supervisors.get(environmentId)!),
              ),
          } as EnvironmentRegistry["Service"]),
        );
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        registry.mount(sessions(HUB));
        registry.mount(sessions(SPOKE));
        const command = createMachinePairingCommand(runtime);
        const target = {
          environmentId: SPOKE,
          input: { hubEnvironmentId: HUB, hubName: "Studio" },
        };

        registry.set(sessions(SPOKE), AsyncResult.success(session(true)));
        registry.set(sessions(HUB), AsyncResult.success(session(false)));
        expect(registry.get(command.permissionAtom(SPOKE))).toBe(true);
        expect(registry.get(command.permissionAtom(HUB))).toBe(false);
        const denied = yield* Effect.promise(() => command.run(registry, target));
        expect(denied._tag).toBe("Failure");
        if (denied._tag === "Failure") {
          expect(Cause.squash(denied.cause)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredScope: AuthAccessWriteScope,
          });
        }
        expect(calls).toEqual([]);

        registry.set(sessions(HUB), AsyncResult.success(session(true)));
        const paired = yield* Effect.promise(() => command.run(registry, target));
        expect(paired).toMatchObject({ _tag: "Success", value: JOINED });
        expect(calls).toEqual([
          "hub.setupStatus",
          "spoke.prepareJoin",
          "hub.createPeerGrant:spoke-thumbprint:MacBook",
          "spoke.joinHub",
        ]);
      }),
    ),
  );
});
