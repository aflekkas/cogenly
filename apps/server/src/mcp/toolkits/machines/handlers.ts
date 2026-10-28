import {
  type MachineListResult,
  type MachineSetupStatus,
  OrchestratorMcpFailure,
  type ProviderAuthState,
  type ProviderInstanceId,
  type ThreadRemoteError,
} from "@cogenly/contracts";
import * as Effect from "effect/Effect";

import * as DesktopAppControl from "../../../environment/DesktopAppControl.ts";
import { resolveProjectId } from "../../threadAccess.ts";
import * as ProviderAuthService from "../../../provider/ProviderAuthService.ts";
import * as ProviderSignInRequests from "../../../provider/ProviderSignInRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Machines from "../../../machines/Machines.ts";
import * as ProjectMove from "../../../threadSync/ProjectMove.ts";
import * as ThreadTransfer from "../../../threadSync/ThreadTransfer.ts";
import * as MachineSetup from "../../../tailscale/MachineSetup.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { addEnvironmentFailure } from "../environment/handlers.ts";
import { MachinesToolkit } from "./tools.ts";

const moveFailure = (error: ThreadRemoteError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

/** How an agent hears why the desktop app did not pair the machines. */
export const pairMachinesFailure = (error: DesktopAppControl.DesktopAppControlError) =>
  error._tag === "DesktopAppControlUnreachableError"
    ? new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "machine_pair runs through the Cogenly desktop app on the computer this agent runs on, and none answered here. Ask the user to open the desktop app and try again, or to choose Add machine in Settings → Machines.",
      })
    : addEnvironmentFailure(error);

/** The paired machine `query` names in this machine's list, by environment id or name. */
export const findUnpairTarget = (list: MachineListResult, query: string) => {
  const wanted = query.trim().toLowerCase();
  const matches = list.machines.filter(
    (machine) =>
      machine.environmentId === query.trim() || machine.name.trim().toLowerCase() === wanted,
  );
  const invalid = (message: string) =>
    new OrchestratorMcpFailure({ code: "invalid_request", message });
  if (matches.length > 1) {
    return Effect.fail(
      invalid(
        `More than one machine is named "${query}". Use its environmentId: ${matches.map((machine) => machine.environmentId).join(", ")}.`,
      ),
    );
  }
  const machine = matches[0];
  if (machine === undefined || machine.relation === "this") {
    return Effect.fail(
      invalid(
        machine === undefined
          ? `No machine named "${query}" is paired with this one. machines_list shows them.`
          : "That is this machine. Name the machine to unpair from it.",
      ),
    );
  }
  if (machine.relation === "peer") {
    return Effect.fail(
      invalid(
        `${machine.name} is paired with the hub, not with this machine. Unpair it from an agent on the hub, or in Settings → Machines there.`,
      ),
    );
  }
  return Effect.succeed(machine);
};

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

/** What provider_sign_in start returns once the card is posted (or nothing is needed). */
export const providerSignInCardState = (
  input: { readonly instanceId: ProviderInstanceId },
  result: Exclude<ProviderSignInRequests.ProviderSignInRequestResult, { _tag: "NoThread" }>,
): ProviderAuthState => ({
  instanceId: input.instanceId,
  phase: result._tag === "AlreadySignedIn" ? "succeeded" : "waiting",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  interaction: null,
  message:
    result._tag === "AlreadySignedIn"
      ? `Already signed in on ${result.machineName}.`
      : `A sign-in card for ${result.request.providerName} on ${result.request.machineName} is in this thread. The user finishes it there; this thread is told when it is signed in. Do not ask for codes or links in chat.`,
});

export const layer = McpToolAccess.toLayer(MachinesToolkit, {
  provider_sign_in: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const auth = yield* ProviderAuthService.ProviderAuthService;
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      if (input.request.operation === "start") {
        // From a thread, the user signs in on an inline card rather than a flow the agent owns.
        const requests = yield* ProviderSignInRequests.ProviderSignInRequests;
        const posted = yield* requests.request(invocation, input.request.input);
        if (posted._tag !== "NoThread") return providerSignInCardState(input.request.input, posted);
      }
      const code = input.codeRef
        ? { ref: input.codeRef, projectId: yield* resolveProjectId(yield* check, input.projectId) }
        : undefined;
      return yield* auth.manageSignIn(input.request, invocation.requestNamespace, code).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                "Provider sign-in could not complete. Check the machine connection and try again.",
            }),
        ),
      );
    }),
  ),
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
      const options = {
        ...(input.leaveLocalChanges === undefined
          ? {}
          : { leaveLocalChanges: input.leaveLocalChanges }),
        ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
      };
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
  machine_setup_status: McpToolAccess.reads(() =>
    MachineSetup.MachineSetup.pipe(
      Effect.flatMap((setup) => setup.status),
      Effect.map(withoutSignInLink),
    ),
  ),
  // Installs software and puts this server on the tailnet: full-access work callers only.
  machine_setup_step: McpToolAccess.writesEnvironmentAsWork(({ step }) =>
    MachineSetup.MachineSetup.pipe(
      Effect.flatMap((setup) =>
        step === "disable-expose" ? setup.disableServe : setup.runStep(step),
      ),
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.reason === "busy" ? "invalid_request" : "capability_denied",
            message: error.message,
          }),
      ),
    ),
  ),
  // Pairing is access management, and the desktop app shows it happening. The
  // join code stays inside the app; this sees only the two machines' names.
  machine_pair: McpToolAccess.writesEnvironmentAsWork(({ hub, joining }) =>
    DesktopAppControl.DesktopAppControl.pipe(
      Effect.flatMap((control) => control.pairMachines({ hub, joining })),
      Effect.map((paired) => ({ hub: paired.hub, joining: paired.joining })),
      Effect.mapError(pairMachinesFailure),
    ),
  ),
  machine_unpair: McpToolAccess.writesEnvironmentAsWork(({ machine }) =>
    Effect.gen(function* () {
      const machines = yield* Machines.Machines;
      const failed = (error: { readonly message: string }) =>
        new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
      const target = yield* findUnpairTarget(
        yield* machines.list.pipe(Effect.mapError(failed)),
        machine,
      );
      return yield* machines
        .unpair({ environmentId: target.environmentId })
        .pipe(Effect.mapError(failed));
    }),
  ),
});
