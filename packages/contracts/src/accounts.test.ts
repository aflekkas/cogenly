import { describe, expect, it } from "@effect/vitest";
import { CLIENT_GUARDED_RPC_SCOPES } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("account RPC permissions", () => {
  it("protects reads and all mutations with the destination environment's scopes", () => {
    for (const method of [WS_METHODS.accountsList, WS_METHODS.accountsGet])
      expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe("orchestration:read");
    for (const method of [
      WS_METHODS.accountsCreate,
      WS_METHODS.accountsUpdate,
      WS_METHODS.accountsDisconnect,
      WS_METHODS.accountsUse,
      WS_METHODS.accountsRemoveAccess,
    ])
      expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe("orchestration:operate");
  });
});
