import { useSyncExternalStore } from "react";

/**
 * Which models this device uses, for the model picker's Recent list. Kept in
 * local storage: it is a per-device convenience, not a setting to sync.
 * Recorded when a model is picked and when a turn is sent with one, and
 * seeded from the threads the user has written in (see threadModelUses), so
 * Recent is not empty on a device that has not recorded anything yet.
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

/**
 * The Recent list: the offered models in usage order, at most `limit`. Usage
 * of a model this picker cannot offer (removed, other machine) is skipped.
 */
export function pickRecentModels<T extends { readonly instanceId: string; readonly slug: string }>(
  models: ReadonlyArray<T>,
  usage: ReadonlyArray<ModelUsageEntry>,
  now: number,
  limit: number,
): T[] {
  const byKey = new Map(models.map((model) => [`${model.instanceId}\u0000${model.slug}`, model]));
  const recent: T[] = [];
  for (const entry of rankModelUsage(usage, now)) {
    const model = byKey.get(`${entry.instanceId}\u0000${entry.model}`);
    if (model) recent.push(model);
    if (recent.length === limit) break;
  }
  return recent;
}

/** The model a thread runs with and when the user last wrote in it. */
export interface ThreadModelUse {
  readonly modelSelection: { readonly instanceId: string; readonly model: string };
  readonly lastUserMessageAt: string | null;
}

/** Usage implied by threads: one use per thread, at its last user message. */
export function threadModelUses(
  threads: ReadonlyArray<ThreadModelUse>,
): ReadonlyArray<ModelUsageEntry> {
  let entries: ReadonlyArray<ModelUsageEntry> = [];
  const dated = threads
    .flatMap((thread) => {
      const time = thread.lastUserMessageAt ? Date.parse(thread.lastUserMessageAt) : Number.NaN;
      return Number.isFinite(time) && thread.modelSelection.model
        ? [{ ...thread.modelSelection, time }]
        : [];
    })
    .toSorted((left, right) => left.time - right.time);
  for (const use of dated) {
    entries = addModelUse(entries, use.instanceId, use.model, use.time);
  }
  return entries;
}

/** Both sources of usage as one list; a use both recorded is counted once. */
export function mergeModelUsage(
  recorded: ReadonlyArray<ModelUsageEntry>,
  implied: ReadonlyArray<ModelUsageEntry>,
): ReadonlyArray<ModelUsageEntry> {
  if (implied.length === 0) return recorded;
  let merged = recorded;
  const uses = implied
    .flatMap((entry) => entry.uses.map((time) => ({ ...entry, time })))
    .toSorted((left, right) => left.time - right.time);
  for (const use of uses) {
    const existing = merged.find(
      (entry) => entry.instanceId === use.instanceId && entry.model === use.model,
    );
    if (existing?.uses.some((time) => Math.abs(time - use.time) < REPEAT_WINDOW_MS)) continue;
    const times = [...(existing?.uses ?? []), use.time]
      .toSorted((left, right) => left - right)
      .slice(-USES_PER_MODEL);
    const updated: ModelUsageEntry = { instanceId: use.instanceId, model: use.model, uses: times };
    merged = existing
      ? merged.map((entry) => (entry === existing ? updated : entry))
      : [...merged, updated];
  }
  return merged;
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
