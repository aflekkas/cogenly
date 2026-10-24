import { EnvironmentId, type DesktopAppPairMachinesRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type DesktopPairingCandidate,
  type DesktopPairMachinesDependencies,
  handleDesktopPairMachinesRequest,
} from "./desktopAppActivation";

const VPS: DesktopPairingCandidate = {
  environmentId: EnvironmentId.make("env-vps"),
  label: "Contabo VPS",
  connected: true,
};
const MAC: DesktopPairingCandidate = {
  environmentId: EnvironmentId.make("env-mac"),
  label: "MacBook",
  connected: true,
};

const request = (hub: string, joining: string): DesktopAppPairMachinesRequest => ({
  version: 1,
  requestId: "request-1",
  type: "pair-machines",
  hub,
  joining,
});

function dependencies(
  machines: ReadonlyArray<DesktopPairingCandidate>,
  pair: DesktopPairMachinesDependencies["pair"] = async () => {},
) {
  const paired: Array<Parameters<DesktopPairMachinesDependencies["pair"]>[0]> = [];
  return {
    paired,
    deps: {
      machines,
      pair: async (input) => {
        paired.push(input);
        await pair(input);
      },
      onPaired: () => {},
    } satisfies DesktopPairMachinesDependencies,
  };
}

describe("handleDesktopPairMachinesRequest", () => {
  it("pairs the named connections, by name or environment id", async () => {
    const { paired, deps } = dependencies([VPS, MAC]);
    const response = await handleDesktopPairMachinesRequest(
      request("contabo vps", "env-mac"),
      deps,
    );
    expect(paired).toEqual([
      {
        hub: { environmentId: "env-vps", name: "Contabo VPS" },
        joining: { environmentId: "env-mac", name: "MacBook" },
      },
    ]);
    expect(response).toEqual({
      version: 1,
      requestId: "request-1",
      ok: true,
      hub: { environmentId: "env-vps", name: "Contabo VPS" },
      joining: { environmentId: "env-mac", name: "MacBook" },
    });
  });

  it("names the app's connections when one it was asked for is missing", async () => {
    const { paired, deps } = dependencies([VPS, MAC]);
    const response = await handleDesktopPairMachinesRequest(request("Studio", "MacBook"), deps);
    expect(response).toMatchObject({ ok: false, code: "invalid-request" });
    expect(!response.ok && response.message).toContain('"Contabo VPS" (env-vps)');
    expect(paired).toEqual([]);
  });

  it("refuses a machine paired with itself and a machine it can't reach", async () => {
    const { paired, deps } = dependencies([VPS, { ...MAC, connected: false }]);
    expect(
      await handleDesktopPairMachinesRequest(request("env-vps", "Contabo VPS"), deps),
    ).toMatchObject({ ok: false, code: "invalid-request" });
    expect(
      await handleDesktopPairMachinesRequest(request("Contabo VPS", "MacBook"), deps),
    ).toMatchObject({ ok: false, code: "environment-unavailable" });
    expect(paired).toEqual([]);
  });

  it("reports the pairing command's failure", async () => {
    const { deps } = dependencies([VPS, MAC], async () => {
      throw new Error("Contabo VPS isn't ready for pairing yet. Finish its steps first.");
    });
    expect(await handleDesktopPairMachinesRequest(request("Contabo VPS", "MacBook"), deps)).toEqual(
      {
        version: 1,
        requestId: "request-1",
        ok: false,
        code: "machines-pair-failed",
        message: "Contabo VPS isn't ready for pairing yet. Finish its steps first.",
      },
    );
  });
});
