import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CLIENT_GUARDED_RPC_SCOPES } from "./clientRpcPermissions.ts";
import { ProviderAuthResponse, ProviderAuthState } from "./providerSetup.ts";
import { WS_METHODS } from "./rpc.ts";

const decodeResponse = Schema.decodeUnknownSync(ProviderAuthResponse);
const decodeState = Schema.decodeUnknownSync(ProviderAuthState);

describe("provider sign-in permissions", () => {
  it("guards every sign-in change with the destination's providers scope", () => {
    for (const method of [
      WS_METHODS.providerAuthStart,
      WS_METHODS.providerAuthRespond,
      WS_METHODS.providerAuthComplete,
      WS_METHODS.providerAuthCancel,
      WS_METHODS.providerAuthLogout,
    ])
      expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe("providers:manage");
  });
});

describe("provider credential responses", () => {
  it("accepts the advertised field limit and rejects oversized or invalid fields", () => {
    const values = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`field_${i}`, "value"]),
    );
    expect(decodeResponse({ type: "credentials", values })).toEqual({
      type: "credentials",
      values,
    });
    expect(() =>
      decodeResponse({ type: "credentials", values: { ...values, extra: "value" } }),
    ).toThrow();
    expect(() => decodeResponse({ type: "credentials", values: { "": "value" } })).toThrow();
    expect(() =>
      decodeResponse({ type: "credentials", values: { token: "x".repeat(16_385) } }),
    ).toThrow();
  });
});

describe("provider auth state", () => {
  it("drops auth variants from newer servers instead of rejecting the state", () => {
    const method = { id: "browser", name: "Browser", description: null, type: "agent" };
    expect(
      decodeState({
        instanceId: "cursor",
        phase: "waiting",
        flowId: null,
        authorizationUrl: null,
        expiresAt: null,
        message: null,
        methods: [method, { ...method, id: "passkey", type: "passkey" }],
        interaction: { type: "passkey", id: "passkey" },
        credentialOwner: "keychain",
      }),
    ).toEqual({
      instanceId: "cursor",
      phase: "waiting",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      methods: [method],
    });
  });
});
