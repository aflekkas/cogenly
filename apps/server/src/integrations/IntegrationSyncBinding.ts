import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Machines from "../machines/Machines.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as VaultSync from "../vault/VaultSync.ts";
import * as VaultSyncCapture from "../vault/VaultSyncCapture.ts";
import * as Integrations from "./Integrations.ts";
import { IntegrationSyncPeers, signInPeers } from "./IntegrationSyncPeers.ts";

/**
 * Gives Integrations the paired-machine view, and has the refresh owner
 * renew shared sign-ins before they expire, so no other machine needs to.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const peers = yield* IntegrationSyncPeers;
    const integrations = yield* Integrations.Integrations;
    yield* peers.bind(
      signInPeers({
        self: peers.self,
        machines: yield* Machines.Machines,
        vaultSync: yield* VaultSync.VaultSync,
        capture: yield* VaultSyncCapture.VaultSyncCapture,
      }),
    );
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("integration-sign-in-refresh", integrations.refreshSharedSignIns);
  }),
);
