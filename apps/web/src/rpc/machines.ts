import { createMachinePairingCommand } from "@cogenly/client-runtime/machines/pair";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@cogenly/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Settings → Machines: the environment's paired machines and the Tailscale
 * setup that pairing needs. Both lists are live; the server pushes them again
 * after every change.
 */
export const machinesRpc = {
  list: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "machines:live",
    tag: "machines.subscribe",
  }),
  /**
   * Needs access:write: the status carries the one-time Tailscale sign-in link.
   * The server re-checks Tailscale while subscribed, so it lets go soon after
   * the checklist closes.
   */
  setup: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "machines:setup",
    tag: "machines.setupSubscribe",
    idleTtlMs: 5_000,
  }),
  runStep: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machines:setupRunStep",
    tag: "machines.setupRunStep",
  }),
  disableServe: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machines:setupDisableServe",
    tag: "machines.setupDisableServe",
  }),
  unpair: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machines:unpair",
    tag: "machines.unpair",
  }),
  /** Targets the joining machine; `input.hubEnvironmentId` names the always-on one. */
  pairWith: createMachinePairingCommand(connectionAtomRuntime),
  /**
   * One machine's health report, live. `input.environmentId` names a paired
   * machine, which the viewed server reads over the peer link.
   */
  health: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "machines:health",
    tag: "machines.healthSubscribe",
    idleTtlMs: 30_000,
  }),
  /** The server's open alerts, merged with its paired machines', then each transition. */
  healthAlerts: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "machines:healthAlerts",
    tag: "machines.healthAlertsSubscribe",
  }),
  /** Retries sync between the target server and `input.environmentId`. */
  healthRetrySync: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machines:healthRetrySync",
    tag: "machines.healthRetrySync",
  }),
  /** Sends a test alert through each enabled external channel of the target server. */
  healthTestAlertChannels: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "machines:healthTestAlertChannels",
    tag: "machines.healthTestAlertChannels",
  }),
};
