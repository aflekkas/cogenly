/**
 * Folds entries that share a key into one, kept at the position of the first
 * (for a newest-first list, the latest), with how many there were. `occurrences`
 * keeps every folded entry in input order, so a row can still list each one's
 * own trace and time.
 */
export function groupRepeatedEntries<T>(
  entries: ReadonlyArray<T>,
  keyOf: (entry: T) => string,
): Array<{ readonly entry: T; readonly count: number; readonly occurrences: ReadonlyArray<T> }> {
  const groups = new Map<string, { entry: T; count: number; occurrences: Array<T> }>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.occurrences.push(entry);
    } else groups.set(key, { entry, count: 1, occurrences: [entry] });
  }
  return [...groups.values()];
}

/**
 * Whether a key press in a settings search clears its query. Escape clears a
 * query first; with nothing to clear it bubbles to the page, where Settings
 * treats it as "leave". Mid-composition Escape belongs to the IME.
 */
export function settingsSearchEscapeClears(
  event: { readonly key: string; readonly isComposing: boolean },
  query: string,
): boolean {
  return event.key === "Escape" && !event.isComposing && query !== "";
}

/** Case-insensitive list search across the user-facing names and descriptions. */
export function matchesSettingsListQuery(
  query: string,
  values: ReadonlyArray<string | null | undefined>,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return needle === "" || values.some((value) => value?.toLocaleLowerCase().includes(needle));
}
