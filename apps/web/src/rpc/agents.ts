import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type AgentId, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";

const list = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "agents:live",
  tag: "agents.subscribe",
});
const memory = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "agents:memory",
  tag: "agents.memoryList",
  staleTimeMs: 5_000,
  refreshTrigger: (target) => list({ environmentId: target.environmentId, input: {} }),
});
const refreshMemory = (
  target: { environmentId: EnvironmentId; input: { agentId: AgentId } },
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => {
    registry.refresh(
      memory({ environmentId: target.environmentId, input: { agentId: target.input.agentId } }),
    );
  });
export const agentsRpc = {
  list,
  save: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "agents:save",
    tag: "agents.upsert",
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "agents:delete",
    tag: "agents.delete",
  }),
  send: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "agents:send",
    tag: "agents.send",
  }),
  markRead: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "agents:markRead",
    tag: "agents.markRead",
  }),
  memory,
  saveMemory: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "agents:memoryWrite",
    tag: "agents.memoryWrite",
    onSuccess: refreshMemory,
  }),
  deleteMemory: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "agents:memoryForget",
    tag: "agents.memoryForget",
    onSuccess: refreshMemory,
  }),
  activity: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "agents:runs",
    tag: "agents.runs",
    staleTimeMs: 5_000,
    refreshTrigger: (target) => list({ environmentId: target.environmentId, input: {} }),
  }),
};
