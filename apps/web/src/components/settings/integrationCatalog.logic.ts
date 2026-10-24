import {
  INTEGRATION_CATALOG,
  integrationCatalogEntryFor,
  isIntegrationError,
  integrationCatalogInputs,
  type IntegrationCatalogAuthKind,
  type IntegrationCatalogConnectInput,
  type IntegrationCatalogEntry,
  type IntegrationSummary,
} from "@t3tools/contracts";

import { credentialReferencesIn, integrationErrorText } from "./integrationServices.logic";

const DOCS_URL = "https://github.com/aflekkas/cogenly/blob/main/docs/user/integrations.md";

/** The user guide section for a catalog entry. */
export function integrationDocsUrl(anchor: string): string {
  return `${DOCS_URL}#${anchor}`;
}

export interface CatalogGroup {
  readonly entry: IntegrationCatalogEntry;
  readonly accounts: ReadonlyArray<IntegrationSummary>;
}

/**
 * Every catalog entry in catalog order with its connected accounts, and the
 * integrations that belong to no entry (custom MCP servers).
 */
export function groupByCatalog(summaries: ReadonlyArray<IntegrationSummary>): {
  readonly groups: ReadonlyArray<CatalogGroup>;
  readonly custom: ReadonlyArray<IntegrationSummary>;
} {
  const accounts = new Map<string, IntegrationSummary[]>();
  const custom: IntegrationSummary[] = [];
  for (const summary of summaries) {
    const entry = integrationCatalogEntryFor(summary.integration);
    if (entry === undefined) custom.push(summary);
    else accounts.set(entry.id, [...(accounts.get(entry.id) ?? []), summary]);
  }
  return {
    groups: INTEGRATION_CATALOG.map((entry) => ({ entry, accounts: accounts.get(entry.id) ?? [] })),
    custom,
  };
}

/** The button a catalog entry shows. */
export function catalogAction(
  entry: IntegrationCatalogEntry,
  accounts: ReadonlyArray<IntegrationSummary>,
): "Connect" | "Add account" | "Not available yet" {
  if (entry.kind === "unavailable") return "Not available yet";
  return accounts.length > 0 ? "Add account" : "Connect";
}

export interface CatalogConnectDraft {
  readonly accountLabel: string;
  readonly auth: IntegrationCatalogAuthKind | null;
  readonly region: string;
  readonly apiKey: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export function emptyCatalogDraft(entry: IntegrationCatalogEntry): CatalogConnectDraft {
  return {
    accountLabel: "",
    auth: entry.kind === "remote" ? entry.auth[0].kind : null,
    region: "",
    apiKey: "",
    clientId: "",
    clientSecret: "",
  };
}

/** A connect failure in plain words; a missing input says which. */
export function catalogErrorText(error: unknown): string {
  return isIntegrationError(error) &&
    error.reason === "invalid_request" &&
    typeof error.cause === "string"
    ? error.cause
    : integrationErrorText(error);
}

/** Whether connecting opens a sign-in page afterwards. */
export function catalogDraftSignsIn(
  entry: IntegrationCatalogEntry,
  draft: CatalogConnectDraft,
): boolean {
  return entry.kind === "local-preset" || (entry.kind === "remote" && draft.auth !== "api_key");
}

const isVaultReference = (value: string) =>
  /^\{\{credential:[^}]*\}\}$/.test(value) &&
  credentialReferencesIn(value).every((ref) => ref.field !== "");

/**
 * The request a draft sends, or the first thing it is missing. A second
 * account needs a label, so agents and people can tell the two apart.
 */
export function catalogConnectRequest(
  entry: IntegrationCatalogEntry,
  draft: CatalogConnectDraft,
  existingAccounts: number,
): { readonly request: IntegrationCatalogConnectInput } | { readonly error: string } {
  if (entry.kind === "unavailable") return { error: entry.reason };
  const accountLabel = draft.accountLabel.trim();
  if (entry.kind === "local-preset" && accountLabel === "")
    return { error: "Name this Google account, like personal or work." };
  if (existingAccounts > 0 && accountLabel === "")
    return { error: `Name this account to tell it apart from the ${entry.name} account you have.` };
  const label = accountLabel === "" ? {} : { accountLabel };
  if (entry.kind === "local-preset") return { request: { catalogId: entry.id, ...label } };

  const needs = integrationCatalogInputs(entry, draft.auth ?? undefined);
  const region = draft.region.trim();
  if (needs.includes("region") && !entry.regions.some((candidate) => candidate.id === region))
    return { error: `Choose where your ${entry.name} workspace is hosted.` };
  const apiKey = draft.apiKey.trim();
  if (needs.includes("apiKey") && !isVaultReference(apiKey)) {
    const name = entry.auth.find((auth) => auth.kind === "api_key")?.label ?? "API key";
    // "Personal access token" reads as "personal access token"; "API key" stays.
    const inSentence = name.replace(/^[A-Z][a-z]/, (start) => start.toLowerCase());
    return { error: `Pick the ${inSentence} from the vault with the key button.` };
  }
  const clientId = draft.clientId.trim();
  if (needs.includes("clientId") && clientId === "") return { error: "Enter the app's client ID." };
  const clientSecret = draft.clientSecret.trim();
  if (needs.includes("clientSecret") && !isVaultReference(clientSecret))
    return { error: "Pick the app's client secret from the vault with the key button." };
  return {
    request: {
      catalogId: entry.id,
      ...label,
      inputs: {
        ...(draft.auth === null ? {} : { auth: draft.auth }),
        ...(needs.includes("region") ? { region } : {}),
        ...(needs.includes("apiKey") ? { apiKey } : {}),
        ...(needs.includes("clientId") ? { clientId } : {}),
        ...(needs.includes("clientSecret") ? { clientSecret } : {}),
      },
    },
  };
}
