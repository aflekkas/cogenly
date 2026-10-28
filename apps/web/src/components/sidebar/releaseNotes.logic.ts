/**
 * Cogenly's release notes, from the GitHub Releases API, for the rail's
 * Updates popover. Release bodies are `## New` / `## Fixes` / `## Improvements`
 * headings with bullets (see .github/scripts/release-plan.cjs), closed by a
 * `## Build` section the popover leaves out.
 */

export interface CogenlyReleaseSection {
  /** "New", "Fixes"…; null for bullets before any heading. */
  readonly title: string | null;
  readonly items: ReadonlyArray<string>;
}

export interface CogenlyRelease {
  readonly version: string;
  readonly publishedAt: string | null;
  readonly url: string;
  readonly sections: ReadonlyArray<CogenlyReleaseSection>;
}

const PROD_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const MAX_ITEM_LENGTH = 220;

function parseVersion(version: string): [number, number, number] | null {
  const match = PROD_TAG.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Orders X.Y.Z versions; anything else sorts as equal. */
export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function cleanItem(raw: string): string {
  const item = raw
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // GitHub's generated notes: "... by @someone in https://…/pull/12".
    .replace(/\s+by @[\w-]+ in \S+$/, "")
    // A trailing commit or PR reference: "(abc1234)", "(#12)".
    .replace(/\s*\((?:[0-9a-f]{7,40}|#\d+)\)$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return item.length > MAX_ITEM_LENGTH ? `${item.slice(0, MAX_ITEM_LENGTH - 1).trimEnd()}…` : item;
}

/** The user-facing sections of a release body: headed bullet lists, up to `## Build`. */
export function parseReleaseNotesBody(body: string): CogenlyReleaseSection[] {
  const sections: { title: string | null; items: string[] }[] = [];
  let current: { title: string | null; items: string[] } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line.trim());
    if (heading) {
      const title = heading[1]!.replace(/[*_`]/g, "").trim();
      const normalized = title.toLowerCase();
      if (normalized === "build" || normalized === "new contributors") break;
      const sectionTitle =
        normalized === "what's changed" || normalized === "whats changed" ? null : title;
      // A repeated heading continues its section, so titles stay unique.
      current = sections.find((section) => section.title === sectionTitle) ?? null;
      if (!current) {
        current = { title: sectionTitle, items: [] };
        sections.push(current);
      }
      continue;
    }
    if (/^\**full changelog\**:/i.test(line.trim())) break;
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const item = cleanItem(bullet[1]!);
    if (!item) continue;
    if (!current) {
      current = { title: null, items: [] };
      sections.push(current);
    }
    current.items.push(item);
  }
  return sections.filter((section) => section.items.length > 0);
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}

/**
 * Published prod releases (vX.Y.Z, not drafts or prereleases), newest first,
 * from a `GET /repos/:owner/:repo/releases` payload. Anything malformed is skipped.
 */
export function parseGitHubReleases(payload: unknown): CogenlyRelease[] {
  if (!Array.isArray(payload)) return [];
  const releases = payload.flatMap((entry): CogenlyRelease[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { draft, prerelease } = entry as { draft?: unknown; prerelease?: unknown };
    if (draft === true || prerelease === true) return [];
    const tag = readString(entry, "tag_name");
    const url = readString(entry, "html_url");
    if (!tag || !url || !parseVersion(tag)) return [];
    return [
      {
        version: tag.replace(/^v/, ""),
        publishedAt: readString(entry, "published_at"),
        url,
        sections: parseReleaseNotesBody(readString(entry, "body") ?? ""),
      },
    ];
  });
  return releases.toSorted((left, right) => compareReleaseVersions(right.version, left.version));
}

/** What an update brings: releases after `installed`, up to and including `target`. */
export function releasesBetween(
  releases: ReadonlyArray<CogenlyRelease>,
  installed: string | null,
  target: string,
): CogenlyRelease[] {
  if (!parseVersion(target)) return [];
  return releases.filter(
    (release) =>
      compareReleaseVersions(release.version, target) <= 0 &&
      (installed === null ||
        !parseVersion(installed) ||
        compareReleaseVersions(release.version, installed) > 0),
  );
}

/**
 * The release history up to the installed version, current first. A dev build
 * (no version, or older than every release, like 0.0.0) sees all of it.
 */
export function releaseHistory(
  releases: ReadonlyArray<CogenlyRelease>,
  installed: string | null,
): CogenlyRelease[] {
  if (!installed || !parseVersion(installed)) return [...releases];
  const history = releases.filter(
    (release) => compareReleaseVersions(release.version, installed) <= 0,
  );
  return history.length > 0 ? history : [...releases];
}

/**
 * The notes the popover's What's new shows: the update on offer when there is
 * one, else the release the user is running. Nothing when the running version
 * has no release in the list (a dev build, or a list fetched before it shipped),
 * so the header's version and the notes' version never disagree.
 */
export function whatsNewReleases(
  incoming: ReadonlyArray<CogenlyRelease>,
  history: ReadonlyArray<CogenlyRelease>,
  installed: string | null,
): CogenlyRelease[] {
  if (incoming.length > 0) return [...incoming];
  if (!installed || !parseVersion(installed)) return [];
  const running = history.find(
    (release) =>
      parseVersion(release.version) !== null &&
      compareReleaseVersions(release.version, installed) === 0,
  );
  return running ? [running] : [];
}

export function formatReleaseDate(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Today", "Yesterday", else the short date: the What's new eyebrow's date. */
export function formatReleaseDay(publishedAt: string | null, now = new Date()): string | null {
  if (!publishedAt) return null;
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return null;
  const day = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export interface ReleaseNotesDigestGroup {
  readonly release: CogenlyRelease;
  readonly items: ReadonlyArray<string>;
}

/**
 * The few lines of What's new under the popover's hero: the first `limit`
 * bullets across `releases` (newest first, every section in order), grouped by
 * release, and how many bullets were left out. A release with no bullets
 * still gets its group while there is room, so its version shows.
 */
export function digestReleaseNotes(
  releases: ReadonlyArray<CogenlyRelease>,
  limit: number,
): { groups: ReleaseNotesDigestGroup[]; remaining: number } {
  const groups: ReleaseNotesDigestGroup[] = [];
  let room = limit;
  let remaining = 0;
  for (const release of releases) {
    const items = release.sections.flatMap((section) => section.items);
    const shown = items.slice(0, Math.max(0, room));
    room -= shown.length;
    remaining += items.length - shown.length;
    if (shown.length > 0 || (items.length === 0 && room > 0))
      groups.push({ release, items: shown });
  }
  return { groups, remaining };
}
