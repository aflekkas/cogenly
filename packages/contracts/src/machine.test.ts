import { describe, expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import * as Schema from "effect/Schema";
import { MachineCreatePeerGrantInput } from "./machine.ts";
import { WS_METHODS } from "./rpc.ts";

describe("machine RPC permissions", () => {
  it("requires the intended spoke key before issuing a pairing grant", () => {
    expect(Schema.is(MachineCreatePeerGrantInput)({})).toBe(false);
    expect(Schema.is(MachineCreatePeerGrantInput)({ spokeKeyThumbprint: "" })).toBe(false);
    expect(Schema.is(MachineCreatePeerGrantInput)({ spokeKeyThumbprint: "prepared-key" })).toBe(
      true,
    );
  });

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
