import { describe, expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("integration RPC permissions", () => {
  it("guards integration reads and writes with environment scopes", () => {
    for (const method of [WS_METHODS.integrationsList, WS_METHODS.integrationsSubscribe]) {
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:read"]);
    }
    for (const method of [
      WS_METHODS.integrationsCreate,
      WS_METHODS.integrationsUpdate,
      WS_METHODS.integrationsDelete,
      WS_METHODS.integrationsTestConnection,
      WS_METHODS.integrationsBeginSignIn,
    ]) {
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
    }
  });
});
