import { UsageProviderKind } from "@t3tools/contracts";

import { ProviderDriverKind } from "@t3tools/contracts";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart and table, so adding a provider
 * only requires its contract support and one entry here.
 */
// Legacy usage buckets remain decodable. Give them neutral history presentation,
// while supported providers appear in controls and charts.
export const PROVIDER_PRESENTATION = {
  ...Object.fromEntries(
    UsageProviderKind.literals.map((kind) => [
      kind,
      {
        label: kind,
        color: "var(--muted-foreground)",
        driverKind: ProviderDriverKind.make(kind),
      },
    ]),
  ),
  muse: { label: "Muse Code", color: "#0081fb", driverKind: ProviderDriverKind.make("muse") },
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    driverKind: ProviderDriverKind.make("codex"),
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    driverKind: ProviderDriverKind.make("claudeAgent"),
  },
} as Record<UsageProviderKind, UsageProviderPresentation>;

/** Stable provider reading order across charts, summaries, tables, and hover rows. */
export const PROVIDER_ORDER: UsageProviderKind[] = ["codex", "claude", "muse"];

/** Providers with real activity, independent of the metric currently displayed. */
export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}
