import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createExportAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    exportCreate: createEnvironmentRpcCommand(runtime, {
      label: "export.create",
      tag: WS_METHODS.exportCreate,
    }),
    exportValidate: createEnvironmentRpcCommand(runtime, {
      label: "export.validate",
      tag: WS_METHODS.exportValidate,
    }),
    exportList: createEnvironmentRpcCommand(runtime, {
      label: "export.list",
      tag: WS_METHODS.exportList,
    }),
  };
}
