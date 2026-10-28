import type { VaultItemPortability, VaultPortabilityReason } from "@cogenly/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The vault item LocalIntegrations reads for the Google preset's OAuth client.
 * The fixed Google preset shares its Web OAuth client. Account grants stay
 * local because the managed Python runtime owns their refresh lifecycle.
 */
export const LOCAL_GOOGLE_CLIENT_ITEM = "google-oauth-client";

const CREDENTIAL_REF = /\{\{credential:([^}]*)\}\}/g;

export interface MachineOnlyRules {
  /** Item names a `transport: "local"` integration runs with. */
  readonly localIntegrationItems: ReadonlySet<string>;
  /** Item ids behind an account credential the owner marked machine-only. */
  readonly machineCredentialItems: ReadonlySet<string>;
}

/**
 * What keeps an item on this machine besides its own portability. Local
 * integrations run a command here with the item's secrets, so those secrets
 * never sync; their own sign-in files live in the state directory, not the
 * vault, and so never sync either.
 */
export const loadMachineOnlyRules = Effect.fn("Vault.loadMachineOnlyRules")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const integrations = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM integrations WHERE deleted_at IS NULL AND json_extract(payload_json, '$.transport') = 'local'`;
  const localIntegrationItems = new Set<string>();
  for (const row of integrations)
    for (const match of row.payload_json.matchAll(CREDENTIAL_REF)) {
      const ref = (match[1] ?? "").trim();
      const dot = ref.lastIndexOf(".");
      if (dot > 0) localIntegrationItems.add(ref.slice(0, dot).trim());
    }
  const credentials = yield* sql<{
    id: string;
  }>`SELECT json_extract(c.value, '$.vaultItemId') AS id FROM accounts a, json_each(a.payload_json, '$.credentials') c WHERE a.deleted_at IS NULL AND json_extract(c.value, '$.portability') = 'machine' AND json_extract(c.value, '$.vaultItemId') IS NOT NULL`;
  return {
    localIntegrationItems,
    machineCredentialItems: new Set(credentials.map((row) => row.id)),
  } satisfies MachineOnlyRules;
});

/** The portability metadata reports and sync obeys: the owner's choice, then the rules. */
export const effectivePortability = (
  item: { readonly id: string; readonly name: string; readonly portability: string },
  rules: MachineOnlyRules,
): {
  readonly portability: VaultItemPortability;
  readonly reason?: VaultPortabilityReason;
} => {
  if (item.portability === "machine") return { portability: "machine" };
  if (item.name.startsWith("google-grant-"))
    return { portability: "machine", reason: "local_integration" };
  if (rules.localIntegrationItems.has(item.name))
    return { portability: "machine", reason: "local_integration" };
  if (rules.machineCredentialItems.has(item.id))
    return { portability: "machine", reason: "machine_credential" };
  return { portability: "shared" };
};
