import {
  ProviderMachineAuthRequest,
  ProjectId,
  SecretRef,
  ProviderAuthState,
  DesktopAppPairedMachine,
  EnvironmentId,
  MachineListResult,
  MachineSetupStatus,
  MachineSetupStepId,
  OrchestratorMcpFailure,
  ProjectMoveInput,
  ProjectMoveResult,
  THREAD_MOVE_MAX_THREADS,
  ThreadId,
  ThreadMoveResult,
} from "@cogenly/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as DesktopAppControl from "../../../environment/DesktopAppControl.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ProviderAuthService from "../../../provider/ProviderAuthService.ts";
import * as ProviderSignInRequests from "../../../provider/ProviderSignInRequests.ts";
import * as Machines from "../../../machines/Machines.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as MachineSetup from "../../../tailscale/MachineSetup.ts";
import * as ProjectMove from "../../../threadSync/ProjectMove.ts";
import * as ThreadTransfer from "../../../threadSync/ThreadTransfer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// What writesEnvironment checks the caller against.
const callerDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

export const MachinesToolkit = Toolkit.make(
  Tool.make("provider_sign_in", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      ProviderAuthService.ProviderAuthService,
      ProviderSignInRequests.ProviderSignInRequests,
      SecretRequests.SecretRequests,
      ...callerDependencies,
    ],
    parameters: Schema.Struct({
      request: ProviderMachineAuthRequest,
      codeRef: Schema.optionalKey(SecretRef),
      projectId: Schema.optionalKey(ProjectId),
    }),
    success: ProviderAuthState,
    description:
      "Start/read/cancel/sign out Claude or Codex locally or on targetEnvironmentId. Cancel with read's flowEpoch to stop only that sign-in, or omit flowId to stop the active one. In-thread start returns a sign-in card and later completion notification; never request codes/links in chat. Outside threads use CLI instructions and request_secret codeRef for Claude responses. Each machine logs in independently; never copy tokens or print credentials. No approval gate.",
  }).annotate(Tool.Destructive, false),
  Tool.make("machines_list", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Machines.Machines],
    parameters: Tool.EmptyParams,
    success: MachineListResult,
    description:
      "List local, hub and paired machines with names, types, online state and provider sign-ins. Check before claiming another machine cannot help.",
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
      dryRun: Schema.optional(Schema.Boolean).annotate({
        description: "Preview what would move, skipped reasons and target paths without moving.",
      }),
      leaveLocalChanges: Schema.optional(Schema.Boolean).annotate({
        description:
          "Also move Work whose worktree has uncommitted or unpushed changes; those changes stay on the old machine. Ask the user first.",
      }),
    }),
    success: ThreadMoveResult,
    description:
      "Move conversations and agents (including schedules) to a paired machine; all clients still show them. Busy threads, unpushed Work and missing target repos are skipped with reasons; retry after fixing. IDs: machines_list. Whole-project moves: project_move_to_machine.",
  }).annotate(Tool.Destructive, false),
  Tool.make("project_move_to_machine", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [ProjectMove.ProjectMove, ...callerDependencies],
    parameters: ProjectMoveInput,
    success: ProjectMoveResult,
    description:
      "Clone linked repos on a paired target, then move project threads/agents. Clones continue after return; skipped threads include reasons. IDs: machines_list.",
  }).annotate(Tool.Destructive, false),
  Tool.make("machine_setup_status", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [MachineSetup.MachineSetup],
    parameters: Tool.EmptyParams,
    success: MachineSetupStatus,
    description:
      "Read Tailscale pairing readiness and ordered install/start/sign-in/enable-https/expose checklist. Actions use machine_setup_step; handoffs need the user. Sign-in URLs come from step. When ready, pair in Settings → Machines → Add a machine.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("machine_setup_step", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      MachineSetup.MachineSetup,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
    parameters: Schema.Struct({
      step: MachineSetupStepId.annotate({
        description:
          "The checklist step to run; it must have an `action` in machine_setup_status. install installs Tailscale (Linux with passwordless sudo) or opens the App Store (macOS). start turns Tailscale on. sign-in starts the Tailscale sign-in and returns its link. enable-https and expose put this Cogenly behind Tailscale Serve on the private tailnet; when the tailnet has not allowed HTTPS yet, they return the approval link and finish by themselves once the user approves. disable-expose turns private access off: it removes this server's Serve mapping and saves Serve as off, so paired machines disconnect until expose turns it back on.",
      }),
    }),
    success: MachineSetupStatus,
    description:
      "Start one setup step and return its checklist immediately. Follow background progress with machine_setup_status. Relay open-url/run-command handoffs; never handle passwords. disable-expose reverses expose. Requires full-access/default.",
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
  Tool.make("machine_pair", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      DesktopAppControl.DesktopAppControl,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
    parameters: Schema.Struct({
      hub: Schema.String.annotate({
        description:
          "The always-on machine the other one syncs with, usually the server: its connection name in the desktop app (Settings → Connections) or its environment id. A machine already paired as a joining machine can't be a hub; name its hub instead.",
      }),
      joining: Schema.String.annotate({
        description:
          "The machine that joins the hub, such as the user's laptop: its connection name or environment id.",
      }),
    }),
    success: Schema.Struct({ hub: DesktopAppPairedMachine, joining: DesktopAppPairedMachine }),
    description:
      "Pair two connections in the local desktop app, which privately exchanges the join code. Hub must report ready in machine_setup_status. Requires full-access/default and a desktop on this machine; otherwise use Settings → Machines → Add a machine. machine_unpair reverses it.",
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
  Tool.make("machine_unpair", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Machines.Machines,
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
    ],
    parameters: Schema.Struct({
      machine: Schema.String.annotate({
        description:
          "A machine from machines_list paired with this one: its environmentId or name. On the hub, a joining machine; on a joining machine, its hub.",
      }),
    }),
    success: Schema.Struct({ unpaired: Schema.Boolean }),
    description:
      "Stop sync with a paired machine, preserving both copies. Hub-only peers unpair on the hub. Requires full-access/default; machine_pair reverses it.",
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true),
);
