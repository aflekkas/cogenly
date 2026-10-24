import { describe, expect, it } from "vite-plus/test";
import { AuthStandardClientScopes } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("integration RPC permissions", () => {
  it("guards integration reads and writes with environment scopes", () => {
    for (const method of [
      WS_METHODS.integrationsList,
      WS_METHODS.integrationsSubscribe,
      WS_METHODS.integrationsSubscribeSources,
    ]) {
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:read"]);
    }
    for (const method of [
      WS_METHODS.integrationsCreate,
      WS_METHODS.integrationsUpdate,
      WS_METHODS.integrationsDelete,
      WS_METHODS.integrationsTestConnection,
      WS_METHODS.integrationsBeginSignIn,
      WS_METHODS.integrationsConnectFromCatalog,
      WS_METHODS.integrationsSaveOAuthClient,
      WS_METHODS.integrationsSaveApiKey,
    ]) {
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
    }
    // Installing software needs the grant provider CLI installs need.
    expect(clientRpcRequiredScopes(WS_METHODS.integrationsInstallRuntime, {})).toEqual([
      "providers:manage",
    ]);
  });

  it("lets a standard paired client read the composer's sources", () => {
    const standard: ReadonlyArray<string> = AuthStandardClientScopes;
    for (const scope of clientRpcRequiredScopes(WS_METHODS.integrationsSubscribeSources, {}))
      expect(standard).toContain(scope);
  });
});
