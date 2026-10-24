import { createSyncStatusAtoms } from "@t3tools/client-runtime/state/sync";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "../state/server";

/** What each paired machine has yet to receive; re-read when machines come and go. */
export const syncRpc = createSyncStatusAtoms(connectionAtomRuntime, {
  refreshTrigger: (environmentId) => serverEnvironment.machinesLive({ environmentId, input: {} }),
});
