import type {
  IntegrationCatalogId,
  IntegrationNativeImportServer,
  IntegrationNativeImportServerStatus,
} from "@cogenly/contracts";

/** One server in the import review, however many configs define it. */
export interface NativeImportReviewRow {
  readonly key: string;
  readonly label: string;
  readonly icon: IntegrationCatalogId | null;
  /** Where it was found: a config file, "3 projects", "claude.ai account". */
  readonly source: string;
  readonly status: IntegrationNativeImportServerStatus;
}

export interface NativeImportReviewGroup {
  readonly provider: IntegrationNativeImportServer["provider"];
  readonly title: string;
  readonly rows: ReadonlyArray<NativeImportReviewRow>;
}

export interface NativeImportReview {
  readonly groups: ReadonlyArray<NativeImportReviewGroup>;
  readonly count: number;
}

export const NATIVE_IMPORT_STATUS_TEXT: Readonly<
  Record<
    IntegrationNativeImportServerStatus,
    { readonly label: string; readonly tone: "success" | "warning" | "neutral" }
  >
> = {
  ready: { label: "Ready", tone: "success" },
  "needs-sign-in": { label: "Needs sign-in", tone: "warning" },
  "needs-secret": { label: "Needs a secret", tone: "warning" },
  "needs-setup": { label: "Needs setup", tone: "warning" },
  unsupported: { label: "Can't import", tone: "neutral" },
};

const GROUP_TITLE: Readonly<Record<IntegrationNativeImportServer["provider"], string>> = {
  claude: "Claude",
  codex: "Codex",
};

// When copies of one server disagree, the row shows what the most work-needing copy still needs.
const STATUS_RANK: Readonly<Record<IntegrationNativeImportServerStatus, number>> = {
  ready: 0,
  "needs-sign-in": 1,
  "needs-secret": 2,
  "needs-setup": 3,
  unsupported: 4,
};

const ICON_MATCHERS: ReadonlyArray<readonly [RegExp, IntegrationCatalogId]> = [
  [/gmail|google/, "google-workspace"],
  [/slack/, "slack"],
  [/github/, "github"],
  [/linear/, "linear"],
  [/notion/, "notion"],
  [/wispr/, "wispr-flow"],
  [/fathom/, "fathom"],
];

/** The brand mark for a native server's name, when it is a service Cogenly knows. */
export function nativeServerIcon(label: string): IntegrationCatalogId | null {
  const name = label.toLowerCase();
  return ICON_MATCHERS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

function sourceText(copies: ReadonlyArray<IntegrationNativeImportServer>): string {
  const files = (scope: IntegrationNativeImportServer["scope"]) => [
    ...new Set(copies.flatMap((copy) => (copy.scope === scope && copy.file ? [copy.file] : []))),
  ];
  const projects = files("project");
  return [
    ...files("user"),
    ...(projects.length > 1 ? [`${projects.length} projects`] : projects),
    ...(copies.some((copy) => copy.scope === "account") ? ["claude.ai account"] : []),
  ].join(", ");
}

/**
 * The import offer as the owner reviews it: one row per server name within each provider, so a
 * server defined in a dozen project configs reads once, grouped Claude then Codex.
 */
export function nativeImportReview(
  servers: ReadonlyArray<IntegrationNativeImportServer>,
): NativeImportReview {
  const groups: NativeImportReviewGroup[] = [];
  for (const provider of ["claude", "codex"] as const) {
    const byName = new Map<string, IntegrationNativeImportServer[]>();
    for (const server of servers) {
      if (server.provider !== provider) continue;
      const key = server.label.trim().toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), server]);
    }
    const rows = [...byName].map(([key, copies]): NativeImportReviewRow => {
      const label = copies[0]!.label.trim();
      return {
        key: `${provider}:${key}`,
        label,
        icon: nativeServerIcon(label),
        source: sourceText(copies),
        status: copies.reduce(
          (worst, copy) => (STATUS_RANK[copy.status] > STATUS_RANK[worst] ? copy.status : worst),
          copies[0]!.status,
        ),
      };
    });
    rows.sort((left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
    );
    if (rows.length > 0) groups.push({ provider, title: GROUP_TITLE[provider], rows });
  }
  return { groups, count: groups.reduce((total, group) => total + group.rows.length, 0) };
}
