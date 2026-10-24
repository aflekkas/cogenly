import { describe, expect, it } from "vite-plus/test";
import {
  INTEGRATION_CATALOG,
  SLACK_MCP_USER_SCOPES,
  integrationCatalogEntryFor,
  type IntegrationCatalogConnectInput,
} from "@cogenly/contracts";

import { availableToConnect, resolveCatalogConnect } from "./IntegrationCatalog.ts";

const resolve = (
  request: IntegrationCatalogConnectInput,
  existingNames: ReadonlyArray<string> = [],
  requestOrigin?: string,
) => resolveCatalogConnect(request, { existingNames: new Set(existingNames), requestOrigin });

const ready = (resolution: ReturnType<typeof resolve>) => {
  if (resolution._tag !== "ready") throw new Error(resolution.message);
  return resolution;
};

describe("resolveCatalogConnect", () => {
  it("ignores Google callback origins supplied by agents", () => {
    const resolved = resolveCatalogConnect(
      {
        catalogId: "google-workspace",
        accountLabel: "work",
        inputs: { callbackOrigin: "https://attacker.example" },
      },
      { existingNames: new Set(), requestOrigin: "https://attacker.example", fromAgent: true },
    );
    expect(ready(resolved).input).not.toHaveProperty("callbackOrigin");
  });

  it("signs in to a remote OAuth service under an unused name per account", () => {
    expect(ready(resolve({ catalogId: "linear" }))).toEqual({
      _tag: "ready",
      signsIn: true,
      input: {
        name: "linear",
        displayName: "Linear",
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: {},
        scope: { type: "all" },
        hint: "",
        auth: { type: "oauth" },
      },
    });
    expect(ready(resolve({ catalogId: "linear" }, ["linear"])).input).toMatchObject({
      name: "linear-2",
    });
    expect(
      ready(resolve({ catalogId: "linear", accountLabel: "Spawn Partners" }, ["linear"])).input,
    ).toMatchObject({ name: "linear-spawn-partners", accountLabel: "Spawn Partners" });
  });

  it("sends an API key as a bearer vault reference and needs no sign-in", () => {
    const resolution = ready(
      resolve({ catalogId: "github", inputs: { apiKey: "{{credential:github-token.value}}" } }),
    );
    expect(resolution.signsIn).toBe(false);
    expect(resolution.input).toMatchObject({
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer {{credential:github-token.value}}" },
    });
    expect("auth" in resolution.input && resolution.input.auth).toBeFalsy();
    // A pasted token is never accepted.
    expect(resolve({ catalogId: "github", inputs: { apiKey: "ghp_secret" } })).toMatchObject({
      _tag: "needs",
      message: expect.stringContaining("request_secret"),
    });
  });

  it("asks for the region before choosing an endpoint", () => {
    expect(resolve({ catalogId: "intercom" })).toMatchObject({
      _tag: "needs",
      message: expect.stringContaining('"eu" (Europe)'),
    });
    expect(ready(resolve({ catalogId: "intercom", inputs: { region: "eu" } })).input).toMatchObject(
      { url: "https://mcp.eu.intercom.com/mcp", auth: { type: "oauth" } },
    );
    expect(ready(resolve({ catalogId: "intercom", inputs: { region: "us" } })).input).toMatchObject(
      { url: "https://mcp.intercom.com/mcp" },
    );
  });

  it("connects Slack only through the user's app, asking for its scopes", () => {
    expect(resolve({ catalogId: "slack" })).toMatchObject({
      _tag: "needs",
      message: expect.stringContaining('domains: ["slack.com"]'),
    });
    expect(
      ready(
        resolve({
          catalogId: "slack",
          accountLabel: "Acme",
          inputs: { clientId: "123.456", clientSecret: "{{credential:slack-acme.value}}" },
        }),
      ).input,
    ).toMatchObject({
      name: "slack-acme",
      auth: {
        type: "oauth",
        clientId: "123.456",
        clientSecret: "{{credential:slack-acme.value}}",
        scope: SLACK_MCP_USER_SCOPES.join(" "),
      },
    });
  });

  it("names Google accounts and keeps a loopback request on the configured callback", () => {
    expect(resolve({ catalogId: "google-workspace" })).toMatchObject({ _tag: "needs" });
    expect(
      ready(
        resolve(
          { catalogId: "google-workspace", accountLabel: "personal" },
          [],
          "http://127.0.0.1:3773",
        ),
      ).input,
    ).toEqual({
      preset: "google-workspace",
      accountLabel: "personal",
      name: "google-personal",
      scope: { type: "all" },
    });
    expect(
      ready(
        resolve(
          { catalogId: "google-workspace", accountLabel: "Work" },
          ["google-work"],
          "https://cogenly.example.com",
        ),
      ).input,
    ).toMatchObject({ name: "google-work-2", callbackOrigin: "https://cogenly.example.com" });
  });

  it("refuses an entry that is not available yet", () => {
    expect(resolve({ catalogId: "figma" })).toMatchObject({
      _tag: "needs",
      message: expect.stringContaining("Figma isn't available yet"),
    });
  });
});

describe("availableToConnect", () => {
  it("names connectable entries without an integration, never unavailable ones", () => {
    const available = availableToConnect([
      { transport: "http", url: "https://mcp.linear.app/mcp" },
      { transport: "http", url: "https://example.com/mcp" },
    ]);
    expect(available).toEqual([
      "google-workspace (Gmail, Calendar, Drive)",
      "notion",
      "github",
      "atlassian",
      "intercom",
      "wispr-flow",
      "slack",
      "fathom",
    ]);
  });
});

describe("integrationCatalogEntryFor", () => {
  it("groups integrations under their catalog entry, including ones added by hand", () => {
    const remote = (url: string) => integrationCatalogEntryFor({ transport: "http", url })?.id;
    expect(remote("https://mcp.linear.app/mcp/")).toBe("linear");
    expect(remote("https://api.githubcopilot.com/mcp")).toBe("github");
    expect(remote("https://mcp.eu.intercom.com/mcp")).toBe("intercom");
    expect(remote("https://example.com/mcp")).toBeUndefined();
    expect(
      integrationCatalogEntryFor({
        transport: "local",
        url: "https://accounts.google.com",
        local: { preset: "google-workspace", version: "2.1.2", callbackOrigin: "x" },
      })?.id,
    ).toBe("google-workspace");
    // Every connectable remote endpoint maps back to its own entry.
    for (const entry of INTEGRATION_CATALOG)
      if (entry.kind === "remote")
        for (const region of entry.regions) expect(remote(region.url)).toBe(entry.id);
  });
});
