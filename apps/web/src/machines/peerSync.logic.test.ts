import type { EnvironmentId, SharedSyncPeerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  peerSyncIndicator,
  peerSyncLabel,
  pendingFor,
  vaultItemsWaitingText,
} from "./peerSync.logic";

const label = (input: Parameters<typeof peerSyncIndicator>[0]) =>
  peerSyncLabel(peerSyncIndicator(input));

describe("peerSyncIndicator", () => {
  it("shows progress only for an online machine", () => {
    expect(label({ machine: "Hub", online: true, pending: 0 })).toBe("Synced");
    expect(label({ machine: "Hub", online: true, pending: 1 })).toBe("Syncing 1 change");
    expect(label({ machine: "Hub", online: true, pending: 4 })).toBe("Syncing 4 changes");
    expect(label({ machine: "Hub", online: false, pending: 4 })).toBe("Offline");
  });

  it("puts the owner's sharing choice ahead of presence", () => {
    expect(label({ machine: "Hub", online: false, pending: 2, sharing: "not_shared" })).toBe(
      "Not shared",
    );
    expect(label({ machine: "Hub", online: false, pending: 0, sharing: "key_changed" })).toBe(
      "Key changed: unpair and pair again",
    );
  });

  it("waits on a machine that has not shared back, then follows progress", () => {
    expect(label({ machine: "Hub", online: true, pending: 3, sharing: "waiting_for_peer" })).toBe(
      "Waiting for Hub to share back",
    );
    expect(label({ machine: "Hub", online: false, pending: 0, sharing: "waiting_for_peer" })).toBe(
      "Offline",
    );
    expect(label({ machine: "Hub", online: true, pending: 3, sharing: "shared" })).toBe(
      "Syncing 3 changes",
    );
    expect(label({ machine: "Hub", online: true, pending: 0, sharing: "shared" })).toBe("Synced");
  });
});

describe("pendingFor", () => {
  it("reads one kind's count and treats a missing status as nothing queued", () => {
    const peer: SharedSyncPeerStatus = {
      environmentId: "env-hub" as EnvironmentId,
      label: "Hub",
      online: true,
      relation: "hub",
      kinds: [
        { kind: "fact", pendingOutgoing: 2 },
        { kind: "vault", pendingOutgoing: 5 },
      ],
    };
    expect(pendingFor(peer, "vault")).toBe(5);
    expect(pendingFor(peer, "project")).toBe(0);
    expect(pendingFor(undefined, "fact")).toBe(0);
  });
});

describe("vaultItemsWaitingText", () => {
  it("says nothing until an item waits", () => {
    expect(vaultItemsWaitingText(0)).toBeNull();
    expect(vaultItemsWaitingText(1)).toBe(
      "1 item from another machine is waiting until you share with it.",
    );
    expect(vaultItemsWaitingText(3)).toBe(
      "3 items from other machines are waiting until you share with them.",
    );
  });
});
