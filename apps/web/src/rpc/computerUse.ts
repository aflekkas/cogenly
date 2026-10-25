import { WS_METHODS } from "@cogenly/contracts";
import {
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "@cogenly/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Computer use on an environment's own machine: whether agents can drive its
 * apps and which macOS grants are missing. The thread prompt and the Settings
 * row read the same status, so a grant seen by one shows in the other.
 */
export const computerUseRpc = {
  status: createEnvironmentGuardedRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "computer-use:status",
    tag: WS_METHODS.computerUseStatus,
  }),
  /** Lists Cogenly under the grant and opens its System Settings pane on that machine. */
  requestPermission: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "computer-use:request-permission",
    tag: WS_METHODS.computerUseRequestPermission,
  }),
};
