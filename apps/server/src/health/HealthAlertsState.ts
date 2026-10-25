/**
 * The published health-alert snapshot, apart from the HealthAlerts evaluator
 * so turn context can read it from inside the orchestration runtime, which is
 * built below the machine link HealthAlerts needs. Both provide this same
 * `layer` reference, so layer memoization shares one instance.
 */
import type { MachineHealthAlertsSnapshot } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export class HealthAlertsState extends Context.Service<
  HealthAlertsState,
  {
    readonly current: Effect.Effect<MachineHealthAlertsSnapshot>;
    /** The current snapshot, then each published one. */
    readonly changes: Stream.Stream<MachineHealthAlertsSnapshot>;
    readonly publish: (snapshot: MachineHealthAlertsSnapshot) => Effect.Effect<void>;
  }
>()("cogenly-server/health/HealthAlertsState") {}

export const layer = Layer.effect(
  HealthAlertsState,
  Effect.map(
    SubscriptionRef.make<MachineHealthAlertsSnapshot>({ open: [], recentlyResolved: [] }),
    (ref) =>
      HealthAlertsState.of({
        current: SubscriptionRef.get(ref),
        changes: SubscriptionRef.changes(ref),
        publish: (snapshot) => SubscriptionRef.set(ref, snapshot),
      }),
  ),
);
