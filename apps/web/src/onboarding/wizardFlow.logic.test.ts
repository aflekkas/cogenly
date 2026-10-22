import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type T3ImportStatus } from "@t3tools/contracts";

import {
  detectT3ImportForOnboarding,
  onboardingStageIndex,
  onboardingStages,
  onboardingStepAtStage,
  resolveLocalOnboardingSetup,
  resolveOnboardingImportPath,
  resolveOnboardingStartStep,
} from "./wizardFlow.logic";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

function t3Status(available: boolean): T3ImportStatus {
  return {
    source: {
      available,
      databasePath: "/Users/me/.t3/userdata/statev2.sqlite",
      running: false,
      projects: [],
    },
    job: { _tag: "Idle" },
  };
}

describe("resolveOnboardingStartStep", () => {
  it("skips choosing a computer when this computer serves the app", () => {
    expect(
      resolveOnboardingStartStep({
        resumeEnvironmentId: undefined,
        localAvailable: true,
        localEnvironmentDisabled: false,
      }),
    ).toBe("local");
  });

  it("asks to connect a computer in the hosted app or with the local environment off", () => {
    expect(
      resolveOnboardingStartStep({
        resumeEnvironmentId: undefined,
        localAvailable: false,
        localEnvironmentDisabled: false,
      }),
    ).toBe("connection");
    expect(
      resolveOnboardingStartStep({
        resumeEnvironmentId: undefined,
        localAvailable: true,
        localEnvironmentDisabled: true,
      }),
    ).toBe("connection");
  });

  it("resumes agent setup for a named computer", () => {
    expect(
      resolveOnboardingStartStep({
        resumeEnvironmentId: REMOTE,
        localAvailable: true,
        localEnvironmentDisabled: false,
      }),
    ).toBe("agents");
  });
});

describe("resolveLocalOnboardingSetup", () => {
  it("sets up only this computer once it is connected", () => {
    expect(
      resolveLocalOnboardingSetup({ environmentId: LOCAL, connection: { phase: "connected" } }),
    ).toEqual({ kind: "setup", environmentIds: [LOCAL] });
  });

  it("waits while the catalog loads or the first connection settles", () => {
    expect(resolveLocalOnboardingSetup(null)).toEqual({ kind: "wait" });
    for (const phase of ["available", "connecting", "reconnecting"]) {
      expect(resolveLocalOnboardingSetup({ environmentId: LOCAL, connection: { phase } })).toEqual({
        kind: "wait",
      });
    }
  });

  it("falls back to choosing a computer when this one cannot connect", () => {
    for (const phase of ["error", "unsupported", "offline"]) {
      expect(resolveLocalOnboardingSetup({ environmentId: LOCAL, connection: { phase } })).toEqual({
        kind: "choose",
      });
    }
  });
});

describe("onboarding stages", () => {
  it("has no connection stage for local setup", () => {
    expect(onboardingStages(false)).toEqual(["Agents", "Import"]);
    expect(onboardingStageIndex("local", false)).toBe(0);
    expect(onboardingStageIndex("agents", false)).toBe(0);
    expect(onboardingStageIndex("import", false)).toBe(1);
    expect(onboardingStepAtStage(0, false)).toBe("agents");
  });

  it("keeps the connection stage when a computer must be connected first", () => {
    expect(onboardingStages(true)).toEqual(["Connect", "Agents", "Import"]);
    expect(onboardingStageIndex("connection", true)).toBe(0);
    expect(onboardingStageIndex("agents", true)).toBe(1);
    expect(onboardingStageIndex("import", true)).toBe(2);
    expect(onboardingStepAtStage(0, true)).toBe("connection");
    expect(onboardingStepAtStage(1, true)).toBe("agents");
  });
});

describe("onboarding import path", () => {
  it("prefers Import from T3 Code when T3 is found", () => {
    const detection = detectT3ImportForOnboarding({
      canImport: true,
      status: t3Status(true),
      statusError: null,
    });
    expect(detection).toBe("found");
    expect(resolveOnboardingImportPath(detection, null)).toBe("t3");
  });

  it("keeps the raw session import as an explicit secondary choice", () => {
    expect(resolveOnboardingImportPath("found", "sessions")).toBe("sessions");
  });

  it("offers the session import when T3 is absent, unreachable or not permitted", () => {
    expect(
      detectT3ImportForOnboarding({ canImport: true, status: t3Status(false), statusError: null }),
    ).toBe("absent");
    expect(
      detectT3ImportForOnboarding({ canImport: true, status: null, statusError: "offline" }),
    ).toBe("absent");
    expect(
      detectT3ImportForOnboarding({ canImport: false, status: t3Status(true), statusError: null }),
    ).toBe("absent");
    expect(resolveOnboardingImportPath("absent", null)).toBe("sessions");
  });

  it("waits for the first status before choosing", () => {
    const detection = detectT3ImportForOnboarding({
      canImport: true,
      status: null,
      statusError: null,
    });
    expect(detection).toBe("checking");
    expect(resolveOnboardingImportPath(detection, null)).toBe("checking");
  });
});
