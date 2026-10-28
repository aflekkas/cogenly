/**
 * The published health-alert snapshot, apart from the HealthAlerts evaluator
 * so turn context can read it from inside the orchestration runtime, which is
 * built below the machine link HealthAlerts needs. Both provide this same
 * `layer` reference, so layer memoization shares one instance.
 *
 * It also carries what automatic fixing is handling, which MachineHealthFixes
 * writes from above HealthAlerts: held items stay quiet, failed ones alert
 * with what went wrong.
 */
import type { MachineHealthAlertsSnapshot } from "@cogenly/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** This machine's items automatic fixing owns, by item key. */
export interface HealthAutoFixView {
  /** Being fixed, or fixed and settling: alerts wait for them. */
  readonly holds: ReadonlySet<string>;
  /** The automatic fix failed: alerts open with this message. */
  readonly failures: ReadonlyMap<string, string>;
}

export const EMPTY_AUTO_FIX_VIEW: HealthAutoFixView = { holds: new Set(), failures: new Map() };

export class HealthAlertsState extends Context.Service<
  HealthAlertsState,
  {
    readonly current: Effect.Effect<MachineHealthAlertsSnapshot>;
    /** The current snapshot, then each published one. */
    readonly changes: Stream.Stream<MachineHealthAlertsSnapshot>;
    readonly publish: (snapshot: MachineHealthAlertsSnapshot) => Effect.Effect<void>;
    readonly autoFix: Effect.Effect<HealthAutoFixView>;
    readonly setAutoFix: (view: HealthAutoFixView) => Effect.Effect<void>;
  }
>()("cogenly-server/health/HealthAlertsState") {}

export const layer = Layer.effect(
  HealthAlertsState,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<MachineHealthAlertsSnapshot>({
      open: [],
      recentlyResolved: [],
    });
    const autoFix = yield* Ref.make(EMPTY_AUTO_FIX_VIEW);
    return HealthAlertsState.of({
      current: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      publish: (snapshot) => SubscriptionRef.set(ref, snapshot),
      autoFix: Ref.get(autoFix),
      setAutoFix: (view) => Ref.set(autoFix, view),
    });
  }),
);
