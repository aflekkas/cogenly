import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Approvals, commitments and activity for agent views. `refreshTrigger` names an atom
 * that changes when an environment's agents do (a run finishing, a new message), so
 * open lists pick up what an agent recorded without polling.
 */
export function createAgentWorkspaceAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly refreshTrigger?: (environmentId: EnvironmentId) => Atom.Atom<unknown> | undefined;
  } = {},
) {
  const refresh = options.refreshTrigger
    ? {
        staleTimeMs: 5_000,
        refreshTrigger: (target: { readonly environmentId: EnvironmentId }) =>
          options.refreshTrigger?.(target.environmentId),
      }
    : {};
  return {
    factsList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "facts.list",
      ...refresh,
      tag: WS_METHODS.factsList,
    }),
    factsCreate: createEnvironmentRpcCommand(runtime, {
      label: "facts.create",
      tag: WS_METHODS.factsCreate,
    }),
    factsUpdate: createEnvironmentRpcCommand(runtime, {
      label: "facts.update",
      tag: WS_METHODS.factsUpdate,
    }),
    factsSupersede: createEnvironmentRpcCommand(runtime, {
      label: "facts.supersede",
      tag: WS_METHODS.factsSupersede,
    }),
    factsRetract: createEnvironmentRpcCommand(runtime, {
      label: "facts.retract",
      tag: WS_METHODS.factsRetract,
    }),
    factsHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "facts.history",
      tag: WS_METHODS.factsHistory,
    }),
    contextForRun: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "context.forRun",
      tag: WS_METHODS.contextForRun,
    }),
    contextSettings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "context.settings",
      tag: WS_METHODS.contextSettings,
    }),
    contextSetEnabled: createEnvironmentRpcCommand(runtime, {
      label: "context.setEnabled",
      tag: WS_METHODS.contextSetEnabled,
    }),

    agentsApprovalsList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "agents.approvalsList",
      ...refresh,
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
      ...refresh,
      tag: WS_METHODS.agentsActivity,
    }),
    commitmentsDelete: createEnvironmentRpcCommand(runtime, {
      label: "commitments.delete",
      tag: WS_METHODS.commitmentsDelete,
    }),
    commitmentsList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "commitments.list",
      ...refresh,
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
      ...refresh,
      tag: WS_METHODS.commitmentsHistory,
    }),
  };
}
