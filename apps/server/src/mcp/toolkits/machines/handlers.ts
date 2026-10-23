import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Machines from "../../../machines/Machines.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MachinesToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(MachinesToolkit, {
  machines_list: McpToolAccess.reads(() =>
    Machines.Machines.pipe(
      Effect.flatMap((machines) => machines.list),
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The machine list could not be read.",
          }),
      ),
    ),
  ),
});
