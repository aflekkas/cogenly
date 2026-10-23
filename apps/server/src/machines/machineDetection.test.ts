import { describe, expect, it } from "@effect/vitest";

import {
  classifyMachine,
  defaultMachineName,
  hostingProviderFromText,
} from "./machineDetection.ts";

const signals = {
  detectedKind: null,
  hasBattery: false,
  hasGraphicalSession: true,
  hostingProvider: null,
} as const;

describe("machine detection", () => {
  it("calls a Mac with a battery a laptop and one without a desktop", () => {
    expect(classifyMachine({ ...signals, platform: "darwin", hasBattery: true })).toEqual({
      role: "computer",
      hardware: "laptop",
      hostingProvider: null,
    });
    expect(classifyMachine({ ...signals, platform: "darwin" }).hardware).toBe("desktop");
  });

  it("calls headless Linux without a battery a cloud server", () => {
    expect(classifyMachine({ ...signals, platform: "linux", hasGraphicalSession: false })).toEqual({
      role: "cloud-server",
      hardware: "server",
      hostingProvider: null,
    });
  });

  it("keeps a Linux desktop or laptop a computer", () => {
    expect(classifyMachine({ ...signals, platform: "linux" }).role).toBe("computer");
    expect(
      classifyMachine({
        ...signals,
        platform: "linux",
        hasGraphicalSession: false,
        hasBattery: true,
      }).hardware,
    ).toBe("laptop");
  });

  it("trusts a hosting provider hint even with a graphical session", () => {
    expect(classifyMachine({ ...signals, platform: "linux", hostingProvider: "Contabo" })).toEqual({
      role: "cloud-server",
      hardware: "server",
      hostingProvider: "Contabo",
    });
  });

  it("recognizes hosting providers from DMI strings and reverse DNS", () => {
    expect(hostingProviderFromText("vmi123456.contaboserver.net")).toBe("Contabo");
    expect(hostingProviderFromText("Hetzner vServer")).toBe("Hetzner");
    expect(hostingProviderFromText("Apple Inc. MacBookPro18,1")).toBeNull();
    expect(hostingProviderFromText(undefined)).toBeNull();
  });

  it("names computers by their label and servers by provider, then host", () => {
    const base = { environmentLabel: "MacBook Pro", hostname: "vmi1", hostingProvider: null };
    expect(defaultMachineName({ ...base, role: "computer" })).toBe("MacBook Pro");
    expect(defaultMachineName({ ...base, role: "cloud-server", hostingProvider: "Contabo" })).toBe(
      "Cloud server · Contabo",
    );
    expect(defaultMachineName({ ...base, role: "cloud-server" })).toBe("Cloud server · vmi1");
  });
});
