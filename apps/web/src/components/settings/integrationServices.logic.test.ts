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
  integrationTitle,
  referenceableVaultItems,
  rowsToHeaders,
  scopeLabel,
  signInAction,
  slugifyIntegrationName,
  testResultReason,
  unresolvedCredentialReferences,
  updateInputFromDraft,
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

  it("shows a missing sign-in over any test, and the server's error with when it checked", () => {
    const oauth = { ...integration, auth: { type: "oauth" as const } };
    const needs = summary({
      integration: oauth,
      status: "needs_sign_in",
      message: "The sign-in was revoked or expired. Sign in again.",
    });
    expect(integrationStatus(needs, failed)).toMatchObject({
      tone: "warning",
      label: "Needs sign-in",
      reason: "The sign-in was revoked or expired. Sign in again.",
    });
    expect(signInAction(needs)).toBe("Sign in");
    expect(signInAction(summary({ integration: oauth, status: "connected" }))).toBe("Reconnect");
    expect(signInAction(summary({ status: "connected" }))).toBeNull();
    expect(
      integrationStatus(
        summary({
          status: "error",
          message: "The server could not be reached.",
          checkedAt: "2026-10-01T00:00:00.000Z" as IntegrationSummary["checkedAt"] & string,
        }),
        undefined,
      ),
    ).toEqual({
      tone: "error",
      label: "Error",
      reason: "The server could not be reached.",
      toolCount: null,
      checkedAt: "2026-10-01T00:00:00.000Z",
    });
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
  it("shows current process health ahead of a stale successful connection test", () => {
    const runningTest = {
      updatedAt: integration.updatedAt,
      result: { status: "connected" as const, toolCount: 1, message: "" },
    };
    expect(
      integrationStatus(
        summary({ managed: { state: "failed", version: "2.1.2", stderrTail: "Process exited" } }),
        runningTest,
      ),
    ).toMatchObject({ label: "Failed", tone: "error", reason: "Process exited" });
    expect(
      integrationStatus(
        summary({ managed: { state: "starting", version: "2.1.2", stderrTail: "" } }),
        undefined,
      ),
    ).toMatchObject({ label: "Starting" });
    // A managed Google account without a grant signs in like a remote OAuth one.
    const google = summary({
      integration: { ...integration, transport: "local", headers: {} },
      status: "needs_sign_in",
      managed: { state: "running", version: "2.1.2", stderrTail: "" },
    });
    expect(integrationStatus(google, runningTest)).toMatchObject({ label: "Needs sign-in" });
    expect(signInAction(google)).toBe("Sign in");
    expect(signInAction({ ...google, status: "connected" })).toBeNull();
  });
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
  it("keeps a managed account local when editing its display name", () => {
    const local = { ...integration, transport: "local" as const, headers: {} };
    const fields = validateIntegrationDraft({
      ...draftFromIntegration(local),
      displayName: "Google · work",
    });
    if ("error" in fields) throw new Error(fields.error);
    expect(updateInputFromDraft(local, fields.fields)).toMatchObject({
      transport: "local",
      displayName: "Google · work",
    });
  });
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

  it("carries the account label and OAuth settings, and turns OAuth off explicitly", () => {
    const stored = {
      ...integration,
      headers: {},
      accountLabel: "Spawn Partners",
      auth: {
        type: "oauth" as const,
        clientId: "slack-app",
        clientSecret: "{{credential:slack-app.password}}",
        scope: "chat:write",
      },
    } as Integration;
    expect(integrationTitle(stored)).toBe("Gmail · Spawn Partners");
    const draft = draftFromIntegration(stored);
    const result = validateIntegrationDraft(draft);
    if ("error" in result) throw new Error(result.error);
    expect(draftChanges(stored, result.fields)).toBe(false);
    // The scope is not edited in Settings, so a save keeps it.
    expect(updateInputFromDraft(stored, result.fields)).toMatchObject({
      accountLabel: "Spawn Partners",
      auth: { ...stored.auth },
    });
    const off = validateIntegrationDraft({ ...draft, oauth: false, accountLabel: " " });
    if ("error" in off) throw new Error(off.error);
    expect(updateInputFromDraft(stored, off.fields)).toMatchObject({
      auth: null,
      accountLabel: "",
    });

    expect(validateIntegrationDraft({ ...draft, clientSecret: "pasted-secret" })).toHaveProperty(
      "error",
    );
    expect(validateIntegrationDraft({ ...draft, clientId: "" })).toHaveProperty("error");
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
