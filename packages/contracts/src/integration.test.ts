import * as Schema from "effect/Schema";
import {
  Integration,
  IntegrationAddToolInput,
  IntegrationSaveOAuthClientInput,
  IntegrationUpdateByNameInput,
} from "./integration.ts";
import { INTEGRATION_CATALOG, integrationIcon } from "./integrationCatalog.ts";
import { describe, expect, it } from "vite-plus/test";
import { AuthStandardClientScopes } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("integration RPC permissions", () => {
  it("guards integration reads and writes with environment scopes", () => {
    for (const method of [
      WS_METHODS.repoMcpTrustSubscribe,
      WS_METHODS.integrationsList,
      WS_METHODS.integrationsSubscribe,
      WS_METHODS.integrationsSubscribeSources,
    ]) {
      expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:read"]);
    }
    for (const method of [
      WS_METHODS.repoMcpTrustRespond,
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

const decodeIntegration = Schema.decodeUnknownSync(Integration);
const decodeAddTool = Schema.decodeUnknownSync(IntegrationAddToolInput);
const update = Schema.decodeUnknownSync(IntegrationUpdateByNameInput);

describe("integration setup notes", () => {
  const stored = {
    id: "integration:google",
    name: "google-personal",
    displayName: "Google Workspace",
    transport: "http",
    url: "https://accounts.google.com",
    headers: {},
    enabled: true,
    scope: { type: "all" },
    hint: "",
    createdAt: "2026-10-26T04:00:00.000Z",
    updatedAt: "2026-10-26T04:00:00.000Z",
    deletedAt: null,
  };
  const notes =
    "GCP project cogenly-a1b2 (Cogenly); OAuth client Cogenly 123.apps.googleusercontent.com";

  it("round-trips stored notes with their timestamp, and older definitions without them", () => {
    const decoded = decodeIntegration({
      ...stored,
      setupNotes: notes,
      setupNotesUpdatedAt: "2026-10-26T04:45:00.000Z",
    });
    expect(decoded).toMatchObject({
      setupNotes: notes,
      setupNotesUpdatedAt: "2026-10-26T04:45:00.000Z",
    });
    expect(decodeIntegration(stored)).not.toHaveProperty("setupNotes");
    // Stored notes are never blank; clearing removes the field instead.
    expect(() => decodeIntegration({ ...stored, setupNotes: "  " })).toThrow();
  });

  it("lets agents write notes on add and update, bounded in length", () => {
    expect(
      decodeAddTool({
        catalogId: "google-workspace",
        accountLabel: "personal",
        setupNotes: notes,
      }).setupNotes,
    ).toBe(notes);
    // An empty string is how an update clears them.
    expect(update({ name: "google-personal", setupNotes: "" }).setupNotes).toBe("");
    expect(() => update({ name: "google-personal", setupNotes: "x".repeat(4001) })).toThrow();
  });
});

describe("private OAuth client targets", () => {
  const decode = Schema.decodeUnknownSync(IntegrationSaveOAuthClientInput);
  const fields = { clientId: "id", clientSecret: "secret" };
  it("requires an account id for a custom server, and permits catalog setup before an account exists", () => {
    expect(decode({ ...fields, integrationId: "integration:custom" })).toMatchObject({
      integrationId: "integration:custom",
    });
    expect(decode({ ...fields, catalogId: "slack" })).toMatchObject({ catalogId: "slack" });
    expect(() => decode(fields)).toThrow();
  });
});

describe("integration icons", () => {
  it("keeps catalog marks on both complete endpoints and old origin-only definitions", () => {
    for (const entry of INTEGRATION_CATALOG) {
      if (entry.kind !== "remote") continue;
      for (const url of [entry.url, `${new URL(entry.url).origin}/`])
        expect(integrationIcon({ transport: "http", url, icon: "github" })).toEqual({
          icon: entry.icon,
        });
    }
  });

  it("uses custom marks or images, then the cached site icon by host without private URL parts", () => {
    const custom = {
      transport: "http" as const,
      url: "https://example.com/mcp/private?token=secret",
    };
    expect(integrationIcon(custom)).toEqual({ icon: null, faviconHost: "example.com" });
    expect(integrationIcon({ ...custom, url: "http://example.com/mcp" })).toEqual({ icon: null });
    expect(integrationIcon({ ...custom, iconUrl: "https://example.com/brand.png" })).toEqual({
      icon: null,
      iconUrl: "https://example.com/brand.png",
    });
    expect(integrationIcon({ ...custom, icon: "linear" })).toEqual({ icon: "linear" });
    expect(integrationIcon({ transport: "stdio", url: "https://localhost" })).toEqual({
      icon: null,
    });
  });

  it("accepts an agent's public icon override and rejects URLs carrying credentials", () => {
    const decode = Schema.decodeUnknownSync(IntegrationUpdateByNameInput);
    expect(decode({ name: "custom", iconUrl: "https://example.com/brand.png" })).toMatchObject({
      iconUrl: "https://example.com/brand.png",
    });
    for (const iconUrl of [
      "javascript:alert(1)",
      "https://user:secret@example.com/icon",
      "https://example.com/icon?token=secret",
      "http://example.com/icon",
    ])
      expect(() => decode({ name: "custom", iconUrl })).toThrow();
  });
});
