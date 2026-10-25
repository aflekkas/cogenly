/** Case-insensitive list search across the user-facing names and descriptions. */
export function matchesSettingsListQuery(
  query: string,
  values: ReadonlyArray<string | null | undefined>,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return needle === "" || values.some((value) => value?.toLocaleLowerCase().includes(needle));
}
