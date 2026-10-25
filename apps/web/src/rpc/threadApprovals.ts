import { createThreadApprovalAtoms } from "@cogenly/client-runtime/state/threadApprovals";

import { connectionAtomRuntime } from "../connection/runtime";

/** Owner approvals ordinary threads wait on; decided through `agentWorkspaceRpc.agentsApprove`. */
export const threadApprovals = createThreadApprovalAtoms(connectionAtomRuntime);
