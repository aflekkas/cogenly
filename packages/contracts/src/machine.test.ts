import { describe, expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("machine RPC permissions", () => {
  it("lets readers see machines and keeps pairing behind access management", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.machinesList, {})).toEqual(["orchestration:read"]);
    expect(clientRpcRequiredScopes(WS_METHODS.machinesSubscribe, {})).toEqual([
      "orchestration:read",
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.machinesUpdate, {})).toEqual(["settings:write"]);
    for (const method of [
      WS_METHODS.machinesPrepareJoin,
      WS_METHODS.machinesCreatePeerGrant,
      WS_METHODS.machinesJoinHub,
      WS_METHODS.machinesUnpair,
    ]) {
      expect(clientRpcRequiredScopes(method, {})).toEqual(["access:write"]);
    }
  });
});
