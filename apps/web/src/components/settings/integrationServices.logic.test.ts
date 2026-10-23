import {
  IntegrationError,
  type Integration,
  type IntegrationSummary,
  type ProjectLabelId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_INTEGRATION_DRAFT,
  credentialReference,
  credentialReferencesIn,
  draftChanges,
  draftFromIntegration,
  insertCredentialReference,
  integrationErrorText,
  integrationStatus,
  referenceableVaultItems,
  rowsToHeaders,
  scopeLabel,
  slugifyIntegrationName,
  testResultReason,
  unresolvedCredentialReferences,
  urlHost,
  validateIntegrationDraft,
  withDisplayName,
} from "./integrationServices.logic";

const integration = {
  id: "integration:1",
  name: "gmail",
  displayName: "Gmail",
  transport: "http",
  url: "https://mcp.example.com/gmail",
  headers: { Authorization: "Bearer {{credential:gmail.password}}" },
  enabled: true,
  scope: { type: "all" },
  hint: "",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
} as unknown as Integration;

const summary = (overrides: Partial<IntegrationSummary> = {}): IntegrationSummary => ({
  integration,
  status: "unknown",
  toolCount: null,
  ...overrides,
});

describe("slugifyIntegrationName", () => {
  it("makes an agent-callable slug from a display name", () => {
    expect(slugifyIntegrationName("Gmail (Work)")).toBe("gmail-work");
    expect(slugifyIntegrationName("  Café Notes!! ")).toBe("cafe-notes");
    expect(slugifyIntegrationName("--Linear_v2")).toBe("linear_v2");
    expect(slugifyIntegrationName("日本")).toBe("");
  });

  it("stays within the name limit without a trailing dash", () => {
    const slug = slugifyIntegrationName(`${"a".repeat(63)} b`);
    expect(slug).toBe("a".repeat(63));
  });
});

describe("headers", () => {
  it("drops blank rows and rejects half-filled or repeated names", () => {
    expect(
      rowsToHeaders([
        { key: "Authorization", value: "Bearer x" },
        { key: " ", value: "" },
      ]),
    ).toEqual({ headers: { Authorization: "Bearer x" } });
    expect(rowsToHeaders([{ key: "", value: "x" }])).toHaveProperty("error");
    expect(rowsToHeaders([{ key: "Bad Name", value: "x" }])).toHaveProperty("error");
    expect(
      rowsToHeaders([
        { key: "X-Key", value: "a" },
        { key: "x-key", value: "b" },
      ]),
    ).toHaveProperty("error");
  });

  it("inserts a vault reference after a typed prefix", () => {
    const ref = credentialReference("gmail", "password");
    expect(ref).toBe("{{credential:gmail.password}}");
    expect(insertCredentialReference("", ref)).toBe(ref);
    expect(insertCredentialReference("Bearer", ref)).toBe(`Bearer ${ref}`);
    expect(insertCredentialReference("Bearer ", ref)).toBe(`Bearer ${ref}`);
  });

  it("parses references like the server, splitting on the last dot", () => {
    expect(
      credentialReferencesIn("Bearer {{credential:work.gmail.value}} {{credential:x}}"),
    ).toEqual([
      { item: "work.gmail", field: "value" },
      { item: "x", field: "" },
    ]);
  });

  it("flags references no vault item can fill", () => {
    const vault = [{ name: "gmail", fields: ["password"] as const }];
    expect(
      unresolvedCredentialReferences(
        {
          A: "{{credential:gmail.password}}",
          B: "{{credential:gmail.totp}} {{credential:x.value}}",
        },
        vault,
      ),
    ).toEqual([
      { item: "gmail", field: "totp" },
      { item: "x", field: "value" },
    ]);
  });

  it("offers only items a template can name", () => {
    expect(
      referenceableVaultItems([
        { name: "zeta", fields: ["value"] },
        { name: "empty", fields: [] },
        { name: "odd}name", fields: ["value"] },
        { name: "alpha", fields: ["password"] },
      ]).map((item) => item.name),
    ).toEqual(["alpha", "zeta"]);
  });
});

describe("integrationStatus", () => {
  const failed = {
    updatedAt: integration.updatedAt,
    result: {
      status: "disconnected" as const,
      toolCount: 0,
      message: "Could not connect (upstream_timeout).",
    },
  };

  it("prefers off, then a test of this version, then cached tools", () => {
    expect(
      integrationStatus(summary({ integration: { ...integration, enabled: false } }), failed),
    ).toMatchObject({ label: "Off", tone: "neutral" });
    expect(integrationStatus(summary({ status: "connected", toolCount: 4 }), failed)).toMatchObject(
      { tone: "error", reason: "The server took too long to answer." },
    );
    expect(
      integrationStatus(summary(), {
        updatedAt: integration.updatedAt,
        result: { status: "connected", toolCount: 1, message: "" },
      }),
    ).toEqual({ tone: "success", label: "Connected", reason: null, toolCount: 1 });
    expect(integrationStatus(summary({ status: "connected", toolCount: 4 }), undefined)).toEqual({
      tone: "success",
      label: "Connected",
      reason: null,
      toolCount: 4,
    });
    expect(integrationStatus(summary(), undefined)).toMatchObject({ label: "Not checked" });
  });

  it("drops a test once the integration changes", () => {
    expect(
      integrationStatus(summary(), { ...failed, updatedAt: "2026-09-01T00:00:00.000Z" }),
    ).toMatchObject({ label: "Not checked" });
  });

  it("words RPC failures plainly", () => {
    expect(
      integrationErrorText(new IntegrationError({ operation: "create", reason: "conflict" })),
    ).toBe("Another integration already uses this name.");
    expect(integrationErrorText(new Error("Socket closed"))).toBe("Socket closed");
    expect(integrationErrorText(undefined)).toBe("The server rejected the change.");
  });

  it("keeps an unrecognised failure message as written", () => {
    expect(
      testResultReason({ status: "disconnected", toolCount: 0, message: "Something odd" }),
    ).toBe("Something odd");
  });
});

describe("display helpers", () => {
  it("shows a host and a scope", () => {
    expect(urlHost("https://mcp.example.com:8443/x")).toBe("mcp.example.com:8443");
    expect(urlHost("not a url")).toBe("not a url");
    const labels = [{ id: "a", name: "Cogenly" }];
    expect(scopeLabel({ type: "all" }, labels)).toBe("All projects");
    expect(
      scopeLabel(
        { type: "projects", labelIds: ["a", "gone"] as unknown as ProjectLabelId[] },
        labels,
      ),
    ).toBe("Cogenly");
  });
});

describe("drafts", () => {
  it("follows the display name until the name is edited", () => {
    const named = withDisplayName(EMPTY_INTEGRATION_DRAFT, "My Linear");
    expect(named.name).toBe("my-linear");
    const edited = withDisplayName({ ...named, name: "linear", nameEdited: true }, "Linear");
    expect(edited.name).toBe("linear");
  });

  it("validates and builds the create fields", () => {
    const draft = {
      ...withDisplayName(EMPTY_INTEGRATION_DRAFT, "Gmail"),
      url: " https://mcp.example.com/gmail ",
      headers: [{ key: "Authorization", value: "Bearer {{credential:gmail.password}}" }],
    };
    expect(validateIntegrationDraft(draft)).toEqual({
      fields: {
        name: "gmail",
        displayName: "Gmail",
        transport: "http",
        url: "https://mcp.example.com/gmail",
        headers: { Authorization: "Bearer {{credential:gmail.password}}" },
        scope: { type: "all" },
        hint: "",
      },
    });
    expect(validateIntegrationDraft({ ...draft, url: "ftp://x" })).toHaveProperty("error");
    expect(validateIntegrationDraft({ ...draft, name: "Bad" })).toHaveProperty("error");
    expect(validateIntegrationDraft({ ...draft, scope: "projects" })).toHaveProperty("error");
  });

  it("round-trips a stored integration without reporting a change", () => {
    const draft = draftFromIntegration(integration);
    const result = validateIntegrationDraft(draft);
    if ("error" in result) throw new Error(result.error);
    expect(draftChanges(integration, result.fields)).toBe(false);
    const changed = validateIntegrationDraft({ ...draft, hint: "Work inbox" });
    if ("error" in changed) throw new Error(changed.error);
    expect(draftChanges(integration, changed.fields)).toBe(true);
  });
});
