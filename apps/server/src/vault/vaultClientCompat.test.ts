import { VaultItemMetadata, VaultListResult, VaultPolicy } from "@cogenly/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { updatedVaultPolicy, vaultListForClient } from "./vaultClientCompat.ts";

const policy = (mode: VaultPolicy["mode"]): VaultPolicy => ({
  mode,
  allowedAgentIds: [],
  allowedDomains: [],
});

const item = (id: string, mode: VaultPolicy["mode"]) =>
  Schema.decodeUnknownSync(VaultItemMetadata)({
    id,
    name: id,
    type: "login",
    scopeProjectId: null,
    allowedDomains: ["github.com"],
    policy: policy(mode),
    fields: ["password"],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });

/** The vault list as a 0.3.2 client decodes it: no `deny` mode. */
const { policy: _, ...olderItemFields } = VaultItemMetadata.fields;
const OlderVaultList = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      ...olderItemFields,
      policy: Schema.Struct({ ...VaultPolicy.fields, mode: Schema.Literals(["ask", "allow"]) }),
    }),
  ),
});

const encodeList = Schema.encodeSync(VaultListResult);

describe("vault Block for clients without it", () => {
  const result = { items: [item("vault:open", "allow"), item("vault:blocked", "deny")] };

  it("sends Block as Ask to a 0.3.2 client, which then decodes the whole list", () => {
    const wire = encodeList(vaultListForClient(result, undefined));
    expect(() => Schema.decodeUnknownSync(OlderVaultList)(encodeList(result))).toThrow();
    expect(
      Schema.decodeUnknownSync(OlderVaultList)(wire).items.map((entry) => entry.policy.mode),
    ).toEqual(["allow", "ask"]);
  });

  it("sends Block unchanged to a client that supports it", () => {
    expect(vaultListForClient(result, true)).toBe(result);
  });

  it("keeps an item blocked when a 0.3.2 client saves the Ask it was shown", () => {
    expect(updatedVaultPolicy(policy("deny"), policy("ask"), undefined).mode).toBe("deny");
    expect(updatedVaultPolicy(policy("deny"), policy("allow"), undefined).mode).toBe("allow");
    expect(updatedVaultPolicy(policy("deny"), undefined, undefined).mode).toBe("deny");
    expect(updatedVaultPolicy(policy("deny"), policy("ask"), true).mode).toBe("ask");
  });
});
