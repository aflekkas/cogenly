import type { EnvironmentConnectionPhase } from "@cogenly/client-runtime/connection";
import type { EnvironmentId } from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeRemoteMachine,
  isLocalMachine,
  LOCAL_MACHINE_LABEL,
  machineChoiceLabel,
  nameLocalMachine,
  pairedMachineChoice,
  resolveRemoteMachine,
  threadRunsOn,
} from "./machineBadge.logic";

const env = (id: string) => id as EnvironmentId;
const mac = env("mac");
const hub = env("hub");
const studio = env("studio");

describe("threadRunsOn", () => {
  it("is the paired machine running a replica, else the thread's environment", () => {
    expect(threadRunsOn({ environmentId: mac, source: { ownerMachine: hub } })).toBe(hub);
    expect(threadRunsOn({ environmentId: mac, source: { ownerMachine: null } })).toBe(mac);
    expect(threadRunsOn({ environmentId: hub })).toBe(hub);
  });
});

describe("isLocalMachine", () => {
  it("is the environment the client is primarily connected to", () => {
    expect(isLocalMachine(mac, mac)).toBe(true);
    expect(isLocalMachine(hub, mac)).toBe(false);
  });

  it("treats every machine as remote without a primary, as in the hosted app", () => {
    expect(isLocalMachine(mac, null)).toBe(false);
    expect(isLocalMachine(null, null)).toBe(false);
  });
});

describe("resolveRemoteMachine", () => {
  const resolve = (
    direct: { name: string; phase: EnvironmentConnectionPhase } | null,
    paired: { name: string; online: boolean } | null,
    runsOn: EnvironmentId | null = hub,
  ) => resolveRemoteMachine({ runsOn, localEnvironmentId: mac, direct, paired });

  it("badges nothing for work on this computer, even when it is a replica's owner", () => {
    expect(
      resolveRemoteMachine({
        runsOn: mac,
        localEnvironmentId: mac,
        direct: null,
        paired: { name: "MacBook", online: true },
      }),
    ).toBeNull();
  });

  it("trusts a live direct connection over the pairing report", () => {
    expect(
      resolve({ name: "Contabo", phase: "connected" }, { name: "contabo.vps", online: false }),
    ).toEqual({ name: "Contabo", online: true });
  });

  it("reads an offline direct connection's machine from the pairing report", () => {
    expect(
      resolve({ name: "Contabo", phase: "offline" }, { name: "contabo.vps", online: true }),
    ).toEqual({ name: "Contabo", online: true });
    expect(resolve({ name: "Contabo", phase: "error" }, null)).toEqual({
      name: "Contabo",
      online: false,
    });
  });

  it("defers to the pairing report while reconnecting, and does not flash offline without one", () => {
    expect(
      resolve({ name: "Contabo", phase: "reconnecting" }, { name: "Contabo", online: false }),
    ).toEqual({ name: "Contabo", online: false });
    expect(resolve({ name: "Contabo", phase: "reconnecting" }, null)).toEqual({
      name: "Contabo",
      online: true,
    });
  });

  it("names a machine only the pairing report knows, as from the hub's browser", () => {
    expect(
      resolveRemoteMachine({
        runsOn: mac,
        localEnvironmentId: hub,
        direct: null,
        paired: { name: "MacBook", online: false },
      }),
    ).toEqual({ name: "MacBook", online: false });
  });

  it("still shows a cloud for a machine neither source knows yet", () => {
    expect(resolve(null, null, studio)).toEqual({ name: "Another machine", online: true });
  });

  it("badges nothing while the machine is unknown", () => {
    expect(resolve(null, null, null)).toBeNull();
  });
});

describe("picker names", () => {
  it("calls the local machine This computer and others by name", () => {
    expect(machineChoiceLabel(mac, "MacBook", mac)).toBe(LOCAL_MACHINE_LABEL);
    expect(machineChoiceLabel(hub, "Contabo", mac)).toBe("Contabo");
    expect(pairedMachineChoice({ environmentId: mac, name: "MacBook", online: true }, mac)).toBe(
      null,
    );
    expect(
      pairedMachineChoice({ environmentId: hub, name: "Contabo", online: false }, mac),
    ).toEqual({ name: "Contabo", online: false });
  });

  it("renames only the local machine in a target list", () => {
    expect(
      nameLocalMachine(
        [
          { environmentId: mac, name: "MacBook" },
          { environmentId: hub, name: "Contabo" },
        ],
        mac,
      ).map((machine) => machine.name),
    ).toEqual([LOCAL_MACHINE_LABEL, "Contabo"]);
  });
});

describe("describeRemoteMachine", () => {
  it("names the machine and says when it is offline", () => {
    expect(describeRemoteMachine({ name: "Contabo", online: true })).toBe("Runs on Contabo");
    expect(describeRemoteMachine({ name: "Contabo", online: false })).toBe(
      "Runs on Contabo, offline",
    );
  });
});
