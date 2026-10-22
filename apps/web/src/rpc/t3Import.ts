import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Import from T3 Code: the live source and job status, plus the scan, run and cancel commands. */
export const t3ImportRpc = {
  status: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "t3-import:status",
    tag: WS_METHODS.t3ImportStatus,
    idleTtlMs: 0,
  }),
  scan: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "t3-import:scan",
    tag: WS_METHODS.t3ImportScan,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
  }),
  run: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "t3-import:run",
    tag: WS_METHODS.t3ImportRun,
    concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
  }),
  cancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "t3-import:cancel",
    tag: WS_METHODS.t3ImportCancel,
  }),
};
