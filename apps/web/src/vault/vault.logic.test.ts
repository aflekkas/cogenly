import {
  AgentId,
  ProjectLabelId,
  VaultItemId,
  type VaultItemMetadata,
  type VaultUsageEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  lastUsedByItem,
  parseDomainList,
  sortVaultItems,
  vaultCreateInput,
  vaultDraftFromItem,
  vaultDraftProblem,
  vaultPolicySummary,
  vaultUpdateInput,
  type VaultDraft,
} from "./vault.logic";

const item = (
  id: string,
  name: string,
  overrides: Partial<VaultItemMetadata> = {},
): VaultItemMetadata =>
  ({
    id: VaultItemId.make(id),
    name,
    type: "login",
    scopeProjectId: null,
    allowedDomains: ["github.com"],
    policy: { mode: "ask", allowedAgentIds: [], allowedDomains: [] },
    fields: ["username", "password"],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  }) as VaultItemMetadata;

const draft = (overrides: Partial<VaultDraft> = {}): VaultDraft => ({
  ...vaultDraftFromItem(null),
  name: "GitHub",
  ...overrides,
});

describe("parseDomainList", () => {
  it("keeps hosts from urls and lists, deduplicated", () => {
    expect(parseDomainList("https://GitHub.com/login, github.com\napi.stripe.com:443 ")).toEqual([
      "github.com",
      "api.stripe.com",
    ]);
  });
});

describe("vaultDraftProblem", () => {
  it("requires a name and the type's required secret on create only", () => {
    expect(vaultDraftProblem(draft({ name: " " }), "create")).toBe("Name the item.");
    expect(vaultDraftProblem(draft(), "create")).toBe("Enter the password.");
    expect(vaultDraftProblem(draft(), "edit")).toBeNull();
    expect(
      vaultDraftProblem(
        draft({ type: "api_key", secrets: { ...draft().secrets, value: "sk" } }),
        "create",
      ),
    ).toBeNull();
  });
});

describe("vaultCreateInput", () => {
  it("sends only the type's typed secrets and its domains", () => {
    const input = vaultCreateInput(
      draft({
        label: " Work ",
        allowedDomains: "github.com",
        secrets: { username: "me", password: "pw", totpSecret: "", value: "ignored" },
      }),
    );
    expect(input.label).toBe("Work");
    expect(input.allowedDomains).toEqual(["github.com"]);
    expect(input.secretFields).toEqual({ username: "me", password: "pw" });
    expect(input.policy).toEqual({ mode: "ask", allowedAgentIds: [], allowedDomains: [] });
  });

  it("stores a card's expiry as its label", () => {
    const input = vaultCreateInput(
      draft({
        type: "card",
        label: "08/27",
        allowedDomains: "shop.com",
        secrets: { username: "A Person", password: "123", totpSecret: "", value: "4242" },
      }),
    );
    expect(input.label).toBe("08/27");
    expect(input.allowedDomains).toEqual([]);
    expect(input.secretFields).toEqual({ username: "A Person", password: "123", value: "4242" });
  });

  it("drops agents and domains from an ask policy", () => {
    const agent = AgentId.make("agent-1");
    expect(
      vaultCreateInput(
        draft({ policyMode: "ask", policyAgentIds: [agent], policyDomains: "a.com" }),
      ).policy,
    ).toEqual({ mode: "ask", allowedAgentIds: [], allowedDomains: [] });
    expect(
      vaultCreateInput(
        draft({ policyMode: "allow", policyAgentIds: [agent], policyDomains: "a.com" }),
      ).policy,
    ).toEqual({ mode: "allow", allowedAgentIds: [agent], allowedDomains: ["a.com"] });
  });
});

describe("vaultUpdateInput", () => {
  it("leaves blank secrets unchanged and clears a removed label", () => {
    const saved = item("vault:1", "GitHub", { label: "Work" });
    const edited = { ...vaultDraftFromItem(saved), label: "" };
    const input = vaultUpdateInput(saved.id, edited);
    expect(input.secretFields).toBeUndefined();
    expect(input.label).toBeNull();
    expect(input.allowedDomains).toEqual(["github.com"]);
  });

  it("sends only the secrets that were typed", () => {
    const saved = item("vault:1", "GitHub");
    const edited = {
      ...vaultDraftFromItem(saved),
      secrets: { username: "", password: "new", totpSecret: "", value: "" },
    };
    expect(vaultUpdateInput(saved.id, edited).secretFields).toEqual({ password: "new" });
  });

  it("keeps the scope a saved item had", () => {
    const project = ProjectLabelId.make("label-1");
    const saved = item("vault:1", "GitHub", { scopeProjectId: project });
    expect(vaultUpdateInput(saved.id, vaultDraftFromItem(saved)).scopeProjectId).toBe(project);
  });
});

describe("vaultPolicySummary", () => {
  const names = new Map([["agent-1", "Scout"]]);
  const agentName = (id: string) => names.get(id);
  it("describes ask, any agent, and listed agents with domains", () => {
    expect(
      vaultPolicySummary({ mode: "ask", allowedAgentIds: [], allowedDomains: [] }, agentName),
    ).toBe("Agents ask first");
    expect(
      vaultPolicySummary({ mode: "allow", allowedAgentIds: [], allowedDomains: [] }, agentName),
    ).toBe("Allowed for: all agents");
    expect(
      vaultPolicySummary(
        {
          mode: "allow",
          allowedAgentIds: [AgentId.make("agent-1"), AgentId.make("gone")],
          allowedDomains: ["github.com"],
        },
        agentName,
      ),
    ).toBe("Allowed for: Scout, a deleted agent on github.com");
  });
});

describe("sortVaultItems", () => {
  it("orders by name regardless of case", () => {
    const sorted = sortVaultItems([item("3", "stripe"), item("1", "AWS"), item("2", "github")]);
    expect(sorted.map((entry) => entry.name)).toEqual(["AWS", "github", "stripe"]);
  });
});

describe("lastUsedByItem", () => {
  it("keeps the newest use per item", () => {
    const use = (itemId: string, at: string): VaultUsageEntry =>
      ({
        id: `${itemId}-${at}`,
        itemId: VaultItemId.make(itemId),
        threadId: null,
        agentId: null,
        action: "fill",
        domain: null,
        at,
        outcome: "allowed",
      }) as VaultUsageEntry;
    const latest = lastUsedByItem([
      use("a", "2026-10-02T00:00:00.000Z"),
      use("a", "2026-10-05T00:00:00.000Z"),
      use("b", "2026-10-01T00:00:00.000Z"),
    ]);
    expect(latest.get(VaultItemId.make("a"))).toBe("2026-10-05T00:00:00.000Z");
    expect(latest.get(VaultItemId.make("b"))).toBe("2026-10-01T00:00:00.000Z");
  });
});
