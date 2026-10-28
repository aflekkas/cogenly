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
  const known = { name: "Contabo", online: true };

  it("badges nothing for work on this computer, even when it is a replica's owner", () => {
    expect(
      resolveRemoteMachine({
        runsOn: mac,
        localEnvironmentId: mac,
        connected: null,
        paired: known,
      }),
    ).toBeNull();
  });

  it("badges a hub thread seen from the Mac, and a Mac thread seen from the hub's browser", () => {
    expect(
      resolveRemoteMachine({
        runsOn: hub,
        localEnvironmentId: mac,
        connected: known,
        paired: null,
      }),
    ).toEqual(known);
    expect(
      resolveRemoteMachine({
        runsOn: mac,
        localEnvironmentId: hub,
        connected: null,
        paired: { name: "MacBook", online: false },
      }),
    ).toEqual({ name: "MacBook", online: false });
  });

  it("prefers the connected environment's own name over a pairing report", () => {
    expect(
      resolveRemoteMachine({
        runsOn: studio,
        localEnvironmentId: mac,
        connected: { name: "Studio", online: true },
        paired: { name: "studio.local", online: false },
      }),
    ).toEqual({ name: "Studio", online: true });
  });

  it("still shows a cloud for a machine neither source knows yet", () => {
    expect(
      resolveRemoteMachine({
        runsOn: studio,
        localEnvironmentId: mac,
        connected: null,
        paired: null,
      }),
    ).toEqual({ name: "Another machine", online: true });
  });

  it("badges nothing while the machine is unknown", () => {
    expect(
      resolveRemoteMachine({
        runsOn: null,
        localEnvironmentId: mac,
        connected: null,
        paired: null,
      }),
    ).toBeNull();
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
