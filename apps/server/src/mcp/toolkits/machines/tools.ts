import {
  EnvironmentId,
  MachineListResult,
  OrchestratorMcpFailure,
  ProjectMoveInput,
  ProjectMoveResult,
  THREAD_MOVE_MAX_THREADS,
  ThreadId,
  ThreadMoveResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as Machines from "../../../machines/Machines.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectMove from "../../../threadSync/ProjectMove.ts";
import * as ThreadTransfer from "../../../threadSync/ThreadTransfer.ts";
import * as Invocation from "../../McpInvocationContext.ts";

// What writesEnvironment checks the caller against.
const callerDependencies = [Invocation.McpInvocationContext, Threads.ThreadManagementService];

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
  Tool.make("machines_move_threads", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [ThreadTransfer.ThreadTransfer, ...callerDependencies],
    parameters: Schema.Struct({
      threadIds: Schema.optional(
        Schema.Array(ThreadId).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(THREAD_MOVE_MAX_THREADS),
        ),
      ).annotate({ description: "Threads to move. Give these or fromMachine." }),
      fromMachine: Schema.optional(EnvironmentId).annotate({
        description: "Move every thread this machine runs (its environment ID).",
      }),
      target: EnvironmentId.annotate({
        description: "Environment ID of the paired machine that runs them from now on.",
      }),
      leaveLocalChanges: Schema.optional(Schema.Boolean).annotate({
        description:
          "Also move Work whose worktree has uncommitted or unpushed changes; those changes stay on the old machine. Ask the user first.",
      }),
    }),
    success: ThreadMoveResult,
    description:
      "Move threads (chats, Work, agent conversations) to another paired machine, which runs them from then on; every machine keeps showing them. An agent moves with its conversation, schedules included. Busy threads, Work with unpushed changes and threads whose repository the target lacks are skipped with a reason; moving them again retries. Get environment IDs from machines_list. To move a whole project with its repositories, use project_move_to_machine.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_move_to_machine", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [ProjectMove.ProjectMove, ...callerDependencies],
    parameters: ProjectMoveInput,
    success: ProjectMoveResult,
    description:
      "Move a project to another paired machine: clones each repository the project links onto that machine from its remote, then moves every thread and agent filed in the project. Clones keep running after this answers. Skipped threads come back with the reason. Get the machine's environment ID from machines_list.",
  }).annotate(Tool.Destructive, false),
);
