import {
  IntegrationId,
  IntegrationName,
  integrationCatalogEntry,
  type Integration,
  type IntegrationCatalogEntry,
  type IntegrationSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  catalogAction,
  catalogConnectRequest,
  catalogDraftSignsIn,
  emptyCatalogDraft,
  groupByCatalog,
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

describe("catalog buttons", () => {
  it("offers Connect, then Add account once one is connected, and nothing for Figma", () => {
    const linear = summary({
      name: IntegrationName.make("linear"),
      url: "https://mcp.linear.app/mcp",
    });
    const custom = summary({ name: IntegrationName.make("tools") });
    const { groups, custom: unmatched } = groupByCatalog([linear, custom]);
    const actions = Object.fromEntries(
      groups.map((group) => [group.entry.id, catalogAction(group.entry, group.accounts)]),
    );
    expect(actions).toMatchObject({
      linear: "Add account",
      notion: "Connect",
      "google-workspace": "Connect",
      figma: "Not available yet",
    });
    expect(groups.find((group) => group.entry.id === "linear")?.accounts).toEqual([linear]);
    expect(unmatched).toEqual([custom]);
  });
});

describe("catalogConnectRequest", () => {
  it("asks only for what the chosen way to connect needs", () => {
    const linear = entry("linear");
    expect(catalogConnectRequest(linear, emptyCatalogDraft(linear), 0)).toEqual({
      request: { catalogId: "linear", inputs: { auth: "oauth" } },
    });
    const withKey = { ...emptyCatalogDraft(linear), auth: "api_key" as const };
    expect(catalogConnectRequest(linear, withKey, 0)).toEqual({
      error: "Pick the API key from the vault with the key button.",
    });
    expect(catalogDraftSignsIn(linear, withKey)).toBe(false);
    expect(
      catalogConnectRequest(linear, { ...withKey, apiKey: "{{credential:linear.value}}" }, 0),
    ).toEqual({
      request: {
        catalogId: "linear",
        inputs: { auth: "api_key", apiKey: "{{credential:linear.value}}" },
      },
    });
  });

  it("needs a region, an app's credentials, or a Google account name where those apply", () => {
    const intercom = entry("intercom");
    expect(catalogConnectRequest(intercom, emptyCatalogDraft(intercom), 0)).toEqual({
      error: "Choose where your Intercom workspace is hosted.",
    });
    expect(
      catalogConnectRequest(intercom, { ...emptyCatalogDraft(intercom), region: "eu" }, 0),
    ).toMatchObject({ request: { inputs: { region: "eu" } } });

    const slack = entry("slack");
    expect(catalogConnectRequest(slack, emptyCatalogDraft(slack), 0)).toEqual({
      error: "Enter the app's client ID.",
    });
    expect(
      catalogConnectRequest(
        slack,
        {
          ...emptyCatalogDraft(slack),
          clientId: "1.2",
          clientSecret: "{{credential:slack.value}}",
        },
        0,
      ),
    ).toMatchObject({
      request: { inputs: { clientId: "1.2", clientSecret: "{{credential:slack.value}}" } },
    });

    const google = entry("google-workspace");
    expect(catalogDraftSignsIn(google, emptyCatalogDraft(google))).toBe(true);
    expect(catalogConnectRequest(google, emptyCatalogDraft(google), 0)).toHaveProperty("error");
    expect(
      catalogConnectRequest(google, { ...emptyCatalogDraft(google), accountLabel: " work " }, 0),
    ).toEqual({ request: { catalogId: "google-workspace", accountLabel: "work" } });
  });

  it("needs a label for a second account", () => {
    const notion = entry("notion");
    expect(catalogConnectRequest(notion, emptyCatalogDraft(notion), 1)).toHaveProperty("error");
    expect(
      catalogConnectRequest(notion, { ...emptyCatalogDraft(notion), accountLabel: "Work" }, 1),
    ).toMatchObject({ request: { accountLabel: "Work" } });
  });
});
