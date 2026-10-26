import { describe, expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import * as Schema from "effect/Schema";
import { MachineCreatePeerGrantInput, PeerPush } from "./machine.ts";
import { WS_METHODS } from "./rpc.ts";

const isCreatePeerGrantInput = Schema.is(MachineCreatePeerGrantInput);
const decodePush = Schema.decodeUnknownSync(PeerPush);
const decodeLegacyPush = Schema.decodeUnknownSync(
  Schema.TaggedStruct("Machines", { machines: Schema.Array(Schema.Unknown) }),
);

describe("machine RPC permissions", () => {
  it("requires the intended spoke key before issuing a pairing grant", () => {
    expect(isCreatePeerGrantInput({})).toBe(false);
    expect(isCreatePeerGrantInput({ spokeKeyThumbprint: "" })).toBe(false);
    expect(isCreatePeerGrantInput({ spokeKeyThumbprint: "prepared-key" })).toBe(true);
  });

  it("lets readers see machines and keeps pairing behind access management", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.machinesList, {})).toEqual(["orchestration:read"]);
    expect(clientRpcRequiredScopes(WS_METHODS.machinesCatalog, {})).toEqual(["orchestration:read"]);
    expect(clientRpcRequiredScopes(WS_METHODS.machinesSubscribe, {})).toEqual([
      "orchestration:read",
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.syncStatus, {})).toEqual(["orchestration:read"]);
    expect(clientRpcRequiredScopes(WS_METHODS.machinesForkThread, {})).toEqual([
      "orchestration:operate",
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.machinesUpdate, {})).toEqual(["settings:write"]);
    for (const method of [
      WS_METHODS.machinesPrepareJoin,
      WS_METHODS.machinesCreatePeerGrant,
      WS_METHODS.machinesJoinHub,
      WS_METHODS.machinesUnpair,
      // Setup installs software, exposes the server, and carries sign-in links.
      WS_METHODS.machinesSetupStatus,
      WS_METHODS.machinesSetupSubscribe,
      WS_METHODS.machinesSetupRunStep,
      WS_METHODS.machinesSetupDisableServe,
    ]) {
      expect(clientRpcRequiredScopes(method, {})).toEqual(["access:write"]);
    }
  });
});

it("exchanges Machines pushes with 0.3.2 peers that omit routes or ignore new fields", () => {
  const oldPush = { _tag: "Machines", machines: [] };
  expect(decodePush(oldPush)).toEqual(oldPush);
  expect(decodeLegacyPush({ ...oldPush, hubRoutes: ["https://hub.ts.net/"] })).toEqual(oldPush);
});
