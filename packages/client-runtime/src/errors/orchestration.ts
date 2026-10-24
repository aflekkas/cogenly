import {
  OrchestrationDispatchCommandError,
  OrchestrationV2ThreadLaunchError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isThreadLaunchError = Schema.is(OrchestrationV2ThreadLaunchError);

/** A launch on a paired machine refused because that machine is offline; nothing was created or queued. */
export function wasLaunchMachineOffline(error: unknown): boolean {
  return isThreadLaunchError(error) && error.machineOffline === true;
}

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function wasBootstrapThreadNotCreated(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "not-created"
  );
}
