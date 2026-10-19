import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createAgentWorkspaceAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    agentsApprovalsList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "agents.approvalsList",
      tag: WS_METHODS.agentsApprovalsList,
    }),
    agentsRequestApproval: createEnvironmentRpcCommand(runtime, {
      label: "agents.requestApproval",
      tag: WS_METHODS.agentsRequestApproval,
    }),
    agentsApprove: createEnvironmentRpcCommand(runtime, {
      label: "agents.approve",
      tag: WS_METHODS.agentsApprove,
    }),
    agentsReject: createEnvironmentRpcCommand(runtime, {
      label: "agents.reject",
      tag: WS_METHODS.agentsReject,
    }),
    agentsStartWork: createEnvironmentRpcCommand(runtime, {
      label: "agents.startWork",
      tag: WS_METHODS.agentsStartWork,
    }),
    agentsActivity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "agents.activity",
      tag: WS_METHODS.agentsActivity,
    }),
    commitmentsDelete: createEnvironmentRpcCommand(runtime, {
      label: "commitments.delete",
      tag: WS_METHODS.commitmentsDelete,
    }),
    commitmentsList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "commitments.list",
      tag: WS_METHODS.commitmentsList,
    }),
    commitmentsCreate: createEnvironmentRpcCommand(runtime, {
      label: "commitments.create",
      tag: WS_METHODS.commitmentsCreate,
    }),
    commitmentsUpdateStatus: createEnvironmentRpcCommand(runtime, {
      label: "commitments.updateStatus",
      tag: WS_METHODS.commitmentsUpdateStatus,
    }),
    commitmentsConfirm: createEnvironmentRpcCommand(runtime, {
      label: "commitments.confirm",
      tag: WS_METHODS.commitmentsConfirm,
    }),
    commitmentsDismiss: createEnvironmentRpcCommand(runtime, {
      label: "commitments.dismiss",
      tag: WS_METHODS.commitmentsDismiss,
    }),
    commitmentsHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "commitments.history",
      tag: WS_METHODS.commitmentsHistory,
    }),
  };
}
