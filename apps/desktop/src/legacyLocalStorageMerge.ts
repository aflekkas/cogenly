/**
 * Merges V1 profile localStorage items into the V2 profile. Runs in the preload
 * before the app reads storage, and never overwrites what V2 already holds: a
 * key V2 has written keeps V2's value, except that unsent drafts are merged
 * entry by entry so neither side's are lost.
 */

interface MergeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const COMPOSER_DRAFTS_KEY = "cogenly:composer-drafts:v1";
const NOT_IMPORTED_KEYS = new Set([
  // Identifies one running install to the server; two apps must not share it.
  "cogenly.backgroundActivity.clientId",
  // Resumes a permission setup V1 left mid-flow; V2 would redirect to it on boot.
  "cogenly:snap-shot-setup-resume:v1",
]);
const DRAFT_RECORD_FIELDS = [
  "draftsByThreadKey",
  "draftThreadsByThreadKey",
  "logicalProjectDraftThreadKeyByLogicalProjectKey",
] as const;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseObject(raw: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Adds V1 drafts for threads V2 has no draft for. Shapes must share a version. */
function mergeComposerDrafts(current: JsonObject, legacy: JsonObject): JsonObject | null {
  if (current.version !== legacy.version) return null;
  if (!isObject(current.state) || !isObject(legacy.state)) return null;
  const state: JsonObject = { ...current.state };
  for (const field of DRAFT_RECORD_FIELDS) {
    const currentRecord = state[field];
    const legacyRecord = legacy.state[field];
    if (!isObject(currentRecord) || !isObject(legacyRecord)) return null;
    state[field] = { ...legacyRecord, ...currentRecord };
  }
  return { ...current, state };
}

const isMergedKey = (key: string) => key === COMPOSER_DRAFTS_KEY;

function mergeValue(key: string, current: string, legacy: string): string | null {
  if (!isMergedKey(key)) return null;
  const currentObject = parseObject(current);
  const legacyObject = parseObject(legacy);
  if (currentObject === null || legacyObject === null) return null;
  const merged = mergeComposerDrafts(currentObject, legacyObject);
  return merged === null ? null : JSON.stringify(merged);
}

/** Returns false when a write failed, so the caller can retry on a later launch. */
export function mergeLegacyLocalStorage(
  storage: MergeStorage,
  legacyItems: Readonly<Record<string, string>>,
): boolean {
  let complete = true;
  // Drafts first, so a full quota costs layout state rather than prompts.
  const keys = Object.keys(legacyItems).sort(
    (left, right) => Number(isMergedKey(right)) - Number(isMergedKey(left)),
  );
  for (const key of keys) {
    if (NOT_IMPORTED_KEYS.has(key)) continue;
    const legacy = legacyItems[key]!;
    const current = storage.getItem(key);
    const next = current === null ? legacy : mergeValue(key, current, legacy);
    if (next === null || next === current) continue;
    try {
      storage.setItem(key, next);
    } catch {
      // Over quota: skip this key rather than abandon the rest.
      complete = false;
    }
  }
  return complete;
}
