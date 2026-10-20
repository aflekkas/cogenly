// Badge tints for repository headings, picked by name so a repository keeps its colour.
const BADGE_TINTS = [
  { background: "rgb(139 120 220 / 22%)", foreground: "#b7a8f0" },
  { background: "rgb(96 140 230 / 22%)", foreground: "#9dbcf5" },
  { background: "rgb(80 180 140 / 20%)", foreground: "#8fd6b6" },
  { background: "rgb(220 160 80 / 20%)", foreground: "#e8c08a" },
  { background: "rgb(220 110 140 / 20%)", foreground: "#efa3b8" },
] as const;

function badgeInitials(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (
    name
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

function badgeTint(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return BADGE_TINTS[hash % BADGE_TINTS.length]!;
}

/**
 * A repository's tinted square with its initials. `heading` is the small mark
 * in the Work list; `inline` sits in running text at the size of the capitals.
 */
export function RepositoryBadge({
  name,
  size = "heading",
}: {
  name: string;
  size?: "heading" | "inline";
}) {
  const tint = badgeTint(name);
  return (
    <span
      aria-hidden
      className={
        size === "inline"
          ? "inline-flex size-5 shrink-0 items-center justify-center rounded-tile font-sans font-semibold text-2xs leading-none sm:size-6"
          : "flex size-3.5 shrink-0 items-center justify-center rounded-tile font-sans font-semibold text-5xs leading-none"
      }
      style={{ backgroundColor: tint.background, color: tint.foreground }}
    >
      {badgeInitials(name)}
    </span>
  );
}
