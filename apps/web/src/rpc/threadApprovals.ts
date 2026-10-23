import { createThreadApprovalAtoms } from "@t3tools/client-runtime/state/threadApprovals";

import { connectionAtomRuntime } from "../connection/runtime";

/** Owner approvals ordinary threads wait on; decided through `agentWorkspaceRpc.agentsApprove`. */
export const threadApprovals = createThreadApprovalAtoms(connectionAtomRuntime);
