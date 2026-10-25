import { createMachinePairingCommand } from "@t3tools/client-runtime/machines/pair";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

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
};
