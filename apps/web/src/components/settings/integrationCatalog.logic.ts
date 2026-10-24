import {
  INTEGRATION_CATALOG,
  integrationCatalogEntry,
  integrationCatalogEntryFor,
  isIntegrationError,
  type IntegrationCatalogEntry,
  type IntegrationCatalogId,
  type IntegrationId,
  type IntegrationSetupAction,
  type IntegrationSummary,
} from "@t3tools/contracts";

import { integrationErrorText } from "./integrationServices.logic";

/** One connected account and the catalog service it belongs to; none for a custom server. */
export interface AccountRow {
  readonly summary: IntegrationSummary;
  readonly entry: IntegrationCatalogEntry | undefined;
}

const catalogRank = (entry: IntegrationCatalogEntry | undefined) =>
  entry === undefined
    ? INTEGRATION_CATALOG.length
    : INTEGRATION_CATALOG.findIndex((candidate) => candidate.id === entry.id);

/**
 * Accounts in catalog order, then custom servers, each service keeping the
 * server's order. Accounts of services the catalog no longer lists (Atlassian,
 * Intercom, Figma) are custom servers now.
 */
export function orderAccounts(summaries: ReadonlyArray<IntegrationSummary>): AccountRow[] {
  return summaries
    .map((summary, index) => ({
      summary,
      entry: integrationCatalogEntryFor(summary.integration),
      index,
    }))
    .toSorted(
      (left, right) =>
        catalogRank(left.entry) - catalogRank(right.entry) || left.index - right.index,
    )
    .map(({ summary, entry }) => ({ summary, entry }));
}

/** How many accounts each catalog service has. */
export function accountCounts(
  rows: ReadonlyArray<AccountRow>,
): ReadonlyMap<IntegrationCatalogId, number> {
  const counts = new Map<IntegrationCatalogId, number>();
  for (const { entry } of rows) {
    if (entry !== undefined) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Why a new account can't be added with this label yet. Google accounts are
 * always named; any other service needs a name once it has an account, so
 * people and agents can tell the two apart.
 */
export function accountLabelProblem(
  entry: IntegrationCatalogEntry,
  existingAccounts: number,
  label: string,
): string | null {
  if (label.trim() !== "") return null;
  if (entry.kind === "local-preset") return "Name this Google account, like personal or work.";
  if (existingAccounts > 0)
    return `Name this account to tell it apart from the ${entry.name} account you have.`;
  return null;
}

/** Whether adding this service asks for an account name. */
export function addAsksForAccountLabel(
  entry: IntegrationCatalogEntry,
  existingAccounts: number,
): boolean {
  return entry.kind === "local-preset" || existingAccounts > 0;
}

/** A setup that takes more than one click: steps, a form or a command, shown under its row. */
export type GuidedSetup = Extract<
  IntegrationSetupAction,
  { readonly type: "oauth_client" | "api_key" | "install_runtime" }
>;

export function isGuidedSetup(action: IntegrationSetupAction): action is GuidedSetup {
  return (
    action.type === "oauth_client" || action.type === "api_key" || action.type === "install_runtime"
  );
}

/** The one button a setup action puts on its row, and what it does. */
export type SetupControl =
  | { readonly kind: "sign_in" | "test" | "edit" | "enable" | "install"; readonly label: string }
  | { readonly kind: "expand"; readonly label: string; readonly action: GuidedSetup };

/**
 * One-click actions run from the row; anything with steps or a form opens
 * under it. `canInstall` is whether this connection may install software;
 * without it a missing runtime shows its command instead. A client or key
 * step that names no catalog service can only be fixed in Edit.
 */
export function setupControl(action: IntegrationSetupAction, canInstall: boolean): SetupControl {
  switch (action.type) {
    case "sign_in":
      return { kind: "sign_in", label: "Sign in" };
    case "retry":
      return action.button === "sign_in"
        ? { kind: "sign_in", label: "Sign in" }
        : { kind: "test", label: "Test again" };
    case "fix":
      return action.button === "enable"
        ? { kind: "enable", label: "Enable" }
        : { kind: "edit", label: "Edit" };
    case "install_runtime":
      return action.canInstall && canInstall
        ? { kind: "install", label: `Install ${action.runtime}` }
        : { kind: "expand", label: "Set up", action };
    case "oauth_client":
    case "api_key":
      return action.catalogId === undefined
        ? { kind: "edit", label: "Edit" }
        : { kind: "expand", label: "Set up", action };
  }
}

const SETUP_TARGET_MAX_LENGTH = 200;

/**
 * `?setup=` on Settings → Integrations: an integration id or a catalog id,
 * from an agent's link. The router may hand a number back for a digit-only
 * value, so that reads as its text.
 */
export function parseSetupSearch(raw: unknown): string | undefined {
  const value = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  return value === "" || value.length > SETUP_TARGET_MAX_LENGTH ? undefined : value;
}

/** What a `?setup=` target opens: an account's step, or adding a catalog service. */
export function resolveSetupTarget(
  target: string,
  summaries: ReadonlyArray<IntegrationSummary>,
):
  | { readonly kind: "account"; readonly id: IntegrationId }
  | { readonly kind: "catalog"; readonly catalogId: IntegrationCatalogId }
  | null {
  const account = summaries.find((summary) => summary.integration.id === target);
  if (account !== undefined) return { kind: "account", id: account.integration.id };
  const entry = integrationCatalogEntry(target);
  return entry === undefined ? null : { kind: "catalog", catalogId: entry.id };
}

/** Anchor ids the page scrolls to: one per account row, and the Add row. */
export const accountRowId = (id: IntegrationId) => `integration-${id}`;

/** A connect failure in plain words; a missing input says which. */
export function catalogErrorText(error: unknown): string {
  return isIntegrationError(error) &&
    error.reason === "invalid_request" &&
    typeof error.cause === "string"
    ? error.cause
    : integrationErrorText(error);
}
