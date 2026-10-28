import { describe, expect, it } from "vite-plus/test";
import { integrationMachineCompletion, integrationSetupStages } from "./secretRequest.ts";

describe("integration setup progress", () => {
  it("ticks only verified stages and spins only the active stage", () => {
    const stages = integrationSetupStages(
      {
        type: "oauth_client",
        title: "Connecting",
        message: "",
        steps: [],
        progress: { stage: "consent" },
      },
      false,
    );
    expect(stages.map((stage) => stage.state)).toEqual([
      "complete",
      "complete",
      "active",
      "pending",
      "pending",
    ]);
    const waiting = integrationSetupStages(
      { type: "sign_in", title: "Sign in", message: "" },
      false,
    );
    expect(waiting.map((stage) => stage.state)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "waiting",
    ]);
    expect(
      integrationSetupStages(undefined, true).every((stage) => stage.state === "complete"),
    ).toBe(true);
  });

  it("keeps the remaining machine in the same flow and names every completed destination", () => {
    const first = integrationMachineCompletion([
      { name: "MacBook", status: "connected" },
      { name: "Cloud server", status: "needs_sign_in" },
    ]);
    expect(first.complete).toBe(false);
    expect(first.message).toBe("Connected on MacBook");
    expect(first.pending).toEqual([{ name: "Cloud server", status: "needs_sign_in" }]);
    const complete = integrationMachineCompletion([
      { name: "MacBook", status: "connected" },
      { name: "Cloud server", status: "connected" },
    ]);
    expect(complete.complete).toBe(true);
    expect(complete.message).toBe("Connected on MacBook and Cloud server");
    expect(
      integrationMachineCompletion([{ name: "Cloud server", status: "offline" }]).complete,
    ).toBe(false);
    expect(integrationMachineCompletion([]).complete).toBe(false);
  });
});
