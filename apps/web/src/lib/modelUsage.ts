import { useSyncExternalStore } from "react";

/**
 * Which models this device uses, for the model picker's Recent list. Kept in
 * local storage: it is a per-device convenience, not a setting to sync.
 * Recorded when a model is picked and when a turn is sent with one.
 */
export interface ModelUsageEntry {
  readonly instanceId: string;
  readonly model: string;
  /** Recent use times in ms, newest last, at most USES_PER_MODEL. */
  readonly uses: ReadonlyArray<number>;
}

const STORAGE_KEY = "cogenly:model-usage";
const USES_PER_MODEL = 10;
const MAX_MODELS = 40;
/** A use counts half as much after this long. */
const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
/** Picking and then sending is one use, not two. */
const REPEAT_WINDOW_MS = 60 * 1000;

const NO_USAGE: ReadonlyArray<ModelUsageEntry> = [];
let cache: ReadonlyArray<ModelUsageEntry> | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): ReadonlyArray<ModelUsageEntry> {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): ModelUsageEntry[] => {
      if (typeof item !== "object" || item === null) return [];
      const { instanceId, model, uses } = item as Record<string, unknown>;
      if (typeof instanceId !== "string" || typeof model !== "string" || !Array.isArray(uses)) {
        return [];
      }
      const times = uses.filter((time): time is number => typeof time === "number");
      return times.length > 0 ? [{ instanceId, model, uses: times }] : [];
    });
  } catch {
    return [];
  }
}

export function readModelUsage(): ReadonlyArray<ModelUsageEntry> {
  if (cache === null) {
    try {
      cache = parse(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      cache = [];
    }
  }
  return cache;
}

/** The usage list with one more use of `model`, trimmed to its caps. */
export function addModelUse(
  entries: ReadonlyArray<ModelUsageEntry>,
  instanceId: string,
  model: string,
  now: number,
): ReadonlyArray<ModelUsageEntry> {
  const existing = entries.find(
    (entry) => entry.instanceId === instanceId && entry.model === model,
  );
  const lastUse = existing?.uses.at(-1);
  if (existing && lastUse !== undefined && now - lastUse < REPEAT_WINDOW_MS) {
    return entries;
  }
  const updated: ModelUsageEntry = {
    instanceId,
    model,
    uses: [...(existing?.uses ?? []), now].slice(-USES_PER_MODEL),
  };
  const others = entries.filter((entry) => entry !== existing);
  // Least recently used models drop off first.
  return [...others, updated]
    .toSorted((left, right) => (right.uses.at(-1) ?? 0) - (left.uses.at(-1) ?? 0))
    .slice(0, MAX_MODELS);
}

/** Frecency: every recent use counts, halving in weight every few days. */
export function modelUsageScore(entry: ModelUsageEntry, now: number): number {
  let score = 0;
  for (const time of entry.uses) {
    score += 0.5 ** (Math.max(0, now - time) / HALF_LIFE_MS);
  }
  return score;
}

/** The most used, most recent models first. */
export function rankModelUsage(
  entries: ReadonlyArray<ModelUsageEntry>,
  now: number,
): ReadonlyArray<ModelUsageEntry> {
  return entries
    .map((entry) => ({ entry, score: modelUsageScore(entry, now) }))
    .toSorted(
      (left, right) =>
        right.score - left.score || (right.entry.uses.at(-1) ?? 0) - (left.entry.uses.at(-1) ?? 0),
    )
    .map(({ entry }) => entry);
}

export function recordModelUsage(instanceId: string, model: string): void {
  const next = addModelUse(readModelUsage(), instanceId, model, Date.now());
  if (next === cache) return;
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the list still holds for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cache = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useModelUsage(): ReadonlyArray<ModelUsageEntry> {
  return useSyncExternalStore(subscribe, readModelUsage, () => NO_USAGE);
}
