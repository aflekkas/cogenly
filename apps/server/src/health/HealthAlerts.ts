/**
 * HealthAlerts: turns machine health into alerts on state transitions only,
 * debounced, for this machine and the machines it is paired with. Clients
 * subscribe to the snapshot; optional Slack and email channels go through
 * Cogenly integrations.
 */
import {
  MachineHealthError,
  type MachineHealthAlertsSnapshot,
  type MachineHealthChannelTestResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export class HealthAlerts extends Context.Service<
  HealthAlerts,
  {
    readonly snapshot: Effect.Effect<MachineHealthAlertsSnapshot>;
    /** The snapshot, then again after each transition. */
    readonly subscribe: Stream.Stream<MachineHealthAlertsSnapshot>;
    /** Send a test message through each enabled external channel. */
    readonly testChannels: Effect.Effect<MachineHealthChannelTestResult, MachineHealthError>;
  }
>()("cogenly-server/health/HealthAlerts") {}

// TODO(health-alerts): replaced by the real implementation.
const empty: MachineHealthAlertsSnapshot = { open: [], recentlyResolved: [] };
export const layer = Layer.succeed(
  HealthAlerts,
  HealthAlerts.of({
    snapshot: Effect.succeed(empty),
    subscribe: Stream.make(empty),
    testChannels: Effect.fail(new MachineHealthError({ reason: "unavailable" })),
  }),
);
