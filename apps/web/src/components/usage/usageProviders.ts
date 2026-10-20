import { UsageProviderKind } from "@t3tools/contracts";

import { ProviderDriverKind } from "@t3tools/contracts";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
};

/**
 * Exhaustive presentation for providers supported by the usage contract. Kinds
 * without an entry below get a neutral label and colour.
 */
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
