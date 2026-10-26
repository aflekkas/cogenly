import {
  AgentId,
  groupVaultLoginsBySite,
  ProjectLabelId,
  ThreadId,
  VaultItemId,
  type VaultItemMetadata,
  type VaultUsageEntry,
} from "@cogenly/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  lastUsedByItem,
  parseDomainList,
  sortVaultItems,
  vaultCreateInput,
  vaultDraftFromItem,
  vaultDraftProblem,
  splitVaultItems,
  vaultLastUsedText,
  vaultPolicySummary,
  vaultPolicyWithAccess,
  vaultSavedFromThread,
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
        secrets: {
          ...vaultDraftFromItem(null).secrets,
          username: "me",
          password: "pw",
          value: "ignored",
        },
      }),
    );
    expect(input.label).toBe("Work");
    expect(input.allowedDomains).toEqual(["github.com"]);
    expect(input.secretFields).toEqual({ username: "me", password: "pw" });
    // A new item starts on the default rule: agents fill it on its sites.
    expect(input.policy).toEqual({ mode: "allow", allowedAgentIds: [], allowedDomains: [] });
  });

  it("stores a card in its own encrypted fields, expiry included", () => {
    const input = vaultCreateInput(
      draft({
        type: "card",
        label: " Personal ",
        allowedDomains: "shop.com",
        secrets: {
          ...draft().secrets,
          cardNumber: "4242 4242 4242 4242",
          cardExpiryMonth: "08",
          cardExpiryYear: "2027",
          cardCvc: "987",
          cardholderName: "A Person",
        },
      }),
    );
    expect(input.label).toBe("Personal");
    expect(input.allowedDomains).toEqual(["shop.com"]);
    expect(input.secretFields).toEqual({
      cardNumber: "4242 4242 4242 4242",
      cardExpiryMonth: "08",
      cardExpiryYear: "2027",
      cardCvc: "987",
      cardholderName: "A Person",
    });
  });

  it("requires a complete expiry when either half is typed", () => {
    const base = draft({
      type: "card",
      secrets: { ...draft().secrets, cardNumber: "4242" },
    });
    expect(vaultDraftProblem(base, "create")).toBeNull();
    expect(
      vaultDraftProblem({ ...base, secrets: { ...base.secrets, cardExpiryMonth: "08" } }, "create"),
    ).toBe("Enter the full expiry (month and year).");
    expect(
      vaultDraftProblem(
        {
          ...base,
          secrets: { ...base.secrets, cardExpiryMonth: "13", cardExpiryYear: "2027" },
        },
        "edit",
      ),
    ).toBe("Enter the full expiry (month and year).");
  });

  it("drops agents and domains from an ask policy and marks a picked rule as the owner's", () => {
    const agent = AgentId.make("agent-1");
    expect(
      vaultCreateInput(
        draft({ policyMode: "ask", policyAgentIds: [agent], policyDomains: "a.com" }),
      ).policy,
    ).toEqual({ mode: "ask", allowedAgentIds: [], allowedDomains: [] });
    expect(vaultCreateInput(draft({ policyMode: "deny", policyOwnerSet: true })).policy).toEqual({
      mode: "deny",
      allowedAgentIds: [],
      allowedDomains: [],
      ownerSet: true,
    });
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
      secrets: { ...vaultDraftFromItem(null).secrets, password: "new" },
    };
    expect(vaultUpdateInput(saved.id, edited).secretFields).toEqual({ password: "new" });
  });

  it("sends only the card secrets that were typed", () => {
    const saved = item("vault:2", "Visa", {
      type: "card",
      fields: ["cardNumber", "cardExpiry", "cardCvc", "cardholderName"],
      cardLast4: "4242",
    });
    const edited = {
      ...vaultDraftFromItem(saved),
      secrets: { ...vaultDraftFromItem(saved).secrets, cardCvc: "111" },
    };
    expect(vaultUpdateInput(saved.id, edited).secretFields).toEqual({ cardCvc: "111" });
  });

  it("keeps the scope a saved item had", () => {
    const project = ProjectLabelId.make("label-1");
    const saved = item("vault:1", "GitHub", { scopeProjectId: project });
    expect(vaultUpdateInput(saved.id, vaultDraftFromItem(saved)).scopeProjectId).toBe(project);
  });

  it("saves the owner's portability, not one a rule imposes", () => {
    const chosen = item("vault:1", "GitHub", { portability: "machine" });
    expect(vaultUpdateInput(chosen.id, vaultDraftFromItem(chosen)).portability).toBe("machine");
    const byRule = item("vault:2", "Google OAuth", {
      portability: "machine",
      portabilityReason: "local_integration",
    });
    expect(vaultUpdateInput(byRule.id, vaultDraftFromItem(byRule)).portability).toBe("shared");
    // A server that predates vault sync reports none, and is sent none.
    const legacy = item("vault:3", "Stripe");
    expect(vaultUpdateInput(legacy.id, vaultDraftFromItem(legacy)).portability).toBeUndefined();
  });
});

describe("vaultPolicySummary", () => {
  const names = new Map([["agent-1", "Scout"]]);
  const agentName = (id: string) => names.get(id);
  it("describes the default, ask, block, and listed agents with domains", () => {
    expect(
      vaultPolicySummary({ mode: "ask", allowedAgentIds: [], allowedDomains: [] }, agentName),
    ).toBe("Asks you first");
    expect(
      vaultPolicySummary({ mode: "allow", allowedAgentIds: [], allowedDomains: [] }, agentName),
    ).toBe("Agents fill it on its sites");
    expect(
      vaultPolicySummary({ mode: "deny", allowedAgentIds: [], allowedDomains: [] }, agentName),
    ).toBe("Blocked for agents");
    expect(
      vaultPolicySummary(
        {
          mode: "allow",
          allowedAgentIds: [AgentId.make("agent-1"), AgentId.make("gone")],
          allowedDomains: ["github.com"],
        },
        agentName,
      ),
    ).toBe("Scout, a deleted agent may use it on github.com");
  });
});

describe("sortVaultItems", () => {
  it("orders by name regardless of case", () => {
    const sorted = sortVaultItems([item("3", "stripe"), item("1", "AWS"), item("2", "github")]);
    expect(sorted.map((entry) => entry.name)).toEqual(["AWS", "github", "stripe"]);
  });
});

describe("lastUsedByItem", () => {
  const use = (
    itemId: string,
    at: string,
    overrides: Partial<VaultUsageEntry> = {},
  ): VaultUsageEntry =>
    ({
      id: `${itemId}-${at}`,
      itemId: VaultItemId.make(itemId),
      threadId: null,
      agentId: null,
      action: "fill",
      domain: null,
      at,
      outcome: "allowed",
      ...overrides,
    }) as VaultUsageEntry;

  it("keeps the newest use per item, preferring one that went through", () => {
    const latest = lastUsedByItem([
      use("a", "2026-10-02T00:00:00.000Z"),
      use("a", "2026-10-05T00:00:00.000Z"),
      use("a", "2026-10-06T00:00:00.000Z", { outcome: "approval_required" }),
      use("b", "2026-10-01T00:00:00.000Z", { outcome: "denied_domain" }),
    ]);
    expect(latest.get(VaultItemId.make("a"))?.at).toBe("2026-10-05T00:00:00.000Z");
    expect(latest.get(VaultItemId.make("b"))?.at).toBe("2026-10-01T00:00:00.000Z");
  });

  it("says when and by which agent", () => {
    const agentName = (id: string) => (id === "agent-1" ? "Inbox" : undefined);
    const relative = () => "2 hours ago";
    expect(vaultLastUsedText(undefined, agentName, relative)).toBe("Never used");
    expect(
      vaultLastUsedText(
        use("a", "2026-10-05T00:00:00.000Z", { agentId: AgentId.make("agent-1") }),
        agentName,
        relative,
      ),
    ).toBe("Used 2 hours ago by Inbox");
    expect(
      vaultLastUsedText(
        use("a", "2026-10-05T00:00:00.000Z", { threadId: ThreadId.make("thread:1") }),
        agentName,
        relative,
      ),
    ).toBe("Used 2 hours ago in a chat");
  });
});

describe("vaultPolicyWithAccess", () => {
  it("changes the mode, keeps approved sites, and marks the choice as the owner's", () => {
    const policy = {
      mode: "allow" as const,
      allowedAgentIds: [AgentId.make("agent-1")],
      allowedDomains: [],
      approvedDomains: ["login.example.com"],
    };
    expect(vaultPolicyWithAccess(policy, { mode: "ask" })).toEqual({
      mode: "ask",
      allowedAgentIds: [],
      allowedThreadIds: [],
      allowedDomains: [],
      approvedDomains: ["login.example.com"],
      ownerSet: true,
    });
    expect(vaultPolicyWithAccess(policy, { agentIds: [] })).toMatchObject({
      mode: "allow",
      allowedAgentIds: [],
      ownerSet: true,
    });
  });
});

describe("groupVaultLoginsBySite", () => {
  it("groups logins by their first allowed site and leaves other types out", () => {
    const sites = groupVaultLoginsBySite([
      item("vault:2", "GitHub", { username: "octo-work", label: "Work" }),
      item("vault:1", "GitHub", { username: "octo-home" }),
      item("vault:3", "ADSO member portal", {
        allowedDomains: ["theadso.my.site.com"],
        fields: ["password"],
      }),
      item("vault:4", "Stripe", { type: "api_key", allowedDomains: [] }),
    ]);
    expect(sites).toEqual([
      {
        host: "theadso.my.site.com",
        siteName: "ADSO member portal",
        logins: [
          { id: "vault:3", label: "ADSO member portal", username: null, missingUsername: true },
        ],
      },
      {
        host: "github.com",
        siteName: "GitHub",
        logins: [
          {
            id: "vault:1",
            label: "GitHub · octo-home",
            username: "octo-home",
            missingUsername: false,
          },
          { id: "vault:2", label: "Work", username: "octo-work", missingUsername: false },
        ],
      },
    ]);
  });

  it("splits logins from the other types for their own list", () => {
    const { logins, others } = splitVaultItems([
      item("vault:4", "Stripe", { type: "api_key" }),
      item("vault:1", "GitHub"),
    ]);
    expect(logins.map((entry) => entry.id)).toEqual(["vault:1"]);
    expect(others.map((entry) => entry.id)).toEqual(["vault:4"]);
  });
});

describe("vaultSavedFromThread", () => {
  it("names the thread a sign-in card saved or updated the item from", () => {
    const threadId = ThreadId.make("thread:1");
    expect(vaultSavedFromThread({ action: "saved_from_request", threadId })).toEqual({
      threadId,
      updated: false,
    });
    expect(vaultSavedFromThread({ action: "updated_from_request", threadId })?.updated).toBe(true);
    expect(vaultSavedFromThread({ action: "fill", threadId })).toBeNull();
    expect(vaultSavedFromThread({ action: "saved_from_request", threadId: null })).toBeNull();
  });
});
