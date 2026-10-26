import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { IntegrationAgentResult, IntegrationError, IntegrationSource } from "./integration.ts";
import { MachineProvider } from "./machine.ts";
import { ProviderAuthStartInput } from "./providerSetup.ts";
import { VaultItemMetadata, VaultListInput, VaultListResult, VaultPolicy } from "./vault.ts";

/**
 * Paired machines and clients upgrade one at a time. Each case decodes what
 * the other side sends: a new payload with an older schema (rebuilt from the
 * fields it had), and an older payload with the current one.
 */

const source = {
  id: "integration:custom-1",
  name: "custom",
  displayName: "Custom",
  icon: null,
  serviceName: "Custom",
  accountLabel: null,
  status: "connected",
  scope: { type: "all" },
};

const login = {
  id: "vault:1",
  name: "GitHub",
  type: "login",
  scopeProjectId: null,
  allowedDomains: ["github.com"],
  policy: { mode: "allow", allowedAgentIds: [], allowedDomains: [] },
  fields: ["username", "password"],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("integration results across versions", () => {
  it("decodes a result without settingsUrl on an older client, and ignores one from an older server", () => {
    const { nextStep } = IntegrationAgentResult.fields;
    const older = Schema.Struct({ nextStep, settingsUrl: Schema.optional(Schema.String) });
    expect(Schema.decodeUnknownSync(older)({ nextStep: "Use the inline card." })).toEqual({
      nextStep: "Use the inline card.",
    });
    expect(
      Schema.decodeUnknownSync(IntegrationAgentResult)({
        nextStep: "Open Settings",
        settingsUrl: "https://example.com/settings/integrations",
      }),
    ).toEqual({ nextStep: "Open Settings" });
  });

  it("decodes sources with or without the cached-favicon host", () => {
    const { faviconHost: _, iconUrl: _iconUrl, ...olderFields } = IntegrationSource.fields;
    const fromNewer = { ...source, faviconHost: "example.com" };
    expect(Schema.decodeUnknownSync(Schema.Struct(olderFields))(fromNewer)).not.toHaveProperty(
      "faviconHost",
    );
    expect(Schema.decodeUnknownSync(IntegrationSource)(source)).not.toHaveProperty("faviconHost");
  });

  it("decodes an integration error with or without OAuth diagnostics", () => {
    const decode = Schema.decodeUnknownSync(IntegrationError);
    const error = { _tag: "IntegrationError", operation: "sign in", reason: "upstream_error" };
    expect(decode(error).message).toBe("Could not sign in integration (upstream_error).");
    expect(
      decode({ ...error, oauthFailure: { stage: "token", host: "example.com", status: 400 } })
        .message,
    ).toBe("OAuth token failed at example.com (HTTP 400).");
  });
});

describe("vault lists across versions", () => {
  it("decodes logins without username, links or grouped sites from an older server", () => {
    const result = Schema.decodeUnknownSync(VaultListResult)({ items: [login] });
    expect(result.sites).toBeUndefined();
    expect(result.items[0]?.username).toBeUndefined();
  });

  it("lets an older client skip the username, links and site groups", () => {
    const { username: _, integrationIds: _ids, ...olderFields } = VaultItemMetadata.fields;
    const older = Schema.Struct({ items: Schema.Array(Schema.Struct(olderFields)) });
    const decoded = Schema.decodeUnknownSync(older)({
      items: [{ ...login, username: "octocat", integrationIds: ["integration:github-1"] }],
      sites: [{ host: "github.com", siteName: "GitHub", logins: [] }],
    });
    expect(decoded.items[0]).not.toHaveProperty("username");
  });

  it("decodes Block on a current client, and only its Ask stand-in on a 0.3.2 client", () => {
    const { policy: _, ...olderItemFields } = VaultItemMetadata.fields;
    const olderPolicy = Schema.Struct({
      ...VaultPolicy.fields,
      mode: Schema.Literals(["ask", "allow"]),
    });
    const older = Schema.Struct({
      items: Schema.Array(Schema.Struct({ ...olderItemFields, policy: olderPolicy })),
    });
    const blocked = { ...login, policy: { ...login.policy, mode: "deny" } };
    expect(
      Schema.decodeUnknownSync(VaultListResult)({ items: [blocked] }).items[0]?.policy.mode,
    ).toBe("deny");
    expect(() => Schema.decodeUnknownSync(older)({ items: [login, blocked] })).toThrow();
    const asked = { ...login, policy: { ...login.policy, mode: "ask" } };
    expect(
      Schema.decodeUnknownSync(older)({ items: [login, asked] }).items.map(
        (item) => item.policy.mode,
      ),
    ).toEqual(["allow", "ask"]);
  });

  it("lets a 0.3.2 server ignore the Block capability a current client sends", () => {
    const older = Schema.Struct({ scopeProjectId: VaultListInput.fields.scopeProjectId });
    expect(Schema.decodeUnknownSync(older)({ supportsDenyPolicy: true })).toEqual({});
  });
});

describe("provider sign-in across versions", () => {
  it("decodes machine providers without install or sign-in capability", () => {
    const provider = Schema.decodeUnknownSync(MachineProvider)({
      instanceId: "codex",
      displayName: "Codex",
      enabled: true,
      auth: "authenticated",
    });
    expect(provider.installed).toBeUndefined();
    expect(provider.canAuthenticate).toBeUndefined();
  });

  it("starts sign-in on this machine when no target machine is named", () => {
    expect(
      Schema.decodeUnknownSync(ProviderAuthStartInput)({ instanceId: "codex" }),
    ).not.toHaveProperty("targetEnvironmentId");
  });
});
