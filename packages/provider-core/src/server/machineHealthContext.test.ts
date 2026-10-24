import { describe, expect, it } from "vite-plus/test";

import { buildMachineHealthContextLine } from "./machineHealthContext.ts";

const alert = (originMachineName: string, title: string, status = "warn") => ({
  originMachineName,
  title,
  status,
});

describe("buildMachineHealthContextLine", () => {
  it("is null when nothing is open", () => {
    expect(buildMachineHealthContextLine([])).toBeNull();
  });

  it("groups by machine and points at machine_health", () => {
    expect(
      buildMachineHealthContextLine([
        alert("Contabo VPS", "Claude needs sign-in"),
        alert("Contabo VPS", 'Scheduled task "Nightly" failed', "fail"),
      ]),
    ).toBe(
      'Machine health: Contabo VPS: Scheduled task "Nightly" failed; Claude needs sign-in. Call machine_health for details.',
    );
  });

  it("drops a machine name the title already starts with", () => {
    expect(
      buildMachineHealthContextLine([
        alert("Contabo VPS", "Contabo VPS hasn't been reachable for 10 minutes", "fail"),
      ]),
    ).toBe(
      "Machine health: Contabo VPS: hasn't been reachable for 10 minutes. Call machine_health for details.",
    );
  });

  it("names at most three, failures first, and counts the rest", () => {
    const line = buildMachineHealthContextLine([
      alert("Laptop", "Disk almost full"),
      alert("Laptop", "Sync is behind"),
      alert("Contabo VPS", "Codex signed out", "fail"),
      alert("Laptop", "Tailscale Serve is off"),
      alert("Laptop", "Boot service missing"),
    ]);
    expect(line).toBe(
      "Machine health: Contabo VPS: Codex signed out. Laptop: Disk almost full; Sync is behind (+2 more). Call machine_health for details.",
    );
  });
});
