import {
  IntegrationId,
  IntegrationName,
  integrationCatalogEntry,
  type Integration,
  type IntegrationCatalogEntry,
  type IntegrationSetupAction,
  type IntegrationSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountCounts,
  accountLabelProblem,
  addAsksForAccountLabel,
  orderAccounts,
  parseSetupSearch,
  resolveSetupTarget,
  setupControl,
} from "./integrationCatalog.logic";

const entry = (id: string): IntegrationCatalogEntry => integrationCatalogEntry(id)!;

const summary = (fields: Partial<Integration>): IntegrationSummary => ({
  integration: {
    id: IntegrationId.make(`integration:${fields.name ?? "x"}`),
    name: IntegrationName.make("x"),
    displayName: "X",
    transport: "http",
    url: "https://example.com/mcp",
    headers: {},
    enabled: true,
    scope: { type: "all" },
    hint: "",
    createdAt: "2026-10-23T00:00:00.000Z" as Integration["createdAt"],
    updatedAt: "2026-10-23T00:00:00.000Z" as Integration["updatedAt"],
    deletedAt: null,
    ...fields,
  },
  status: "connected",
  toolCount: 1,
});

describe("orderAccounts", () => {
  it("lists accounts in catalog order, then custom servers, keeping each service's order", () => {
    const custom = summary({ name: IntegrationName.make("tools") });
    // An account of a service the catalog dropped is a custom server now.
    const atlassian = summary({
      name: IntegrationName.make("atlassian"),
      url: "https://mcp.atlassian.com/v1/mcp",
    });
    const linearWork = summary({
      name: IntegrationName.make("linear-work"),
      url: "https://mcp.linear.app/mcp",
    });
    const linear = summary({
      name: IntegrationName.make("linear"),
      url: "https://mcp.linear.app/mcp/",
    });
    const google = summary({
      name: IntegrationName.make("google"),
      transport: "local",
      url: "http://127.0.0.1:9/mcp",
      local: { preset: "google-workspace", version: "1", callbackOrigin: "http://localhost" },
    });
    const rows = orderAccounts([custom, linearWork, atlassian, google, linear]);
    expect(rows.map((row) => row.summary.integration.name)).toEqual([
      "google",
      "linear-work",
      "linear",
      "tools",
      "atlassian",
    ]);
    expect(rows.map((row) => row.entry?.id)).toEqual([
      "google-workspace",
      "linear",
      "linear",
      undefined,
      undefined,
    ]);
    expect(Object.fromEntries(accountCounts(rows))).toEqual({ "google-workspace": 1, linear: 2 });
  });
});

describe("account labels", () => {
  it("always names a Google account, and any other account once the service has one", () => {
    const google = entry("google-workspace");
    const notion = entry("notion");
    expect(addAsksForAccountLabel(google, 0)).toBe(true);
    expect(accountLabelProblem(google, 0, " ")).toMatch(/Name this Google account/);
    expect(accountLabelProblem(google, 0, "personal")).toBeNull();
    expect(addAsksForAccountLabel(notion, 0)).toBe(false);
    expect(accountLabelProblem(notion, 0, "")).toBeNull();
    expect(addAsksForAccountLabel(notion, 1)).toBe(true);
    expect(accountLabelProblem(notion, 1, "")).toMatch(/Notion account you have/);
    expect(accountLabelProblem(notion, 1, "Work")).toBeNull();
  });
});

describe("setupControl", () => {
  const base = { title: "T", message: "M" };
  it("runs one-click actions from the row and opens anything with steps or a form", () => {
    const control = (action: IntegrationSetupAction, canInstall = true) =>
      setupControl(action, canInstall);
    expect(control({ type: "sign_in", ...base })).toEqual({ kind: "sign_in", label: "Sign in" });
    expect(control({ type: "retry", button: "test", ...base })).toEqual({
      kind: "test",
      label: "Test again",
    });
    expect(control({ type: "retry", button: "sign_in", ...base }).kind).toBe("sign_in");
    expect(control({ type: "fix", button: "enable", ...base })).toEqual({
      kind: "enable",
      label: "Enable",
    });
    expect(control({ type: "fix", button: "edit", ...base }).kind).toBe("edit");

    const slack: IntegrationSetupAction = {
      type: "oauth_client",
      ...base,
      catalogId: "slack",
      steps: [{ text: "Make an app" }],
    };
    expect(control(slack)).toEqual({ kind: "expand", label: "Set up", action: slack });
    // A target is needed to save the client; custom accounts use their id.
    expect(control({ ...slack, catalogId: undefined } as IntegrationSetupAction).kind).toBe("edit");
    expect(
      control({
        ...slack,
        catalogId: undefined,
        integrationId: IntegrationId.make("integration:custom"),
      } as IntegrationSetupAction).kind,
    ).toBe("expand");
    expect(control({ type: "api_key", ...base, catalogId: "github", label: "Token" }).kind).toBe(
      "expand",
    );
  });

  it("installs a missing runtime only where this connection may, otherwise shows the command", () => {
    const uv: IntegrationSetupAction = {
      type: "install_runtime",
      ...base,
      runtime: "uv",
      canInstall: true,
      command: "brew install uv",
    };
    expect(setupControl(uv, true)).toEqual({ kind: "install", label: "Install uv" });
    expect(setupControl(uv, false).kind).toBe("expand");
    expect(setupControl({ ...uv, canInstall: false }, true).kind).toBe("expand");
  });
});

describe("?setup=", () => {
  it("reads a trimmed id, including one the router turned into a number", () => {
    expect(parseSetupSearch(" slack ")).toBe("slack");
    expect(parseSetupSearch(42)).toBe("42");
    expect(parseSetupSearch("")).toBeUndefined();
    expect(parseSetupSearch(["slack"])).toBeUndefined();
    expect(parseSetupSearch("x".repeat(201))).toBeUndefined();
  });

  it("opens an account by id, else a catalog service, else nothing", () => {
    const linear = summary({
      name: IntegrationName.make("linear"),
      url: "https://mcp.linear.app/mcp",
    });
    expect(resolveSetupTarget("integration:linear", [linear])).toEqual({
      kind: "account",
      id: "integration:linear",
    });
    expect(resolveSetupTarget("google-workspace", [linear])).toEqual({
      kind: "catalog",
      catalogId: "google-workspace",
    });
    expect(resolveSetupTarget("atlassian", [linear])).toBeNull();
  });
});
