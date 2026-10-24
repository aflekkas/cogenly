import {
  MachineListResult,
  MachineSetupStatus,
  MachineSetupStepId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Machines from "../../../machines/Machines.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as MachineSetup from "../../../tailscale/MachineSetup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

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
  Tool.make("machine_setup_status", {
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [MachineSetup.MachineSetup],
    parameters: Tool.EmptyParams,
    success: MachineSetupStatus,
    description:
      "Check whether this machine is ready to pair with the user's other machines. Cogenly links machines through Tailscale, a free app that gives them a private, encrypted connection. Returns Tailscale's state (installed, running, signed in, tailnet, MagicDNS name, HTTPS allowed, whether Tailscale Serve fronts this server) and an ordered checklist: install, start, sign-in, enable-https, expose. Each step has a state, a plain-language title and detail, an `action` when machine_setup_step can do it, and a `handoff` (a URL to open, or a command the user runs because it needs their password). The Tailscale sign-in link is left out here; machine_setup_step returns it. When `ready` is true the user pairs machines in Settings → Machines → Add a machine.",
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
          "The checklist step to run; it must have an `action` in machine_setup_status. install installs Tailscale (Linux with passwordless sudo) or opens the App Store (macOS). start turns Tailscale on. sign-in starts the Tailscale sign-in and returns its link. enable-https and expose put this Cogenly behind Tailscale Serve on the private tailnet; when the tailnet has not allowed HTTPS yet, they return the approval link and finish by themselves once the user approves.",
      }),
    }),
    success: MachineSetupStatus,
    description:
      "Run one machine setup step on this machine and return the updated checklist. It returns at once; slow steps show as working or waiting and finish in the background, so call machine_setup_status to follow them. Give the user any handoff it returns: open-url links to open, or the run-command to type in a terminal on this machine because it asks for their password. Never ask for or handle the password yourself. Requires a live full-access/default calling thread.",
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
);
