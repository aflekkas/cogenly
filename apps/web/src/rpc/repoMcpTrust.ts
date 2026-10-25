import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@cogenly/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const repoMcpTrustRpc = {
  pending: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "repoMcpTrust:pending",
    tag: "repoMcpTrust.subscribe",
  }),
  respond: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "repoMcpTrust:respond",
    tag: "repoMcpTrust.respond",
  }),
};
