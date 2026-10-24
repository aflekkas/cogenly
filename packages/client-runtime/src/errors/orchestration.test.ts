import { CommandId, OrchestrationV2ThreadLaunchError, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { wasLaunchMachineOffline } from "./orchestration.ts";

const launchError = (machineOffline?: boolean) =>
  new OrchestrationV2ThreadLaunchError({
    commandId: CommandId.make("command-1"),
    projectId: ProjectId.make("project-1"),
    message: "The hub is offline.",
    ...(machineOffline === undefined ? {} : { machineOffline }),
  });

describe("wasLaunchMachineOffline", () => {
  it("recognizes only a launch refused for an offline machine", () => {
    expect(wasLaunchMachineOffline(launchError(true))).toBe(true);
    expect(wasLaunchMachineOffline(launchError(false))).toBe(false);
    // Older servers omit the flag: an ordinary failure, not the offline fallback.
    expect(wasLaunchMachineOffline(launchError())).toBe(false);
    expect(wasLaunchMachineOffline(new Error("offline"))).toBe(false);
  });
});
