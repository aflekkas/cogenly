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
      "Sign a provider (Claude, Codex) in on this machine or a paired targetEnvironmentId, or read, cancel or sign out its login. Pass the flowEpoch returned by read to cancel only that observed sign-in. Cancel may omit flowId (or pass null) to stop the active sign-in even when read hides its details. From a thread, start posts a guided sign-in card in the thread and returns at once: the user opens the sign-in page and enters any code on their own device, and this thread is told when that machine is signed in, even after this turn ends. Don't ask for links or codes in chat. Without a thread, start runs the official CLI login: read for browser instructions and completion, and pass a Claude browser code collected with request_secret as codeRef on a respond request. Each machine obtains its own login, so rotating refresh tokens are never copied. Never print credentials. No approval gate.",
  }).annotate(Tool.Destructive, false),
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
  Tool.make("machine_setup_status", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [MachineSetup.MachineSetup],
    parameters: Tool.EmptyParams,
    success: MachineSetupStatus,
    description:
      "Check whether this machine is ready to pair with the user's other machines. Cogenly links machines through Tailscale, a free app that gives them a private, encrypted connection. Returns Tailscale's state (installed, running, signed in, tailnet, MagicDNS name, HTTPS allowed, whether Tailscale Serve fronts this server) and an ordered checklist: install, start, sign-in, enable-https, expose. Each step has a state, a plain-language title and detail, an `action` when machine_setup_step can do it, and a `handoff` (a URL to open, or a command the user runs because it needs their password). The Tailscale sign-in link is left out here; machine_setup_step returns it. When `ready` is true the user pairs machines in Settings → Machines → Add machine.",
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
      "Run one machine setup step on this machine and return the updated checklist. It returns at once; slow steps show as working or waiting and finish in the background, so call machine_setup_status to follow them. Give the user any handoff it returns: open-url links to open, or the run-command to type in a terminal on this machine because it asks for their password. Never ask for or handle the password yourself. Use step disable-expose to turn private access off and expose to turn it back on. Requires a live full-access/default calling thread.",
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
      "Pair two of the user's machines so they sync, the same as Settings → Machines → Add machine. The Cogenly desktop app on this computer runs it, because only an app signed in to both machines can: it checks the hub, mints a one-time join code bound to the joining machine's key, and redeems it, so the code never reaches you. Both machines must be connections in that app, and the hub must be ready: its machine_setup_status (or its checklist in Settings → Machines → Add machine) shows ready. Only works from an environment on the same computer as the desktop app; elsewhere, ask the user to choose Add machine in Settings → Machines. Requires a live full-access/default calling thread. machine_unpair undoes it.",
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
      "Unpair a machine from this one, like Unpair in Settings → Machines: the two stop syncing, and projects and conversations stay on both. A machine paired with the hub rather than with this one is unpaired on the hub. Requires a live full-access/default calling thread. machine_pair pairs them again.",
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true),
);
