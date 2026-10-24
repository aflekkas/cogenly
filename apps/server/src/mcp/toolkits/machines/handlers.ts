import { type MachineSetupStatus, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Machines from "../../../machines/Machines.ts";
import * as MachineSetup from "../../../tailscale/MachineSetup.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MachinesToolkit } from "./tools.ts";

/**
 * A pending Tailscale sign-in link lets whoever opens it add this machine to
 * their own tailnet, so readers (including read-only clients) don't get it.
 */
export const withoutSignInLink = (status: MachineSetupStatus): MachineSetupStatus => ({
  ...status,
  steps: status.steps.map((step) =>
    step.id === "sign-in" && step.state === "waiting" && step.handoff?._tag === "open-url"
      ? {
          ...step,
          handoff: null,
          detail: `${step.detail} Run machine_setup_step with sign-in for the link, or open Settings → Machines.`,
        }
      : step,
  ),
});

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
  machine_setup_status: McpToolAccess.reads(() =>
    MachineSetup.MachineSetup.pipe(
      Effect.flatMap((setup) => setup.status),
      Effect.map(withoutSignInLink),
    ),
  ),
  // Installs software and puts this server on the tailnet: full-access work callers only.
  machine_setup_step: McpToolAccess.writesEnvironmentAsWork(({ step }) =>
    MachineSetup.MachineSetup.pipe(
      Effect.flatMap((setup) => setup.runStep(step)),
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.reason === "busy" ? "invalid_request" : "capability_denied",
            message: error.message,
          }),
      ),
    ),
  ),
});
