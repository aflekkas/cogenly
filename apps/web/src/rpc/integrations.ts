import {
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const list = createEnvironmentGuardedRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "integrations:list",
  tag: "integrations.list",
});

const refreshList = (
  target: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => {
    registry.refresh(list({ environmentId: target.environmentId, input: {} }));
  });

/** Settings → Integrations: the environment's upstream MCP servers and the vault names they reference. */
export const integrationsRpc = {
  list,
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:create",
    tag: "integrations.create",
    onSuccess: refreshList,
  }),
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:update",
    tag: "integrations.update",
    onSuccess: refreshList,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:delete",
    tag: "integrations.delete",
    onSuccess: refreshList,
  }),
  // A successful test caches the tool list server-side, which the list reports.
  testConnection: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "integrations:testConnection",
    tag: "integrations.testConnection",
    onSuccess: refreshList,
  }),
};
