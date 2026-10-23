import { MachineListResult, OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as Machines from "../../../machines/Machines.ts";

export const MachinesToolkit = Toolkit.make(
  Tool.make("machines_list", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Machines.Machines],
    parameters: Tool.EmptyParams,
    success: MachineListResult,
    description:
      "List the user's Cogenly machines: this one, the hub it is paired with, and other paired machines, with each one's name, kind (this computer, cloud server, another computer), whether it is online, and its provider sign-ins. Check this before telling the user something can't be done on another machine.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
