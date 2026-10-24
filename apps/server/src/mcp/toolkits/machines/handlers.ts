import { OrchestratorMcpFailure, type ThreadRemoteError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Machines from "../../../machines/Machines.ts";
import * as ProjectMove from "../../../threadSync/ProjectMove.ts";
import * as ThreadTransfer from "../../../threadSync/ThreadTransfer.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MachinesToolkit } from "./tools.ts";

const moveFailure = (error: ThreadRemoteError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

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
  // Moving where threads run changes the environment, like re-homing a project.
  machines_move_threads: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const transfer = yield* ThreadTransfer.ThreadTransfer;
      const options =
        input.leaveLocalChanges === undefined ? {} : { leaveLocalChanges: input.leaveLocalChanges };
      if ((input.threadIds === undefined) === (input.fromMachine === undefined))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Give either threadIds or fromMachine.",
        });
      return yield* (
        input.threadIds !== undefined
          ? transfer.move({ threadIds: input.threadIds, target: input.target, ...options })
          : transfer.moveAllFrom({ from: input.fromMachine!, target: input.target, ...options })
      ).pipe(Effect.mapError(moveFailure));
    }),
  ),
  project_move_to_machine: McpToolAccess.writesEnvironment((input) =>
    ProjectMove.ProjectMove.pipe(
      Effect.flatMap((projects) => projects.move(input)),
      Effect.mapError(moveFailure),
    ),
  ),
});
