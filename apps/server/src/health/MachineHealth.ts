/**
 * MachineHealth: the state of each subsystem an always-on machine depends on,
 * as one report. The one service every transport calls (WebSocket RPC, MCP
 * `machine_health`, `cogenly health`). A paired machine's report is read over
 * the peer link; an unreachable one is described from what this side saw.
 */
import {
  MachineHealthError,
  type MachineHealthInput,
  type MachineHealthReport,
  type MachineHealthRetrySyncInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export class MachineHealth extends Context.Service<
  MachineHealth,
  {
    /** This machine's report. Never fails: a check that cannot run is `unknown`. */
    readonly report: Effect.Effect<MachineHealthReport>;
    /** This machine, or a paired one read over the peer link. */
    readonly reportFor: (
      input: MachineHealthInput,
    ) => Effect.Effect<MachineHealthReport, MachineHealthError>;
    /** The report, then a fresh one whenever it changes. */
    readonly subscribe: (
      input: MachineHealthInput,
    ) => Stream.Stream<MachineHealthReport, MachineHealthError>;
    /** Retry held or failed sync with one paired machine now. */
    readonly retrySync: (
      input: MachineHealthRetrySyncInput,
    ) => Effect.Effect<void, MachineHealthError>;
  }
>()("cogenly-server/health/MachineHealth") {}

// TODO(health): replaced by the real implementation.
const unavailable = new MachineHealthError({ reason: "unavailable" });
export const layer = Layer.succeed(
  MachineHealth,
  MachineHealth.of({
    report: Effect.die("MachineHealth not implemented"),
    reportFor: () => Effect.fail(unavailable),
    subscribe: () => Stream.fail(unavailable),
    retrySync: () => Effect.fail(unavailable),
  }),
);
