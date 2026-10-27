/**
 * The order every single-project picker and move menu lists projects in: the
 * ones the user worked in most recently first, then the rest by name. A search
 * ranks names that start with the query above ones that merely contain it.
 */
import type { ProjectLabelId } from "@cogenly/contracts";

import { threadProjectFolderId } from "./projectLabels.logic";

/** How many recently used projects lead a picker before the rest go by name. */
export const RECENT_PROJECT_LIMIT = 5;

interface ProjectActivityThread {
  readonly source: { readonly projectFolderId?: ProjectLabelId | null | undefined };
  readonly createdAt: string;
  readonly latestUserMessageAt: string | null;
  readonly latestUserAuthoredMessageAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

/**
 * When the user last worked in each project, by project id: the latest message
 * they sent in any thread filed there, else when that thread started. Project
 * ids are shared across paired machines, so every machine's threads count.
 */
export function projectLastUsedAt(
  threads: Iterable<ProjectActivityThread>,
): Map<ProjectLabelId, string> {
  const lastUsed = new Map<ProjectLabelId, string>();
  for (const thread of threads) {
    if (thread.deletedAt != null) continue;
    const folderId = threadProjectFolderId(thread);
    if (folderId === null) continue;
    const at = thread.latestUserAuthoredMessageAt ?? thread.latestUserMessageAt ?? thread.createdAt;
    const previous = lastUsed.get(folderId);
    if (previous === undefined || at > previous) lastUsed.set(folderId, at);
  }
  return lastUsed;
}

/** Whether two recency maps hold the same projects at the same times. */
export function sameProjectLastUsedAt(
  left: ReadonlyMap<ProjectLabelId, string>,
  right: ReadonlyMap<ProjectLabelId, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, at] of left) if (right.get(id) !== at) return false;
  return true;
}

const byName = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: "base" });

export interface OrderedProjects<T> {
  /** Used most recently first, at most `limit`. */
  readonly recent: T[];
  /** Everything else, by name. */
  readonly rest: T[];
}

/** `entries` split into the recently used ones, newest first, and the rest by name. */
export function orderProjectsByUse<
  T extends { readonly label: { readonly id: ProjectLabelId; readonly name: string } },
>(
  entries: ReadonlyArray<T>,
  lastUsedAt: ReadonlyMap<ProjectLabelId, string>,
  limit = RECENT_PROJECT_LIMIT,
): OrderedProjects<T> {
  const used = entries
    .filter((entry) => lastUsedAt.has(entry.label.id))
    .toSorted(
      (left, right) =>
        lastUsedAt.get(right.label.id)!.localeCompare(lastUsedAt.get(left.label.id)!) ||
        byName(left.label.name, right.label.name),
    )
    .slice(0, limit);
  const recentIds = new Set(used.map((entry) => entry.label.id));
  const rest = entries
    .filter((entry) => !recentIds.has(entry.label.id))
    .toSorted((left, right) => byName(left.label.name, right.label.name));
  return { recent: used, rest };
}

/** `entries` in picker order as one list: recent, then the rest by name. */
export function projectsByUse<
  T extends { readonly label: { readonly id: ProjectLabelId; readonly name: string } },
>(entries: ReadonlyArray<T>, lastUsedAt: ReadonlyMap<ProjectLabelId, string>): T[] {
  const { recent, rest } = orderProjectsByUse(entries, lastUsedAt);
  return [...recent, ...rest];
}

/** 0 when the name starts with `needle`, 1 when a word in it does, 2 when it only contains it. */
function matchRank(name: string, needle: string): number | null {
  const lower = name.toLowerCase();
  const at = lower.indexOf(needle);
  if (at === -1) return null;
  if (at === 0) return 0;
  return lower.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle)) ? 1 : 2;
}

/**
 * The entries whose name contains `query`, names starting with it first, then
 * names with a word starting with it; each tier keeps the order given, so a
 * list already in picker order stays recent-first within a tier.
 */
export function rankProjectMatches<T extends { readonly label: { readonly name: string } }>(
  entries: ReadonlyArray<T>,
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...entries];
  const tiers: T[][] = [[], [], []];
  for (const entry of entries) {
    const rank = matchRank(entry.label.name, needle);
    if (rank !== null) tiers[rank]!.push(entry);
  }
  return tiers.flat();
}

/** Whether a project already has exactly this name, so "create" would only duplicate it. */
export function hasProjectNamed(
  entries: ReadonlyArray<{ readonly label: { readonly name: string } }>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  return entries.some((entry) => entry.label.name.toLowerCase() === needle);
}
